# OpsPilot — CI/CD and Deployment

| Field | Value |
| --- | --- |
| Status | **CI implemented (PR 5A). Deployment configuration implemented (PR 5B). Not yet deployed.** |
| Workflow | `.github/workflows/ci.yml` |
| Node | `22.21.0`, pinned in `.nvmrc` |
| pnpm | `11.13.1`, pinned in the root `package.json` `packageManager` field |
| Container | `Dockerfile` (multi-stage), `docker/entrypoint.sh`, `.dockerignore` |
| Deployment target | Render (Docker web service) + Neon (managed PostgreSQL) |

> **Scope note — Feature Complete vs Portfolio Ready.** PR 5B ships the *configuration* for a
> single-origin, deterministic FAKE-provider deployment: the Dockerfile, the entrypoint, the health
> endpoints, `render.yaml`, and the `docker-smoke` CI job that proves the image end to end. **It does
> not prove a deployment happened.**
>
> ```text
> PR 5B merged != Portfolio Ready
> ```
>
> Portfolio Ready requires all five of: a successful Render deployment of the merged image; verified
> Neon persistence; completed deterministic and approval browser walkthroughs against the live URL;
> the actual public URL documented in this repository; and the free-tier cold-start limitation stated
> plainly (§16). None of those exist yet — this document contains **no live URL** and makes **no
> claim** that a public deployment currently exists. That evidence is PR 5C's job, once the service
> has actually been created and exercised.

---

## 1. What CI guarantees

Every pull request, and every push to `main`, must prove that the repository:

- installs reproducibly from the committed lockfile;
- generates the Prisma client from scratch (it is gitignored, never committed);
- typechecks under the strict compiler settings in `tsconfig.base.json`;
- passes every unit test;
- produces production builds for `apps/api` and `apps/web`;
- ships a web bundle free of development origins, backend identifiers, and test assets;
- passes both PostgreSQL integration suites against a real database;
- has no schema drift between the committed migrations and the schema they produce.

CI does not lint or format — see §8.

---

## 2. Triggers, permissions, and concurrency

```yaml
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
```

- **Triggers.** Every pull request regardless of target branch, plus direct pushes to `main` so the
  post-merge state is verified independently of the PR that produced it.
- **Permissions.** `contents: read` at the workflow level. The workflow never publishes, comments,
  tags, or pushes, so the default token is narrowed to the one scope it actually needs.
- **Concurrency.** A new push to a pull request cancels the superseded run; runs on `main` are never
  cancelled, so the history of what passed on `main` stays complete.

---

## 3. Job graph

Two jobs, run in parallel with no dependency between them:

```text
verify        (ubuntu-latest, no database)         timeout 20 min
integration   (ubuntu-latest, postgres service)    timeout 25 min
```

Splitting them means a typecheck or unit-test failure surfaces without waiting for a database to
start, and the database job's slower work never blocks fast feedback. Both jobs carry an explicit
`timeout-minutes` so a hung test or database command cannot occupy a runner indefinitely.

### Deterministic environment

Set once at the workflow level and inherited by both jobs:

```text
TZ=UTC
CI=true
AGENT_RUN_PROVIDER_MODE=FAKE
```

`TZ=UTC` removes any dependency on the runner's local time zone from date formatting.
`AGENT_RUN_PROVIDER_MODE=FAKE` is the only mode `apps/api` supports; see §7. `LIVE` selects the
Claude provider in `apps/worker` only, and is never set in CI or in the deployed container. The
worker's live path is bounded by a caller-owned signal covering its Anthropic provider calls; tool,
retrieval, and persistence cancellation are not wired in this milestone.

### Toolchain setup (identical in both jobs)

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4
  with:
    version: 11.13.1
    run_install: false
- uses: actions/setup-node@v4
  with:
    node-version-file: .nvmrc
    cache: pnpm
    cache-dependency-path: pnpm-lock.yaml
- run: pnpm install --frozen-lockfile
```

The order is load-bearing. pnpm is installed **before** `setup-node` so that `cache: pnpm` can
resolve the pnpm store path, and so the pnpm version comes from the explicit `11.13.1` pin rather
than from whichever Corepack shim the runner image happens to ship. `cache-dependency-path` keys the
store cache on `pnpm-lock.yaml`, the one file that determines the dependency set.

`--frozen-lockfile` fails the build if `pnpm-lock.yaml` is out of sync with any `package.json`,
rather than silently resolving something different from what a developer has locally.

Note that `--ignore-scripts` is **not** used: `pnpm-workspace.yaml`'s `allowBuilds` deliberately
permits install scripts for `prisma`, `@prisma/engines`, and `esbuild`, and skipping them would
break the install.

---

## 4. `verify` job

```bash
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opspilot/web run check:bundle
```

The built bundle is then uploaded with `actions/upload-artifact@v4` as `web-dist`, retained for 7
days, so a reviewer can inspect exactly what a given run produced.

`pnpm db:generate` runs first and on its own. The Prisma client is generated into
`packages/database/src/generated/` and is gitignored, so nothing downstream typechecks or builds
until it exists.

---

## 5. `integration` job

A `postgres:16-alpine` service container with a health check, matching the local Compose image:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: opspilot
      POSTGRES_PASSWORD: opspilot_ci_only
      POSTGRES_DB: opspilot
    ports:
      - 5432:5432
    options: >-
      --health-cmd "pg_isready -U opspilot -d opspilot"
      --health-interval 5s
      --health-timeout 3s
      --health-retries 10
```

with `DATABASE_URL`, `TEST_DATABASE_URL`, and `SHADOW_DATABASE_URL` pointing at `opspilot`,
`opspilot_test`, and `opspilot_shadow` on `localhost:5432`. These are throwaway CI credentials for a
container that exists for the duration of one job; they are not secrets and are not shared with any
other environment. Note the port is the standard `5432` here, unlike local development's `55432`
host mapping (chosen to avoid a port conflict on the developer's machine).

**Creating the test and shadow databases.** `pnpm db:test:ensure` is *not* used in CI:
`scripts/ensure-test-database.sh` shells into the database through `docker compose exec` and hard
-exits when the Compose service is not running, which is exactly the case here. Nor does the workflow
assume the runner image provides a `psql` binary — that is an undocumented property that can change.
Instead it uses the client inside the image already pinned above:

```yaml
- name: Create the test and shadow databases
  run: |
    docker exec "${{ job.services.postgres.id }}" \
      psql -U opspilot -d opspilot \
        -c 'CREATE DATABASE opspilot_test OWNER opspilot;' \
        -c 'CREATE DATABASE opspilot_shadow OWNER opspilot;'
```

No client installation, no version skew between client and server, and no network round-trip. The
connection runs over the container's local socket, which the official image trusts, so no password is
needed. `scripts/ensure-test-database.sh` is left unchanged — it remains the correct tool locally.

Then:

```bash
pnpm db:generate
pnpm db:migrate:test               # migrate deploy against TEST_DATABASE_URL
pnpm test:integration:sequential   # database suite, then API suite
pnpm db:migrate:deploy             # migrate DATABASE_URL so drift has a target
pnpm db:migrate:drift              # migrate diff --exit-code
```

`db:migrate:deploy` runs before the drift check because `prisma migrate diff --to-config-datasource`
compares the committed migrations against a **live** datasource; that datasource has to be migrated
first for the comparison to mean anything. `SHADOW_DATABASE_URL` is the throwaway database Prisma
replays the migration history into for the comparison, and Prisma does not create it automatically —
hence `opspilot_shadow` above.

The drift check earns its place in this repository specifically: all 12 `CHECK` constraints live in
hand-authored migration SQL that Prisma's schema DSL cannot express, so a hand-edited migration or a
`schema.prisma` change without a corresponding migration is a real and otherwise-silent risk.

---

## 6. Why serialization is preserved

Two independent serialization requirements exist, and CI weakens neither.

**Prisma generation.** The generated client is written to a single directory,
`packages/database/src/generated/`. Two concurrent `prisma generate` processes would write it at
once. This never happens today because every root aggregate script pins
`--workspace-concurrency=1`, and each package's own script chains `db:generate` ahead of its work.
CI runs `pnpm db:generate` once explicitly, up front, and **must never introduce `pnpm -r --parallel`**
— that is the single change that would turn a safe ordering into a race.

**Integration suites.** `packages/database` and `apps/api` share **one physical test database** and
`TRUNCATE` between tests, with `fileParallelism: false` in both integration configs. Running them
concurrently would have one suite truncate the other's rows mid-test. The root script
`test:integration:sequential` exists precisely to run them one after the other, and CI calls that
script rather than the two suites separately.

---

## 7. Why CI cannot call a paid provider

Three independent reasons, in order of how hard they are to defeat:

1. **No secret is referenced.** The workflow contains no `secrets.*` expression at all — no
   `ANTHROPIC_API_KEY`, no `VOYAGE_API_KEY`, no OpenAI key. There is nothing to authenticate with.
2. **The API refuses any other mode.** `apps/api` reads `AGENT_RUN_PROVIDER_MODE` and throws
   `LiveProviderModeNotSupportedError` at dependency-injection time for any value other than `FAKE`,
   before a network call is possible. CI sets it to `FAKE` explicitly anyway.
3. **Nothing in the test suites reaches a provider.** The live spikes
   (`apps/worker`'s `spike:claude` and `spike:rag`) and the live smoke
   (`test:claude:live`) are separate scripts that are never invoked by `pnpm test` or by any CI
   step, and each fails fast on a missing key. `pnpm test` runs `pnpm -r --if-present run test`,
   which matches the script name `test` exactly — `test:claude:live` is not a match, so it cannot be
   picked up by the recursive run. The smoke additionally requires `OPSPILOT_LIVE_SMOKE=1` and
   `AGENT_RUN_PROVIDER_MODE=LIVE`, neither of which exists in CI.
4. **The Anthropic SDK is not in the production image.** `pnpm install --prod --filter
   "@opspilot/api..."` resolves only the API's dependency closure, and the `docker-smoke` job
   asserts `! test -d /app/node_modules/@anthropic-ai`. The Claude adapter therefore lives in
   `apps/worker`, never in `packages/agent-runtime` — that package *is* copied into the image, so
   putting SDK-importing code there would defeat this boundary (see §13).

---

## 8. What CI deliberately does not do

**No lint or format step.** The repository has no ESLint, Prettier, or Biome configuration, and no
package defines a `lint` script — the root `lint` script is currently a no-op. This is a deliberate
deferral, not an oversight, and the reason is technical as well as scoping: `typescript@7.0.2` is the
native rewrite, whose npm distribution no longer exposes the classic TypeScript Compiler API through
`require("typescript")`. Compiler-API consumers such as `typescript-eslint` cannot be assumed to work
under it — the same incompatibility that removed `@nestjs/cli` from this repository (see
`docs/10-engineering-challenges.md`, Challenge 4). Adopting lint tooling means first proving it
functions under the pinned TypeScript, which is its own piece of work.

The quality gate is therefore strict `tsc` — `strict`, `noUncheckedIndexedAccess`, and
`exactOptionalPropertyTypes` — plus the test suites.

**No deployment.** No image is built, published, or deployed. See the scope note at the top.

---

## 9. Production bundle guard

`apps/web` ships to a browser, so its build output is checked for things that must never reach a
user. This automates invariants that were previously asserted by hand during review.

| Rule | Catches |
| --- | --- |
| `dev-host-localhost` | A development origin (`localhost`) in the bundle |
| `dev-host-loopback` | A development origin by IP (`127.0.0.1`) |
| `absolute-api-origin` | An absolute `http(s)` origin whose path reaches `/v1`, replacing the relative-request contract |
| `backend-env-name` | `DATABASE_URL` reaching the browser |
| `prisma-runtime` | `PrismaClient` leaking into the browser bundle |
| `test-assets` | `__tests__`, `*.test.[jt]sx?`, or `/src/test/` paths in production output |

**The guard deliberately does not ban all URLs.** A React production build legitimately contains
`http://www.w3.org/2000/svg`, `https://react.dev/errors/`, dependency homepages, and license links.
A rule broad enough to catch those produces false positives on every run, and a guard nobody trusts
gets switched off. Each rule above targets a concrete leak instead. The `absolute-api-origin` rule in
particular uses a lookahead so that `/v10` and `/v1beta` do not match.

Layout:

| File | Role |
| --- | --- |
| `apps/web/src/build-guard/forbidden-patterns.ts` | Pure, dependency-free rule table and `findBundleViolations()` |
| `apps/web/src/build-guard/forbidden-patterns.test.ts` | Positive **and** negative cases — the benign-URL cases are the point |
| `apps/web/scripts/check-bundle.ts` | CLI: walks `dist/`, prints violations, exits non-zero |

Detection logic is a pure function so it is unit-tested directly rather than through the filesystem;
the CLI only walks the directory and formats output. No application source imports the guard, so it
never enters the browser bundle. A missing or empty `dist/` is a hard failure rather than a silent
pass — a guard that reports success because there was nothing to check is worse than no guard.

Run it against an arbitrary directory when debugging:

```bash
pnpm --filter @opspilot/web run check:bundle -- path/to/dist
```

---

## 10. Running the same checks locally

Without a database — the `verify` job:

```bash
pnpm install --frozen-lockfile
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opspilot/web run check:bundle
```

With PostgreSQL — the `integration` job:

```bash
pnpm infra:up                     # local Compose Postgres on host port 55432
pnpm db:test:ensure               # local equivalent of the CI database-creation step
pnpm db:migrate:test
pnpm test:integration:sequential
pnpm db:migrate:deploy
pnpm db:migrate:drift
```

The commands are identical to CI except for database creation: locally `pnpm db:test:ensure` uses
Docker Compose; CI uses the service container's own `psql` (§5).

---

## 11. Known limitations

- **CI pins Node `22.21.0` via `.nvmrc`, which may differ from a developer's local Node.** The
  repository requires `>=22.21.0`, so a newer local version is supported and expected to work, but
  CI is the authority. Use `nvm use` to match it exactly when reproducing a CI-only failure.
- **No lint or format gate** (§8).
- **No end-to-end or browser test.** The browser walkthrough in `docs/14-web-ui.md` §11 is a manual
  procedure; there is no Playwright or equivalent in the repository.
- **No coverage reporting or thresholds.**
- **The workflow is not exercised until it runs on GitHub.** Local verification proves the commands
  pass; it cannot prove the runner environment, the service container, or the caching behave as
  expected. The first real run is the actual verification.
- **No live deployment yet** — the configuration below exists and is proven in CI (§20), but no
  Render service or Neon database has been created (see the scope note at the top).

---

## 12. Deployment architecture

One Render Web Service, one Neon PostgreSQL database, one public origin:

```text
                    ┌─────────────────────────────────────────┐
  Browser  ──────►  │ Render Web Service (Docker, Node 22)     │
                    │                                         │
                    │  /              → apps/web/dist (static)│
                    │  /assets/*      → hashed bundle, immutable
                    │  /v1/**         → NestJS (global prefix)│
                    │  /v1/health/*   → liveness / readiness  │
                    │  other GET      → SPA fallback index.html
                    └──────────────────┬──────────────────────┘
                                       │ pg.Pool + @prisma/adapter-pg
                                       ▼
                              Neon PostgreSQL (managed)
```

**One origin, no CORS.** A separate static host plus a separate API service would create a second
origin and force CORS. Instead the built React app is served from the same NestJS process as the
API: `apps/api` is already a `NestExpressApplication`, so `useStaticAssets` needs no new dependency,
and the frontend already emits only relative `/v1/...` requests. The static mount and the API are
kept from colliding by two things together, not the route prefix alone: the order static/SPA-fallback
middleware is registered in (before Nest's own routing — see
`docs/10-engineering-challenges.md` Challenge 5 for why the prefix by itself is not sufficient in
this exact framework/library combination), and the SPA fallback's own explicit, case-aware `/v1`
exclusion (below).

`apps/worker` is **not** deployed — it has no build script, the API never imports it, and its
runbook path resolution is source-relative (see §17). No queue, no second service, no CDN, no
pgvector.

### Middleware order

```text
1. requestIdMiddleware              (unchanged)
2. useStaticAssets(webDistDir)      conditional — only when a build is present
3. spaFallbackMiddleware            conditional, same guard
4. jsonBodyParser (32 KB)           (unchanged)
5. jsonParserErrorHandler           (unchanged)
6. Nest routes (/v1/**)             (unchanged)
```

Static handling runs **before** the JSON parser, so asset requests never enter body parsing, and
**before** Nest, so they never touch the logging interceptor or the DI container. Both are entirely
skipped when `apps/web/dist/index.html` does not exist (`WEB_DIST_DIR`, default resolved from
`apps/api/dist/main.js`) — so local `pnpm api:start` next to `vite dev` is unaffected, and the
API-only behavior developers already rely on is preserved byte-for-byte.

### SPA fallback — three guards

```ts
if (req.method !== "GET" && req.method !== "HEAD") return next();
const normalizedPath = req.path.toLowerCase();          // comparison only — never used for sendFile
if (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/")) return next();  // never shadow the API
if (path.extname(req.path) !== "") return next();        // missing assets 404, not the app shell
res.setHeader("Cache-Control", "no-cache");
res.sendFile(indexPath, (err) => err && next(err));
```

The `/v1` guard compares against a lowercased copy of the path — never the raw path used for the
extension check or `sendFile` — so it correctly excludes prefix lookalikes like `/v1abc` **and**
alternate-case requests like `/V1/health/live`. This matters because Express's router is
case-insensitive by default (case-sensitive routing is not enabled anywhere in this app): a real
request to `/V1/health/live` reaches the exact same Nest route `/v1/health/live` does, so a
case-sensitive guard would have let the SPA fallback intercept it first and silently return
`index.html` instead of the API response. The extension guard is equally load-bearing: browsers send
`Accept: */*` for scripts, which would satisfy an `Accept`-only check and let a missing `.js` file
silently receive `index.html` — turning a deploy
error into a blank page with a browser MIME-type console error instead of an honest 404. See
`docs/10-engineering-challenges.md` Challenge 5 for the full failure-mode discussion, including a
repository-verified correction to how the API's unmatched-route handling actually scopes.

### Asset caching

- `/assets/*` (Vite's content-hashed filenames) → `Cache-Control: public, max-age=31536000,
  immutable`.
- `index.html` and the SPA fallback response → `Cache-Control: no-cache`.

---

## 13. Container build

Five-stage `Dockerfile`: `base` → `deps` → `build` → `prod-deps` → `runtime`.

| Stage | Purpose |
| --- | --- |
| `base` | Pins `node:22.21.0-bookworm-slim`; enables Corepack (activates the exact pnpm pin once `package.json` is copied into a later stage). |
| `deps` | Copies only workspace manifests + lockfile, then `pnpm install --frozen-lockfile` — maximizes layer-cache reuse across source-only changes. |
| `build` | Copies the full source, generates the Prisma client, and builds `@opspilot/api` and `@opspilot/web` (each pulls in its own workspace dependency chain). |
| `prod-deps` | A **separate** `pnpm install --frozen-lockfile --prod --filter "@opspilot/api..."` — the production dependency closure of `@opspilot/api` only. |
| `runtime` | Assembles the final image from the previous stages; nothing here re-installs or rebuilds anything. |

**`--filter "@opspilot/api..."` on the production install** is what keeps `apps/worker`'s
`@anthropic-ai/sdk` and `voyageai` — and all of `apps/web`'s dev-only dependencies — out of the
runtime image entirely. `--frozen-lockfile` still requires an importer entry for every workspace
package, `apps/worker` included, so its `package.json` is copied into every stage and does end up in
the image as an inert manifest; nothing installs its dependencies or starts it as a process (see the
boundary table below).

**The entire `prod-deps` output is copied into `runtime` as one layer** (`COPY --from=prod-deps /app
/app`) so pnpm's relative symlinks into `node_modules/.pnpm/` survive the stage copy. Cherry-picking
individual `node_modules` subdirectories would break them — see
`docs/10-engineering-challenges.md` Challenge 6.

### What the runtime image contains, and what it does not

| | Status |
| --- | --- |
| Compiled `apps/api/dist`, `apps/web/dist`, and the three built workspace packages | present |
| Prisma migrations, `prisma.config.ts`, and the Prisma CLI (`node_modules/.bin/prisma`) | present — needed by the entrypoint (§14) |
| `docker/entrypoint.sh` | present at `/usr/local/bin/opspilot-entrypoint`, `COPY --chmod=755` (deterministic executable bit, independent of the host's file mode or git's executable-bit tracking) |
| Worker **source** (`apps/worker/src`) | absent — excluded by `.dockerignore` |
| Worker **build output** | absent — `apps/worker` has no build script, so none exists to exclude |
| A worker **process** | absent — the entrypoint execs the API only |
| `@anthropic-ai/sdk`, `voyageai` | absent — excluded by the `--filter "@opspilot/api..."` production install |
| `runbooks/` | absent — the deployed API never reads them (§17) |
| `.env`, any secret | absent — `.dockerignore` excludes `.env`/`.env.*`; the container reads real environment variables only |
| `apps/worker/package.json` | **present** — an inert manifest required by the frozen-lockfile workspace install; not worth pruning |

### Build-time assertions

The image fails to build — not merely to start — if any of the following do not hold:

```dockerfile
RUN test -x /app/packages/database/node_modules/.bin/prisma \
 && test -f /app/apps/api/dist/main.js \
 && test -f /app/apps/web/dist/index.html \
 && test -x /usr/local/bin/opspilot-entrypoint \
 && (cd /app/apps/api && node -e "require.resolve('@opspilot/database'); require.resolve('@opspilot/agent-runtime')") \
 && (cd /app/packages/database && node -e "require.resolve('@prisma/client')")
```

**The `cd` before each `require.resolve()` is load-bearing, not decoration.** `require.resolve()`
walks up from the directory of the *file performing the resolution*, not the process's current
working directory — so it must run from the package context that actually declares each dependency:
`apps/api` for the workspace packages it imports directly, `packages/database` for `@prisma/client`,
which `apps/api` never depends on directly. A `node -e` check run from `/app` (the image's `WORKDIR`)
would not see either dependency and would report a false failure. This was found only by attempting
this assertion against the real installed image — see
`docs/10-engineering-challenges.md` Challenge 6.

Runtime user is `node` (non-root); the image `EXPOSE`s port `3000`.

---

## 14. Startup and migration strategy

**The first database contact in the container is `prisma migrate deploy`, run from
`docker/entrypoint.sh` — not the application.** A Neon free-tier database that has auto-suspended
needs a few seconds to wake, so the retry has to live at the point of first contact; anywhere later
is unreachable, because the container would already have exited. This is why
`PrismaLifecycleService` (the API's own `SELECT 1` on boot) is **deliberately unmodified** and stays
fail-fast — by the time Nest starts, the entrypoint's successful migration has already proven the
database reachable, so a second retry layer there would add latency and a second failure mode for no
benefit. Exactly one retry policy exists in the system. See
`docs/10-engineering-challenges.md` Challenge 7 for the full reasoning, including how an earlier
draft of this design got the retry's location wrong.

### Retry policy

Five attempts, a fixed 3-second delay, both overridable:

| Variable | Default | Purpose |
| --- | --- | --- |
| `RUN_MIGRATIONS_ON_START` | `true` | Set to `false` to skip the migration step entirely on start. Only the exact lowercase strings `true`/`false` are accepted — any other value, including a typo like `ture`, aborts startup with a clear error instead of silently skipping migrations. |
| `MIGRATION_RETRY_ATTEMPTS` | `5` | Bounded attempts around `prisma migrate deploy`. |
| `MIGRATION_RETRY_DELAY_SECONDS` | `3` | Fixed delay between attempts (no backoff, no jitter). |
| `PRISMA_BIN` | `/app/packages/database/node_modules/.bin/prisma` | Overridable if the production-dependency layout ever changes; verified executable at build time (§13) and re-checked at start. |
| `MIGRATION_DATABASE_URL` | unset (falls back to `DATABASE_URL`) | Escape hatch for a future pooled (PgBouncer) runtime endpoint — `migrate deploy`'s advisory locks do not survive transaction pooling. |

Deliberately the simplest thing that works: no exponential backoff, no jitter, and — critically — no
classification of PostgreSQL errors. The retry does not distinguish "database still waking up" from
"genuinely broken migration"; it retries either one the same fixed number of times and then fails.
Retrying a deterministic failure a few times is cheap (worst case ~12 seconds at the defaults);
misclassifying a permanent error as transient is a worse failure mode than a short delay. Every
failed attempt is logged to stderr specifically so this is visible in Render's logs — if a deploy
routinely needs 2–3 attempts, that is a signal the database is degraded, not a reason to raise the
budget.

`prisma migrate deploy` is idempotent and advisory-locked, so running it on every container start is
safe.

### A Prisma CLI quirk found only by running the real container

`packages/database/prisma.config.ts` unconditionally declares `datasource.shadowDatabaseUrl` (needed
by `prisma migrate diff`, used in CI's drift check — see §5). `migrate deploy` never connects to a
shadow database, but Prisma 7.9's CLI validates that field for **every** command regardless of
whether that command uses it: an empty string fails with `P1013`, and — a second, distinct check — a
value identical to `DATABASE_URL` is explicitly rejected ("the shadow database you configured
appears to be the same as the main database"). Neither failure mode is reachable locally, because
`scripts/run-prisma.mjs` loads the repo-root `.env` (which sets a real `SHADOW_DATABASE_URL`); inside
the container there is no `.env` at all. `docker/entrypoint.sh` therefore defaults
`SHADOW_DATABASE_URL` to a fixed, obviously-fake `.invalid` placeholder (RFC 2606 — guaranteed never
to resolve) when the variable is not already set, satisfying both checks without creating any real
second-database dependency. This was discovered empirically, by running `prisma migrate deploy`
inside the actual built image against a real database — not anticipated by the original design plan.

### Failure behavior

```text
temporary database wake-up          → may succeed within the retry budget
broken migration / unreachable DB   → container exits non-zero after the budget, API never binds
```

After a successful migration, the entrypoint execs the API directly:

```sh
exec node apps/api/dist/main.js
```

`exec` (not a background `&`) makes Node PID 1 inside the container, which is what lets Render's
`SIGTERM` reach `enableShutdownHooks` and close the `pg.Pool` cleanly on `docker stop` / redeploy —
verified locally: a running container stops in well under a second with no hang.

---

## 15. Health endpoints

```text
GET /v1/health/live    process-only, never queries the database
GET /v1/health/ready    SELECT 1 through the same Prisma handle the API already holds
```

`live` exists so a liveness probe can tell "the process is up" apart from "the database is
reachable." `ready` success returns the normal `{ data: { status: "ready" } }` envelope; a database
failure reuses the existing `PERSISTENCE_UNAVAILABLE` catalog entry (503, "The database is
temporarily unavailable") rather than a new code — the message already exists, is already tested
against leaking connection strings or raw Postgres errors, and readiness failure is exactly the
condition it describes. Both routes are registered under `/v1`, before the catch-all
`NotFoundModule`, keeping the single-origin contract to exactly one API prefix.

---

## 16. Render configuration

`render.yaml`, committed at the repository root — Render builds the committed `Dockerfile` itself, so
there is no container registry and no push credential to manage.

| Setting | Value |
| --- | --- |
| Runtime | `docker`, `dockerfilePath: ./Dockerfile`, `dockerContext: .` |
| Plan | `free` (initial portfolio demo) |
| Branch | `main`, `autoDeployTrigger: checksPass` — deploys only after this repository's own CI checks pass (`verify`, `integration`, `docker-smoke`), not on every push. The deprecated `autoDeploy: true` field deploys unconditionally on push and is deliberately not used. |
| Health check | `/v1/health/ready` |
| `HOST` | `0.0.0.0` |
| `AGENT_RUN_PROVIDER_MODE` | `FAKE` — unchanged by the live-provider milestone; the deployment remains FAKE-only |
| `DATABASE_URL` | `sync: false` — the **only** secret, entered by hand in the Render dashboard, never committed |

No `ANTHROPIC_API_KEY` is deployed to Render, and none belongs there: `apps/api` rejects
`AGENT_RUN_PROVIDER_MODE=LIVE` at startup, and the Anthropic SDK is absent from the image entirely.
Making the public demo live-LLM-capable is a separate milestone with its own safeguards (rate
limiting, budget controls, protected access) and is explicitly not enabled here.

Render supplies `PORT` itself; `main.ts` already reads it through the same validated `resolveServerConfig()` used everywhere else (§13 in `docs/12-agent-run-api.md` is unaffected — this is additive).

**Render Free cold start.** The free plan spins down after roughly 15 minutes of idle traffic and
takes roughly 50 seconds to cold-start on the next request. This is accepted for the initial
portfolio deployment and must be stated plainly wherever the live URL is eventually shared — a paid
upgrade is optional, later, before any high-stakes demo, and is explicitly not part of this
milestone.

---

## 17. Neon configuration

One project, one database, the **direct (unpooled)** connection string with `?sslmode=require`. A
single web instance with one `pg.Pool` does not need PgBouncer, and the direct endpoint keeps
`migrate deploy`'s advisory locks working — pooled (PgBouncer transaction-mode) connections do not
support Postgres advisory locks. If the runtime connection is later moved to Neon's pooled endpoint,
set `MIGRATION_DATABASE_URL` to the direct one; the entrypoint already supports this split (§14).

Neon's own free-tier auto-suspend is absorbed by the entrypoint's migration retry, which is the
container's first database contact — nothing else in the system retries.

---

## 18. Environment variables (deployment-related)

See `.env.example` for the complete, commented list. Deployment-specific additions beyond the
existing `DATABASE_URL` / `PORT` / `AGENT_RUN_PROVIDER_MODE`:

| Variable | Default | Where set |
| --- | --- | --- |
| `HOST` | `127.0.0.1` locally | `Dockerfile ENV` sets `0.0.0.0`; `render.yaml` sets it explicitly too |
| `WEB_DIST_DIR` | resolved from `apps/api/dist/main.js` | rarely needed — only if the monorepo layout changes |
| `RUN_MIGRATIONS_ON_START` | `true` | entrypoint only |
| `MIGRATION_RETRY_ATTEMPTS` | `5` | entrypoint only |
| `MIGRATION_RETRY_DELAY_SECONDS` | `3` | entrypoint only |
| `MIGRATION_DATABASE_URL` | falls back to `DATABASE_URL` | entrypoint only, future pooled-endpoint escape hatch |
| `PRISMA_BIN` | verified installed path | entrypoint only, rarely needed |

---

## 19. Building and running the image locally

```bash
docker build -t opspilot:local .
docker image inspect -f '{{.Size}}' opspilot:local

docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://opspilot:opspilot_local_dev_only@host.docker.internal:55432/opspilot" \
  -e HOST=0.0.0.0 -e PORT=3000 opspilot:local

curl -i localhost:3000/v1/health/live
curl -i localhost:3000/v1/health/ready
curl -i localhost:3000/ | head
curl -i localhost:3000/v1/nope       # JSON envelope, not the app shell
curl -i localhost:3000/missing.js    # 404, not the app shell
```

`host.docker.internal` reaches the local Compose Postgres (§10) from inside the container on macOS
and Windows Docker Desktop; on Linux, use `--network host` or the bridge gateway address instead.

---

## 20. CI `docker-smoke` job

Added to `.github/workflows/ci.yml`, `needs: verify`, `timeout-minutes: 30`, with the same
`postgres:16-alpine` service container as `integration` (§5) — a genuinely empty database on every
run.

1. **Build and inspect, before running anything.** `docker build`, report the image size, then the
   boundary table (§13) and the non-root user check as static assertions against the built image.
2. **Package-resolution checks, from the correct package context** — the same principle as the
   build-time assertion in §13, run again against the exported image via `docker run --workdir
   ... --entrypoint node`.
3. **Run the container** against the empty service-container database, `--network host`, and poll
   `/v1/health/ready` for up to 60 seconds.
4. **Static frontend and `/v1/**` JSON boundary checks** via `curl`.
5. **The full deterministic and approval workflow** — reuses `apps/api/scripts/run-api-demo.ts`
   (`pnpm --filter @opspilot/api run demo`, pointed at the running container with `API_BASE_URL`)
   rather than reimplementing equivalent assertions in YAML: job creation, run execution
   (`COMPLETED`, ordered trace, structured report), the ordinary run's `NOT_ELIGIBLE` approval read,
   and the full `TICKET-APPROVAL-DEMO` flow — `PENDING` → `APPROVE` (`201` + `Location`) → identical
   replay (`200`, no `Location`, unchanged `decidedAt`) → conflicting decision (`409
   AGENT_RUN_APPROVAL_ALREADY_DECIDED`) → final read. Each step already asserts its own invariant and
   exits non-zero on failure — this is the same script used for local manual demos, reviewed
   separately.
6. **Migration-failure verification**, with the real exit code captured explicitly rather than hidden
   behind an unconditional `|| true`: an unreachable database, a small retry budget
   (`MIGRATION_RETRY_ATTEMPTS=2`, `MIGRATION_RETRY_DELAY_SECONDS=1`), then assertions that the exit
   code is non-zero, that exactly the configured number of failed attempts appear in the logs, and
   that the API never logged its "listening" line (i.e. never bound a port).
7. **`RUN_MIGRATIONS_ON_START` verification**, two directions: `false` against the already-migrated
   primary database asserts the container still starts and serves `/v1/health/ready`, with no
   `migrate deploy` invocation logged (proving migrations were genuinely skipped, not just fast because
   there was nothing pending); an invalid value (`ture`) asserts a non-zero exit, the validation error
   message in the logs, and — like the migration-failure case — that the API's "listening" line never
   appears.
8. **Logs and cleanup, unconditionally.** Container logs are printed under `if: always()` so a red run
   is diagnosable from the CI summary page without reproducing it locally, and containers are always
   removed afterward.

---

## 21. Rollback and forward-only migrations

**Rollback** means redeploying the previous successful build in Render — an image rebuild of that
earlier commit. There is no separate rollback mechanism to maintain.

**Migrations are forward-only.** A schema change that needs to be undone requires a **new** forward
migration, never an edit to an already-committed one. Editing a committed migration would desync it
from what Prisma's migration-history table on any already-migrated database recorded as applied.

**A bad migration blocks all deploys, not just schema-related ones** — the entrypoint runs migrations
before the application binds, so any migration failure prevents the container from starting at all.
This is deliberate (§14): the alternative is starting an application against a schema it doesn't
match. The retry budget means a genuine failure surfaces roughly 12 seconds later than a no-retry
design would, which is judged an acceptable cost for absorbing a Neon free-tier cold start.

---

## 22. Security and public-demo limitations

**In scope** — the minimum a public demo needs:

- Single origin; no CORS enabled anywhere.
- FAKE provider only, enforced at dependency-injection time (§7) — no provider key exists in the
  image or in Render, and no outbound model call is possible.
- Existing protections carry over unchanged: the 32 KB JSON body cap, Zod validation at every
  boundary, and the fixed-vocabulary error catalog that never leaks connection strings, stack traces,
  or raw provider payloads.
- Non-root container user; `DATABASE_URL` is the only secret; no `.env` ships in the image.
- The CI bundle guard (§9) asserts no secret or absolute API origin reaches the browser.

**Explicitly deferred**, and to be labelled as such wherever the live URL is eventually shared, so the
demo is never mistaken for a production system: no authentication, no rate limiting, no abuse
protection, no per-IP quotas, no WAF, no observability stack, no backup or retention policy. Any
visitor can create investigations; all data is demo data with no privacy expectation. The deployment
stays explicitly demo-oriented until authentication and abuse controls exist.

---

## 23. What the public demo does — and does not — do

The repository contains real retrieval-augmented-generation work: a provider-neutral
`RunbookRetriever`, deterministic in-memory retrieval, application-assigned evidence IDs,
evidence-grounding validation, prompt-injection test scenarios, and file-backed runbooks with
deterministic ordering. That work is real and is fairly described as repository/offline-evaluation
work.

**The first deployed browser flow does not exercise any of it.** `apps/api` wires
`InMemoryToolRegistry([getServiceStatusTool])` and no retriever at all — runbook loading exists only
in `apps/worker`, which is not deployed (§12), and `runbooks/` is excluded from the runtime image
entirely (§13). The deployed FAKE-provider path performs **zero** runbook retrieval.

Any description of this system — this document, the README, an architecture diagram, or a résumé
bullet — must keep that distinction explicit: retrieval is implemented and evaluated **offline**; the
**public demo** runs the deterministic provider path only. Production/deployed RAG, real embeddings,
and a real provider are later, unstarted milestones.

---

## 24. Deployment known limitations

In addition to §11 (CI-specific):

- **No live deployment exists yet.** Everything in §12–§23 describes configuration proven by
  `docker-smoke` (§20) and local manual verification, not an observed production system. See the
  scope note at the top of this document for the Feature Complete / Portfolio Ready distinction.
- **Render Free cold start** (§16) and **Neon free-tier auto-suspend** (§17) are both accepted for
  this milestone, not engineered away; a paid upgrade is optional and out of scope here.
- **`prisma` now ships in `packages/database`'s production `dependencies`**, not `devDependencies`,
  because the self-contained migration strategy (§14) requires the CLI at runtime. This grows the
  image; §13 reports the measured size for exactly this reason, so the cost is visible rather than
  assumed.
- **A bad migration blocks every deploy** (§21) — accepted as the safer default over starting an
  application against a schema it does not match.
