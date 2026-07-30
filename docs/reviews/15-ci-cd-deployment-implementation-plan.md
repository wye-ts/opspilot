# OpsPilot — CI/CD + Deterministic Deployment Implementation Plan (PR 5A / PR 5B)

| Field | Value |
| --- | --- |
| Milestone | Milestone 7 — Evaluation + CI/CD + Deployment (evaluation portion already complete) |
| Status | Plan only — nothing in this document is implemented yet |
| Scope | PR 5A (GitHub Actions CI), PR 5B (production container + deployment configuration), PR 5C (post-deploy documentation of the live deployment) |
| Baseline | `feat/ci-deployment` at `0e29df9`, identical to `main` (PR 4B merged, working tree clean) |
| Provider mode | `FAKE` only — no paid API calls in CI, in the container, or in the first deployment |

> This is a review artifact under `docs/reviews/**`. It is not intended for the final implementation
> commit. Nothing described here may be documented elsewhere as though it already exists until the
> corresponding PR lands.

---

## 0. Why this milestone exists

OpsPilot is feature-complete for the deterministic FAKE-provider workflow — agent runtime, minimal
RAG, file-backed runbooks, deterministic evaluation, Prisma/PostgreSQL persistence, the synchronous
NestJS Agent Run API, the React investigation timeline, and the browser approval workflow are all
implemented, reviewed, and merged.

What the project has never had is **any** automation. `.github/workflows/` is an empty, untracked
directory and `docs/08-cicd-deployment.md` is a 0-byte placeholder. Every quality claim to date rests
on commands run by hand on one laptop, and nobody can see the product without cloning the repo and
starting Docker, PostgreSQL, the API, and Vite separately.

This milestone closes both gaps:

- **PR 5A** makes every pull request prove itself in GitHub Actions.
- **PR 5B** ships everything needed to serve one public origin (`/` → React, `/v1/**` → NestJS) on
  Render + Neon with the deterministic FAKE provider — so the full path `Browser → API → agent
  runtime → PostgreSQL → timeline/report → approval` can be demonstrated **without** mixing
  deployment failures with LLM nondeterminism, provider rate limits, or API cost.
- **PR 5C** records what the live deployment actually did — the real URL, verified walkthrough
  results, and screenshots — none of which can be known before the service exists.

### Feature Complete vs Portfolio Ready

```text
PR 5B merged != Portfolio Ready
```

Merging PR 5B ships the *configuration* for a deployment. It does not prove one happened. **Portfolio
Ready** requires all five of:

1. a successful Render deployment of the merged image;
2. successful Neon persistence (migrations applied, runs and approvals durably stored);
3. completed deterministic **and** approval browser walkthroughs against the live URL;
4. the actual public URL documented in the repository;
5. the free-tier cold-start limitation documented plainly.

Until every one of those is true, the project stays *Feature Complete*. This document does not blur
the two labels, and neither should the README.

### Decisions resolved with the project owner

| # | Decision | Resolution |
| --- | --- | --- |
| 1 | Migration strategy | Migrations run from the container entrypoint. Accepted for the free-tier, single-instance demo, and it is what makes a deploy self-contained. |
| 2 | Image build | Render builds the committed Dockerfile itself — no container registry, no push credentials. |
| 3 | Lint/format tooling | Explicitly deferred; strict `tsc` is this milestone's quality gate. |
| 4 | Render Free cold start | **Accepted** for the initial portfolio deployment (~15 min idle spin-down, ~50s cold start). It must be documented plainly rather than hidden. A paid upgrade is optional later, before high-stakes sharing, and is **not** part of this milestone. |
| 5 | Database retry | **Retry the first database contact in the entrypoint**, around `prisma migrate deploy`. `PrismaLifecycleService` stays fail-fast and unchanged — there must not be a second retry policy in the application. See §4.3. |
| 6 | `prisma` CLI in production dependencies | **Accepted** as the cost of the self-contained migration strategy. The final image size must be measured and reported in the PR 5B verification summary; revisit only if the cost turns out to be unreasonable. |

---

## 1. Current repository findings

Every item below was verified by direct inspection of the repository at `0e29df9`. Items marked
**blocker** must change before a container can work at all.

### 1.1 Workspace, scripts, and package relationships

- pnpm workspace (`apps/*`, `packages/*`), six packages, all `private`, all `0.1.0`. No turbo, no nx,
  no lerna. `packageManager: pnpm@11.13.1`, `engines.node: >=22.21.0`.
- **There is no `.nvmrc`, `.node-version`, `.tool-versions`, or `volta` field anywhere.** CI must
  introduce an exact Node pin; today only a floor exists.
- `pnpm-workspace.yaml` declares `allowBuilds`: `prisma`, `@prisma/engines`, `esbuild` → `true`;
  `@nestjs/core` → `false`. **CI and Docker must never pass `--ignore-scripts`**, or the Prisma
  install steps are skipped.
- Dependency/build order:

  ```text
  contracts → database → agent-runtime → api
  contracts → web
  (worker: no build script at all)
  ```

- Every package script chains `build:deps`
  (`pnpm --filter "<pkg>^..." -r --workspace-concurrency=1 run build`), and every root aggregate
  (`build`, `typecheck`, `test`, `clean`) pins `--workspace-concurrency=1`. **Builds are already
  fully serialized** — this is what makes a parallel `prisma generate` race structurally impossible,
  and it is the reason the CI design needs no extra locking.
- Root scripts relevant to CI, verbatim:

  ```json
  "build":     "pnpm -r --workspace-concurrency=1 --if-present run build",
  "typecheck": "pnpm -r --workspace-concurrency=1 --if-present run typecheck",
  "test":      "pnpm -r --workspace-concurrency=1 --if-present run test",
  "lint":      "pnpm -r --if-present run lint",
  "test:integration:sequential":
      "pnpm --filter @opspilot/database run test:integration && pnpm --filter @opspilot/api run test:integration"
  ```

- **`apps/worker` has no `build` script** (`typecheck` is `tsc --noEmit`; every entry point runs from
  source through `tsx`). It cannot be shipped as a compiled image today, and nothing requires it to
  be.
- **There is no `start:prod` script** for any package, contrary to `docs/03-technical-design.md`
  §25.1. The production entry point today is `node dist/main.js`, wrapped by
  `scripts/run-with-root-env.mjs`.
- `apps/api` builds with plain `tsc -p tsconfig.build.json` → `apps/api/dist/main.js`, **CommonJS**,
  `node_modules` external, no bundler. `@nestjs/cli` and `nest-cli.json` were deliberately removed —
  see `docs/10-engineering-challenges.md` Challenge 4: `typescript@7.0.2` is the native rewrite and
  no longer exposes the classic Compiler API through `require("typescript")`. **Any tool that
  consumes the TypeScript Compiler API will fail in this repository.**
- `apps/web` builds with Vite 8 to `apps/web/dist`. No `base` override (assets emit as `/assets/…`,
  root-absolute), no `public/` directory, **no `VITE_*` environment variables at all**, no router,
  exactly one route (`/`). The bundle already issues only relative `/v1/...` requests — so
  single-origin serving requires **zero frontend changes**.

### 1.2 Existing infrastructure and configuration

- `docker-compose.yml` — local development only: `postgres:16-alpine`, host port **55432** → 5432,
  credentials `opspilot` / `opspilot_local_dev_only`, healthcheck `pg_isready`, init directory
  mounted from `docker/postgres-init/`. No pgvector (RAG is in-memory today).
- `docker/postgres-init/001-create-test-db.sql` creates `opspilot_test` and `opspilot_shadow`, but
  **only on a brand-new volume**.
- `scripts/ensure-test-database.sh` is the authoritative, idempotent creator — and it shells in via
  `docker compose exec`, exiting 1 if the Compose service is not running.
- `scripts/run-with-root-env.mjs` loads a repo-root `.env` if present (silently skipping when
  absent), spawns the child with inherited stdio, and forwards `SIGINT`/`SIGTERM`.
- `scripts/with-test-database-url.mjs` remaps `TEST_DATABASE_URL` → `DATABASE_URL` for the child, and
  hard-exits 1 when `TEST_DATABASE_URL` is unset.
- `.env.example` documents exactly five variables: `DATABASE_URL`, `TEST_DATABASE_URL`,
  `SHADOW_DATABASE_URL`, `PORT`, `AGENT_RUN_PROVIDER_MODE`.

### 1.3 Prisma

- Prisma 7.9.0. Generator block:

  ```prisma
  generator client {
    provider     = "prisma-client"
    output       = "../src/generated/prisma-client"
    moduleFormat = "cjs"
  }
  datasource db {
    provider = "postgresql"
  }
  ```

- The datasource has **no `url`** — it comes from `prisma.config.ts`
  (`process.env.DATABASE_URL ?? ""`), which is precisely why `prisma generate` succeeds with no
  `.env` and no running database.
- The generated client lands in `packages/database/src/generated/prisma-client/` and is
  **gitignored**. It is pure TypeScript — **zero engine binaries**. `tsc` compiles it into
  `packages/database/dist/generated/prisma-client/**`, so the built `dist` is self-contained JS.
- Runtime needs `@prisma/client` present in `node_modules` (its runtime plus a base64-embedded WASM
  query compiler), but there is **no native query-engine binary to copy** into an image.
- Connections use `@prisma/adapter-pg` over an application-owned `pg.Pool`. `createPrismaClient()` is
  called exactly once in production, at `apps/api/src/main.ts:22`.
- Two migrations exist (`20260723010949_init`, `20260724183209_add_agent_run_approvals`), plus
  `migration_lock.toml`. All 12 `CHECK` constraints are hand-authored SQL that Prisma's DSL cannot
  express — which is what makes the drift check in §3 genuinely worth running.
- `PrismaLifecycleService.onModuleInit` runs a real `SELECT 1`. **The API refuses to boot against an
  unreachable database.**

### 1.4 API bootstrap and runtime configuration

- **blocker** — `HOST` is hardcoded `"127.0.0.1"` (`apps/api/src/main.ts:16`, applied at `:54`), with
  no environment override. A container built from the current source is unreachable from outside
  itself.
- `PORT` is read but unvalidated: `process.env.PORT ? Number(process.env.PORT) : 3000` — `PORT=abc`
  silently yields `NaN`.
- `app.setGlobalPrefix("v1")` (`:43`); controllers use bare paths. `NotFoundController`'s
  `@All("*splat")` therefore only ever matches `/v1/**` — **it can never intercept `/`**.
- Middleware order is exactly: `requestIdMiddleware` → `jsonBodyParser` (32 KB) →
  `jsonParserErrorHandler` → Nest routes.
- **blocker** — no static middleware, no `useStaticAssets`, and `@nestjs/serve-static` is not
  installed. However the app is already created as a `NestExpressApplication`, so `useStaticAssets`
  is available with **no new dependency**.
- **blocker** — there is no health, liveness, or readiness endpoint. Nothing exists for a Render
  health check, a Docker `HEALTHCHECK`, or a probe to hit.
- `enableShutdownHooks(["SIGINT","SIGTERM"])` is present and closes the `pg.Pool` through the
  once-guarded `safeClose`.
- **No CORS anywhere**, and the single-origin design means none is needed.
- The API reads exactly three environment variables: `PORT`, `AGENT_RUN_PROVIDER_MODE`,
  `DATABASE_URL`. `AGENT_RUN_PROVIDER_MODE` defaults to `FAKE`; anything else throws
  `LiveProviderModeNotSupportedError` at DI time, before any network access is possible.
- Controllers return `{ data: … }` object literals; there is **no response-wrapping interceptor**, so
  any new endpoint must construct that envelope itself.

### 1.5 Runbooks and RAG — the finding that most simplifies PR 5B

- `apps/api`'s tool registry is `new InMemoryToolRegistry([getServiceStatusTool])`
  (`apps/api/src/execution/agent-runtime.module.ts:25`). **No retriever is wired into the API at
  all**; grepping `apps/api/src` for "runbook" returns nothing.
- Runbook loading exists only in `apps/worker`, and resolves relative to `import.meta.url` with four
  `..` hops:

  ```ts
  // apps/worker/src/rag/load-default-runbook-corpus.ts:7-10
  export function resolveDefaultRunbooksDir(): string {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, "../../../../runbooks");
  }
  ```

  Not cwd-relative, not environment-configurable. It only works because the worker runs from
  TypeScript source under `tsx`.
- Nothing is precomputed on disk: the corpus is parsed at runtime, and both retrievers
  (`InMemoryKeywordRunbookRetriever`, `VoyageRunbookRetriever`) live in `apps/worker`.

**Consequences:** the production image must **not** ship `runbooks/`, needs **no** `ANTHROPIC_API_KEY`
or `VOYAGE_API_KEY`, and makes **zero** outbound model calls. If the worker is ever containerized,
that `import.meta.url`-relative path will break silently — record it as a known trap; do not change
it in this milestone.

### 1.6 Tests and database test setup

- Vitest 4 everywhere; 60 test files. There is no `projects`/workspace file — unit and integration
  are separated by filename convention plus a second config per package.
- Unit configs exclude `**/*.integration.test.ts` (and `test/**` for the API). Unit tests need no
  database, no `.env`, and no Docker.
- **Both integration suites share one physical test database** and `TRUNCATE` in `afterEach`, with
  `fileParallelism: false` and 30-second timeouts. `pnpm test:integration:sequential` exists
  precisely so they never overlap. **CI must use it; it must never run the two suites concurrently.**
- `TEST_DATABASE_URL` reaches vitest through `scripts/with-test-database-url.mjs`.
  `scripts/run-with-root-env.mjs` silently skips a missing `.env`, so real CI and container
  environment variables pass straight through — **no `.env` file is needed in CI or in the image**.
- **`pnpm db:test:ensure` cannot be used in CI.** `scripts/ensure-test-database.sh` requires a
  running Docker Compose service and will not work against a GitHub Actions `services:` container.
  CI creates the databases inline with `psql` instead. **Leave the script unchanged — it is correct
  for local development.**

### 1.7 Missing CI/deployment capabilities

| Capability | State today |
| --- | --- |
| GitHub Actions workflows | `.github/workflows/` exists, is empty, and is untracked — zero files under `.github/` in git |
| Dockerfile / `.dockerignore` | Do not exist anywhere |
| Node version pin | Does not exist (`engines` floor only) |
| Health / readiness endpoint | Does not exist |
| Static asset serving | Does not exist |
| `start:prod` script | Does not exist |
| Lint / format tooling | Does not exist — no ESLint, Prettier, or Biome config or dependency; the root `lint` script is a **no-op** because no package defines one |
| Deployment documentation | `docs/08-cicd-deployment.md` is 0 bytes; the only recorded design lives in `docs/03-technical-design.md` §23–§25 and is now partly stale (it assumes Vercel + `start:prod` + `VITE_API_BASE_URL`, none of which match the shipped code) |

### 1.8 Constraints discovered from the code

1. TypeScript 7's native rewrite removes the Compiler API — no Compiler-API-consuming tool can be
   added (Challenge 4). This is the technical reason lint tooling is deferred, not merely a scoping
   preference.
2. The Prisma client is gitignored and generated — `prisma generate` is mandatory before any
   typecheck, build, or test of `packages/database` or anything downstream.
3. Recursive scripts are serialized by design (`--workspace-concurrency=1`); introducing
   `pnpm -r --parallel` would create a real `prisma generate` race.
4. The two integration suites share one database and must stay sequential.
5. `apps/worker` pulls `@anthropic-ai/sdk` and `voyageai`; a naive workspace-wide production install
   would drag both into the image.
6. The API's `SELECT 1` at boot means container start ordering and database wake-up latency matter.

---

## 2. Deployment architecture

**One Render Web Service, one Neon PostgreSQL database, one public origin.**

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

### 2.1 One service, not two

Repository inspection found **no blocker** to the preferred single-service design:

- the app is already a `NestExpressApplication`, so `useStaticAssets` needs no new dependency;
- the frontend already emits only relative `/v1/...` paths and has no API-base environment variable;
- Vite emits root-absolute asset URLs (`/assets/…`), which is exactly what a mount at `/` wants;
- the `/v1` global prefix guarantees the SPA mount at `/` cannot collide with any API route.

A separate static host plus an API service would create a second origin and force CORS — explicitly
rejected. `useStaticAssets` is preferred over `@nestjs/serve-static` because it adds no dependency
and gives explicit control over ordering relative to the existing middleware chain.

**No CORS is enabled. One origin means one origin.**

### 2.2 Middleware order in `main.ts`

```text
1. requestIdMiddleware              (unchanged)
2. useStaticAssets(webDistDir)      NEW — real files win; falls through when no file matches
3. spaFallbackMiddleware            NEW — guarded, see 2.3
4. jsonBodyParser (32 KB)           (unchanged)
5. jsonParserErrorHandler           (unchanged)
6. Nest routes (/v1/**)             (unchanged)
```

Static handling sits **before** the JSON parser so asset requests never enter body parsing, and
**before** Nest so they never touch the `LoggingInterceptor` or the DI container.

### 2.3 SPA fallback — three guards, all required

```ts
if (req.method !== "GET" && req.method !== "HEAD") return next();
if (req.path === "/v1" || req.path.startsWith("/v1/")) return next();  // never shadow the API
if (path.extname(req.path) !== "") return next();                      // missing assets 404, not HTML
res.setHeader("Cache-Control", "no-cache");
res.sendFile(indexPath, (err) => err && next(err));
```

The `/v1` guard is what makes it structurally impossible for the fallback to intercept the API. The
extension guard is equally load-bearing but less obvious: browsers send `Accept: */*` for scripts,
and `*/*` satisfies `req.accepts("html")` — so an `Accept`-only check would cheerfully return
`index.html` for a missing `.js` file, converting a deploy error into a blank page with a
MIME-type console error. **Only extensionless paths get the fallback.**

The application has exactly one route today, so the fallback is not required for current
functionality. It exists so that a deep link or a refresh cannot 404 if routing is added later, and
it is tested as a boundary against `/v1/**` regardless.

### 2.4 Asset caching and web-dist resolution

- `/assets/*` filenames are content-hashed by Vite → `Cache-Control: public, max-age=31536000,
  immutable`.
- `index.html` → `Cache-Control: no-cache`.
- Web dist path: `WEB_DIST_DIR` environment variable, defaulting to
  `path.resolve(__dirname, "../../web/dist")`. From `apps/api/dist/main.js` this resolves to
  `apps/web/dist` in both the repository and an image that preserves the monorepo layout (which the
  Dockerfile in §4 does).
- If `index.html` is not present at that path, **static serving and the fallback are both skipped**
  and the API behaves exactly as it does today. Local `pnpm api:start` alongside `vite dev` is
  therefore completely unaffected.

### 2.5 What is not deployed

`apps/worker` is **not** deployed: it has no build script, it is not imported by the API, and its
runbook path resolution depends on the source layout. No queue, no second service, no CDN, no
reverse proxy, no pgvector.

---

## 3. PR 5A — GitHub Actions CI

New files: `.nvmrc` (containing `22.21.0`) and `.github/workflows/ci.yml`. **No application code
changes** — PR 5A must be green against `main` exactly as it exists today.

### 3.1 Triggers and concurrency

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

Superseded pull-request pushes are cancelled; `main` runs always finish. `permissions: contents: read`
is set at the workflow level so the default token cannot write to the repository — nothing in this
workflow publishes, comments, or pushes.

Every job carries an explicit `timeout-minutes` so a hung test, a stuck database command, or a
runaway image build cannot occupy a runner indefinitely: `verify` 20, `integration` 25,
`docker-smoke` 30 (added in PR 5B). These are generous against today's serialized workload and should
be tightened once real run times are known.

### 3.2 Deterministic environment

Workflow-level `env`: `TZ: UTC`, `CI: true`, `AGENT_RUN_PROVIDER_MODE: FAKE`.

**No secrets are referenced anywhere in the workflow** — no `ANTHROPIC_API_KEY`, no `VOYAGE_API_KEY`,
nothing. CI cannot make a paid provider call, both because no key exists in the environment and
because the API's provider factory throws on any value other than `FAKE`.

### 3.3 Job graph

```text
  verify        (ubuntu-latest, no database)      ─┐  run in parallel,
  integration   (ubuntu-latest, postgres service) ─┘  no dependency between them
```

Common setup — the standard `pnpm/action-setup` → `setup-node` sequence, in this exact order:

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

`pnpm/action-setup` runs **before** `setup-node` deliberately. A Corepack-based sequence would either
activate pnpm using the runner's preinstalled Node rather than the repository-pinned one, or leave
pnpm off `PATH` when `setup-node` tries to resolve its `cache: pnpm` key. Installing pnpm standalone
first makes the cache key resolvable and keeps the pnpm version independent of whichever Node the
runner image happens to ship.

Both pins stay exact: pnpm `11.13.1` (matching the root `packageManager` field) and Node from
`.nvmrc`. `cache-dependency-path: pnpm-lock.yaml` makes the store cache key depend on the one file
that actually determines the dependency set.

### 3.4 `verify` job — exact commands

```bash
pnpm db:generate     # once, up front, serialized
pnpm typecheck       # pnpm -r --workspace-concurrency=1 --if-present run typecheck
pnpm test            # unit only — integration files are excluded by config
pnpm build           # contracts → database → agent-runtime → api → web
pnpm --filter @opspilot/web run check:bundle   # production bundle guard, see below
```

Finally, upload `apps/web/dist` as an artifact with 7-day retention so a reviewer can inspect the
exact bundle a run produced.

### 3.4.1 Production bundle guard

This automates the invariants the PR 4B review previously asserted by hand: no dev origin, no backend
secret name, no Prisma runtime, and no test assets in the shipped bundle.

**It deliberately does not ban URLs.** A blanket `http://`/`https://` rule fails on harmless
dependency strings — license headers, `https://react.dev` warning links, source-map comments, schema
URLs — and a guard that cries wolf gets disabled. The rules target *actual deployment leaks* only:

| Rule | Pattern (illustrative) | Why it is forbidden |
| --- | --- | --- |
| `dev-host-localhost` | `/\blocalhost\b/` | A dev origin reached the bundle |
| `dev-host-loopback` | `/\b127\.0\.0\.1\b/` | Same, by IP |
| `absolute-api-origin` | `/https?:\/\/[^\s"']*\/v1(?:[\/"']\|$)/` | An absolute API base replaced the relative `/v1/...` contract |
| `backend-env-name` | `/\bDATABASE_URL\b/` | A backend environment variable name reached the browser |
| `prisma-runtime` | `/\bPrismaClient\b/` | Backend persistence runtime leaked into the browser |
| `test-assets` | `/__tests__\|\.test\.[jt]sx?\b\|\/src\/test\//` | Test-only code was bundled |

**Implementation — readable, testable, false-positive resistant:**

- `apps/web/src/build-guard/forbidden-patterns.ts` *(new)* — a pure, exported
  `findBundleViolations(fileName, contents): Violation[]` holding the rule table above. Each
  violation carries the rule name, the file, and a short surrounding excerpt so a failure is
  self-explaining.
- `apps/web/src/build-guard/forbidden-patterns.test.ts` *(new)* — proves each rule fires **and**,
  just as importantly, that benign content does not: a license header URL, `https://react.dev/...`,
  a docs link in a dependency comment, `latest` inside an unrelated identifier, and the literal word
  `test` inside a legitimate name must all pass cleanly. These negative cases are the point of the
  test file.
- `apps/web/scripts/check-bundle.ts` *(new)* — walks `dist/**/*.{js,css,html}`, applies the function,
  prints every violation, exits 1 on any. Run through `tsx` (already a root devDependency).
- `apps/web/package.json` gains `"check:bundle": "tsx scripts/check-bundle.ts"`;
  `apps/web/tsconfig.json`'s `include` gains `scripts/**/*.ts` so the script is typechecked like
  everything else.

Keeping the rules in a tested pure function rather than a pile of shell `grep`s is what makes the
guard maintainable: adding or relaxing a rule is a code change with a test beside it, not an
inscrutable one-liner in YAML.

### 3.5 Prisma generation without races

`pnpm db:generate` runs **once**, explicitly, before anything else. Beyond that no additional guard
is needed: every recursive root script already pins `--workspace-concurrency=1`, and each package's
own script chains `db:generate` serially ahead of its own work.

**The rule to record and enforce: never introduce `pnpm -r --parallel` in CI.** That is the only way
two `prisma generate` processes could write `packages/database/src/generated/` simultaneously.

### 3.6 `integration` job — service container and exact commands

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_USER: opspilot
      POSTGRES_PASSWORD: opspilot_ci_only
      POSTGRES_DB: opspilot
    ports: ["5432:5432"]
    options: >-
      --health-cmd "pg_isready -U opspilot -d opspilot"
      --health-interval 5s --health-timeout 3s --health-retries 10

env:
  DATABASE_URL:        postgres://opspilot:opspilot_ci_only@localhost:5432/opspilot
  TEST_DATABASE_URL:   postgres://opspilot:opspilot_ci_only@localhost:5432/opspilot_test
  SHADOW_DATABASE_URL: postgres://opspilot:opspilot_ci_only@localhost:5432/opspilot_shadow
```

**Creating the test and shadow databases without assuming a host `psql`.** `pnpm db:test:ensure` is
Docker-Compose-coupled and unusable here, but the replacement must not assume the runner image ships
a PostgreSQL client either — that is an undocumented property of `ubuntu-latest` that can change
without notice. The simplest deterministic answer is to use the client that is *guaranteed* to exist:
the one inside the service container we already pinned.

```yaml
- name: Create the test and shadow databases
  run: |
    docker exec "${{ job.services.postgres.id }}" \
      psql -U opspilot -d opspilot \
        -c 'CREATE DATABASE opspilot_test OWNER opspilot;' \
        -c 'CREATE DATABASE opspilot_shadow OWNER opspilot;'
```

No client installation, no apt round-trip, no version drift: the `psql` used is the one shipped in
`postgres:16-alpine`, matching the server exactly. No `PGPASSWORD` is needed because the connection
goes over the container's local socket, which the official image trusts. GitHub exposes the service
container's id as `job.services.<id>.id`, and the job's own health check has already gated the step,
so the server is accepting connections by the time it runs.

*(Fallback, if a future runner or a self-hosted environment makes `docker exec` unavailable: add an
explicit `sudo apt-get update && sudo apt-get install -y postgresql-client` step. It is a network
dependency and a possible client/server version skew, which is why it is the fallback and not the
default.)*

The remaining commands:

```bash
pnpm db:generate
pnpm db:migrate:test              # migrate deploy against TEST_DATABASE_URL
pnpm test:integration:sequential  # database suite, then api suite — never concurrent
pnpm db:migrate:deploy            # apply to DATABASE_URL so the drift check has a target
pnpm db:migrate:drift             # migrate diff --exit-code; non-zero on schema drift
```

The drift check earns its place: it catches a hand-edited migration or a `schema.prisma` change
without a corresponding migration — a real risk in this repository, where all 12 `CHECK` constraints
live in hand-authored migration SQL that Prisma's DSL cannot express.

### 3.7 Formatting and linting

None. The root `lint` script is a no-op because no package defines a `lint` script, so
`docs/03-technical-design.md` §23.2's "validate formatting" and "run lint" steps have nothing to
invoke.

Per the confirmed decision, strict `tsc` (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`) is this milestone's quality gate, and lint tooling is deferred. The
reason is technical as well as scoping: `typescript@7.0.2`'s native rewrite no longer exposes the
Compiler API that `typescript-eslint` requires (Challenge 4), so adopting it would likely expand this
milestone into a tooling investigation.

---

## 4. PR 5B — Production container and deployment

### 4.1 Application changes

These land **with** the container, not before — they are only meaningful together.

| File | Change |
| --- | --- |
| `apps/api/src/main.ts` | Read `HOST` from the environment, defaulting to `"127.0.0.1"` so local behaviour is byte-identical. Validate `PORT` and **fail startup** on a non-integer or out-of-range value rather than silently binding 3000. Conditionally register `useStaticAssets` + the SPA fallback. |
| `apps/api/src/common/web-assets.ts` *(new)* | `resolveWebDistDir()` = `process.env.WEB_DIST_DIR ?? path.resolve(__dirname, "../../web/dist")`, plus an `index.html` existence check that decides whether static serving is enabled at all. |
| `apps/api/src/common/spa-fallback.middleware.ts` *(new)* | `createSpaFallbackMiddleware(webDistDir)` implementing the three guards from §2.3. |
| `apps/api/src/health/health.module.ts`, `health.controller.ts` *(new)* | `GET /v1/health/live` → `{ data: { status: "ok" } }`, never touches the database. `GET /v1/health/ready` → `SELECT 1`; 200 `{ data: { status: "ready" } }`, or **503** with the standard error envelope. |
| `apps/api/src/app.module.ts` | Import `HealthModule` in `forRoot()`'s array, **before `NotFoundModule`** — the catch-all is order-sensitive. |
| `apps/api/src/errors/api-error-catalog.ts` | Add the 503 code the readiness failure maps to, following the existing catalog pattern and its fixed-message discipline. |
| `packages/database/package.json` | Move `prisma@7.9.0` from `devDependencies` to `dependencies` so the CLI survives a `--prod` install. `pnpm-lock.yaml` updates accordingly. |
| `.env.example` | Document `HOST`, `WEB_DIST_DIR`, `RUN_MIGRATIONS_ON_START`, `MIGRATION_RETRY_ATTEMPTS`, `MIGRATION_RETRY_DELAY_SECONDS`, `MIGRATION_DATABASE_URL`. |

**`apps/api/src/persistence/prisma-lifecycle.service.ts` is deliberately not modified.** An earlier
draft of this plan put a bounded startup retry there. That was wrong: the entrypoint runs
`prisma migrate deploy` *before* NestJS starts, so the migration — not `onModuleInit`'s `SELECT 1` —
is the first database contact. A retry in the lifecycle service would sit behind a container that had
already exited. The retry belongs in the entrypoint (§4.3), and there must be exactly one retry
policy in the system: `PrismaLifecycleService` stays fail-fast and untouched. By the time Nest boots,
the entrypoint's successful migration has already proven the database is awake and reachable, so a
second retry layer would add latency and a second failure mode for no benefit.

Health endpoints live **under `/v1`** deliberately: it matches `docs/03-technical-design.md` §25.1's
`/v1/health/ready` and keeps the single-origin contract to exactly one API prefix.

### 4.2 Multi-stage Dockerfile

```dockerfile
FROM node:22.21.0-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---- dependencies: manifests + lockfile only, for maximal layer caching ----
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json               apps/api/
COPY apps/web/package.json               apps/web/
COPY apps/worker/package.json            apps/worker/
COPY packages/contracts/package.json     packages/contracts/
COPY packages/database/package.json      packages/database/
COPY packages/agent-runtime/package.json packages/agent-runtime/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm db:generate \
 && pnpm --filter @opspilot/api run build \
 && pnpm --filter @opspilot/web run build

# ---- production dependencies only ----
FROM base AS prod-deps
COPY (the same manifest set as the deps stage)
RUN pnpm install --frozen-lockfile --prod --filter "@opspilot/api..."

# ---- runtime ----
FROM node:22.21.0-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 AGENT_RUN_PROVIDER_MODE=FAKE
WORKDIR /app
COPY --from=prod-deps /app /app
COPY --from=build /app/apps/api/dist               apps/api/dist
COPY --from=build /app/apps/web/dist               apps/web/dist
COPY --from=build /app/packages/contracts/dist     packages/contracts/dist
COPY --from=build /app/packages/database/dist      packages/database/dist
COPY --from=build /app/packages/agent-runtime/dist packages/agent-runtime/dist
COPY packages/database/prisma            packages/database/prisma
COPY packages/database/prisma.config.ts  packages/database/prisma.config.ts
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/opspilot-entrypoint

# Build-time assertions: fail the build now, not at container start.
# The Prisma CLI path in particular must be VERIFIED, never assumed.
RUN test -x /app/packages/database/node_modules/.bin/prisma \
 && test -f /app/apps/api/dist/main.js \
 && test -f /app/apps/web/dist/index.html \
 && node -e "require.resolve('@opspilot/database'); require.resolve('@prisma/client')"

USER node
EXPOSE 3000
ENTRYPOINT ["opspilot-entrypoint"]
```

Points that are not incidental:

- **`--filter "@opspilot/api..."` on the production install** is what keeps `@anthropic-ai/sdk` and
  `voyageai` — worker-only dependencies — out of the production image entirely.
- **`COPY --from=prod-deps /app /app` copies the whole tree in one layer** so pnpm's relative
  symlinks into `node_modules/.pnpm/` stay intact. Do not cherry-pick `node_modules` subdirectories.
- **The worker boundary, stated precisely.** The prod-deps stage copies *all* workspace manifests —
  including `apps/worker/package.json` — because `--frozen-lockfile` requires an importer entry for
  every package in the lockfile, and that whole tree is then copied into the runtime image. So the
  image *does* contain an inert `apps/worker/package.json`. Claiming "no `apps/worker/` in the image"
  would be internally inconsistent with the Dockerfile above. The boundary that actually matters, and
  the one the smoke test enforces, is:

  | Must not be in the runtime image | Status |
  | --- | --- |
  | Worker **source** (`apps/worker/src`) | excluded via `.dockerignore` |
  | Worker **build output** | none exists — the worker has no build script |
  | A worker **process** | nothing starts it; the entrypoint execs the API only |
  | `@anthropic-ai/sdk` | excluded by `--filter "@opspilot/api..."` |
  | `voyageai` | excluded by `--filter "@opspilot/api..."` |
  | `runbooks/` | excluded — §1.5 proved the deployed API never reads them. Revisit only if a deployed runtime dependency is later proven |
  | `apps/worker/package.json` | **may remain** — an inert manifest required by the frozen-lockfile workspace install |

  No pruning complexity is added merely to delete an inert manifest; it costs a few hundred bytes and
  removing it would risk the lockfile invariant that keeps the install reproducible.
- **No engine binary to copy.** Prisma 7's driver-adapter model means `@prisma/client`'s WASM query
  compiler arrives through the normal dependency install.
- **The monorepo layout is preserved**, which is exactly what makes the default `WEB_DIST_DIR`
  (`apps/api/dist/../../web/dist`) resolve correctly with no configuration.
- **`node dist/main.js` runs directly** — `scripts/run-with-root-env.mjs` is bypassed. There is no
  `.env` in the image; real environment variables are the only source. Node is PID 1, so Render's
  `SIGTERM` reaches `enableShutdownHooks` and the `pg.Pool` closes cleanly.

`.dockerignore`: `node_modules`, `**/node_modules`, `**/dist`, `.git`, `.github`, `.env`, `.env.*`,
`packages/database/src/generated`, `apps/worker/src`, `docs`, `evals`, `coverage`, `.claude`,
`.plans`. **Worker manifests must remain** — the lockfile has an importer entry for them and
`--frozen-lockfile` would otherwise fail.

### 4.3 Entrypoint, migrations, and startup

**The first database contact in the container is `prisma migrate deploy`, not the application.** A
Neon free-tier database that has auto-suspended needs a few seconds to wake, so the retry has to live
here — anywhere later is unreachable, because the container would already have exited.

```sh
#!/bin/sh
set -e

PRISMA_BIN="${PRISMA_BIN:-/app/packages/database/node_modules/.bin/prisma}"
ATTEMPTS="${MIGRATION_RETRY_ATTEMPTS:-5}"
DELAY_SECONDS="${MIGRATION_RETRY_DELAY_SECONDS:-3}"

run_migrations() {
  if [ ! -x "$PRISMA_BIN" ]; then
    echo "Prisma CLI not found or not executable at $PRISMA_BIN" >&2
    return 1
  fi

  cd /app/packages/database
  attempt=1
  while :; do
    if [ -n "$MIGRATION_DATABASE_URL" ]; then
      DATABASE_URL="$MIGRATION_DATABASE_URL" "$PRISMA_BIN" migrate deploy && return 0
    else
      "$PRISMA_BIN" migrate deploy && return 0
    fi

    if [ "$attempt" -ge "$ATTEMPTS" ]; then
      echo "prisma migrate deploy failed after ${attempt} attempt(s); aborting startup" >&2
      return 1
    fi

    echo "prisma migrate deploy attempt ${attempt}/${ATTEMPTS} failed; retrying in ${DELAY_SECONDS}s" >&2
    attempt=$((attempt + 1))
    sleep "$DELAY_SECONDS"
  done
}

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  run_migrations           # set -e aborts the container if this returns non-zero
  cd /app
fi

exec node apps/api/dist/main.js
```

**Retry policy — deliberately the simplest thing that works.** Five attempts, a fixed 3-second delay,
a worst case of roughly 12 seconds of waiting. No exponential backoff, no jitter, no error
classification, and **no general retry framework** — this is one command on one single-instance
portfolio demo. Both knobs are environment-overridable for the smoke test, and setting
`MIGRATION_RETRY_ATTEMPTS=1` reproduces the original fail-fast behaviour exactly.

- **Real migration errors still fail the deployment.** The retry does not inspect or classify the
  error, so a genuinely broken migration is simply retried a handful of times and then fails —
  within about 12 seconds, not indefinitely. Retrying a deterministic failure is cheap; classifying
  transient-vs-permanent PostgreSQL errors correctly is not, and getting that classification wrong is
  a far worse failure mode than a 12-second delay.
- **`set -e` behaviour is preserved after the budget is exhausted.** `run_migrations` is invoked as a
  bare command, so a non-zero return trips `errexit` and the container exits before `exec`. Inside the
  loop, `cmd && return 0` keeps `errexit` from firing on an individual attempt — that is the only
  place failure is tolerated, and only up to the budget.
- **Exactly one retry policy exists in the system.** `PrismaLifecycleService` stays fail-fast and
  unchanged (§4.1). Once `migrate deploy` succeeds, the database is demonstrably awake, so Nest's
  `SELECT 1` moments later needs no retry of its own.
- `prisma migrate deploy` is idempotent and advisory-locked, so running it on every start is safe.
- **The Prisma CLI path is verified, not assumed** — asserted at build time by the `RUN test -x …`
  step in §4.2, re-checked at start by the guard above, and overridable via `PRISMA_BIN` if the
  production-dependency layout ever changes.
- `./node_modules/.bin/prisma` is used rather than `pnpm exec`, so pnpm is not needed in the runtime
  image at all.
- `MIGRATION_DATABASE_URL` is the escape hatch for a later switch to Neon's pooled (`-pooler`)
  endpoint, since `migrate deploy`'s advisory locks do not survive PgBouncer transaction pooling.
- **Runtime database readiness** is a separate concern from startup: `/v1/health/ready` covers
  database loss *after* a successful boot.
- **Graceful shutdown:** already implemented — `enableShutdownHooks(["SIGINT","SIGTERM"])` →
  `PrismaLifecycleService.onModuleDestroy` → `safeClose()` → `prisma.$disconnect()` then
  `pool.end()`. `exec` makes Node PID 1, which preserves it.
- **The entrypoint must be executable.** `COPY --chmod=755` in §4.2 sets the mode in the image
  deterministically, so it does not depend on the file mode in the developer's working tree or on
  git's executable bit surviving a checkout.

### 4.4 Render configuration

`render.yaml`, committed. Render builds the Dockerfile itself — no registry, no push credentials.

```yaml
services:
  - type: web
    name: opspilot
    runtime: docker
    dockerfilePath: ./Dockerfile
    dockerContext: .
    plan: free
    branch: main
    autoDeploy: true
    healthCheckPath: /v1/health/ready
    envVars:
      - { key: HOST, value: 0.0.0.0 }
      - { key: AGENT_RUN_PROVIDER_MODE, value: FAKE }
      - { key: DATABASE_URL, sync: false }   # set in the dashboard, never committed
```

Render injects `PORT`; `main.ts` already reads it. **`DATABASE_URL` is the only secret**, and the
only value that must be entered by hand.

### 4.5 Neon configuration

One project, one database. Use the **direct (unpooled)** connection string with `?sslmode=require`.
A single web instance with one `pg.Pool` does not need PgBouncer, and the direct endpoint keeps
`migrate deploy`'s advisory locks working. If the runtime is later moved to the pooled endpoint, set
`MIGRATION_DATABASE_URL` to the direct one — the entrypoint already supports it.

Free-tier auto-suspend is absorbed by the entrypoint's migration retry (§4.3), which is the container's
first database contact. Nothing else in the system retries.

### 4.6 Deployment verification, rollback, and migration failure

**Verification** — see §6 for the full procedure. In short: the `docker-smoke` CI job proves the
image end to end before merge, and a manual browser walkthrough against the Render URL proves the
deployment.

**Rollback:** redeploy the previous successful deploy in Render (an image rebuild of that commit).
Migrations are **forward-only** — a rollback that requires a schema revert needs a **new forward
migration**, never an edit to a committed one. This must be stated explicitly in
`docs/08-cicd-deployment.md`.

**Migration failure:** after the retry budget in §4.3 is exhausted (~12 seconds), the container exits
non-zero before binding, the health check never passes, and Render keeps the previous instance live.
The deploy is blocked until the migration is fixed forward. This is deliberate. Two tradeoffs to
state in `docs/08-cicd-deployment.md`: a bad migration blocks all deploys, not just schema ones, and
the retry means a genuine failure surfaces ~12 seconds later than it otherwise would.

---

## 5. Security and public-demo boundaries

In scope — the minimum a public demo needs:

- Single origin; **no CORS enabled**.
- **FAKE provider only**, enforced at DI time. No provider key exists in the image or in Render, and
  no outbound model call is possible.
- Existing protections carry over unchanged: the 32 KB JSON body cap, Zod validation at every
  boundary, and sanitized fixed-vocabulary error codes that never leak connection strings, stack
  traces, prompts, or provider payloads.
- Non-root container user; `DATABASE_URL` is the only secret; no `.env` in the image.
- The CI bundle guard asserts no secrets or absolute API origins reach the browser.

**Explicitly deferred**, and to be labelled as such in the README so the demo is not mistaken for a
production system: no authentication, no rate limiting, no abuse protection, no per-IP quotas, no
WAF, no observability stack, no backup or retention policy. Any visitor can create investigations;
all data is demo data with no privacy expectation. The deployment stays explicitly demo-oriented
until authentication and abuse controls exist.

### 5.1 Claim discipline: the deployed demo does not exercise RAG

§1.5 established this by inspection, and it creates a documentation obligation that is easy to get
wrong by accident. **This is a binding rule for every artifact produced in this milestone and after
it:**

- The repository genuinely contains minimal RAG work — a provider-neutral `RunbookRetriever`,
  deterministic in-memory retrieval, application-assigned evidence IDs, evidence-grounding
  validation, prompt-injection test scenarios, and file-backed runbooks with deterministic ordering
  and filesystem safety boundaries. That work is real and is fairly claimed **as repository work**.
- **The first deployed browser flow does not exercise any of it.** `apps/api` wires
  `InMemoryToolRegistry([getServiceStatusTool])` and no retriever at all; runbook loading is
  worker-side only. The deployed FAKE-provider path performs **zero** runbook retrieval.
- Therefore the README, the architecture diagram, the demo script, the deployment documentation, and
  any résumé bullet **must not imply that the live deployment retrieves runbooks or grounds evidence
  in retrieved content**. Where RAG is described, it must be attributed to the repository and the
  offline evaluation harness, not to the public demo.
- Production/deployed RAG is a later milestone, alongside real embeddings and a real provider.
- **Runbooks stay out of the first runtime image** unless implementation proves a deployed runtime
  dependency on them — at which point the `import.meta.url`-relative path in §1.5 becomes a real
  problem that must be solved deliberately, not patched around.

This matters more than a normal documentation nit: overclaiming RAG on a deployed demo is exactly the
kind of thing an interviewer probes, and the honest version — "the retrieval layer is implemented and
evaluated offline; the public demo runs the deterministic provider path" — is both true and more
impressive than a claim that collapses under one question.

---

## 6. Testing strategy

### 6.1 New unit tests (no database)

- **`spa-fallback.middleware.test.ts`** — each guard independently: `POST /anything` → `next()`;
  `/v1`, `/v1/`, `/v1/agent-runs/x` → `next()`; **`/v1abc`** (prefix lookalike) → falls through to
  the fallback, *not* to the API; `/app.js` → `next()`; `/some/deep/link` → `index.html` with
  `Cache-Control: no-cache`.
- **`web-assets.test.ts`** — `WEB_DIST_DIR` override wins; the default resolves relative to
  `__dirname`; a missing `index.html` reports "not servable" so serving is skipped.
- **`health.controller.test.ts`** — liveness never touches the database; readiness maps a rejecting
  `$queryRaw` to 503 with the standard error envelope, and a resolving one to
  `{ data: { status: "ready" } }`.
- **`forbidden-patterns.test.ts`** (`apps/web`) — every guard rule from §3.4.1 fires on a real leak,
  and — the load-bearing half — none of them fire on benign bundle content (license header URLs,
  `https://react.dev/...` warning links, docs links inside dependency comments, the word `test`
  inside a legitimate identifier).

**Not changed:** `prisma-lifecycle.service.test.ts` and the service it covers stay exactly as they
are. The startup retry lives in the entrypoint (§4.3), so there is nothing new to unit-test here.

**Entrypoint retry verification** is behavioural, not a unit test — a POSIX shell script is verified
by running it. The `docker-smoke` job covers it from both directions: the normal path (migrations
apply against an empty database on the first attempt) and the exhaustion path (start the container
with `MIGRATION_RETRY_ATTEMPTS=2`, `MIGRATION_RETRY_DELAY_SECONDS=1` and an unreachable
`DATABASE_URL`, then assert the container **exits non-zero**, never binds a port, and logs two
attempts). That second case is what proves a real migration failure still fails the deployment
instead of being retried away.

### 6.2 New transport test

`apps/api/test/static-assets.integration.test.ts`, mirroring the existing
`http-transport.integration.test.ts` pattern — mocked Prisma handle, real Nest app, supertest, and a
temp-directory web-dist fixture. No database required.

| Request | Expected |
| --- | --- |
| `GET /` | 200, `text/html`, contains `<div id="root">` |
| `GET /assets/<fixture>.js` | 200, JS content type, `immutable` cache header |
| `GET /v1/definitely-not-a-route` | JSON `ROUTE_NOT_FOUND` envelope — **never `index.html`** |
| `GET /v1/agent-runs/not-a-uuid` | the existing validation error envelope, unchanged |
| `GET /deep/link` | 200 `index.html` |
| `GET /missing.js` | 404, **not** HTML |
| `POST /unknown` | not `index.html` |
| `GET /v1/health/live` | 200 without touching the mocked database |
| *(with no web dist present)* `GET /` | the pre-existing behaviour; all `/v1/**` routes unchanged |

### 6.3 Container smoke test (`docker-smoke` CI job, added in PR 5B)

`needs: verify`, `timeout-minutes: 30`, with the same `postgres:16-alpine` service container.

**Step 1 — build and inspect the image before running anything.** These are static assertions about
what got built; they fail fast and they are what keep §4.2's boundary table honest.

```bash
docker build -t opspilot:ci .
docker image inspect -f '{{.Size}}' opspilot:ci     # report the size (decision #6)

# Image boundary checks — each must find nothing.
docker run --rm --entrypoint sh opspilot:ci -c '
  set -e
  ! test -d /app/apps/worker/src            # no worker source
  ! test -d /app/apps/worker/dist           # no worker build output
  ! test -d /app/runbooks                   # no runbooks
  ! test -d /app/node_modules/@anthropic-ai # no Anthropic SDK
  ! test -d /app/node_modules/voyageai      # no Voyage SDK
  test -x /app/packages/database/node_modules/.bin/prisma   # verified CLI path
'

# Runs as a non-root user.
test "$(docker run --rm --entrypoint id opspilot:ci -u)" != "0"

# Production workspace dependencies resolve after the stage copy — this is what
# would break if pnpm's relative symlinks did not survive COPY --from.
docker run --rm --entrypoint node opspilot:ci \
  -e "require.resolve('@opspilot/database'); require.resolve('@opspilot/agent-runtime'); require.resolve('@prisma/client')"
```

**Step 2 — run it and exercise the real workflow.**

```bash
docker run -d --network host --name opspilot \
  -e DATABASE_URL=postgres://opspilot:opspilot_ci_only@localhost:5432/opspilot \
  -e PORT=3000 -e HOST=0.0.0.0 opspilot:ci

# poll /v1/health/ready for up to 60s
curl -f  localhost:3000/v1/health/live
curl -sf localhost:3000/ | grep -q 'id="root"'
curl -s  localhost:3000/v1/nope | grep -q '"error"'   # JSON, not HTML

# full deterministic workflow, FAKE provider:
#   POST /v1/agent-jobs                  → jobId
#   POST /v1/agent-jobs/:jobId/runs      → runId, 201 + Location header
#   GET  /v1/agent-runs/:runId           → COMPLETED, ordered trace, structured report
#   GET  /v1/agent-runs/:runId/approval  → NOT_ELIGIBLE
#
# approval workflow, ticketId TICKET-APPROVAL-DEMO:
#   → one DRAFT_CUSTOMER_REPLY, PENDING
#   POST /v1/agent-runs/:runId/approval  → 201 APPROVED
#   POST again, identical body           → 200 (idempotent replay)
#   POST with the opposite decision      → 409
```

**Step 3 — prove a real migration failure still fails the deploy** (see §6.1):

```bash
docker run --name opspilot-migration-failure \
  -e DATABASE_URL=postgres://opspilot:wrong@127.0.0.1:59999/nope \
  -e MIGRATION_RETRY_ATTEMPTS=2 -e MIGRATION_RETRY_DELAY_SECONDS=1 \
  opspilot:ci || true
# assert: non-zero exit, no port ever bound, logs show 2 attempts then "aborting startup"
```

**Container logs are captured on every failure**, not only the ones anyone remembered to instrument:

```yaml
- name: Container logs
  if: always()
  run: |
    docker logs opspilot || true
    docker logs opspilot-migration-failure || true
```

An `if: always()` log step is the difference between a red CI run you can diagnose from the summary
page and one that requires reproducing the whole thing locally.

Together, steps 1–3 prove: the image boundary holds, workspace dependencies resolve after the stage
copy, the container runs unprivileged, migrations apply from the entrypoint against an empty
database, the retry budget is bounded, and a genuine migration failure still aborts startup.

### 6.4 Manual post-deploy browser verification

To be recorded in `docs/08-cicd-deployment.md`. Load the Render URL and:

1. Run an investigation with **Approval workflow demo unchecked** → `COMPLETED`, timeline, report,
   zero suggested actions, `NOT_ELIGIBLE`.
2. Run one with the box **checked** → `TICKET-APPROVAL-DEMO`, one `DRAFT_CUSTOMER_REPLY`, `PENDING`
   → Approve → terminal `APPROVED`.
3. Start a fresh run and **Reject** → terminal `REJECTED`.
4. In DevTools, confirm every request is same-origin and relative, and that **no CORS preflight
   occurs**.

---

## 7. File-by-file implementation map

### PR 5A — CI only (no application code touched; green on `main` as-is)

| File | Action | Purpose |
| --- | --- | --- |
| `.nvmrc` | create | Pin `22.21.0`; consumed via `node-version-file` |
| `.github/workflows/ci.yml` | create | `verify` + `integration` jobs per §3, with `permissions`, timeouts, and the `pnpm/action-setup` sequence |
| `apps/web/src/build-guard/forbidden-patterns.ts` + test | create | Narrow, tested bundle-leak rules (§3.4.1) |
| `apps/web/scripts/check-bundle.ts` | create | Walks `dist/`, applies the rules, exits non-zero on a violation |
| `apps/web/package.json` | modify | Add `check:bundle` script |
| `apps/web/tsconfig.json` | modify | Add `scripts/**/*.ts` to `include` so the checker is typechecked |
| `docs/08-cicd-deployment.md` | fill in | CI half of the document only |
| `README.md` | modify | CI badge and how to run the same checks locally |

### PR 5B — container, single origin, deployment

| File | Action | Purpose |
| --- | --- | --- |
| `Dockerfile` | create | Four-stage build (§4.2) |
| `.dockerignore` | create | Lean, deterministic build context |
| `docker/entrypoint.sh` | create | `migrate deploy`, then `exec node` (§4.3) |
| `render.yaml` | create | Blueprint; Render builds the Dockerfile |
| `apps/api/src/common/web-assets.ts` + test | create | Web-dist resolution and enablement check |
| `apps/api/src/common/spa-fallback.middleware.ts` + test | create | Guarded SPA fallback |
| `apps/api/src/health/health.{module,controller}.ts` + test | create | Liveness / readiness |
| `apps/api/test/static-assets.integration.test.ts` | create | Origin and routing boundary proof |
| `apps/api/src/main.ts` | modify | `HOST`/`PORT` from env; register static + fallback |
| `apps/api/src/app.module.ts` | modify | `HealthModule` before `NotFoundModule` |
| `apps/api/src/errors/api-error-catalog.ts` | modify | 503 readiness error code |
| `packages/database/package.json`, `pnpm-lock.yaml` | modify | `prisma` → `dependencies` |
| `.github/workflows/ci.yml` | modify | Add the `docker-smoke` job (build, image inspection, workflow, migration-failure case, `if: always()` logs) |
| `.env.example` | modify | `HOST`, `WEB_DIST_DIR`, `RUN_MIGRATIONS_ON_START`, `MIGRATION_RETRY_ATTEMPTS`, `MIGRATION_RETRY_DELAY_SECONDS`, `MIGRATION_DATABASE_URL` |
| `docs/08-cicd-deployment.md` | modify | Deployment half: Render/Neon, secrets, migration strategy, verification procedure, rollback |
| `docs/12-agent-run-api.md` | modify | Document the two health endpoints — it currently states the API is "exactly six endpoints" |
| `docs/10-engineering-challenges.md` | modify | See §10 |
| `README.md` | modify | Explicit demo-only limitations and the §5.1 RAG claim discipline. **No live URL yet** — that is PR 5C |

`apps/api/src/persistence/prisma-lifecycle.service.ts` is intentionally absent from this table
(§4.1).

### PR 5C — post-deploy documentation (small, narrowly deployment-specific)

Cannot be written before PR 5B is merged **and** actually deployed, because none of its content
exists until then.

| File | Action | Purpose |
| --- | --- | --- |
| `README.md` | modify | The real public URL; the cold-start limitation stated plainly; final demo instructions |
| `docs/08-cicd-deployment.md` | modify | Verified walkthrough results, actual deployment observations, measured image size, anything the real deploy contradicted |
| `docs/` (screenshots) | add | Final screenshots of the deployed timeline, report, and approval panel |

**Keep PR 5C narrow.** It is deployment evidence only. Broad README rewriting and résumé polish stay
in the later portfolio-polish milestone.

**Separability:** PR 5A touches no application code and no container file. PR 5B does not depend on
PR 5A having landed, beyond reusing `.nvmrc` and the workflow file. PR 5C depends on a real
deployment existing, which is exactly why it cannot be folded into PR 5B.

---

## 8. Risks, alternatives, and explicit non-goals

### Risks

1. **`pnpm install --prod --filter "@opspilot/api..."` layout inside the image.** The highest-risk
   step in the plan — pnpm's symlinked store must survive the stage copy. Mitigation: build and run
   the image locally before opening the PR; the `docker-smoke` job catches any later regression.
2. **`prisma` in `dependencies`** grows the runtime image and puts a CLI in production. Accepted
   deliberately (decision #6) so that deploys are self-contained. **The PR 5B verification summary
   must report the measured image size**; revisit only if the cost turns out to be unreasonable.
3. **Render free tier spins down after ~15 minutes idle** (~50s cold start) and **Neon free tier
   auto-suspends**. The first request after idle can look broken. Accepted for this milestone
   (decision #4). The entrypoint retry (§4.3) absorbs the database wake-up; the Render cold start
   itself cannot be engineered away on the free tier, so the README must **state it plainly** rather
   than hide it. A paid upgrade is optional later, before high-stakes sharing.
4. **Migration failure on start aborts the container after the retry budget.** Intended — but it
   means a bad migration blocks *all* deploys until fixed forward, and it does so ~12 seconds later
   than a no-retry design would. Call both out beside the rollback procedure.
5. **The retry could mask a slow-burning problem.** A database that consistently needs 2–3 attempts
   is degraded, not healthy, and the retry makes that invisible in a green deploy. The retry logs
   every failed attempt to stderr specifically so Render's logs show it; if attempts become routine,
   that is a signal to investigate, not to raise the budget.
6. **SPA fallback shadowing the API.** Mitigated by the explicit `/v1` guard plus dedicated tests,
   including the `/v1abc` prefix-lookalike case.
7. **A bundle guard that is too broad gets disabled.** This is why §3.4.1 bans specific leaks rather
   than every URL, and why the guard's test file spends as much effort on negative cases as positive
   ones. A guard nobody trusts is worse than no guard.
8. **TypeScript 7 tooling incompatibility** (Challenge 4) will hit any future Compiler-API consumer.
   Check a tool's actual `require("typescript")` usage before adopting it.
9. **The two integration suites share one database.** Never parallelize them —
   `--workspace-concurrency=1` and `test:integration:sequential` are load-bearing, not stylistic.

### Alternatives considered and rejected

| Alternative | Why rejected |
| --- | --- |
| Separate static host (Vercel) + API service | Two origins, forces CORS, contradicts the recorded single-origin decision |
| `@nestjs/serve-static` | A new dependency for behaviour `useStaticAssets` already provides, with less control over middleware ordering |
| CI builds and pushes to GHCR; Render deploys the digest | Guarantees "tested image == deployed image" and enables digest-pinned rollback, but adds registry setup, package permissions, and a deploy hook. Rejected per the owner's decision; CI still builds the image for the smoke test, so the Dockerfile stays verified on every PR |
| Manual migrations run from a laptop | Keeps the image minimal, but a deploy is no longer self-contained and a forgotten migration breaks production |
| Render pre-deploy command for migrations | Cleanest separation, but pre-deploy commands are a paid-instance feature, unavailable on the free tier |
| Deploying `apps/worker` | No runtime requirement — the API does not import it, and it has no build script |

### Explicit non-goals for this milestone

Real Claude/LLM integration; real embeddings; pgvector or managed vector retrieval; Jira or Zendesk
integration; queues or background workers; SSE/streaming; authentication; rate limiting; action
execution after approval; a historical investigation list; observability dashboards; lint/format
tooling; the accepted stale Refresh-notice cleanup; and any redesign or reimplementation of the
completed evaluation harness.

---

## 9. Verification commands and acceptance criteria

### PR 5A

```bash
pnpm install --frozen-lockfile
pnpm db:generate && pnpm typecheck && pnpm test && pnpm build
pnpm --filter @opspilot/web run check:bundle

pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:test
pnpm test:integration:sequential
pnpm db:migrate:deploy && pnpm db:migrate:drift

# then push the branch and confirm both GitHub Actions jobs pass on a real PR
```

**Accept when:**

- both jobs pass on a real pull request, and again on the merge to `main`;
- a deliberately broken type fails `verify`; a deliberately broken integration test fails
  `integration`;
- the workflow references no secrets and the run makes no provider call;
- a second push to the same PR cancels the in-flight run;
- `pnpm db:migrate:drift` exits non-zero when `schema.prisma` is edited without a migration;
- the integration job creates both databases without any host-side `psql` installation;
- the bundle guard fails when an absolute `/v1` API origin, `localhost`, or `127.0.0.1` is introduced
  into `apps/web/dist`, **and passes cleanly on the unmodified bundle** — a false positive on the
  current build is a guard bug, not a finding;
- the workflow declares `permissions: contents: read` and every job has a `timeout-minutes`.

**Report the actual test counts produced by the run.** Do not carry forward PR 4B's numbers
(11 web files / 107 tests, 708 repository-wide, 63/63 API and 74/74 database integration) — they were
accurate then and must be re-measured now.

### PR 5B

```bash
pnpm --filter @opspilot/api run build && pnpm --filter @opspilot/web run build
pnpm --filter @opspilot/api run test          # new unit + transport tests

docker build -t opspilot:local .
docker run --rm -p 3000:3000 \
  -e DATABASE_URL="postgres://opspilot:opspilot_local_dev_only@host.docker.internal:55432/opspilot" \
  -e HOST=0.0.0.0 -e PORT=3000 opspilot:local

curl -i localhost:3000/v1/health/live
curl -i localhost:3000/v1/health/ready
curl -i localhost:3000/ | head
curl -i localhost:3000/v1/nope       # JSON envelope, not HTML
curl -i localhost:3000/missing.js    # 404, not HTML
docker stop <id>                     # clean SIGTERM shutdown, no hanging process
```

**Accept when:**

- the image builds reproducibly from a clean context, and **its measured size is reported** in the
  verification summary (decision #6);
- the image contains no worker **source**, no worker build output, no `@anthropic-ai/sdk`, no
  `voyageai`, no `runbooks/`, and no `.env` — an inert `apps/worker/package.json` is expected and
  acceptable (§4.2);
- the container runs as a non-root user;
- `@opspilot/database`, `@opspilot/agent-runtime`, and `@prisma/client` all resolve inside the image
  after the stage copy;
- the Prisma CLI exists at the verified path, and `docker/entrypoint.sh` is executable via
  `COPY --chmod=755`;
- migrations apply automatically against an empty database; a transient database failure is retried
  within the budget; and a genuinely broken migration or an unreachable database **still aborts
  startup non-zero** without the API ever binding;
- `PrismaLifecycleService` is unchanged, and no second retry policy exists anywhere;
- `/` serves the React application and `/v1/**` serves JSON, with no path able to cross over in
  either direction;
- both health endpoints behave correctly, including 503 from readiness against a dead database;
- `docker stop` closes the `pg.Pool` cleanly with no hang;
- the `docker-smoke` job passes image inspection, the full deterministic **and** approval workflows,
  and the migration-failure case, with container logs captured on every failure;
- documentation added in this PR contains **no live URL claim** and **no claim that the deployed path
  performs runbook retrieval** (§5.1).

### PR 5C — Portfolio Ready

Cannot start until PR 5B is merged **and** deployed. Accept when all five Portfolio Ready conditions
from §0 hold and are evidenced in the repository:

- the Render service is live and the recorded URL actually loads;
- Neon shows persisted jobs, runs, trace events, and approval decisions from the live walkthrough;
- both the deterministic and approval browser walkthroughs (§6.4) are completed against the live URL,
  with results written down — including anything that contradicted this plan;
- the public URL is documented in `README.md`;
- the free-tier cold-start behaviour is documented plainly, not buried.

Only at that point does the project become *Portfolio Ready*. Merging PR 5B does not.

---

## 10. Engineering-challenges documentation

Updates required in `docs/10-engineering-challenges.md`. Follow the existing entry template exactly
— Context → Problem → Why It Is Difficult → Failure Modes → Decision → Alternatives Considered →
Tradeoffs → Implementation Notes → Testing Strategy → Observability → Interview Explanation →
Resume Relevance — and bump the metadata table's version (currently 1.8) with a revision note.

**Challenge 5 — One public origin without the SPA fallback swallowing the API.**
Why serving the React build from NestJS beats a second origin plus CORS; the exact middleware
ordering and why static handling precedes the JSON parser; why the `Accept: */*` trap makes the
extension guard mandatory rather than optional; why the `/v1` global prefix means
`NotFoundController` was never actually at risk; failure modes — a blank page caused by an
HTML-bodied `.js` 404, API routes returning `index.html`, and a stale `index.html` from a caching
mistake.

**Challenge 6 — Reproducible container builds for a pnpm workspace with a generated Prisma client.**
The gitignored generated client and why `prisma generate` must run inside the image; why Prisma 7's
driver-adapter model means there is no engine binary to copy, but `@prisma/client`'s WASM query
compiler must survive a `--prod` install; why the entire prod-deps tree is copied in one layer
(pnpm's relative symlinks); why `--filter "@opspilot/api..."` is what keeps worker-only SDKs out; the
deliberate move of `prisma` into `dependencies` and its cost; the inert worker manifest that survives
a frozen-lockfile workspace install and why it is not worth pruning; and the `import.meta.url`-relative
runbook path as a documented trap for any future worker image.

**Challenge 7 — Where a startup retry actually belongs.**
This one is worth its own entry because the first draft of the plan got it wrong in an instructive
way. The obvious home for "retry the database on startup" is the application's lifecycle hook — but
in this container the application is not the first thing to touch the database; `prisma migrate
deploy` in the entrypoint is. A retry in `PrismaLifecycleService` would have sat behind a container
that had already exited, and would have looked correct in every unit test while being unreachable in
production. Cover: how the ordering was spotted (reading the entrypoint against the lifecycle hook,
not the code in isolation); why exactly one retry policy may exist; why a deliberately dumb policy
(fixed delay, no error classification) is the right call for a single-instance demo, and why
misclassifying a permanent error as transient is worse than a 12-second delay; how `set -e` interacts
with `cmd && return 0` inside the loop; and the failure mode where a retry silently masks a
consistently degraded database, mitigated by logging every attempt.

**Optional addition under Challenge 4.** A short note that the same TypeScript 7 Compiler-API
constraint is why this milestone shipped CI **without** lint tooling — a decision *not* to adopt
something, which §1 of that document explicitly says to preserve.

**Documentation discipline.** None of these entries may be written as though already implemented
until the corresponding PR lands. Keep *Feature Complete* and *Portfolio Ready* distinct
(`PR 5B merged != Portfolio Ready`, §0). Apply the §5.1 RAG claim discipline everywhere: the
engineering-challenges entries, the README, the architecture diagram, the demo script, and résumé
bullets must not imply the deployed FAKE-provider path performs runbook retrieval. Review artifacts
under `docs/reviews/**` are not part of the implementation commit.
