# PR 6B — Protected Live Claude API: Implementation Plan

| | |
| --- | --- |
| Document | PR 6B — Protected Live Claude API (planning artifact) |
| Revision | 3 — final focused planning revision |
| Status | Plan only. No code, credential, API call, deployment, commit, or push. |
| Branch | `feat/protected-live-claude-api` |
| Base | `feat/live-claude-provider` (PR 6A) — rebase decided, §3 |
| Repository inspection date | 2026-07-28 |
| External source verification date | 2026-07-28 |
| Open owner questions | **none** — see §27 |

---

## 1. Objective and PR boundary

### Objective

Let a caller choose, **per run**, whether the deployed NestJS API executes against the
deterministic fake provider or against live Claude — and make the live path safe enough to
expose from a public portfolio deployment.

```text
POST /v1/agent-jobs/:jobId/runs   { "providerMode": "FAKE" | "LIVE" }
→ validate the requested mode
→ FAKE: deterministic provider, no safeguards consulted, no Anthropic config required
→ LIVE: capability + kill switch + access token + rate limit + concurrency lease
        + one atomic transaction (job lock → attempt limit → budget reservation → run insert)
        + Claude provider under a deadline
→ existing two-turn orchestrator
→ persisted normalized run, report, and usage
```

The browser never receives the Anthropic key, and never receives anything from which it could
be reconstructed. The shared demo token never leaves browser memory.

### The four concepts this plan keeps strictly separate

| Concept | Name | Meaning | Default |
| --- | --- | --- | --- |
| **Default request mode** | `AGENT_RUN_PROVIDER_MODE` | What an *absent* `providerMode` means | `FAKE` |
| **Requested run mode** | request body `providerMode` | What *this* run asked for | absent → default request mode |
| **Server live capability** | derived from `ANTHROPIC_API_KEY` + `ANTHROPIC_MODEL` | Whether this process *can* execute a live run | absent |
| **Live kill switch** | `LIVE_AGENT_RUNS_ENABLED` | Whether this process *may* start new live runs now | **`false`** |

A server can be capable but switched off; switched on but incapable; capable and on but out of
budget. Each produces a specific response (§16), but the **public** capability endpoint
collapses all three into one opaque `UNAVAILABLE` (§9.2).

### In scope

1. `packages/provider-claude`, consumable by `apps/worker` and `apps/api`; `agent-runtime`
   stays provider-neutral.
2. Per-run `FAKE | LIVE` selection through schema, controller, service, and persistence.
3. Optional server live capability with fail-closed startup validation and secret redaction.
4. A response-lifecycle disconnect adapter, a provider deadline, and **abort provenance**.
5. Live safeguards: fail-closed kill switch (PR 6B1), shared access token, rate limit,
   concurrency lease, an **atomic** per-job attempt limit, and a durable PostgreSQL daily
   budget.
6. A **service-owned** per-run usage collector feeding both run persistence and budget
   reconciliation, with exact integer nanoUSD end to end.
7. A coherent HTTP contract: admission failures are error statuses; anything after run
   creation is `201` with the persisted run.
8. Docker/Render changes, a corrected image-boundary claim, a strengthened bundle guard.
9. A minimal UI: `FAKE | LIVE` selector, memory-only demo-token input, availability
   messaging, and persisted provider/model/duration/cost display.
10. Deterministic tests requiring no Anthropic credential; opt-in live tests kept separate.
11. Documentation honest about what still does not work.

### Explicitly out of scope

Browser RAG wiring; approved-action execution; full authentication/RBAC; a historical run
browser; final screenshots and portfolio copy; any Claude model other than `claude-sonnet-5`;
**unrelated** UI redesign (the §9 work is deliberately minimal and nothing beyond it is
touched).

### What PR 6B does *not* claim

- It does not make a run cancellable end to end (§8.4).
- It does not deliver a hard dollar cap (§13.1).
- It does not deliver authentication (§14).
- It does not make the deployment "Portfolio Ready" (§20).

---

## 2. Current architecture findings

All observations are from direct file inspection on 2026-07-28.

### 2.1 Workspace

`pnpm-workspace.yaml` globs `apps/*` and `packages/*`, so `packages/provider-claude` needs no
workspace-config change. `allowBuilds` gates only `@nestjs/core`, `@prisma/engines`, `esbuild`,
`prisma`; the Anthropic SDK has no install script.

Root `package.json` pins `pnpm@11.13.1`, Node `>=22.21.0`, `typescript@^7.0.2`,
`vitest@^4.1.10`; every recursive script runs `--workspace-concurrency=1`.

`tsconfig.base.json` sets `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`esModuleInterop`, `target/lib: ES2022`. `exactOptionalPropertyTypes` is load-bearing — an
optional property must be *absent or a real value*, never explicitly `undefined` — which is why
conditional spreads appear throughout.

### 2.2 Package layout and module format

| Package | `type` | tsc `module` | Notes |
| --- | --- | --- | --- |
| `@opspilot/contracts` | (none → CJS) | `Node16` | Zod schemas |
| `@opspilot/database` | (none → CJS) | `Node16` | Prisma client generated `moduleFormat = "cjs"` |
| `@opspilot/agent-runtime` | (none → CJS) | `Node16` | `main: ./dist/index.js` + `exports` map |
| `@opspilot/api` | (none → CJS) | `Node16` | NestJS, `reflect-metadata` |
| `@opspilot/worker` | **`module`** (ESM) | `ESNext`/`Bundler`, `noEmit` | runs via `tsx`, never built |
| `@opspilot/web` | — | Vite | browser bundle |

`packages/agent-runtime/src/index.ts` documents why every **value** export is imported then
re-exported as a plain `const`: under CommonJS the named re-export form compiles to a
live-binding getter, and Vite-node's CJS interop does not forward those getters when the module
is consumed through a default import — which is how the ESM worker consumes workspace packages
under Vitest. **Any package consumed by both `apps/worker` and `apps/api` must repeat this.**

### 2.3 PR 6A's provider layer

`apps/worker/src/providers/` holds 17 `.ts` files — 9 source, 8 test. Verified properties:

- **`module-boundary.test.ts` exists specifically to make this move mechanical**, asserting
  every specifier is a sibling, a `@opspilot/*` package, one of `@anthropic-ai/sdk`/`zod`/
  `vitest`, or one of four `node:` builtins, and that none starts with `../`.
- **`claude-config.ts`** parses a plain `EnvRecord`, never `process.env`; returns a
  discriminated union; holds the key non-enumerable and non-writable with `toJSON` and
  `[util.inspect.custom]` redacting, object frozen; error messages name the *variable*, never
  the *value*. Defaults `DEFAULT_TIMEOUT_MS = 45_000`, `DEFAULT_MAX_RETRIES = 1`.
- **`claude-model.ts`** is a one-member allowlist (`claude-sonnet-5`), justified by a request
  policy (`thinking: { type: "disabled" }` + forced `tool_choice`) valid only for that model.
- **`create-llm-provider.ts`** constructs `new Anthropic({ …, logLevel: "off" })` *inside*
  `createProvider`, never at module load; a LIVE selection without config throws
  `LiveProviderUnavailableError` — no fallback to FAKE.
- **`claude-llm-provider.ts`** depends on a structural `AnthropicMessagesClient`, accepts an
  optional `logger: (event: ClaudeProviderLogEvent) => void`, and classifies SDK errors into
  `LlmProviderErrorCategory` with a documented load-bearing ordering.
- **`ClaudeProviderLogEvent`** already carries `inputTokens`, `outputTokens`,
  `cacheReadInputTokens`, `cacheCreation5mInputTokens`, `cacheCreation1hInputTokens`,
  `estimatedCostUsd`, `pricingStatus`, `latencyMs`, `providerRequestId`, `model`,
  `normalizedResultType`, plus an `outcome: "error"` variant with `terminalErrorCategory`.
- **`cost-estimation.ts`** prices in integer nanoUSD per token — `totalNanoUsd()` is exact
  integer arithmetic — but `CostEstimate.estimatedCostUsd` is `number | null`, i.e. the
  **exactness is discarded at the boundary**. §12.2 fixes this.
- **`claude-pricing.ts`** encodes introductory rates with `validThrough: "2026-08-31"`; past
  that, estimates become `STALE` with a null cost rather than a wrong number.

Worker consumers of `../providers/**` — the only import sites that change:
`demo/run-claude-agent-spike.ts`, `demo/run-rag-live-spike.ts`, `smoke/claude-live-smoke.ts`,
`smoke/claude-live-smoke.test.ts`. (`rag/voyage-embedding-client.ts` mentions the path in a
comment only.)

### 2.4 `apps/api` execution wiring

- `execution/deterministic-execution.module.ts` reads `process.env.AGENT_RUN_PROVIDER_MODE`
  once at module-instantiation time; `createDeterministicProviderFactory` throws
  `LiveProviderModeNotSupportedError` for anything but `FAKE`. `main.ts`'s
  `abortOnError: false` turns that into a rejected bootstrap promise.
- `execution/deterministic-provider-factory.ts` also owns `createDeterministicScenario(job)` —
  pure, provider-agnostic, with an opt-in `TICKET-APPROVAL-DEMO` branch. Must survive unchanged.
- `agent-runs.controller.ts` calls `executeAndPersist({ jobId, providerMode: "FAKE", … })` — a
  literal — and never passes `modelIdentifier`. Success returns `201` + a `Location` header.
- `execute-agent-run-request.schema.ts` accepts only an absent body or `{}`, via
  `z.preprocess((v) => (v === undefined ? {} : v), z.object({}).strict())`.
- `agent-run-service.ts`'s `ExecuteAndPersistResult` is a **discriminated union**, not a flat
  object:

  ```ts
  | { persistence: "persisted";   run: PersistedAgentRun }
  | { persistence: "unavailable"; stage: "run-creation";  error: PersistenceError }
  | { persistence: "unavailable"; stage: "finalization";  runId; agentResult; error }
  ```

  The controller maps the `unavailable` variants to `503`/`409` via `mapDomainError`. Any
  change to this type must preserve those two variants — §12.3.
- `startRun` loads the `AgentJob` **under a row lock** and allocates `attempt_number` in the
  same transaction. §11.5 extends exactly that transaction.

### 2.5 Request handling and observability

`json-body-parser.ts`: `express.json({ limit: "32kb", type: "*/*" })` plus four-argument error
middleware mapping `entity.too.large` → 413 and everything else → 400.
`logging.interceptor.ts` logs one fixed-shape line per finished response and deliberately uses
`request.route?.path ?? request.path`, never `originalUrl` — already secret-safe.
`api-error-catalog.ts` is the single source of truth for all 13 public status/message pairs.
`main.ts` never calls `app.set("trust proxy", …)`, so `req.ip` is currently the proxy's address.

### 2.6 Persistence

Four models, two committed migrations. `agent_runs.provider_mode` is already `String` with
`ProviderMode = "FAKE" | "LIVE"`, `model_identifier` is `String?`, `failure_code` is `String` —
so **per-run mode and new failure codes need no migration**. `@@unique([jobId, attemptNumber])`
already exists.

### 2.7 Web UI

`App.tsx:251` renders `Local-only, deterministic provider — no live model calls.` —
false once LIVE exists. `endpoints.ts`'s `startAgentRun` deliberately sends **no body**.
`api/types.ts`'s `AgentRunRecordView` **already carries `providerMode` and `modelIdentifier`**,
and `agent-run-response.mapper.ts` already returns both — so displaying the persisted mode needs
no mapper change. `RunOverviewPanel.tsx` already renders Duration via `formatDuration`.
`InvestigationForm.tsx` gates submission on `trimmedSummary.length > 0`.

### 2.8 CI and container

CI sets `AGENT_RUN_PROVIDER_MODE: FAKE`, references no `secrets.*`, and asserts
`! test -d /app/node_modules/@anthropic-ai`. The `Dockerfile`'s `prod-deps` stage runs
`pnpm install --prod --filter "@opspilot/api..."` and the whole output is copied as **one**
layer so pnpm's relative symlinks survive. Build assertions `require.resolve` from the package
directory that declares each dependency (the `cd` is load-bearing).
`render.yaml`: `plan: free`, `AGENT_RUN_PROVIDER_MODE: FAKE`, `DATABASE_URL` the only secret.

### 2.9 Two gaps PR 6B must close

**Gap A — a thrown `LlmProviderError` orphans the run.** `executeAndPersist` catches any throw
and rethrows `AgentRunServiceError("AGENT_EXECUTION_CRASHED")`; the row stays `RUNNING` forever.
Under FAKE that is a genuine "should never happen"; under LIVE it is the **normal** path for
auth failure, rate limiting, timeout, and cancellation.

**Gap B — the factory takes its fake scenario eagerly.** `LlmProviderFactoryOptions.fakeScenario`
is a value, not a thunk, but the API's scenario depends on the job, known only after `startRun`.

---

## 3. Stacked-PR / base assumptions

```text
main                            00522bd
feat/protected-live-claude-api  00522bd   ← identical to main
feat/live-claude-provider       f868aac   ← 4 commits ahead, unmerged, no upstream
```

The branch is **not currently stacked on PR 6A**. **Resolved: rebase
`feat/protected-live-claude-api` onto `feat/live-claude-provider`** and open PR 6B1 against
that branch. This is step 1 of §22; every path in §21 assumes PR 6A's tree.

### Compatibility changes PR 6B makes to PR 6A's code

Minimal, and each forced by a concrete constraint:

1. `LlmProviderFactoryOptions` gains optional `client?: AnthropicMessagesClient` (Gap B).
2. `parseWorkerProviderConfig` → `parseProviderConfig`; `WorkerProviderConfig` →
   `ProviderConfig`; `LiveWorkerProviderConfig` → `LiveProviderConfig`.
3. `parseProviderConfig` restructured so live capability is **optional** rather than
   mode-selected (§6.1); validation strictness and redaction unchanged.
4. `runAgentOrchestrator` converts a thrown `LlmProviderError` into a `failed` result (Gap A).
5. **`CostEstimate` gains `estimatedCostNanoUsd: string | null`; `totalNanoUsd()` returns
   `bigint`; `ClaudeProviderLogEvent.estimatedCostUsd: number | null` is replaced by
   `estimatedCostNanoUsd: string | null`** (§12.2). This changes one log field in the worker
   smoke and both spike runners — a formatting change at their print sites, no logic change.
6. `LlmProviderFactoryOptions.logger` is invoked once per turn as today; PR 6B simply attaches
   a second consumer (§12.1).

---

## 4. Target package architecture

### 4.1 Layering

```text
packages/contracts        Zod schemas + shared types (no vendor, no I/O)
packages/database         Prisma repository functions
packages/agent-runtime    provider-NEUTRAL contracts, orchestrator, persistence service,
                          RunAbortContext, cost estimation
packages/provider-claude  Anthropic-SPECIFIC adapter, config, model allowlist, pricing,
                          usage collector                                              ← new
apps/worker (ESM) ──┐
apps/api    (CJS) ──┴──> both depend on provider-claude
apps/web            never depends on provider-claude, transitively or otherwise
```

### 4.2 Files moved (`git mv`)

All 17 files move to `packages/provider-claude/src/`, preserving history. Because the boundary
test already proves nothing reaches outside the directory, **no import inside the moved files
changes** — the only edits are §3's renames, the `client` option, the capability restructure,
the nanoUSD field, and `index.ts`'s export shape.

New in the package: `run-provider-usage-collector.ts` (+ test) — §12.

### 4.3 Manifest

```jsonc
{
  "name": "@opspilot/provider-claude",
  "private": true,
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { /* build:deps / typecheck / build / test / clean — mirroring agent-runtime */ },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.112.0",
    "@opspilot/agent-runtime": "workspace:*",
    "@opspilot/contracts": "workspace:*",
    "zod": "^4.4.3"
  },
  "devDependencies": { "typescript": "^7.0.2", "vitest": "^4.1.10" }
}
```

Versions copied verbatim from `apps/worker/package.json`; the lockfile already resolves both.
**No `@opspilot/database` dependency** — enforced by test (§4.5), which is what keeps Prisma out.

### 4.4 TypeScript module format

`tsconfig.json` / `tsconfig.build.json` copied from `packages/agent-runtime` — `Node16`
module/resolution, `declaration: true`, tests excluded from the build config. CommonJS output is
required (`apps/api` is CJS; the Prisma client is `cjs`).

### 4.5 `index.ts` export shape and the boundary test

`index.ts` switches its own value exports to the plain-`const` pattern (§2.2). The boundary test
moves unchanged except: the directory comment names the package; a new assertion that no file
imports `@opspilot/database`; a new self-import assertion; and the `files.length >= 8` floor
raised to the real count so a lost file fails loudly.

### 4.6 Worker compatibility

Four import specifiers change to `@opspilot/provider-claude`. `apps/worker/package.json` gains
the package and **drops `@anthropic-ai/sdk`**, provided the spike runners go through
`createLlmProviderFactory`; verify at implementation, and if one genuinely needs the raw client,
keep the dependency and say so rather than overclaiming the boundary. `voyageai` stays
worker-only. **Worker smoke and internal caller budgets are not changed by this PR** — §13's
limits apply to the API LIVE path only.

---

## 5. `apps/api` wiring

### 5.1 Request schema

```ts
export const ExecuteAgentRunRequestSchema = z.preprocess(
  (value) => (value === undefined ? {} : value),      // absent-only, unchanged
  z.object({ providerMode: z.enum(["FAKE", "LIVE"]).optional() }).strict(),
);
```

Absent body, `{}`, and `{"providerMode":"FAKE"}` all remain valid — the existing web client,
demo script, and integration tests keep working unchanged. Explicit `null` is still rejected.
Any other key or enum value → `REQUEST_BODY_INVALID` (400).

### 5.2 Tokens and modules

```ts
export const AGENT_RUN_SERVICE     = "AGENT_RUN_SERVICE";
export const TOOL_REGISTRY         = "TOOL_REGISTRY";
export const AGENT_PROVIDER_FACTORY= "AGENT_PROVIDER_FACTORY";   // was DETERMINISTIC_PROVIDER_FACTORY
export const RUN_EXECUTION_CONFIG  = "RUN_EXECUTION_CONFIG";     // new — §6
export const LIVE_RUN_ADMISSION    = "LIVE_RUN_ADMISSION";       // new — PR 6B2
export const USAGE_HOOKS           = "USAGE_HOOKS";              // new — §12
```

`deterministic-execution.module.ts` → `run-execution.module.ts`, which parses config once at DI
time and constructs the shared `Anthropic` client once when capability is present.
`api-provider-factory.ts` is the one place `AgentJobRecord` meets `LlmProviderSelection`:

```ts
createProvider(job, requested, collector?): LlmProvider {
  const selection = requested === "LIVE"
    ? { providerMode: "LIVE", modelIdentifier: SUPPORTED_CLAUDE_MODEL }
    : { providerMode: "FAKE" };
  return createLlmProviderFactory({
    fakeScenario: createDeterministicScenario(job),
    ...(anthropic ? { anthropic } : {}),
    ...(client ? { client } : {}),
    ...(collector ? { logger: (e) => { collector.record(e); logProviderEvent(e); } } : {}),
  }).createProvider(selection);
}
```

`createDeterministicScenario` moves to `execution/deterministic-scenario.ts` **unmodified**.
`LiveProviderModeNotSupportedError` is deleted.

### 5.3 Controller flow

```ts
@Post("agent-jobs/:jobId/runs")
async createAgentRun(@Param(...) jobId, @Body(...) body, @Req() req, @Res({ passthrough: true }) res) {
  const requested = body.providerMode ?? this.config.defaultRequestMode;

  if (requested === "FAKE") return this.executeFake(jobId, res);      // no admission, no collector, no abort context

  // Admission steps 2–7 (§11.1). Throws an ApiError for any rejection.
  const admission = await this.admission.admit(req);                 // { reservationInput, concurrencyLease }
  const disconnect = createRequestAbortHandle(res);                  // §7
  const abortContext = buildRunAbortContext(this.config.providerDeadlineMs, disconnect.signal);  // §8

  let result: ExecuteAndPersistResult | undefined;
  try {
    result = await this.agentRunService.executeAndPersist({
      jobId,
      providerMode: "LIVE",
      modelIdentifier: SUPPORTED_CLAUDE_MODEL,
      createProvider: (job, collector) => this.providerFactory.createProvider(job, "LIVE", collector),
      toolRegistry: this.toolRegistry,
      maxOutputTokens: this.config.liveMaxOutputTokens,
      usageHooks: this.usageHooks,
      abortContext,
      liveAttemptLimit: this.config.maxLiveAttemptsPerJob,          // §11.5
      budgetReservationInput: admission.reservationInput,           // §11.5
    });
    return this.respond(result, res);                                // §16 — 201 for any finalized run
  } finally {
    disconnect.dispose();
    // §10 — reconciliation must never override the response, nor block the lease release.
    try {
      const usage = usageSummaryOf(result);
      const reservation = reservationOf(result);
      if (usage && reservation) await this.budget.reconcile(reservation, usage);
    } catch (error) {
      logBudgetReconciliationFailure(error);                         // sanitized; §10.3
    } finally {
      admission.concurrencyLease.release();
    }
  }
}
```

Note `maxOutputTokens` and `abortContext` are passed unconditionally on the LIVE branch and
omitted entirely on the FAKE branch — `exactOptionalPropertyTypes` forbids passing an explicit
`undefined`.

### 5.4 Provider-failure finalization (Gap A)

`packages/contracts/src/agent-orchestrator.ts` gains:

```ts
"PROVIDER_UNAVAILABLE",   // AUTHENTICATION | BILLING | RATE_LIMIT | CONNECTION | SERVER_ERROR | REQUEST_INVALID | UNKNOWN
"PROVIDER_TIMEOUT",       // TIMEOUT
"PROVIDER_CANCELLED",     // CANCELLED
```

`runAgentOrchestrator` wraps each `provider.runAgentTurn(...)`:

```ts
try { result = await params.provider.runAgentTurn({ … }); }
catch (error) {
  if (error instanceof LlmProviderError) return failed(providerFailureCode(error.category), error.message, trace);
  throw error;                    // genuine crashes still surface as AGENT_EXECUTION_CRASHED
}
```

The message is already the sanitized, category-keyed string, so no vendor body, header, or
request ID reaches persistence. `failure_code` is a plain `String` column — **no migration**.
The orchestrator stays HTTP-agnostic and knows nothing about abort provenance; that is resolved
one layer up (§8.2).

---

## 6. Configuration and secret handling

### 6.1 Live capability is optional; misconfiguration still fails closed

| `ANTHROPIC_API_KEY` | `ANTHROPIC_MODEL` | Result |
| --- | --- | --- |
| absent | absent | `liveCapability: "absent"` — startup succeeds. This is CI, and default local. |
| present | `claude-sonnet-5` | `liveCapability: "present"` — one shared `Anthropic` client constructed |
| present | absent | **startup fails** — `ANTHROPIC_MODEL is required when ANTHROPIC_API_KEY is set.` |
| absent | present | **startup fails** — `ANTHROPIC_API_KEY is required when ANTHROPIC_MODEL is set.` |
| present | any other value | **startup fails** |
| any | any | `ANTHROPIC_TIMEOUT_MS`/`ANTHROPIC_MAX_RETRIES` out of range → **startup fails** |

Partial or invalid configuration never degrades to "capability absent" — that would be a silent
downgrade. `AGENT_RUN_PROVIDER_MODE=LIVE` with capability absent also **fails startup**.

### 6.2 Variables

| Variable | Concept | Default | Validation | PR |
| --- | --- | --- | --- | --- |
| `AGENT_RUN_PROVIDER_MODE` | default request mode | `FAKE` | exactly `FAKE` or `LIVE` | 6B1 |
| `ANTHROPIC_API_KEY` | capability | — | non-empty after trim | 6B1 |
| `ANTHROPIC_MODEL` | capability | — | exactly `claude-sonnet-5` | 6B1 |
| `ANTHROPIC_TIMEOUT_MS` | capability | `45000` | integer 1 000–600 000 | 6B1 |
| `ANTHROPIC_MAX_RETRIES` | capability | `1` | integer 0–5 | 6B1 |
| `AGENT_RUN_PROVIDER_DEADLINE_MS` | deadline | `120000` | integer 5 000–600 000 | 6B1 |
| **`LIVE_AGENT_RUNS_ENABLED`** | kill switch | **`false`** | exactly `true` or `false` | **6B1** |
| `LIVE_RUN_ACCESS_TOKEN` | access gate | unset | non-empty when set | 6B2 |
| `LIVE_RUN_MAX_OUTPUT_TOKENS` | budget | `1024` | integer 256–4096 | 6B2 |
| `LIVE_RUN_MAX_ATTEMPTS_PER_JOB` | budget | `2` | integer 1–10 | 6B2 |
| `LIVE_RUN_MAX_CONCURRENCY` | concurrency | `1` | integer 1–4 | 6B2 |
| `LIVE_RUN_RATE_LIMIT_MAX` | rate limit | `2` | integer 1–60 | 6B2 |
| `LIVE_RUN_RATE_LIMIT_WINDOW_MS` | rate limit | `60000` | integer 1 000–3 600 000 | 6B2 |
| `LIVE_RUN_DAILY_LIMIT` | budget | `10` | integer 1–1000 | 6B2 |
| `LIVE_RUN_DAILY_COST_CEILING_USD` | budget | `1.00` | decimal string, parsed to integer nanoUSD | 6B2 |
| `TRUST_PROXY_HOPS` | rate-limit identity | `1` | integer 0–5 (§11.3) | 6B2 |

**`AGENT_RUN_PROVIDER_MODE` is reused, not renamed** (resolved decision, §27). Its meaning
becomes "the mode a request gets when it does not ask for one". Every existing value in
`Dockerfile`, `render.yaml`, `.env.example`, and CI is `FAKE` and keeps behaving identically, so
no deployment artefact changes meaning. `AGENT_RUN_DEFAULT_PROVIDER_MODE` is **not** introduced.

Every integer uses `parseBoundedInteger`-style strictness — `Number()`, not `parseInt`, so
`"45s"` is rejected rather than read as `45`. Every message names the *variable*, never the
*value*.

### 6.3 Secret redaction

Inherited unchanged from `claude-config.ts`: non-enumerable, non-writable `apiKey`; redacting
`toJSON` and `[util.inspect.custom]`; frozen object; **callers pass the `LiveProviderConfig`
around rather than copying `apiKey` out**, which would undo all of it. Plus: `logLevel: "off"`
on every client; `ClaudeProviderLogEvent` is the only provider log surface and carries no
prompt, response text, or credential; `providerRequestId` is server-side only; no DTO, mapper,
or error envelope carries configuration; **the shared demo token is never logged, never
persisted, and never echoed in an error** (§9.3, §10.3).

### 6.4 `.env.example` and CI

The root `.env.example` replaces its "must be FAKE (the only supported value today)" note with
the four-concept model, the optional-capability rule, the kill switch and its `false` default,
the deadline, and the safeguard knobs — `ANTHROPIC_API_KEY` left empty with "never put a value
here; this file is committed". `apps/worker/.env.example` drops its false claim about `apps/api`.

CI keeps `AGENT_RUN_PROVIDER_MODE: FAKE` and, because neither Anthropic variable is set, runs
with `liveCapability: "absent"` — a *supported, tested* configuration rather than an accident.

---

## 7. Request-disconnect handling

### 7.1 Why the previous designs were wrong

Revision 1 used `req.signal`, which Express 5 / Nest do not expose. Revision 2 replaced it with
`request.on("close")` guarded by `response.writableEnded` — **also wrong**:
`IncomingMessage`'s `close` fires once the request body has been fully read, which on a normal
`POST` happens long before the response is generated. At that moment `writableEnded` is still
`false`, so every ordinary LIVE run would abort itself immediately.

### 7.2 Correct design — response lifecycle only

```ts
export interface RequestAbortHandle {
  readonly signal: AbortSignal;
  dispose(): void;
}

export function createRequestAbortHandle(response: ServerResponse): RequestAbortHandle;
```

**The request object is not observed at all.** Only two listeners, both on the response:

```ts
response.once("finish", onFinished);
response.once("close",  onClosed);
```

| Event | Guard | Action |
| --- | --- | --- |
| `finish` | — | normal completion → mark settled, remove listeners, **do not abort** |
| `close` | `!response.writableFinished` | client disconnected before the response completed → **abort**, remove listeners |
| `close` | `response.writableFinished` | ordinary socket close after a complete response → mark settled, **do not abort** |

`writableFinished` (not `writableEnded`) is the key guard: `writableEnded` flips as soon as
`end()` is *called*, whereas `writableFinished` is true only once the data has actually been
flushed — which is the property that distinguishes "we finished" from "the socket went away
mid-flush".

`dispose()` is **idempotent**: it marks settled and removes both listeners, and is safe after an
abort, after a finish, or called twice. The controller calls it in a `finally`, so no listener
outlives the request even on a thrown error. The internal `AbortController.abort()` is called at
most once, guarded by the same `settled` flag.

### 7.3 Tests

- normal `finish` does **not** abort;
- premature `close` (before `writableFinished`) **does** abort;
- `close` after `finish` does **not** abort;
- both listeners removed after settle (asserted via `response.listenerCount`);
- `dispose()` twice, and after an abort, are no-ops;
- `abort` fires at most once under repeated events.

---

## 8. Deadline, abort provenance, and cancellation

### 8.1 Deadline policy

| | |
| --- | --- |
| Variable | `AGENT_RUN_PROVIDER_DEADLINE_MS` |
| Default | `120000` |
| Range | `5000`–`600000` |
| Timer starts | Immediately before `executeAndPersist` |

Required wording, used verbatim in the code comment and in `docs/12-agent-run-api.md`:

> A caller-owned deadline covering Anthropic provider calls across the run.
> It is a product-level execution budget, not a mathematical worst-case formula.

and

> tool execution, retrieval, and persistence cancellation are not wired in PR 6B

**No arithmetic identity is claimed anywhere.** The accurate statement: the SDK `timeout` is a
**per-attempt** bound; the retry count is **bounded**; total elapsed time also includes retry
backoff and any `retry-after` delay, neither observable from the response; and the caller-owned
deadline is the **outer bound for provider calls**. `120000` is a product-level budget for an
interactive demo, not a value derived from the per-attempt timeout.

### 8.2 Abort provenance

`AbortSignal.any([…])` yields one aborted signal, and the SDK reports both causes identically as
`APIUserAbortError` → `CANCELLED`. Merging alone therefore loses the distinction between "we ran
out of time" and "the user left". The context preserves it:

```ts
// packages/agent-runtime — provider-neutral, no HTTP types
export interface RunAbortContext {
  readonly signal: AbortSignal;            // the merged signal handed to the provider
  readonly deadlineSignal: AbortSignal;
  readonly disconnectSignal: AbortSignal;
}
```

Built once per LIVE run, in the controller:

```ts
const deadlineSignal   = AbortSignal.timeout(providerDeadlineMs);
const disconnectHandle = createRequestAbortHandle(response);
const abortContext: RunAbortContext = {
  deadlineSignal,
  disconnectSignal: disconnectHandle.signal,
  signal: AbortSignal.any([deadlineSignal, disconnectHandle.signal]),
};
```

**Precedence, applied by `AgentRunService` immediately before finalization:**

```text
deadlineSignal.aborted                    → PROVIDER_TIMEOUT
else if disconnectSignal.aborted          → PROVIDER_CANCELLED
else                                      → keep the provider-derived code unchanged
```

Deadline wins a near-simultaneous race. That is a deliberate, documented choice: a run that
exceeded its budget *and* lost its client is more usefully recorded as a timeout, because the
timeout is the actionable operational fact.

`ClaudeLlmProvider` learns nothing about Express, response objects, or HTTP status codes — it
only ever receives an `AbortSignal` on `AgentTurnInput`. Provenance resolution lives in the
service layer that already decides how an `AgentRun` is finalized.

### 8.3 End-to-end data flow

```text
AbortSignal.any([deadline, disconnect])
  → AgentTurnInput.signal
  → SDK request { signal }
  → APIUserAbortError
  → LlmProviderError("CANCELLED")                          (provider — vendor-specific)
  → runAgentOrchestrator catch → failed("PROVIDER_CANCELLED")   (runtime — provider-neutral)
  → AgentRunService provenance override:
        deadlineSignal.aborted   → PROVIDER_TIMEOUT
        disconnectSignal.aborted → PROVIDER_CANCELLED
  → finalizeFailed(runId, trace, code) + usage metadata     (persistence)
  → agent_runs.status = FAILED, failure_code = <resolved>
  → HTTP: 201 with the persisted FAILED run                 (§16)
          …unless the client actually disconnected, in which case nothing is written
```

### 8.4 Honest scope statement

**This milestone does not make a run cancellable.** The signal reaches Anthropic provider calls
only. It does not cancel retriever calls (`RunbookRetriever` takes no signal, and the API wires
no retriever), diagnostic tool execution (`DiagnosticToolDefinition.execute` takes no signal), or
any persistence call. Extending cancellation there means changing three contracts across
`agent-runtime` and `database`, deliberately out of scope. Practically: after the deadline fires
the provider calls abort promptly, but an in-flight tool call and the finalizing write still
complete — milliseconds for a seeded in-memory tool and one `UPDATE`.

### 8.5 Tests

Deadline wins (both aborted, deadline first); disconnect wins (only disconnect aborted);
provider-native timeout with **neither** outer signal aborted keeps `PROVIDER_TIMEOUT` from the
provider category; near-simultaneous abort follows the documented precedence deterministically
(both signals pre-aborted before the call); and the **same composed signal instance** reaches
both provider turns, asserted through a fake provider that records signal identity.

---

## 9. Minimum UI scope (PR 6B2)

Deliberately minimal and additive. The approval UI, trace timeline, report panel, and layout are
untouched.

### 9.1 Mode selector

```text
[ Demo — FAKE ]  [ Live Claude ]
```

A two-option radio group in `InvestigationForm`, defaulting to **FAKE**.

| | FAKE | LIVE |
| --- | --- | --- |
| Copy | "Deterministic, fast, no model cost." | "Real `claude-sonnet-5`. Protected by availability and usage limits." |
| Approval workflow demo checkbox | **shown** | **hidden** — the deterministic `TICKET-APPROVAL-DEMO` scenario has no meaning for a live run |
| Access-token field | hidden | shown when the server says a token is required (§9.3) |
| Request body | `{"providerMode":"FAKE"}` | `{"providerMode":"LIVE"}` |

### 9.2 Capability endpoint

`/v1/health/ready` stays focused on **service and database readiness** — the `liveAgentRuns`
field proposed in Revision 2 is removed. Product configuration and budget state get their own
endpoint:

```http
GET /v1/capabilities
```

```json
{
  "liveAgentRuns": "AVAILABLE" | "UNAVAILABLE",
  "liveAccess":    "TOKEN_REQUIRED" | "PUBLIC" | "NOT_APPLICABLE"
}
```

Rules, enforced by test:

- no remaining budget, no current counts, no key or config details, no token value;
- **no distinction** between kill switch off, capability absent, and budget exhausted — all
  three render as `UNAVAILABLE`, so an anonymous visitor learns nothing about which safeguard is
  engaged or how much headroom remains;
- computed from local state only — **no Anthropic status probe, no paid request**;
- `liveAccess` is `NOT_APPLICABLE` whenever `liveAgentRuns` is `UNAVAILABLE`.

When `UNAVAILABLE`, the LIVE option renders **disabled with a visible reason** ("Live Claude is
temporarily unavailable — the deterministic demo is always available") rather than hidden: a
hidden control makes the feature look absent rather than protected.

### 9.3 Demo access token — the browser path

The resolved posture is *LIVE behind a shared access token, FAKE public* — so the UI needs a way
to send `X-OpsPilot-Demo-Token`, or every browser LIVE request is a guaranteed 401.

```text
Live demo access token
[••••••••••••••••]

Used only for this browser session.
Not stored on this device.
```

| Rule | Enforcement |
| --- | --- |
| Shown only when LIVE is selected **and** `liveAccess === "TOKEN_REQUIRED"` | render condition |
| Held in React component/application state only | no storage call exists in the diff |
| Never in `localStorage` or `sessionStorage` | asserted by a test that spies on both |
| Never in a URL, query string, pathname, hash, analytics event, or log | asserted; the logging interceptor already avoids `originalUrl` |
| Never persisted server-side | no DTO or column carries it |
| Sent only on LIVE run requests; omitted entirely for FAKE | asserted on both branches |
| Cleared on page reload | in-memory state, by construction |
| Cleared when switching back to FAKE | explicit `setToken("")` on mode change |
| Rendered as `type="password"` | asserted |
| Never echoed in an error message | the 401 message is the fixed catalog string |

API client:

```ts
startAgentRun({ jobId, providerMode, liveAccessToken? })
// LIVE only:  X-OpsPilot-Demo-Token: <memory-only value>
```

`endpoints.ts`'s comment about sending no body is updated.

### 9.4 Run display

`RunOverviewPanel` gains three rows, all from data the API returns:

| Row | Source | When absent |
| --- | --- | --- |
| Provider mode | `run.providerMode` (**already** present) | never |
| Model | `run.modelIdentifier` (**already** present) | `—` for FAKE |
| Duration | existing `formatDuration(...)` | already handled |
| Estimated cost | `run.estimatedCostUsd` — a **string**, §12.2 | row hidden entirely |

Rules enforced by test: **never claim LIVE when the persisted mode is FAKE** (the badge renders
`run.providerMode` verbatim; the *requested* mode is never displayed); **never hide a backend
rejection by falling back to FAKE** (a 401/429/503 surfaces as an error banner; no retry, no
silent selector switch); a null cost renders **nothing**, never `$0.00`.

### 9.5 Summary length affordance

Live counter plus a disabled submit below 15 trimmed characters:

```text
Describe the issue in at least 15 characters.
8 / 15
```

`canSubmit` changes from `trimmedSummary.length > 0` to
`trimmedSummary.length >= 15 && trimmedSummary.length <= 2000`. Affordance only — **the backend
remains authoritative** (§14).

---

## 10. Admission resources and reconciliation safety

### 10.1 Explicit resources, not an opaque settle

Revision 2's `admission.settle(admitted, usage)` inside a `finally` conflated reconciliation with
lease release, so a reconciliation throw would both replace the real response and leak the
concurrency slot. Admission now returns its resources explicitly:

```ts
export interface LiveRunConcurrencyLease { release(): void; }        // idempotent

export interface LiveRunAdmission {
  readonly reservationInput: LiveRunBudgetReservationInput;          // consumed inside the run transaction (§11.5)
  readonly concurrencyLease: LiveRunConcurrencyLease;
}
```

### 10.2 Cleanup structure

See §5.3 for the full controller. The invariants, asserted by test:

```text
reconciliation failure
→ logged at error level
→ never overrides the run response or result
→ never prevents concurrency release
```

The nested `try/finally` guarantees the last point structurally: the lease release sits in the
inner `finally`, so it runs whether reconciliation succeeded, threw, or was skipped.

### 10.3 Getting the usage summary out on every path

`AgentRunService` **converts all expected provider and run failures into returned finalized
results, never throws** — that is exactly what §5.4 buys, and it means the normal path always
has `result.usageSummary` available.

The residual case is an unexpected exception (a genuine crash, or a persistence failure). Two
sub-cases:

- **Persistence failure** returns the `unavailable` variant, which carries the usage summary
  when a provider call occurred (§12.3) — so reconciliation still runs.
- **A genuine crash** rethrows `AgentRunServiceError`. That error gains a safe internal
  `executionContext?: { usageSummary: RunProviderUsageSummary | null; reservation: LiveRunBudgetReservation | null }`
  captured before the rethrow. The controller reads it in the `finally` via `usageSummaryOf` /
  `reservationOf`, which accept either a result or a thrown `AgentRunServiceError`. This context
  is internal only — it is never serialized into an HTTP response.

The reconciliation failure log is a fixed-shape structured line carrying `budgetDate`, `runId`,
and the error's `name`/`message` **only** — no credential, no demo token, no prompt, no provider
response body, no stack trace.

### 10.4 Tests

Reconciliation failure after a successful run (201 + the run is still returned); after a failed
run (201 + the FAILED run is still returned); concurrency released in both; the original
HTTP status and body preserved byte-for-byte; the structured error log emitted exactly once; and
the log asserted to contain no credential, token, prompt, or provider body.

---

## 11. Live admission: canonical order

### 11.1 The order — identical in code, tests, and every document

```text
 1. validate requested provider mode                     → REQUEST_BODY_INVALID (400)
 2. verify LIVE capability/configuration                 → LIVE_NOT_CONFIGURED (503)
 3. kill switch                                          → LIVE_RUNS_DISABLED (503)      [PR 6B1]
 4. shared access token                                  → LIVE_RUN_ACCESS_DENIED (401)
 5. per-client rate limit                                → LIVE_RUN_RATE_LIMITED (429)
 6. optional non-authoritative pre-checks (attempts, budget)  → fast 429, advisory only
 7. acquire concurrency lease                            → LIVE_RUN_CONCURRENCY_LIMIT (429)
 8. AUTHORITATIVE TRANSACTION (§11.5):
       lock AgentJob → verify job → count LIVE runs → reserve daily budget → insert AgentRun
                                                         → AGENT_JOB_NOT_FOUND (404)
                                                         → LIVE_RUN_ATTEMPT_LIMIT (429)
                                                         → LIVE_RUN_BUDGET_EXHAUSTED (429)
       COMMIT — the transaction is closed before any provider call
 9. execute orchestrator (provider turns, under the composed signal)
10. resolve abort provenance; finalize the run with usage metadata
11. reconcile budget from the returned reservation + usage summary   (exception-safe, §10)
12. release the concurrency lease                                     (always, §10.2)
```

Steps 4–8 are skipped entirely for FAKE; step 1 applies to every request. Step 6 exists only to
fail obvious cases cheaply; it is explicitly **not** the enforcement point and the plan never
describes it as one.

Concurrency (7) is acquired **before** the authoritative transaction (8) so a request that loses
the concurrency race touches no durable state at all.

### 11.2 Rate limiting

An in-process fixed-window guard (`Map<string, {count, windowStartMs}>` with pruning) rather than
`@nestjs/throttler`: the free plan is single-instance, so throttler's default in-memory storage
gives the same guarantee; its distributed story needs a Redis instance that does not exist here;
and it would add a production dependency for ~60 reviewable lines. `@nestjs/throttler` is the
right answer the moment this becomes multi-instance, and its surface (`ThrottlerModule.forRoot`,
`ThrottlerGuard`, `getTracker`, pluggable `ThrottlerStorage`) maps 1:1, so the swap is
mechanical. Recorded in the PR description.

| Aspect | Decision |
| --- | --- |
| Identity | `req.ip`, after `app.set("trust proxy", TRUST_PROXY_HOPS)` |
| Trusted forwarding | a **numeric hop count** (default `1`). `trust proxy: true` is **not** used — it takes the leftmost `X-Forwarded-For` entry, i.e. whatever the client sent |
| Scope | the live admission path only |
| Window / limit | 60 s fixed / 2 per identity |
| Response | `429`, `Retry-After: <seconds to window end>` |
| Headers | no `X-RateLimit-*` — they leak the limit and remaining quota for no operator benefit |
| Persistence | none; per-process, reset on restart — documented |

### 11.3 Proxy/IP caveat — requires empirical verification

Express's documentation warns that configuring more hops than exist lets a client supply any
value. The chain length behind Render is **not authoritatively documented**, and this plan makes
no claim about whether Render strips, replaces, or appends a client-supplied `X-Forwarded-For`.

> **REQUIRES EMPIRICAL VERIFICATION.** Before `TRUST_PROXY_HOPS` is trusted, send a request to
> the deployed service with a known bogus `X-Forwarded-For` and log `req.ips` alongside
> `req.socket.remoteAddress`. Record the result in `docs/08-cicd-deployment.md`. Until then,
> treat client-supplied `X-Forwarded-For` as untrusted and rely on the global caps.

**Per-IP rate limiting raises the cost of casual abuse. It is not a spend guarantee, and it is
not identity.**

### 11.4 Concurrency limiting

Per-instance counting semaphore, limit `1`. **Reject, never queue** — queuing a request whose own
deadline is 120 s converts a fast, honest 429 into a slow timeout and gives an attacker a free
way to pin memory. The lease is released in §10.2's inner `finally` on **every** exit path:
success, orchestrator failure, provider failure, deadline abort, client disconnect, transaction
rejection, persistence failure, and reconciliation failure. `release()` is idempotent.

Honest limitation: per-instance. On the free single-instance plan it is also the global limit; on
any multi-instance plan it is not.

### 11.5 Atomic per-job attempt limit and budget reservation

A read-then-check admission query (`count LIVE runs; if count < 2, continue`) is race-prone, so
the cap would not be hard. **Enforcement moves inside the transaction that creates the run** —
the same transaction that already row-locks the `AgentJob` to allocate `attempt_number`.

New repository method:

```ts
startLiveRunWithAttemptLimit({
  jobId,
  modelIdentifier,
  maxLiveAttempts,
  budget: { budgetDate, dailyLimit, costCeilingNanoUsd },
}): Promise<StartedLiveRun>          // { run, job, reservation }
```

Fixed lock order, one transaction:

```text
BEGIN
  1. SELECT … FROM agent_jobs WHERE id = $jobId FOR UPDATE      -- existing lock, reused
       not found                        → rollback → AGENT_JOB_NOT_FOUND (404)
  2. SELECT count(*) FROM agent_runs WHERE job_id = $jobId AND provider_mode = 'LIVE'
       count >= maxLiveAttempts         → rollback → LIVE_RUN_ATTEMPT_LIMIT (429)
  3. INSERT INTO live_run_budget … ON CONFLICT (budget_date) DO UPDATE
       SET runs_reserved = runs_reserved + 1
       WHERE runs_reserved < $dailyLimit
         AND estimated_cost_nano_usd < $costCeilingNanoUsd
         AND pricing_unknown_runs = 0
       RETURNING budget_date, runs_reserved
       zero rows                        → rollback → LIVE_RUN_BUDGET_EXHAUSTED (429)
  4. allocate attempt_number; INSERT INTO agent_runs (…, provider_mode='LIVE', …)
COMMIT
```

**The transaction commits before any provider call.** A 120-second orchestration must never run
inside an open transaction holding a row lock on `AgentJob` and the day's budget row.

This buys four properties the smaller alternative cannot:

- **attempt-limit rejection consumes no reservation** (same transaction, rolled back);
- **a missing job consumes no reservation**;
- **budget failure creates no run**;
- **no race** — two concurrent requests for the final allowed attempt serialize on the
  `AgentJob` row lock, so exactly one wins.

Only with this design is the per-job cap called **hard**. FAKE keeps the existing `startRun` path
unchanged — two repository methods, no shared-path refactor, no unnecessary scope.

The rejected alternative (reserve before `startRun`) is recorded in §25: it is spend-safe but
lets a caller burn the daily quota with requests naming a nonexistent job, which is a trivially
cheap way to take the demo offline.

### 11.6 Tests

Fixed-window boundary with an injected clock; independent buckets; `Retry-After` correctness;
pruning; FAKE never limited; semaphore accounting; lease released on all eight exit paths.

**Concurrent PostgreSQL tests** for §11.5:

- two requests race for the final allowed attempt → **exactly one** succeeds;
- the loser receives `LIVE_RUN_ATTEMPT_LIMIT`;
- **no third LIVE run row exists** afterwards;
- the loser's transaction consumed **no** budget reservation (`runs_reserved` incremented once);
- a request naming a nonexistent job consumes no reservation;
- a budget-exhausted request creates no `agent_runs` row;
- FAKE runs do not count toward the LIVE attempt limit.

---

## 12. Per-run usage: collection, exactness, ownership

### 12.1 Why a collector

Budget reconciliation and the run audit both need each run's real token usage and cost.
Parsing the structured log stream to recover them would be fragile and untestable.
`ClaudeLlmProvider` already accepts an injected `logger` and already emits every needed field, so
the collector is a **second consumer of an existing callback**, not new instrumentation.

```ts
export interface RunProviderUsageCollector {
  record(event: ClaudeProviderLogEvent): void;
  snapshot(): RunProviderUsageSummary;
}

export interface RunProviderUsageSummary {
  readonly providerCallsObserved: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreation5mInputTokens: number;
  readonly cacheCreation1hInputTokens: number;
  readonly estimatedCostNanoUsd: bigint | null;
  readonly pricingStatus: "CURRENT" | "STALE" | "UNKNOWN_MODEL" | "INSUFFICIENT_USAGE_DETAIL";
  readonly possibleUnobservedCost: boolean;
}
```

Lives in `packages/provider-claude` — it consumes a Claude-specific event type, so it belongs
beside the adapter, not in the neutral runtime.

### 12.2 Exact nanoUSD, end to end

Converting `estimatedCostUsd: number` back into nanoUSD would reintroduce the floating-point
loss that `cost-estimation.ts` was written to avoid. The money path carries **integers only**:

```text
pricing calculation                 totalNanoUsd() returns bigint          (agent-runtime)
  → CostEstimate.estimatedCostNanoUsd: string | null                       (decimal string)
  → ClaudeProviderLogEvent.estimatedCostNanoUsd: string | null             (replaces estimatedCostUsd)
  → collector: BigInt(event.estimatedCostNanoUsd), summed as bigint
  → agent_runs.estimated_cost_nano_usd  BigInt?                            (persisted)
  → live_run_budget.estimated_cost_nano_usd  BigInt                        (reconciled, bigint add)
  → API DTO: estimatedCostUsd: string | null                               (formatted for display)
```

There is **no reverse conversion from a decimal USD number anywhere**, and no `bigint` is ever
handed to `JSON.stringify` — the DTO mapper formats it to a fixed-precision decimal string at the
boundary:

```json
{ "estimatedCostUsd": "0.017956" }
```

**Money is never a JSON number.** `CostEstimate` keeps `estimatedCostUsd: number | null` only if
an existing consumer needs it for display; the *accounting* input is always the string field.

Tests: exact round trip (`bigint → string → BigInt` identity); multi-turn sum; synthetic values
above `Number.MAX_SAFE_INTEGER` surviving intact; no `bigint` reaching `JSON.stringify`; the UI
receiving a string; and `null` staying `null` and never rendering `$0.00`.

### 12.3 Ownership — `AgentRunService`, not the controller

Revision 2 had the controller create the collector *and* claimed finalization persisted usage —
impossible, since the service would have to write data it never received. **The service owns the
collector lifecycle.**

```ts
export interface AgentRunUsageHooks { createCollector(): RunProviderUsageCollector; }

export interface ExecuteAndPersistParams {
  // existing fields …
  createProvider(job: AgentJobRecord, collector?: RunProviderUsageCollector): LlmProvider;
  usageHooks?: AgentRunUsageHooks;
  abortContext?: RunAbortContext;
  liveAttemptLimit?: number;
  budgetReservationInput?: LiveRunBudgetReservationInput;
}
```

LIVE flow, inside `executeAndPersist`:

```text
startLiveRunWithAttemptLimit  (§11.5 — returns run, job, reservation)
→ create ONE collector via usageHooks.createCollector()
→ createProvider(job, collector)
→ run the orchestrator
→ snapshot the collector EXACTLY ONCE
→ resolve the abort provenance override (§8.2)
→ finalizeCompleted / finalizeFailed WITH the usage metadata
→ return the persisted run, the usage summary actually persisted, and the reservation
```

FAKE flow: no collector, no usage persistence, usage columns stay `NULL`.

**Result type.** The prompt's flat `{ run, report, usageSummary }` cannot be adopted verbatim —
the existing `ExecuteAndPersistResult` is a discriminated union whose `unavailable` variants the
controller maps to 503/409 via `mapDomainError` (§2.4). Collapsing it would silently drop that
error contract. The union is **extended** instead:

```ts
| { persistence: "persisted";   run: PersistedAgentRun;
    usageSummary: RunProviderUsageSummary | null;
    reservation: LiveRunBudgetReservation | null }
| { persistence: "unavailable"; stage: "run-creation";  error: PersistenceError }
    // no provider call happened — no usage, no reservation
| { persistence: "unavailable"; stage: "finalization";  runId; agentResult; error;
    usageSummary: RunProviderUsageSummary | null;
    reservation: LiveRunBudgetReservation | null }
    // provider calls DID happen — the budget must still be reconciled
```

This guarantees the properties the milestone needs: POST and a later GET show the same persisted
usage and cost; both successful and failed LIVE runs persist usage; there is exactly **one**
authoritative snapshot; budget reconciliation and the run audit use identical numbers; and there
is **no second patch/update after finalization**.

### 12.4 Aggregation rules

Token counts sum. Cost sums as `bigint`. `providerCallsObserved` counts
`outcome: "response_received"` events, deduplicated by `providerRequestId` (a repeat is ignored,
never double-counted); `error` events carry no request ID and are counted by arrival, which
cannot double-count because the adapter emits exactly one terminal event per `runAgentTurn`.

Pricing status across turns is the worst observed:
`UNKNOWN_MODEL > INSUFFICIENT_USAGE_DETAIL > STALE > CURRENT`. A `null` cost on any turn makes
the total `null`.

| Scenario | Calls | Cost | `possibleUnobservedCost` |
| --- | --- | --- | --- |
| Both turns succeed | 2 | sum | false |
| Turn 1 succeeds, turn 2 fails | 1 | turn 1 | per the table below |
| No provider call (e.g. `createProvider` threw) | 0 | `0n` | false |
| Turn 1 fails | 0 | `0n` | per the table below |
| Any turn reports a `null` cost | unchanged | `null` | **true** |

**Fail closed on ambiguity**, from `terminalErrorCategory`:

| Category | Provably rejected before inference? | `possibleUnobservedCost` |
| --- | --- | --- |
| `AUTHENTICATION` (401/403) · `BILLING` (402) · `RATE_LIMIT` (429) · `REQUEST_INVALID` (400/404/409/413/422) | yes | false |
| `CONNECTION` · `TIMEOUT` · `CANCELLED` · `SERVER_ERROR` · `UNKNOWN` | no | **true** |

When true: `pricing_unknown_runs` is incremented and the cost gate closes for the rest of that
UTC day (the reservation `WHERE` clause in §11.5 requires `pricing_unknown_runs = 0`).
**A null or unobserved cost is never reconciled as a known `$0`.**

**Documented blind spot:** with `ANTHROPIC_MAX_RETRIES = 1`, a turn that fails once and succeeds
on retry reports only the final attempt's usage; an abandoned-but-billed first attempt is not
observable. The cost estimate is therefore a **lower bound**. The hard control — the daily run
count — is unaffected. Stated in `docs/08-cicd-deployment.md`, not papered over.

### 12.5 Tests

Aggregation across two turns; partial success then failure; zero calls; every error category's
`possibleUnobservedCost`; duplicate `providerRequestId` ignored; pricing-status precedence;
`bigint` arithmetic with no float intermediate; a `null` cost producing a `null` total plus
`possibleUnobservedCost: true`; a FAKE run never constructing a collector; and — the ownership
property — that the value in `agent_runs` equals the value used for reconciliation, byte for
byte, in the same test.

---

## 13. Token and cost budget

### 13.1 Three tiers, kept separate

**Tier 1 — hard pre-run safeguards** (enforced before any Anthropic call):

| Control | Value | Mechanism |
| --- | --- | --- |
| Max provider turns per run | **2** | `MAX_PROVIDER_TURNS` — unchanged |
| Max output tokens per turn (API LIVE) | **1024** | `LIVE_RUN_MAX_OUTPUT_TOKENS` → `AgentOrchestratorParams.maxOutputTokens` |
| Max input per run | 32 KB body + `summary` ≤ 2000 + `ticketId` ≤ 64 | existing parser + §14 |
| Live runs per UTC day | **10** | `LIVE_RUN_DAILY_LIMIT`, reserved inside the run transaction |
| Live attempts per job | **2** | `LIVE_RUN_MAX_ATTEMPTS_PER_JOB`, **atomic** (§11.5) |
| Concurrent live runs | **1** | `LIVE_RUN_MAX_CONCURRENCY` |
| Live requests per minute per client | **2** | `LIVE_RUN_RATE_LIMIT_MAX` |

**Worst-case daily output cost, exactly:**

```text
1024 output tokens/turn × 2 turns × 10 runs = 20,480 output tokens/day
20,480 × 10,000 nanoUSD/token (claude-sonnet-5 introductory output rate, $10/MTok)
= 204,800,000 nanoUSD = $0.2048/day
```

Hard-bounded by construction, dependent on no post-run measurement. Input tokens are bounded per
run by the body cap, the 2000-character summary, and the fixed system prompt and tool schemas,
but are not a single constant — at a generous 5 000 input tokens per turn the input side adds
≈ $0.20/day at the $2/MTok introductory rate, so total expected spend sits well under the $1.00
ceiling. The output figure is exact; the input figure is an estimate with its assumption named.

**Tier 2 — post-run accounting:** the snapshot is added to the day's row and compared against
`LIVE_RUN_DAILY_COST_CEILING_USD` (default `1.00`); crossing it refuses subsequent runs for the
rest of the UTC day.

> The daily **run count** is hard.
> The daily **cost estimate** stops later runs after reconciliation.
> Actual spend can exceed the estimate ceiling by one bounded run.

The $1.00 figure is **not** a hard dollar cap and is never described as one.

**Tier 3 — best-effort:** per-IP rate limiting, the per-instance concurrency lease, and the
environment kill switch. Each is defeatable or resettable, and documented as such.

### 13.2 Reservation and reconciliation

```ts
export interface LiveRunBudgetReservationInput {
  readonly budgetDate: string;             // "YYYY-MM-DD" UTC, captured at admission
  readonly dailyLimit: number;
  readonly costCeilingNanoUsd: bigint;
}
export interface LiveRunBudgetReservation {
  readonly budgetDate: string;             // echoed back from the transaction
  readonly runsReserved: number;
}
```

Reservation SQL is step 3 of §11.5's transaction. Reconciliation is a separate autocommit
statement, keyed on **the reservation's** `budgetDate`:

```sql
UPDATE live_run_budget
   SET runs_completed          = runs_completed + 1,
       estimated_cost_nano_usd = estimated_cost_nano_usd + $observedNanoUsd,
       pricing_unknown_runs    = pricing_unknown_runs + $unknownIncrement
 WHERE budget_date = $reservation.budgetDate;      -- NEVER a recomputed "today"
```

**Never recompute "today" during reconciliation.** A run reserved at `2026-07-28T23:59:50Z` and
finishing at `2026-07-29T00:00:30Z` reconciles the **2026-07-28** row. Recomputing would credit
the new day while leaving yesterday's reservation permanently unreconciled.

| Situation | Accounting |
| --- | --- |
| Run completes | `runs_completed += 1`; observed cost added |
| Run fails after ≥1 provider call | `runs_completed += 1`; observed cost added — the tokens were spent |
| Refused at steps 2–7 | no reservation taken |
| Rejected inside the transaction (job, attempts, budget) | transaction rolled back — **no reservation consumed** |
| Deadline abort / disconnect | `runs_completed += 1`; cost if observed; `possibleUnobservedCost` → `pricing_unknown_runs += 1` |
| Persistence failure after a provider call | reconciled from the `unavailable/finalization` variant (§12.3) |
| `possibleUnobservedCost` or `null` cost | cost contribution `0` **and** `pricing_unknown_runs += 1`, closing the cost gate |

Reservations are **never released** once committed. A leaked reservation costs the demo one run
of ten; a released reservation on a request that did spend money costs real dollars.

UTC reset is implicit — a new day gets a new row, no cron. Process restart is irrelevant.
Multiple instances share the table correctly.

### 13.3 Visibility

No public budget endpoint. One structured line per admission decision
(`event`, `decision`, `budgetDate`, `runsReserved`, `runsCompleted`, `estimatedCostNanoUsd`,
`pricingStatus`, `possibleUnobservedCost`), plus the per-turn provider event. `/v1/capabilities`
exposes only the opaque pair in §9.2.

---

## 14. Input validation

| Field | Rule |
| --- | --- |
| `ticketId` | 1–64 characters |
| `summary` | **trimmed** 15–2000 characters |

Trim once at the API contract boundary; validate the trimmed value; persist it normalized:

```ts
export const TicketContextSchema = z.object({
  ticketId: z.string().trim().min(1).max(64),
  summary:  z.string().trim().min(15).max(2000),
}).strict();
```

`z.string().trim()` transforms before the length checks, so `min`/`max` see the trimmed value and
the parsed output — which `createAgentJob` persists — is already normalized. No downstream
re-trim. Failures flow through the existing pipe → `REQUEST_BODY_INVALID` (400).
`createDeterministicScenario`'s 200-character truncation is unchanged and still correct.

**The backend is authoritative.** §9.5's counter and disabled button are an affordance; a request
that bypasses the UI with `summary.trim().length < 15` still receives 400.

Tests: 14 rejected; 15 accepted; leading/trailing whitespace accepted and stored trimmed;
whitespace-only rejected; 2000 accepted; 2001 rejected; `ticketId` 64/65; frontend counter and
disabled button at 8 vs 15; and a UI-bypassing request rejected by the API integration suite.

---

## 15. Persistence and migration design

### 15.1 What needs no change

Per-run provider mode (`provider_mode` is already `String`, `ProviderMode` already
`"FAKE" | "LIVE"`, `startRun` already takes a `modelIdentifier`); model metadata; new failure
codes (`failure_code` is `String`); the run audit trail; limiter state (deliberately in memory).

### 15.2 One migration, two additions (PR 6B2)

```prisma
model LiveRunBudget {
  budgetDate            DateTime @id @map("budget_date") @db.Date
  runsReserved          Int      @default(0) @map("runs_reserved")
  runsCompleted         Int      @default(0) @map("runs_completed")
  estimatedCostNanoUsd  BigInt   @default(0) @map("estimated_cost_nano_usd")
  pricingUnknownRuns    Int      @default(0) @map("pricing_unknown_runs")
  updatedAt             DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@map("live_run_budget")
}

model AgentRun {
  // … existing fields unchanged …
  providerCallsObserved  Int?     @map("provider_calls_observed")
  inputTokens            Int?     @map("input_tokens")
  outputTokens           Int?     @map("output_tokens")
  estimatedCostNanoUsd   BigInt?  @map("estimated_cost_nano_usd")
  pricingStatus          String?  @map("pricing_status")
  possibleUnobservedCost Boolean? @map("possible_unobserved_cost")
}
```

**Resolved (§27): the six `AgentRun` columns are accepted.** They are nullable and additive, no
existing query changes, and FAKE rows stay `NULL`. They exist for four concrete reasons: the UI's
cost figure survives a page refresh; daily totals are auditable per run; successful and failed
LIVE runs are comparable; and reconciliation and the audit read the same number by construction
(§12.3). They ride in the same migration as `live_run_budget` — no second migration.

An index on `agent_runs (job_id, provider_mode)` is added to support §11.5's in-transaction count.

| Aspect | Decision |
| --- | --- |
| Budget PK | `budget_date` (`DATE`) — one row per UTC day; the PK is the only access path |
| Cost units | `BigInt` **nanoUSD** everywhere; no floats in the money path |
| Constraints | `CHECK` non-negative on all four budget counters; `CHECK (estimated_cost_nano_usd IS NULL OR >= 0)` on `agent_runs` |
| Transaction boundaries | Reservation is **inside** the run-creation transaction (§11.5), which commits before any provider call. Reconciliation is a separate autocommit statement so the budget stays durable even if the run's own persistence failed. |
| Lock order | `AgentJob` → `LiveRunBudget` → `AgentRun` insert. One job row and one budget row per request; a global, fixed order, so no deadlock is possible. |
| Failure recovery | Failed reservation → the whole transaction rolls back, no run created. Failed reconciliation → logged, response preserved, lease released (§10). |
| Rollback | `DROP TABLE live_run_budget;` + `ALTER TABLE agent_runs DROP COLUMN …` ×6 + drop the index. Nothing references them; reverting the code alone is also safe. |
| Drift verification | `pnpm db:migrate:drift`, already in CI |
| `BigInt` handling | never `JSON.stringify`'d; the DTO mapper formats a decimal USD **string** (§12.2) |

### 15.3 Integration tests

Reservation below the limit succeeds and returns `{ budgetDate, runsReserved }`; at the limit
returns zero rows and the transaction rolls back; N parallel transactions never exceed the limit;
reconciliation accumulates; **cross-midnight** (reserve `2026-07-28T23:59:50Z`, reconcile
`2026-07-29T00:00:30Z`, assert the 28th's row updated and no 29th row exists); a
`possibleUnobservedCost` run closes the gate for the next reservation; a new UTC date starts a
fresh row; `CHECK` constraints reject negatives; a LIVE run persists its usage columns and a FAKE
run leaves them `NULL`; plus §11.6's concurrent attempt-limit races.

---

## 16. HTTP contract

### 16.1 The rule

**Where the failure happens decides the status.**

**Admission failure — before any `AgentRun` exists.** No run is created; an error envelope is
returned:

| Cause | Status | Code |
| --- | --- | --- |
| Invalid `providerMode`, short summary, bad body | 400 | `REQUEST_BODY_INVALID` |
| Missing/incorrect demo token | 401 | `LIVE_RUN_ACCESS_DENIED` |
| Job not found (inside the transaction) | 404 | `AGENT_JOB_NOT_FOUND` |
| Rate limit / concurrency / attempt limit / budget | 429 | `LIVE_RUN_*` |
| Capability absent / kill switch off | 503 | `LIVE_NOT_CONFIGURED` / `LIVE_RUNS_DISABLED` |

**Failure after the `AgentRun` row exists — `201 Created`** with the persisted run resource and
the usual `Location` header:

```json
{ "data": { "run": { "status": "FAILED", "failureCode": "PROVIDER_TIMEOUT" }, "trace": [ … ] } }
```

This covers provider unavailable, provider timeout, provider cancellation **while the connection
is still writable**, and orchestrator/domain failures. The rationale is that the run resource
genuinely was created: the UI gets a `runId`, the timeline and failure details stay reachable, a
later `GET` is consistent, and no run hides behind an unrelated error envelope.

**Actual client disconnect:** the connection is gone, so no response body is written at all. The
run still finalizes `FAILED` with `PROVIDER_CANCELLED`.

Consequently `AGENT_PROVIDER_UNAVAILABLE` (502) and `AGENT_RUN_TIMED_OUT` (504) are **removed as
public controller errors** — they were contradictory with a finalized run resource. The
distinctions survive where they are useful: as `failure_code` on the row, as the internal
provider category in structured logs, and in the trace.

### 16.2 Still-unchanged codes

`REQUEST_BODY_TOO_LARGE` (413), `ROUTE_PARAMETER_INVALID` (400), `PERSISTENCE_CONFLICT` (409),
`PERSISTENCE_UNAVAILABLE` (503 — the `unavailable` variants, where the run was never created or
never finalized), `AGENT_EXECUTION_CRASHED` (500 — genuine crashes only, where no finalization
happened), `INTERNAL_ERROR` (500). **Invalid configuration has no HTTP code** — it fails startup.

### 16.3 What never appears in a public response

Anthropic response bodies, prompts, headers, or request IDs; credentials; the shared demo token;
stack traces; the offending request body; SQL; the internal provider error category; and any
budget figure or count.

---

## 17. Docker and Render changes

### 17.1 `Dockerfile`

Add `packages/provider-claude/package.json` to the `deps` and `prod-deps` stages; copy its `dist`
into `runtime`; extend the build assertions:

```dockerfile
 && (cd /app/apps/api && node -e "require.resolve('@opspilot/database'); require.resolve('@opspilot/agent-runtime'); require.resolve('@opspilot/provider-claude')") \
 && (cd /app/packages/provider-claude && node -e "require.resolve('@anthropic-ai/sdk')") \
```

Build order is already handled by each package's `build:deps`. The single-layer
`COPY --from=prod-deps /app /app` stays as-is. `ANTHROPIC_API_KEY` is not an `ENV` and is never
baked into a layer. `AGENT_RUN_PROVIDER_MODE=FAKE` stays the image default, so a container run
with no configuration is deterministic, has capability absent, and makes no network call.

### 17.2 CI image-boundary checks

Replace the now-false assertion with a positive one:

```diff
-  ! test -d /app/node_modules/@anthropic-ai
   ! test -d /app/node_modules/voyageai
```

plus `require.resolve` checks as above. `docs/08-cicd-deployment.md` §13's table changes to:
`@anthropic-ai/sdk` — **present**, in the server-side API dependency path only
(`packages/provider-claude`), never in `apps/web` or any public frontend asset; `voyageai` —
absent (still worker-only).

### 17.3 Frontend bundle guard

Three rules added, each with a unit-test case:

| Rule | Pattern |
| --- | --- |
| `provider-secret-env-name` | `/\bANTHROPIC_API_KEY\b/` |
| `provider-sdk` | `/@anthropic-ai\/sdk/` |
| `provider-credential-literal` | `/\bsk-ant-[A-Za-z0-9_-]{8,}/` |

`LIVE_RUN_ACCESS_TOKEN` is deliberately **not** a pattern: its value never exists at build time,
and a rule matching the *header name* would fire on the legitimate §9.3 client code. The
structural guarantee — the token is typed by a human into memory-only state and never read from
config — is what protects it, and §9.3's tests assert it.

### 17.4 `render.yaml`

`AGENT_RUN_PROVIDER_MODE: FAKE` (now documented as the **default request mode**);
`LIVE_AGENT_RUNS_ENABLED: "false"` **shipped in PR 6B1**; the deadline; all safeguard knobs with
committed values; `TRUST_PROXY_HOPS: "1"` annotated *REQUIRES EMPIRICAL VERIFICATION*;
`DATABASE_URL`, `ANTHROPIC_API_KEY`, and `LIVE_RUN_ACCESS_TOKEN` as `sync: false`. The file's
header comment is updated.

### 17.5 Health, capability, startup, rollback

`/v1/health/ready` stays service-and-database readiness only — it must not depend on the
provider, or a provider outage becomes a deploy failure. `/v1/capabilities` is computed from
local state only and issues no provider call. Invalid live configuration fails startup, so the
health check never passes and the previous deploy keeps serving — a bad key cannot take the demo
down, it just fails to roll forward. Rollback: `LIVE_AGENT_RUNS_ENABLED=false` (fastest, no
rebuild), or redeploy the previous commit. FAKE behaviour is unchanged in every respect.

---

## 18. Rollout and rollback

| # | Stage | Gate |
| --- | --- | --- |
| 1 | Local FAKE regression: `pnpm typecheck && pnpm test && pnpm build && pnpm test:integration:sequential` green | — |
| 2 | Local API LIVE opt-in: key in a local shell only, `LIVE_AGENT_RUNS_ENABLED=true`, one `{"providerMode":"LIVE"}` run verifying persisted mode, model, trace, report, usage columns, and budget row | **Owner authorization — this spends money** |
| 3 | Docker smoke: image builds, boundary checks pass, container serves FAKE end to end (CI, per PR) | — |
| 4 | Deploy **PR 6B1**. Capability absent, kill switch `false`, no key on Render. **Public LIVE is impossible**: a direct `{"providerMode":"LIVE"}` call returns 503. | — |
| 5 | Deploy **PR 6B2** — safeguards, migration, UI — still with no key and the switch `false`. Verify the migration applied, drift is clean, `/v1/capabilities` reports `UNAVAILABLE`/`NOT_APPLICABLE`, and the LIVE option renders disabled with its reason. | — |
| 6 | Run the §11.3 proxy measurement; record `TRUST_PROXY_HOPS` | — |
| 7 | Set `ANTHROPIC_API_KEY` and `LIVE_RUN_ACCESS_TOKEN`; Save and deploy. Capability present, switch still `false` → LIVE still refused. | **Owner authorization — adding the real key** |
| 8 | Set `LIVE_AGENT_RUNS_ENABLED=true`; Save and deploy. `/v1/capabilities` now reports `AVAILABLE`/`TOKEN_REQUIRED`; the token field appears in the UI. | **Owner authorization — enabling paid runs** |
| 9 | Safeguards verification: token required (401 without); rate limit fires on the 3rd request in a minute; concurrency rejects; attempt limit rejects the 3rd LIVE run on one job; budget refuses at 10; deadline yields a `FAILED` run with `PROVIDER_TIMEOUT` returned as **201**; cross-midnight reconciliation observed or simulated | **Owner authorization — paid deployed smoke** |
| 10 | Soak: watch the budget for a full UTC day, token in place | — |
| 11 | Kill-switch test: `false` → Save and deploy → LIVE returns 503, FAKE unaffected → restore | — |
| 12 | Rollback drill: switch `false` and remove the key → the deterministic demo works with no key present | — |

**The rollout ends here, with token-protected LIVE.** Removing `LIVE_RUN_ACCESS_TOKEN` is *not*
planned and is not a soak outcome — it is a later, explicit security and product decision (§27).

Stages 7 and 8 are deliberately separate deploys: because the kill switch defaults to `false`,
adding the key is not sufficient to start spending.

---

## 19. Testing strategy

### 19.1 Deterministic — no Anthropic key, no network, normal CI

| Area | Tests |
| --- | --- |
| Package relocation | boundary test from its new location (incl. the no-`@opspilot/database` rule); an export-surface test resolving every documented name through **both** a named and a default import |
| Worker reuse | existing suites pass from the new location; the smoke compiles against the new specifier and the new cost field |
| API FAKE regression | every existing test passes byte-identically, incl. absent-body and `{}` requests |
| Per-run selection | FAKE/LIVE/absent/invalid bodies (§5.1); no silent downgrade on any path |
| Capability | each §6.1 row; partial configs fail startup and construct no network-capable object |
| Kill switch | default `false` refuses LIVE with 503 while FAKE succeeds; `true` permits; `"TRUE"` fails startup — **in PR 6B1** |
| Secret redaction | key absent from `JSON.stringify` / `util.inspect` / `Object.keys` / spread, from every HTTP body and log line; no `req_` identifier in any response |
| Disconnect adapter | §7.3's six cases |
| Abort provenance | §8.5's five cases |
| Deadline | expiry yields `PROVIDER_TIMEOUT`, a `FAILED` run, and **201** — never an orphaned `RUNNING` row |
| Admission order | §11.6, incl. lease release on all eight exit paths |
| Atomic attempt limit | §11.6's concurrent PostgreSQL races |
| Usage collector | §12.5, incl. persisted value == reconciled value |
| nanoUSD path | §12.2's six cases |
| Budget | unit arithmetic, UTC rollover, stale-pricing fail-closed; integration incl. cross-midnight (§15.3) |
| Reconciliation safety | §10.4's six cases |
| Validation | §14's table |
| HTTP contract | admission failures produce the §16.1 statuses; every post-creation failure produces **201** with the persisted FAILED run; a disconnect writes no body |
| Capability endpoint | shape; `UNAVAILABLE` for all three causes indistinguishably; no counts, no budget, no probe |
| Token handling | header sent only for LIVE; absent for FAKE; never in storage/URL/log; `type="password"`; cleared on mode switch |
| UI | selector default; approval checkbox hidden in LIVE; LIVE disabled with a reason; badge shows the **persisted** mode; a 429 does not fall back to FAKE; null cost renders no row; counter at 8 vs 15 |
| Docker boundary | CI `docker-smoke` (§17.2) |
| Frontend isolation | `forbidden-patterns.test.ts` + `check:bundle` |

### 19.2 Opt-in live tests

`apps/worker`'s `test:claude:live` is unchanged and still requires `OPSPILOT_LIVE_SMOKE=1` in
addition to a key — checked separately from the provider mode so an exported LIVE setting is
never mistaken for an intent to spend money now. PR 6B adds an equivalent `apps/api` script under
the same double gate, invoked by no CI step.

### 19.3 CI invariant

Normal CI makes **no** Anthropic request and requires **no** credential; the workflow references
no `secrets.*`. `docs/08-cicd-deployment.md` §7's reason 2 becomes: "CI runs with live capability
absent, so a LIVE request is refused at admission step 2; and even with capability, the kill
switch defaults to `false`."

---

## 20. Documentation updates

| File | Change |
| --- | --- |
| `README.md` | `packages/provider-claude`; per-run `FAKE \| LIVE`; safeguard summary; limitations pointer |
| `docs/04-agent-design.md` | per-run selection; the deadline seam and its scope; new `PROVIDER_*` codes; abort provenance |
| `docs/08-cicd-deployment.md` | §7's reasons; §13's boundary table; new env vars; safeguards; Render secrets; the Save-and-deploy caveat; the `TRUST_PROXY_HOPS` measurement; the retry blind spot (§12.4) |
| `docs/10-engineering-challenges.md` | three new entries: the CJS/ESM re-export constraint; why the budget must be in PostgreSQL on an instance that spins down; and why `request.on("close")` is the wrong disconnect signal (§7.1) |
| `docs/12-agent-run-api.md` | §191 and §248 rewritten; the `providerMode` field; the four concepts; the canonical admission order; the deadline wording; **the 201-for-finalized-failures contract**; `/v1/capabilities` |
| `docs/13-approval-workflow.md` | the approval demo option is FAKE-only |
| `docs/14-web-ui.md` | selector, token field, availability messaging, run display, 15-character affordance |
| Root `.env.example`, `apps/worker/.env.example`, `render.yaml` | §6.4, §17.4 |

### Limitations to state plainly

RAG is still not browser-wired; approved actions are recorded, never executed; there is **no
authentication and no RBAC** — a shared demo token is a spend gate, not identity; **rate limits
are not identity**, and proxy/`X-Forwarded-For` behaviour behind Render is unverified;
process-local safeguards reset on every restart and cold start; the daily **run count** is hard
while the daily **dollar figure** is a post-run estimate that can be exceeded by one bounded run;
the cost estimate is a **lower bound** because retried-and-abandoned attempts are unobservable;
cancellation covers provider calls only; a `RUNNING` row can still be orphaned by a genuine
process crash (no reaper); and the public deployment is **not Portfolio Ready** until live
evidence and screenshots exist.

---

## 21. File-by-file implementation map

### New — `packages/provider-claude`

```text
package.json, tsconfig.json, tsconfig.build.json          new
src/*.ts                                                   git mv of all 17 files
  └─ index.ts                    plain-const export pattern (§4.5)
  └─ claude-config.ts            renames + optional-capability restructure (§3, §6.1)
  └─ create-llm-provider.ts      + optional `client` (§3)
  └─ claude-llm-provider.ts      estimatedCostUsd → estimatedCostNanoUsd: string|null (§12.2)
  └─ claude-pricing.ts           returns the nanoUSD string field
  └─ module-boundary.test.ts     + no-@opspilot/database rule, raised floor
src/run-provider-usage-collector.ts (+ .test.ts)           new (§12)
```

### Modified — existing packages

```text
packages/contracts/src/agent-orchestrator.ts     + PROVIDER_UNAVAILABLE / _TIMEOUT / _CANCELLED
packages/contracts/src/ticket-context.ts         trim + 1–64 / 15–2000 (§14)
packages/agent-runtime/src/providers/cost-estimation.ts
                                                 totalNanoUsd → bigint; CostEstimate gains
                                                 estimatedCostNanoUsd: string | null (§12.2)
packages/agent-runtime/src/providers/run-abort-context.ts   new — RunAbortContext (§8.2)
packages/agent-runtime/src/agent/agent-orchestrator.ts      + LlmProviderError → failed(...)
packages/agent-runtime/src/persistence/agent-run-service.ts collector ownership, provenance
                                                 override, extended result union (§12.3)
packages/agent-runtime/src/persistence/agent-run-repository-interface.ts
                                                 + startLiveRunWithAttemptLimit (§11.5)
packages/database/prisma/schema.prisma           + LiveRunBudget; + 6 nullable AgentRun columns;
                                                 + index (job_id, provider_mode)
packages/database/prisma/migrations/<ts>_add_live_run_budget_and_run_usage/   new
packages/database/src/{types,validation,mappers}.ts  budget types, the transactional repository
                                                 function, usage mapping
```

### Modified — `apps/api`

```text
src/execution/execution.tokens.ts                renames + 3 new tokens
src/execution/deterministic-provider-factory.ts  → deterministic-scenario.ts (scenario verbatim)
src/execution/deterministic-execution.module.ts  → run-execution.module.ts
src/execution/run-execution-config.ts            new (§6.1)
src/execution/api-provider-factory.ts            new (§5.2)
src/execution/run-deadline.ts                    new (§8.1)
src/execution/request-abort-handle.ts            new (§7.2)
src/execution/run-abort-context.ts               new — buildRunAbortContext (§8.2)
src/execution/usage-hooks.ts                     new (§12.3)
src/execution/live-run-rate-limiter.ts           new (§11.2)  ─┐
src/execution/live-run-concurrency.ts            new (§11.4)   ├─ PR 6B2
src/execution/live-run-budget.ts                 new (§13.2)   │
src/execution/live-run-admission.ts              new (§11.1)  ─┘
src/agent-runs/dto/execute-agent-run-request.schema.ts  + providerMode (§5.1)
src/agent-runs/dto/agent-run-response.mapper.ts  + usage fields; estimatedCostUsd as a string
src/agent-runs/agent-runs.controller.ts          per-run mode, admission, abort context,
                                                 201-for-finalized-failures, exception-safe finally
src/capabilities/                                new module + controller (§9.2)
src/health/health.controller.ts                  unchanged — no product state added
src/errors/api-error-catalog.ts                  + 7 codes; − 502/504 provider codes (§16)
src/errors/map-domain-error.ts                   updated for the new contract
src/main.ts, src/common/server-config.ts         + trust proxy / TRUST_PROXY_HOPS
apps/api/package.json                            + "@opspilot/provider-claude": "workspace:*"
```

Each new module gets a sibling `*.test.ts`.

### Modified — `apps/worker`, `apps/web`, root

```text
apps/worker/package.json                         + provider-claude; − @anthropic-ai/sdk (verify §4.6)
apps/worker/src/demo/run-claude-agent-spike.ts   import specifier + cost log field
apps/worker/src/demo/run-rag-live-spike.ts       import specifier + cost log field
apps/worker/src/smoke/claude-live-smoke.ts       import specifier + cost log field
apps/worker/src/smoke/claude-live-smoke.test.ts  import specifier
apps/worker/src/rag/voyage-embedding-client.ts   stale path in a comment
apps/web/src/App.tsx                             header copy; providerMode; token state; capability fetch
apps/web/src/components/InvestigationForm.tsx    selector; token field; 15-char counter; hide approval demo in LIVE
apps/web/src/components/RunOverviewPanel.tsx     provider mode / model / estimated cost rows
apps/web/src/api/endpoints.ts                    startAgentRun({ jobId, providerMode, liveAccessToken? }); getCapabilities
apps/web/src/api/types.ts                        + usage fields; Capabilities type
apps/web/src/run/run-overview-presentation.ts    provider-mode badge; new failure codes
apps/web/src/build-guard/forbidden-patterns.ts   + 3 rules (§17.3)
Dockerfile, render.yaml, .github/workflows/ci.yml, .env.example    §17, §6.4
README.md, docs/04, 08, 10, 12, 13, 14           §20
```

---

## 22. Implementation sequence

### PR 6B1 — shared provider package + safely closed API capability

1. **Rebase onto `feat/live-claude-provider`.**
2. `git mv` the provider directory; manifest + tsconfigs; plain-const `index.ts`; renames;
   `client` option; optional-capability restructure; boundary test.
   **`pnpm build && pnpm typecheck && pnpm test` green before anything else.**
3. **nanoUSD path (§12.2):** `totalNanoUsd → bigint`, `CostEstimate.estimatedCostNanoUsd`,
   `ClaudeProviderLogEvent.estimatedCostNanoUsd`, and the three worker print sites.
4. Update the four worker import sites and `apps/worker/package.json`.
5. `PROVIDER_*` codes; `LlmProviderError` catch in `runAgentOrchestrator`; `RunAbortContext` type;
   provenance override in `AgentRunService`; extend `apps/web`'s failure rendering.
6. `providerMode` in the request schema, with absent/`{}` compatibility tests.
7. `run-execution-config.ts`, `run-execution.module.ts`, `api-provider-factory.ts`; controller
   per-run selection and `modelIdentifier`.
8. `request-abort-handle.ts` (response-lifecycle only) + `run-deadline.ts` +
   `buildRunAbortContext`; thread the composed signal through.
9. **Kill switch: `LIVE_AGENT_RUNS_ENABLED`, default `false`, enforced at admission step 3.**
10. HTTP contract: 201 for finalized failures; remove the 502/504 codes.
11. Dockerfile, CI boundary checks, bundle-guard rules, `render.yaml` (switch `false`, no key).
12. Docs. Render stays FAKE-only with **no** Anthropic key, and **no public LIVE UI ships**.

### PR 6B2 — durable safeguards + usage persistence + UI + protected rollout

13. `TicketContextSchema` trim + bounds; `trust proxy`.
14. Shared access-token gate.
15. Rate limiter; concurrency lease.
16. Migration: `live_run_budget`, the six nullable `agent_runs` columns, the composite index;
    `startLiveRunWithAttemptLimit`; concurrent integration tests.
17. Usage collector + service-owned lifecycle + extended result union.
18. `live-run-admission.ts` implementing the canonical order; exception-safe reconciliation.
19. `GET /v1/capabilities`.
20. UI: selector, memory-only token field, availability messaging, run display, 15-char
    affordance.
21. `render.yaml` env vars; docs; the safeguard section.
22. Rollout §18 stages 4–12, each behind its gate.

Each numbered step is its own commit. Steps 2, 3, and 16 must be independently revertable.

---

## 23. Verification commands

```bash
pnpm build && pnpm typecheck && pnpm test
pnpm --filter @opspilot/provider-claude run build
pnpm --filter @opspilot/provider-claude run test

pnpm infra:up && pnpm db:test:ensure && pnpm db:generate && pnpm db:migrate:test
pnpm test:integration:sequential
pnpm db:migrate:deploy && pnpm db:migrate:drift        # must report no drift

pnpm --filter @opspilot/web run build
pnpm --filter @opspilot/web run check:bundle

docker build -t opspilot:local .
docker run --rm --entrypoint sh opspilot:local -c '
  ! test -d /app/node_modules/voyageai && ! test -d /app/apps/worker/src && echo boundary ok'
docker run --rm --workdir /app/apps/api --entrypoint node opspilot:local \
  -e "require.resolve(\"@opspilot/provider-claude\")"

API_BASE_URL=http://localhost:3000 pnpm --filter @opspilot/api run demo

# Capability + per-run selection, no key present
curl -sf localhost:3000/v1/capabilities            # {"liveAgentRuns":"UNAVAILABLE","liveAccess":"NOT_APPLICABLE"}
curl -sf localhost:3000/v1/health/ready            # service+DB readiness only — no product state
curl -sf -X POST localhost:3000/v1/agent-jobs/$JOB/runs \
  -H 'content-type: application/json' -d '{"providerMode":"FAKE"}'      # 201
curl -s  -X POST localhost:3000/v1/agent-jobs/$JOB/runs \
  -H 'content-type: application/json' -d '{"providerMode":"LIVE"}'      # 503 LIVE_NOT_CONFIGURED
curl -s  -X POST localhost:3000/v1/agent-jobs/$JOB/runs \
  -H 'content-type: application/json' -d '{"providerMode":"NOPE"}'      # 400 REQUEST_BODY_INVALID
curl -sf -X POST localhost:3000/v1/agent-jobs/$JOB/runs                 # 201, default request mode

# Startup fail-closed checks (no key needed — all must exit non-zero and never bind)
ANTHROPIC_API_KEY=x pnpm api:start                                      # model missing
ANTHROPIC_MODEL=claude-sonnet-5 pnpm api:start                          # key missing
ANTHROPIC_API_KEY=x ANTHROPIC_MODEL=claude-opus-4-8 pnpm api:start      # unsupported model
LIVE_AGENT_RUNS_ENABLED=TRUE pnpm api:start                             # not exactly "true"
AGENT_RUN_PROVIDER_MODE=LIVE pnpm api:start                             # default LIVE, capability absent

# Opt-in, paid — requires explicit owner authorization
OPSPILOT_LIVE_SMOKE=1 pnpm --filter @opspilot/worker run test:claude:live
```

---

## 24. Acceptance criteria

**PR 6B1**

1. `packages/provider-claude` exists; `apps/worker/src/providers/` does not; history preserved.
2. The boundary test passes from the new location and forbids `@opspilot/database`.
3. `pnpm build`, `typecheck`, `test`, and `test:integration:sequential` are green.
4. FAKE behaviour is byte-identical to `main`, incl. absent-body and `{}` requests.
5. Per-run selection works for FAKE, LIVE, absent, and invalid; **no silent downgrade** anywhere.
6. Capability is optional; every partial or invalid combination fails startup with no
   network-capable object constructed.
7. **`LIVE_AGENT_RUNS_ENABLED` defaults to `false` and is enforced in this PR** — a direct
   `{"providerMode":"LIVE"}` call against the deployed service returns 503. **Public LIVE is
   impossible.**
8. `createRequestAbortHandle` observes the **response** only, uses `writableFinished`, and passes
   all six §7.3 tests. `request.on("close")` appears nowhere.
9. Abort provenance resolves per §8.2's precedence and passes all five §8.5 tests; the same
   composed signal reaches both provider turns; `ClaudeLlmProvider` knows nothing about HTTP.
10. A thrown `LlmProviderError` finalizes the run `FAILED` with a `PROVIDER_*` code — no orphaned
    `RUNNING` row — and the response is **201** with the persisted run.
11. `AGENT_PROVIDER_UNAVAILABLE` and `AGENT_RUN_TIMED_OUT` are not public controller errors.
12. The money path is integer-only: `bigint` internally, decimal **string** on the wire, no
    `bigint` in `JSON.stringify`, no float conversion.
13. The image builds; `@anthropic-ai/sdk` resolves from `apps/api`; `voyageai` and worker source
    absent; the bundle guard passes with the three new rules.
14. CI references no `secrets.*` and makes no Anthropic request.

**PR 6B2**

15. The canonical admission order (§11.1) is implemented exactly and asserted end to end.
16. The per-job LIVE attempt limit is enforced **inside the run-creation transaction**; two
    concurrent requests for the final slot yield exactly one run, and the loser consumes no
    reservation.
17. Budget reservation happens in that same transaction, which **commits before any provider
    call**; the lock order is `AgentJob` → `LiveRunBudget` → `AgentRun`.
18. Reconciliation uses `reservation.budgetDate`; the cross-midnight test passes.
19. A reconciliation failure is logged, never overrides the response, and never prevents the
    concurrency lease from being released.
20. `AgentRunService` owns the collector; the value persisted on `agent_runs` is byte-identical to
    the value used for reconciliation; both successful and failed LIVE runs persist usage; FAKE
    runs leave the columns `NULL`.
21. `summary` is trimmed once at the contract boundary and validated 15–2000; 14 rejected, 15
    accepted, whitespace-only rejected, 2001 rejected.
22. `GET /v1/capabilities` exposes only the two opaque values; `/v1/health/ready` carries no
    product state; neither issues a provider call.
23. The demo token can be supplied from the browser, lives only in memory, is sent only on LIVE
    requests, and never reaches storage, a URL, a log, or an error message.
24. The UI offers the selector, hides the approval demo in LIVE, disables LIVE with a reason when
    unavailable, renders the **persisted** mode, and never falls back to FAKE after a rejection.
25. `pnpm db:migrate:drift` reports no drift; the migration is revertable.
26. No public response contains an Anthropic body, header, request ID, prompt, credential, demo
    token, stack trace, or budget figure.
27. Docs state every §20 limitation, including that the deployment is not Portfolio Ready.

---

## 25. Risks and alternatives

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| `index.ts` re-export shape wrong → worker tests see `undefined` | Medium | Build confusion | Export-surface test across both import styles; documented in `docs/10` |
| Disconnect adapter aborts on a normal run | Medium — two revisions got this wrong | Every LIVE run cancelled | Response-only listeners + `writableFinished`; the "normal finish does not abort" test is the guard |
| Provenance lost, timeouts reported as cancellations | Medium | Misleading audit | `RunAbortContext` keeps all three signals; five deterministic tests |
| Long transaction held across provider calls | Low but catastrophic | Job row and budget row locked for 120 s | §11.5 states the commit-before-orchestration boundary; asserted by a test that observes the row is unlocked during execution |
| `TRUST_PROXY_HOPS` mis-set | High until measured | Rate limiting degrades | Conservative default; global caps still bind; §11.3 measurement is rollout stage 6 |
| Reconciliation throw masks a real result | Medium | Wrong HTTP response | §10's nested `try/finally`; six tests |
| `bigint` reaches `JSON.stringify` | Low | 500 | Formatted to a string at the DTO boundary; unit-tested |
| Adding `PROVIDER_*` codes breaks an exhaustive switch | Medium | Compile error | `strict` surfaces every site |
| Free instance cold start (~1 min) pushes the first LIVE run past the deadline | Medium | Confusing `PROVIDER_TIMEOUT` | Documented; warm before recording; deadline configurable |
| Introductory pricing ends 2026-08-31 | Certain | Estimates go `STALE`, budget fails closed | By design; update the table deliberately |
| Two PRs slow delivery | Certain | Schedule | Accepted — reviewability and rollback granularity are worth more |

**Alternatives considered and rejected:** `request.on("close")` as the disconnect source (§7.1);
a merged signal without provenance (§8.2); a controller-owned collector (§12.3); an opaque
`admission.settle()` (§10.1); **reserving the budget before `startRun`** — spend-safe, but a
caller can burn the daily quota with requests naming a nonexistent job, a trivially cheap way to
take the demo offline (§11.5); `@nestjs/throttler` (§11.2); product state on `/v1/health/ready`
(§9.2); a DB-backed kill switch (needs an admin endpoint, which needs auth — circular);
persisting cost only on the POST response (vanishes on refresh, §15.2); hiding the LIVE option
when unavailable (makes the feature look absent rather than protected).

---

## 26. PR split

**PR 6B1 — shared provider package + safely closed API capability.** Rebase onto PR 6A;
`packages/provider-claude`; optional LIVE capability; per-run request mode; provider-failure
finalization; the response-lifecycle disconnect adapter; abort provenance; the provider deadline;
the exact nanoUSD provider event field; **`LIVE_AGENT_RUNS_ENABLED=false` plus its enforcement**;
the 201 contract; Docker/CI/bundle boundaries; deterministic tests; Render remains FAKE-only with
no Anthropic key; no public LIVE UI.

> **Public LIVE must remain impossible after PR 6B1.** The endpoint accepts
> `{"providerMode":"LIVE"}`, so callers can reach it directly even without a UI — the kill switch
> is what makes that a 503 rather than a paid request, which is precisely why it ships here and
> not in 6B2.

**PR 6B2 — durable safeguards + usage persistence + UI + protected rollout.** Shared access
token; token-aware capability endpoint; memory-only browser token input; per-client rate limit;
concurrency limiter; **atomic** per-job LIVE attempt limit; PostgreSQL budget; usage columns;
service-owned collector lifecycle; exact run finalization plus budget reconciliation;
reconciliation exception safety; 15-character validation; FAKE/LIVE selector; persisted
provider/model/duration/cost display; protected Render rollout; **the token remains required at
rollout end**.

| | PR 6B1 | PR 6B2 |
| --- | --- | --- |
| Deployed effect | none — Render unchanged, LIVE impossible | enables token-protected LIVE |
| Risk | structural, compile-time | behavioural and financial |
| Revert | revert the merge | revert the merge + drop the table, six columns, and the index |

---

## 27. Owner decisions

All previously open questions are now resolved and recorded.

```text
Branch strategy:      rebase feat/protected-live-claude-api onto feat/live-claude-provider
PR split:             PR 6B1 + PR 6B2
Migration:            accept live_run_budget
Per-run usage columns: ACCEPTED — six nullable additive columns on agent_runs
                       (UI cost survives refresh; daily totals auditable per run; successful and
                        failed LIVE runs comparable; FAKE rows stay null)
Default-mode variable: KEEP AGENT_RUN_PROVIDER_MODE, redefined as the default request mode when
                       `providerMode` is absent. AGENT_RUN_DEFAULT_PROVIDER_MODE is NOT added.
                       Default stays FAKE.
Access-token posture:  LIVE_RUN_ACCESS_TOKEN required PERMANENTLY for the first public release.
                       No automatic removal after a soak day. Removal is a later explicit
                       security/product decision. The PR 6B rollout ends with token-protected LIVE.
Kill switch:           LIVE_AGENT_RUNS_ENABLED, default false, shipped and enforced in PR 6B1
Initial safeguards:    10 live runs / UTC day · $1.00 estimated daily ceiling · 1024 output
                       tokens/turn · 2 provider turns · 1 concurrent live run · 2 live requests
                       per minute · 2 live attempts per job
Minimum issue summary: 15 trimmed characters
Deployed posture:      LIVE behind the shared token; FAKE remains public
```

### Remaining owner questions

**None.** Implementation can proceed on PR 6B1 immediately after the rebase.

One item is deferred but **does not block implementation**: `TRUST_PROXY_HOPS` needs a one-off
measurement against the deployed service (§11.3). It is rollout stage 6, not a design decision —
the conservative default of `1` ships in the meantime, and the global caps do not depend on it.

---

## Appendix A — external sources

All fetched and verified **2026-07-28**. Claims marked *REQUIRES EMPIRICAL VERIFICATION* are not
treated as settled anywhere in this plan.

| Claim used in this plan | Source |
| --- | --- |
| Free web services spin down after 15 minutes without inbound traffic (~1 minute restart), cannot scale beyond a single instance, have an ephemeral filesystem, and draw on 750 free instance-hours per workspace per month | https://render.com/docs/free |
| Environment-variable changes take effect via "Save, rebuild, and deploy" or "Save and deploy" (redeploys the existing build); "Save only" defers to the next deploy | https://render.com/docs/configure-environment-variables |
| Applications behind Render's proxy read the client IP from `X-Forwarded-For` rather than the socket address | https://render.com/docs/web-services |
| **Whether Render strips, replaces, or appends a client-supplied `X-Forwarded-For`, and how many proxy hops the chain contains, is not authoritatively documented.** This plan makes no claim either way. *REQUIRES EMPIRICAL VERIFICATION (§11.3).* | — |
| Express `trust proxy`: `true` takes the left-most `X-Forwarded-For` entry; a numeric value scans right-to-left and takes the first untrusted address; configuring more hops than exist lets a client supply any value | https://expressjs.com/en/guide/behind-proxies.html |
| PostgreSQL `SELECT … FOR UPDATE` row locks release at transaction end and block conflicting writers; `pg_advisory_xact_lock()` is transaction-scoped and auto-released | https://www.postgresql.org/docs/16/explicit-locking.html |
| `@nestjs/throttler`: `ThrottlerModule.forRoot([{ ttl, limit, name, blockDuration }])` (ms), `ThrottlerGuard`, `protected getTracker(req): Promise<string>`, pluggable `ThrottlerStorage` with an in-memory default | https://github.com/nestjs/throttler , https://docs.nestjs.com/security/rate-limiting |
| Anthropic TypeScript SDK: `timeout` is in **milliseconds** and is a **per-attempt** bound; `maxRetries` bounds the retry count (retrying 408/409/429/5xx and connection errors); `logLevel` controls SDK logging; per-request `{ timeout, signal }` overrides. **Total elapsed time also includes retry backoff and any `retry-after` delay, and is not a fixed multiple of the per-attempt timeout** — the caller-owned deadline (§8.1) is the outer bound this plan relies on. | Anthropic TypeScript SDK client-configuration reference |
| Typed SDK error classes used by PR 6A's classifier — `APIUserAbortError`, `APIConnectionTimeoutError`, `APIConnectionError`, `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InternalServerError`, `BadRequestError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, base `APIError` | Anthropic SDK error reference |
| `claude-sonnet-5` list pricing $3.00 / $15.00 per MTok, introductory $2.00 / $10.00 through **2026-08-31** — matching `claude-pricing.ts` | Anthropic pricing documentation |
| `AbortSignal.any()` and `AbortSignal.timeout()` are available on Node 22 and typed by `@types/node@^26`; `AbortSignal.timeout` schedules an `unref`'d timer | Node.js `AbortSignal` API reference |
| Node HTTP: `ServerResponse` emits `finish` when the response has been handed off, and `close` when the underlying connection closes; `writableFinished` is true only once all data has been flushed, whereas `writableEnded` flips as soon as `end()` is called. `IncomingMessage` emits `close` once the request body has been consumed, which on a normal request precedes response generation — which is why §7.2 observes the response only. | Node.js `http` API reference |
