# OpsPilot — CI/CD and Deployment

| Field | Value |
| --- | --- |
| Status | **CI implemented (PR 5A). Deployment not implemented.** |
| Workflow | `.github/workflows/ci.yml` |
| Node | `22.21.0`, pinned in `.nvmrc` |
| pnpm | `11.13.1`, pinned in the root `package.json` `packageManager` field |

> **Scope note.** This document currently describes continuous integration only. There is no
> Dockerfile, no container image, no Render or Neon configuration, no static React serving from
> NestJS, and no health or readiness endpoint in the repository today. Those are planned for PR 5B
> and will be documented here when they exist — not before. Nothing in this file should be read as
> describing a deployed system.

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
`AGENT_RUN_PROVIDER_MODE=FAKE` is the only mode `apps/api` supports; see §7.

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
   (`apps/worker`'s `spike:claude` and `spike:rag`) are separate scripts that are never invoked by
   `pnpm test` or by any CI step, and they fail fast on a missing key.

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
- **No deployment of any kind** (see the scope note).
