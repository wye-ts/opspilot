# PR 6A — Live Claude Provider Plan

| Field | Value |
|---|---|
| Status | Plan only — no implementation, no credentials, no API call, no deploy, no commit |
| Revision | 2 (focused revision pass, 2026-07-28) |
| Artifact type | Review artifact — **must not be committed with PR 6A** |
| Related design | `docs/04-agent-design.md` §22, `docs/03-technical-design.md` §5.6, `docs/08-cicd-deployment.md` §7 |
| Prior spike | `docs/reviews/04-agent-design-claude-spike-results.md` (ADOPT, `claude-sonnet-5`, 2026-07-17) |
| Official sources verified | 2026-07-28 (see §6.1) |

Throughout, **Verified** marks a fact read directly from this repository or from official Anthropic
documentation on 2026-07-28. Everything else is proposed design.

### Owner decisions — resolved, not open

| Decision | Resolution |
|---|---|
| Persisted and configured execution mode | **`LIVE`** — `AGENT_RUN_PROVIDER_MODE=FAKE \| LIVE`. `CLAUDE` is not introduced. |
| Initial model | **`claude-sonnet-5`**, and it is the *only* supported model in PR 6A |
| Metadata persistence | Provider log event only; **no PostgreSQL migration** |
| Live smoke cost | Approved, with explicit opt-in and a low output budget |
| HTTP 402 | Its own **`BILLING`** category — never folded into `AUTHENTICATION` |

---

## 1. Objective and PR boundary

> PR 6A proves that the existing provider-neutral runtime can execute a real Claude call in a
> protected local or explicitly opted-in environment.
>
> PR 6A does not make the public Render demo live-LLM-enabled.

PR 6A promotes the existing PR-4 Claude spike from two hand-run scripts into a **first-class,
config-selected provider** selected by `AGENT_RUN_PROVIDER_MODE=LIVE`, with validated configuration,
a provider factory, an explicit timeout/retry/cancellation policy, a complete error taxonomy, cost
estimation on an explicit pricing basis, deterministic mocked tests, and one fail-closed opt-in live
smoke.

**Owner direction:** wiring is worker-only, but the adapter and the provider-neutral contract must be
structured so `apps/api` can reuse them in PR 6B **by moving code, never by copying it**. §3 is the
migration map that direction requires.

**In scope:** validated server-side config; a provider factory decoupled from database types;
timeout, bounded retry, cancellation; Anthropic error → provider-neutral error mapping including a
distinct `BILLING` category; latency and token capture; cost estimation on a versioned, explicit
pricing basis; secret hygiene; deterministic tests with a mocked client; one fail-closed opt-in live
smoke CI never runs; configuration and technical documentation.

**Out of scope:** unauthenticated public live-LLM access; any Anthropic key on Render; IP rate
limiting or public-demo budget enforcement; browser/API RAG wiring; approved-action execution;
authentication, RBAC, multi-user; prompt-quality evaluation beyond a narrow contract smoke;
screenshots or Portfolio-Ready claims; replacing the provider-neutral orchestrator with
Anthropic-specific logic; support for any Claude model other than `claude-sonnet-5`.

**Preserved product constraints:** FAKE remains deterministic. CI requires no provider credential.
Orchestration and tool semantics remain provider-neutral. The browser never receives the Anthropic
API key. The public Render deployment remains FAKE-only after PR 6A.

---

## 2. Current architecture findings

### 2.1 The provider-neutral contract (Verified)

`packages/agent-runtime/src/providers/llm-provider.ts` defines:

- `AgentConversationMessage` — `ticket_context`, `diagnostic_tool_request`,
  `diagnostic_tool_result`, `rag_context`. **It carries no Anthropic thinking blocks** — see §6.2.
- `AgentTurnInput` — `{ turnIndex, phase, maxOutputTokens, conversation }`, where `phase` is
  `INVESTIGATION | FINALIZATION`. **There is no `AbortSignal` and no deadline field.**
- `LlmProvider` — one method, `runAgentTurn(input): Promise<AgentTurnResult>`.
- `LlmProviderErrorCategory` — a closed union: `AUTHENTICATION`, `RATE_LIMIT`, `CONNECTION`,
  `TIMEOUT`, `SERVER_ERROR`, `REQUEST_INVALID`, `UNKNOWN`. **There is no `BILLING` member.**
- `LlmProviderError` — a category plus an OpsPilot-composed message, never a raw SDK value.
- `normalizeDiagnosticToolRequests` — shared normalization; anything other than exactly one
  diagnostic request collapses to `protocol_error` / `PROVIDER_PROTOCOL_INVALID`.

`packages/contracts/src/agent-turn.ts` defines `AgentTurnResult` as a Zod discriminated union of
`diagnostic_tool_request`, `report_submission`, and `protocol_error`. `TokenUsageSchema` is
`.strict()` with exactly `inputTokens` and `outputTokens`. **No latency, model, cost, or stop-reason
field exists in the result type.**

The load-bearing invariant, stated in the source comments and honoured by both providers: transport
and auth failures **throw** `LlmProviderError`; response-shape failures **return** a `protocol_error`
value. Neither is ever laundered into the other.

### 2.2 The FAKE implementation (Verified)

`FakeLlmProvider` replays a `FakeAgentScenario`'s scripted turns by `input.turnIndex`, routing
diagnostic turns through the same shared `normalizeDiagnosticToolRequests` helper the live adapter
uses. It reads no clock, no environment, and no network.

### 2.3 A live Claude adapter already exists (Verified)

`apps/worker/src/providers/` holds a complete, tested adapter from the PR-4 spike:

| File | Responsibility |
|---|---|
| `claude-llm-provider.ts` | `AnthropicMessagesClient` seam, request-param construction (tools and `tool_choice` per phase, `thinking: { type: "disabled" }`), `classifyError`, sanitized `LlmProviderError`, latency timing, `ClaudeProviderLogEvent` |
| `claude-message-mapping.ts` | `AgentConversationMessage[]` → `Anthropic.MessageParam[]`; system prompt per phase; `evidenceId` wrapping of tool results and RAG chunks |
| `claude-response-normalization.ts` | Content-block decision tree → `AgentTurnResult`, including `stop_reason === "refusal"` |
| `claude-tool-schemas.ts` | Zod → Anthropic strict-tool-use JSON-Schema subset; the `submit_resolution_report` tool definition |
| `claude-llm-provider.test.ts`, `claude-tool-schemas.test.ts` | Mocked-client unit coverage |

`claude-llm-provider.ts:185` already passes `max_tokens: input.maxOutputTokens` — the
provider-neutral turn input is **already** the sole output-budget authority (§7).

**Critical structural finding:** these files import only `@anthropic-ai/sdk`,
`@opspilot/agent-runtime`, `@opspilot/contracts`, `zod`, `vitest`, and each other. **There is not a
single `apps/worker/**` import among them.** The directory is already one `git mv` away from being a
standalone package — exactly what the PR-6B-reuse direction requires.

### 2.4 Hard constraint — the Anthropic SDK must stay out of the production image (Verified)

`Dockerfile` builds production dependencies with `pnpm install --frozen-lockfile --prod --filter
"@opspilot/api..."`, and its own comment states this "is what keeps apps/worker's @anthropic-ai/sdk
and voyageai (and apps/web) out of the production install entirely."
`.github/workflows/ci.yml` (job `docker-smoke`, step "Image boundary checks") then **asserts** it:

```sh
! test -d /app/node_modules/@anthropic-ai
```

`packages/agent-runtime/dist` **is** copied into the runtime image and `@opspilot/agent-runtime` is
in `@opspilot/api`'s dependency closure. **Therefore no SDK-importing module may be placed in
`packages/agent-runtime`.** This single constraint drives the entire §3 split.

`@anthropic-ai/sdk@^0.112.0` is declared by `apps/worker` only (Verified, `apps/worker/package.json`).

### 2.5 API and worker relationship (Verified)

They are **separate consumers of the same runtime package**, not a client/server pair. There is no
worker daemon; `apps/worker` is demos, evaluation, spikes, and smoke scripts. `apps/api` is the
deployed NestJS service.

`apps/api` is FAKE-only in **two independent places**:

1. `createDeterministicProviderFactory(providerMode)` throws `LiveProviderModeNotSupportedError`
   synchronously for any mode ≠ `FAKE`, before constructing anything network-capable
   (`deterministic-provider-factory.ts:142-146`). `DeterministicExecutionModule` calls it in a Nest
   `useFactory`, so the failure lands in `main.ts`'s guarded bootstrap.
2. `agent-runs.controller.ts:34` passes a **hardcoded** `providerMode: "FAKE"` to
   `executeAndPersist`, and never passes `modelIdentifier`.

Its rejection message is already exactly right under the `FAKE | LIVE` enum (Verified,
`deterministic-provider-factory.ts:120-121`):

```text
AGENT_RUN_PROVIDER_MODE=LIVE is not supported by this API; only FAKE is available.
```

**Consequence: `apps/api` needs no change whatsoever in PR 6A** — see §13.

### 2.6 Orchestration turns and tool-use semantics (Verified)

`runAgentOrchestrator` runs a hard-bounded 2-turn loop (`MAX_PROVIDER_TURNS = 2`,
`DEFAULT_MAX_OUTPUT_TOKENS = 4096`). Turn 0 is `INVESTIGATION`, turn 1 is `FINALIZATION`. It
produces exactly four trace-event kinds and enforces evidence grounding via `findInvalidEvidence`.
`AgentOrchestratorParams.maxOutputTokens?: number` **already exists** (line 54) and flows into every
turn input (line 186) — so a caller can already lower the output budget with no new machinery.
The orchestrator has **no wall-clock budget, no deadline, and no cancellation path.**

### 2.7 Persistence and trace fields (Verified)

`AgentTraceEventSchema` has four variants: `RETRIEVAL_COMPLETED`, `TOOL_REQUESTED`,
`TOOL_COMPLETED`, `REPORT_GENERATED`. **No token, latency, cost, or model field is persisted
anywhere.** `agent_runs` carries `provider_mode` with a `CHECK ("provider_mode" IN ('FAKE','LIVE'))`
constraint (`20260723010949_init/migration.sql:68-69`) and a nullable `model_identifier`;
`ProviderMode = "FAKE" | "LIVE"` (`packages/database/src/types.ts:13`).

**This is why the execution-mode enum stays `FAKE | LIVE`** — see §5.1.

### 2.8 Where provider mode is parsed today (Verified)

| Location | Value | Behaviour |
|---|---|---|
| `apps/api/src/execution/deterministic-execution.module.ts:16` | `process.env.AGENT_RUN_PROVIDER_MODE` | read once at module instantiation |
| `.env.example:23`, `render.yaml:25`, `.github/workflows/ci.yml:24`, `Dockerfile` `ENV` | `FAKE` | the only value the API accepts |

### 2.9 Gaps this PR must close (Verified)

- No `AbortSignal` anywhere in the agent path.
- No `timeout` or `maxRetries` passed to `new Anthropic(...)` — both SDK defaults apply silently.
- No cost estimation for Claude. The only cost arithmetic in the repo is Voyage's, inline in
  `run-rag-live-spike.ts:109`.
- `classifyError` has no branch for HTTP 402, HTTP 504, or `APIUserAbortError`.
- No configuration-time model validation — the model string is passed through unchecked.
- The `get_service_status` tool description is **already duplicated verbatim** between
  `run-claude-agent-spike.ts:62` and `run-rag-live-spike.ts:146`.
- The spike scripts run under bare `tsx`, which does not load `apps/worker/.env` — unlike
  `demo:persisted`, which uses `node --env-file-if-exists=... --import tsx`.

### 2.10 Architectural risks

| Risk | Note |
|---|---|
| Placing Claude code in `packages/agent-runtime` | Would break the §2.4 image boundary check immediately |
| PR 6B duplicating the adapter | The whole point of §3; mitigated by a boundary test |
| Threading `signal` through the orchestrator | Touches the repo's most-tested file — kept to an optional, additive field |
| Widening `LlmProviderErrorCategory` | `RetrieverErrorCategory` is a **separate duplicated union** (`runbook-retriever.ts:34`), so RAG is unaffected by adding `BILLING` or `CANCELLED` (Verified) |

---

## 3. Reuse design — the neutral / Anthropic split and the PR 6B migration map

One dependency test decides placement:

> **Does the module import `@anthropic-ai/sdk`, as a value *or* as a type?**
> **No** → it may live in `packages/agent-runtime` today: image-safe, immediately shared.
> **Yes** → it stays in `apps/worker/src/providers/` today and moves to `packages/provider-claude` in PR 6B.

### 3a. Moves into `packages/agent-runtime` in PR 6A (image-safe, no SDK import)

| What | New location | Why it is provider-neutral |
|---|---|---|
| `LlmProviderSelection` + `LlmProviderFactory` (§3d) | `src/providers/llm-provider-factory.ts` | Depends on a two-field value object, not on a database record — so PR 6B can move the adapter without carrying `@opspilot/database` types |
| `ModelPricing`, `PricingBasis`, `estimateCostUsd(usage, pricing)` | `src/providers/cost-estimation.ts` | Pure arithmetic over priced token quantities. The Anthropic **price table** is provider-specific and stays in the worker (§3b) — this is the neutral/specific seam. |
| `DiagnosticToolCatalogEntry` + the `get_service_status` catalog entry | `src/tools/diagnostic-tool-catalog.ts` | The description describes an *OpsPilot* tool, not an Anthropic concept. Also removes the §2.9 verbatim duplication. |
| `AgentTurnInput.signal?: AbortSignal` | `src/providers/llm-provider.ts` (additive) | §4 |
| `CANCELLED` and `BILLING` in `LlmProviderErrorCategory` | `src/providers/llm-provider.ts` (additive) | §4, §8 |

### 3b. Stays in `apps/worker/src/providers/`; moves to `packages/provider-claude` in PR 6B

Existing: `claude-llm-provider.ts`, `claude-message-mapping.ts`, `claude-response-normalization.ts`,
`claude-tool-schemas.ts`. New in PR 6A: `claude-config.ts`, `claude-pricing.ts` (the Anthropic price
table and its basis metadata), `create-llm-provider.ts`.

**PR 6A deliberately does not create `packages/provider-claude`.** Creating it now is either pure
churn — only `apps/worker` would depend on it — or, if `apps/api` took the dependency, it breaks the
§2.4 image boundary check immediately. Renegotiating that boundary is PR 6B's job.

### 3c. Three rules that keep the PR 6B move mechanical

1. **No `apps/worker/**` imports inside `src/providers/`.** True today (§2.3). Enforced by a new
   `providers/module-boundary.test.ts` that reads each `claude-*.ts` source and asserts every import
   specifier is relative-within-directory (`./`), a `@opspilot/*` workspace package, `zod`, or
   `@anthropic-ai/sdk`. This single guard keeps the PR-6B move a `git mv`.
2. **The adapter never reads `process.env`.** `claude-config.ts` parses environment **once** and
   returns a frozen validated object; `ClaudeLlmProvider` and the factory receive it as input.
3. **`packages/contracts` is untouched.** `AgentTurnResult`, `TokenUsage`, and
   `ResolutionReportSchema` are already the shared neutral contract, already image-safe, and already
   consumed by both apps.

### 3d. The neutral factory contract — decoupled from `AgentJobRecord`

```ts
export interface LlmProviderSelection {
  readonly providerMode: "FAKE" | "LIVE";
  readonly modelIdentifier?: string | null;
}

export interface LlmProviderFactory {
  createProvider(selection: LlmProviderSelection): LlmProvider;
}
```

Rationale:

- **The provider abstraction should not depend on a complete database record.** `AgentJobRecord`
  carries a ticket context the live adapter never reads.
- **It keeps the factory reusable by worker and API.** Each boundary converts its own source — a
  database row in the API, local config in the worker — into a two-field selection.
- **PR 6B can move the adapter without carrying database types**, which is the whole point: a
  `packages/provider-claude` that imported `@opspilot/database` would drag Prisma into any consumer.
- **Existing callers use a small mapping helper at the boundary** (`run → LlmProviderSelection`),
  which is trivially testable and lives on the API side.

**Honest scoping note.** `apps/api`'s existing `DeterministicProviderFactory.createProvider(job)` is
**not** an implementation of this interface and does not become an alias of it. It is a different
concern: it builds a deterministic `FakeAgentScenario` *from* a job's ticket id and summary, so it
genuinely needs the record. `LlmProviderFactory` selects *which provider* to construct;
`DeterministicProviderFactory` constructs *a scripted scenario*. PR 6A leaves the latter untouched
(§13); PR 6B composes the two behind one Nest token.

In the worker, the FAKE branch is supplied its scenario at factory-construction time
(`createLlmProviderFactory({ config, fakeScenario })`), so `LlmProviderSelection` stays free of both
database and scenario types.

---

## 4. Provider-neutral contract review

Three changes to `packages/agent-runtime/src/providers/llm-provider.ts`. All are optional or purely
additive, so **every existing FAKE test compiles and passes unchanged**.

### (a) Add `AgentTurnInput.signal?: AbortSignal`

- **Why necessary.** Cancellation is in scope, and the alternative — a constructor-level signal on
  `ClaudeLlmProvider` — is the wrong seam for PR 6B, where `apps/api` needs a *per-request* deadline
  originating in an HTTP handler. Choosing the constructor now guarantees rework later.
- **Provider-neutral?** Yes. `AbortSignal` is a platform primitive, not an SDK type.
- **Effect on FAKE.** None — `FakeLlmProvider` ignores it.
- **Effect on orchestrator.** `AgentOrchestratorParams` gains an optional `signal`, forwarded into
  each `runAgentTurn` call using the conditional-spread idiom the codebase already requires under
  `exactOptionalPropertyTypes` (`agent-run-service.ts:175-182`). Roughly four lines.
- **Effect on tests / persistence.** None; the field is optional.

### (b) Add `"CANCELLED"` to `LlmProviderErrorCategory`

`APIUserAbortError` has no honest home in the current union. Mapping it to `TIMEOUT` would report a
deliberate caller cancellation as a provider failure, which would be wrong in logs, in smoke output,
and in any future retry decision. Additive; RAG unaffected (§2.10).

### (c) Add `"BILLING"` to `LlmProviderErrorCategory`

Anthropic exposes `402 billing_error` as a distinct error type, and authentication, authorization,
and billing require **different operator actions** — rotate a key, grant a permission, or add
credit. Folding 402 into `AUTHENTICATION` would send an operator down the wrong path. The category
has a concrete OpsPilot use in troubleshooting and in live-smoke output. `401` and `403` remain under
`AUTHENTICATION`; this revision does not open a broader authorization taxonomy.

### Metadata evaluated and **rejected** for `AgentTurnResult`

`latencyMs`, `model`, `estimatedCostUsd`, `stopReason`, cache token counts. `providerRequestId` and
`usage` already exist and are already populated.

Nothing in OpsPilot consumes the rejected fields: `AgentTraceEventSchema` persists only
`type`/`toolCallId`/`toolName`, `TokenUsageSchema` is `.strict()`, and neither the API DTOs nor the
web UI reference them. They go on the **existing adapter-local `ClaudeProviderLogEvent`** instead
(§10).

---

## 5. Configuration design

New `apps/worker/src/providers/claude-config.ts`: a Zod schema over a plain
`Record<string, string | undefined>` — never `process.env` directly — so it is unit-testable without
mutating the ambient environment (§3c rule 2).

### 5.1 Execution mode stays `FAKE | LIVE`

```text
AGENT_RUN_PROVIDER_MODE=FAKE   → FakeLlmProvider
AGENT_RUN_PROVIDER_MODE=LIVE   → ClaudeLlmProvider
```

`CLAUDE` is **not** introduced, because:

- the database already persists `provider_mode = FAKE | LIVE` under a `CHECK` constraint (§2.7);
- the provider-neutral runtime already treats `LIVE` as the high-level execution mode
  (`ProviderMode`, `docs/03-technical-design.md` §620);
- **vendor and model belong in provider/model metadata, not in the execution-mode enum** — the
  vendor is recorded in the log event and the model in `modelIdentifier`;
- introducing `CLAUDE` would create a config/database mismatch that PR 6B would have to migrate away.

A future multi-vendor expansion may add a *separate* selector such as `LIVE_LLM_PROVIDER=ANTHROPIC`.
PR 6A does not add it, because Anthropic is the only live provider.

### 5.2 Configuration table

| Variable | Required | Default | Validation |
|---|---|---|---|
| `AGENT_RUN_PROVIDER_MODE` | no | `FAKE` | exactly `FAKE` or `LIVE` |
| `ANTHROPIC_API_KEY` | **iff `LIVE`** | — | non-empty; never logged, never echoed into an error |
| `ANTHROPIC_MODEL` | **iff `LIVE`** | — | must equal `claude-sonnet-5` — the PR 6A supported set (§6.2) |
| `ANTHROPIC_TIMEOUT_MS` | no | `45000` | positive int; **per-attempt** bound (§9) |
| `ANTHROPIC_MAX_RETRIES` | no | `1` | int 0–5; the SDK is the only retry owner (§9) |

**There is no `ANTHROPIC_MAX_TOKENS`.** See §7 — `input.maxOutputTokens` is the single
output-budget authority, and a second one would be a competing source of truth.

- **Validation timing.** At factory construction, before any `new Anthropic(...)` — mirroring
  `createDeterministicProviderFactory`'s fail-closed-synchronously pattern. Selecting `LIVE` without
  a key, or with an unsupported model, fails **there**, with a fixed message naming the offending
  variable and never its value.
- **Secret redaction.** The validated object stores `apiKey` non-enumerably and overrides
  `toJSON`/`util.inspect.custom` to yield `apiKey: "[redacted]"`, so an accidental
  `JSON.stringify(config)` or `console.log(config)` cannot leak it.
- **Do API and worker share a config module?** Not in PR 6A. `apps/api` keeps its own synchronous
  rejection, which is strictly stronger than any flag PR 6A could add. Unifying them is a PR 6B step,
  made cheap by §3d's selection-based factory.
- **Render.** `render.yaml` keeps `AGENT_RUN_PROVIDER_MODE=FAKE` and gains no Anthropic variable.

---

## 6. Model strategy

### 6.1 Official sources verified 2026-07-28

| Source | Facts used |
|---|---|
| `platform.claude.com/docs/en/about-claude/models/overview` | `claude-sonnet-5` $3/$15 per MTok standard, **introductory $2/$10 through 2026-08-31**, 1M context, 128k max output. "Every Claude model ID is a pinned snapshot… the dateless format is also a pinned snapshot, not an evergreen pointer." |
| `platform.claude.com/docs/en/api/errors` | Status/type table incl. **402 `billing_error`** and **504 `timeout_error`**; SDKs retry transient failures twice by default honouring `retry-after`; `request-id` header semantics |
| `platform.claude.com/docs/en/api/rate-limits` | `retry-after` (seconds) plus the `anthropic-ratelimit-*` header family on 429 |
| `platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript` | `maxRetries` default 2, **exponential backoff**; retries connection errors / 408 / 409 / 429 / ≥500; `timeout` in **milliseconds**, default 10 min; timed-out requests are themselves retried; exception class table |
| Installed `@anthropic-ai/sdk@0.112.0` (Verified locally) | `RequestOptions.signal?: AbortSignal`; `APIUserAbortError` exported and extending `APIError` directly; `APIError.status` and `.type` available |

### 6.2 The supported-model set is exactly `claude-sonnet-5`

```text
ANTHROPIC_MODEL=claude-sonnet-5
```

The variable stays **explicitly required** — there is no default — and is **validated at
configuration time** against a one-member supported set. An unknown or unsupported configured model
**fails during configuration validation, before any live request is attempted.**

This PR does **not** claim support for arbitrary Claude models, because the current request policy is
not capability-safe across the family:

- PR 6A preserves the current provider-neutral conversation shape, which **does not carry Anthropic
  thinking blocks** (§2.1). Replaying a model's thinking blocks unchanged is mandatory on models
  where thinking is on by default, and the conversation type has nowhere to put them.
- `thinking: { type: "disabled" }` is sent unconditionally today
  (`claude-llm-provider.ts:194`) because Sonnet 5's default adaptive thinking is incompatible with the
  forced `tool_choice` the FINALIZATION turn requires. That request shape is **intentionally
  supported only for the validated Sonnet 5 configuration in this PR** — it is not a general policy.
- Adding Opus, Haiku, Fable, Mythos, or any future model requires a **capability-aware request
  policy** and dedicated tests, not just a new pricing row. Officially, for example, thinking cannot
  be disabled at all on Fable/Mythos, and Opus 5 restricts disabling it above `high` effort.

The Models API remains available as a **future diagnostic**; it is not called at startup, because
that would add a network failure mode to configuration for a diagnostic-only benefit.

---

## 7. Output-token budget — a single authority

`AgentTurnInput.maxOutputTokens` is the **sole source of truth** for the request's `max_tokens`.
The adapter already honours it (`claude-llm-provider.ts:185`), and its source comment already says
the caller owns the value.

No `ANTHROPIC_MAX_TOKENS` variable is introduced. A second output-budget authority would create two
competing values with no defined precedence, and would silently override a caller that had
deliberately lowered its budget.

**The live smoke lowers the budget the supported way**, through the existing
`AgentOrchestratorParams.maxOutputTokens` (Verified, `agent-orchestrator.ts:54`), which flows into
every turn input. No new machinery is required.

**Deferred option, not part of PR 6A.** A deployment-level ceiling could later be added as
`ANTHROPIC_MAX_OUTPUT_TOKENS_CAP`, applied as `Math.min(input.maxOutputTokens, configuredCap)` — a
*clamp* on the caller's value rather than a competing authority. It is explicitly **not** in this PR.

---

## 8. Error taxonomy

`classifyError` is extended. Ordering matters and is load-bearing: `APIUserAbortError` first (it
extends `APIError` directly, not `APIConnectionError`), then `APIConnectionTimeoutError` **before**
`APIConnectionError` (the existing comment at `claude-llm-provider.ts:87-88` explains why — preserve
it), then a **numeric `error.status` check before the `>=500` instanceof** so 504 is not swallowed
as a generic server error by `InternalServerError`.

| Provider signal | SDK class | Internal category | Retryable / by whom | Safe user-facing message | Safe log fields | Test strategy |
|---|---|---|---|---|---|---|
| Missing/invalid config (incl. unsupported model) | — | throws at construction | no | names the variable, never its value | mode only | config unit test |
| Abort | `APIUserAbortError` | `CANCELLED` **(new)** | never | "The request to the Anthropic API was cancelled." | category, latency | pre-aborted signal |
| 400 invalid request | `BadRequestError` | `REQUEST_INVALID` | no | existing ("…likely an adapter bug") | category, latency | mocked throw |
| 401 authentication | `AuthenticationError` | `AUTHENTICATION` | no | existing | category, latency | mocked throw |
| **402 billing** | generic `APIError` (`status === 402`) | **`BILLING` (new)** | no | "The Anthropic account cannot process this request because of a billing or credit issue." | category, latency | status-based branch test |
| 403 permission | `PermissionDeniedError` | `AUTHENTICATION` | no | existing | category, latency | mocked throw |
| 404 model/resource | `NotFoundError` | `REQUEST_INVALID` | no | existing | category, latency | mocked throw |
| 409 conflict | `ConflictError` | `REQUEST_INVALID` | SDK | existing | category, latency | mocked throw |
| 413 too large | generic `APIError` | `REQUEST_INVALID` | no | existing | category, latency | mocked throw |
| 429 rate limit | `RateLimitError` | `RATE_LIMIT` | SDK, honouring `retry-after` | existing | category, latency | mocked throw |
| 500 api_error | `InternalServerError` | `SERVER_ERROR` | SDK | existing | category, latency | mocked throw |
| **504 timeout** | `InternalServerError` (`status === 504`) | `TIMEOUT` | SDK | existing | category, latency | status-first branch test |
| 529 overloaded | `InternalServerError` | `SERVER_ERROR` | SDK | existing | category, latency | mocked throw |
| network / DNS / TLS | `APIConnectionError` | `CONNECTION` | SDK | existing | category, latency | mocked throw |
| client per-attempt timeout | `APIConnectionTimeoutError` | `TIMEOUT` | SDK | existing | category, latency | ordering test vs `CONNECTION` |
| missing `_request_id` | — | `UNKNOWN` | no | existing | category, latency | response without `_request_id` |
| malformed / unsupported response | — | **not thrown** → `protocol_error` `PROVIDER_PROTOCOL_INVALID` | n/a | existing normalization message | result type only | existing + new fixtures |
| tool-use contract violation | — | **not thrown** → `protocol_error` | n/a | existing normalization message | result type only | existing coverage |

**Non-negotiable, preserved verbatim:** no raw provider body, header, `cause`, credential, or prompt
content ever reaches a user-facing message. Every message is one of the fixed strings in
`SANITIZED_MESSAGE_BY_CATEGORY`.

---

## 9. Timeout, retry, and deadline policy

**The SDK is the only retry owner. The application adds none. The orchestrator adds none.** This
exists specifically to prevent a compounded `SDK × application × orchestrator` retry stack.

Both knobs are set **explicitly** at client construction from validated config, so neither SDK
default is silently inherited:

| Knob | Value | Enforced by |
|---|---|---|
| **Per-attempt** timeout | `ANTHROPIC_TIMEOUT_MS`, default **45 000 ms** | SDK |
| Maximum retry count | `ANTHROPIC_MAX_RETRIES`, default **1** | SDK |
| Application retry | **none** | by design |
| Orchestrator retry | **none** | unchanged |
| Retryable statuses | connection errors, 408, 409, 429, ≥500 | SDK |
| Backoff and `retry-after` | exponential backoff; header honoured | SDK |
| **Total wall clock** | caller-owned `AbortSignal` | the caller |

### The correct duration model

```text
Per-attempt timeout is bounded.
Retry count is bounded.
Total wall-clock duration is NOT equal to timeout × attempts, because retry
backoff and retry-after waiting may add time.
```

The previous revision of this plan asserted `timeout × (maxRetries + 1)` as a strict worst-case
bound. **That was wrong** and is corrected here: the SDK's exponential backoff between attempts, and
any `retry-after` delay it honours on a 429, are additional waiting time that no per-attempt timeout
bounds. Documentation, tests, and acceptance criteria all use the corrected model.

Consequences that must be stated plainly wherever this is documented:

- The per-attempt timeout and the retry ceiling are both enforced by the SDK.
- Backoff and `retry-after` add unbounded-by-timeout waiting on top of them.
- **A full two-turn agent run invokes the provider twice**, so total run duration is not a
  single-attempt bound and is not a single-request bound either.
- **The only true total-wall-clock bound is a caller-owned abort signal.** The opt-in live smoke
  supplies one: `AbortSignal.timeout(120_000)` (available on Node 22.21.0 — Verified, `.nvmrc`),
  passed as `AgentOrchestratorParams.signal` and forwarded to every turn.
- **PR 6B decides how an HTTP-request deadline is wired into the API path.** PR 6A ships the
  cancellation *seam*, not a deadline scheduler: whoever owns the signal owns the deadline.
- **Idempotency:** a retried attempt may bill twice for one logical turn. Acceptable for a bounded
  two-turn demo loop; documented rather than solved with an idempotency key.

---

## 10. Observability

| Field | Where it goes | Note |
|---|---|---|
| provider, model, request ID, message ID | `ClaudeProviderLogEvent` | `model` is `message.model` — what actually served the request |
| latency | log event (exists) | per attempt-chain, measured around the SDK call |
| stop reason | log event (**new**) | diagnostic for refusal / `max_tokens` |
| token usage (input, output) | `AgentTurnResult.usage` **and** the log event | already in the contract |
| cache usage (read, creation) | log event (**new**) | reported as **separate** quantities, never folded into input tokens |
| `estimatedCostUsd` + `pricingBasis` + `pricingBasisDate` | log event (**new**) | §11 |
| **`configuredMaxRetries`** | log event (**new**) | see below |
| terminal error category | log event (exists) | includes the new `BILLING` and `CANCELLED` |
| **prompt or raw response content** | **nowhere** | see below |

**No `attempts` field.** The previous revision proposed recording the SDK's *actual* retry count. The
normal Messages response exposes no reliable standard field for it, so that value could not be
produced honestly without explicit transport-level instrumentation — which PR 6A does not add. The
plan records **`configuredMaxRetries`** instead: a configuration fact, true by construction and
testable. If actual attempt counting is wanted later, it needs instrumentation *and* tests, as its
own change.

**Default privacy rule, honoured:** raw provider request/response payloads are never persisted for
debugging. Only structured metadata and the existing normalized trace are recorded.

**Persistence is not touched.** No Prisma migration, no `AgentTraceEventSchema` change, no
`TokenUsageSchema` change, no drift-check churn.

**Redaction, enforced by test.** API keys, authorization headers, request bodies, raw provider error
bodies, and ticket content never appear in any log event. The SDK client is constructed with
`logLevel: "off"` so the SDK's own debug logging can never emit headers or bodies.

---

## 11. Pricing strategy — explicit, versioned basis

`apps/worker/src/providers/claude-pricing.ts` (no SDK import) holds the table and its basis metadata.
The **preferred design** from the revision is adopted, so the smoke reports a realistic current
estimate while keeping the basis auditable:

```ts
estimatedCostUsd
pricingBasis: "ACTIVE_RATE"
pricingBasisDate: "2026-07-28"
```

| Model | Active rate on the basis date | Future standard rate |
|---|---|---|
| `claude-sonnet-5` | **$2.00 / $10.00 per MTok** — introductory, through **2026-08-31** | $3.00 / $15.00 per MTok, from 2026-09-01 |

The table contains **only `claude-sonnet-5`**, because that is the only model any PR 6A code path can
reach (§6.2). Rows for models with no code path would be untested, unreachable claims.

Rules the implementation must follow:

- **Price the model Anthropic actually returned** — `message.model` — not only the configured request
  value, so a server-side resolution difference cannot silently mis-price the run.
- **Price four separate quantities**: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`. **Never assume cache tokens are included in ordinary input tokens** —
  officially they are reported separately and `input_tokens` counts only what follows the last cache
  breakpoint.
- **Return `null`** when the response model has no matching pricing entry. Never a guess, never a
  fallback price.
- **Keep the basis explicit and versioned.** `pricingBasis` and `pricingBasisDate` travel with every
  estimate, so a number in a log line can always be re-derived.
- Both the active and the future standard rate are documented; only the active one is used for
  `ACTIVE_RATE`. The rollover on 2026-08-31 is a tracked follow-up (§20).

The Anthropic API response contains **no monetary cost field**; nothing here claims it does. The
value is an *estimate* on a stated basis — not a billed amount.

Tests must cover: cache-read pricing, cache-creation pricing, unknown-model → `null`, and that
`pricingBasis`/`pricingBasisDate` are present and correct on every estimate.

---

## 12. Testing strategy

### 12.1 Unit tests (mocked `AnthropicMessagesClient`; no network, no credential)

Request mapping per phase (tool list and `tool_choice` for `INVESTIGATION` vs `FINALIZATION`;
`max_tokens` comes from `input.maxOutputTokens` and from nowhere else; `thinking: { type: "disabled" }`);
tool-use, text, and report response mapping; usage extraction including the two cache quantities;
cost estimation incl. cache-read, cache-creation, unknown-model `null`, and basis metadata; **every**
error-taxonomy row of §8, with the new `BILLING` (402), `TIMEOUT` (504), and `CANCELLED` (abort)
branches plus the `APIConnectionTimeoutError`-before-`APIConnectionError` ordering; retry-policy
configuration (assert `timeout` and `maxRetries` reach the client); config validation — mode,
missing key, and **unsupported model rejected at configuration time**; malformed response →
`protocol_error` rather than a throw; missing `_request_id`; **secret redaction** — assert the key
string appears in no thrown message, no log event, and no `JSON.stringify` of config.

### 12.2 Integration tests (mocked transport/client)

- The provider factory maps `{ providerMode: "FAKE" }` → `FakeLlmProvider` and
  `{ providerMode: "LIVE" }` → `ClaudeLlmProvider`, driven by an `LlmProviderSelection` value with
  no database record involved.
- The **unmodified** `runAgentOrchestrator` completes its two-turn flow through the Claude adapter
  against scripted `Anthropic.Message` fixtures, producing
  `TOOL_REQUESTED → TOOL_COMPLETED → REPORT_GENERATED` and a report that passes both
  `ResolutionReportSchema` and evidence-grounding validation.
- No real network. No API credential. Deterministic fixtures.
- `providers/module-boundary.test.ts` enforces §3c rule 1.

### 12.3 Existing regression suites

FAKE tests unchanged (all three contract changes are optional/additive); full monorepo typecheck,
unit tests, and build; PostgreSQL integration; bundle guard; migration drift — must report **no
drift**, since this PR adds no migration.

### 12.4 Fail-closed opt-in live smoke

```bash
OPSPILOT_LIVE_SMOKE=1 \
AGENT_RUN_PROVIDER_MODE=LIVE \
ANTHROPIC_MODEL=claude-sonnet-5 \
pnpm --filter @opspilot/worker run test:claude:live
```

Root `test` is `pnpm -r --if-present run test` (Verified), so a script named `test:claude:live` is
**never** picked up by `pnpm test` or by CI.

**The smoke must never silently execute FAKE.** It validates all four conditions and **exits
non-zero** if any is missing or mismatched — there is no fallback path:

```text
OPSPILOT_LIVE_SMOKE === "1"
providerMode === "LIVE"
ANTHROPIC_API_KEY is present
ANTHROPIC_MODEL === "claude-sonnet-5"
```

Beyond the gate, the smoke:

- passes an explicit **low `maxOutputTokens`** through `AgentOrchestratorParams` (§7);
- passes a **caller-owned total deadline**, `AbortSignal.timeout(120_000)`, as
  `AgentOrchestratorParams.signal` — the only true wall-clock bound (§9);
- runs via `node --env-file-if-exists=.env --import tsx` so `apps/worker/.env` actually loads (the
  existing `spike:claude` uses bare `tsx` and does not — §2.9);
- constructs the client with `logLevel: "off"`, so all output comes from the adapter's sanitized
  callback;
- prints model, latency, usage, cache usage, stop reason, `configuredMaxRetries`,
  `estimatedCostUsd`, `pricingBasis`, and `pricingBasisDate` — and **no** key, header, request body,
  or raw SDK payload. The top-level catch stays generic, matching `run-claude-agent-spike.ts:82-91`;
- exits non-zero on provider or contract failure;
- carries an explicit warning that it makes a **paid** API call — approximately $0.03, based on the
  prior spike's measured USD 0.028662 for three calls at a comparable budget.

No real-provider assertion is placed in any normal test. The existing `spike:claude` script is left
untouched, because `docs/reviews/04-agent-design-claude-spike-results.md` references it by name.

---

## 13. File-by-file implementation plan

### Create

| Path | Purpose |
|---|---|
| `packages/agent-runtime/src/providers/llm-provider-factory.ts` | `LlmProviderSelection`, `LlmProviderFactory` (§3d) |
| `packages/agent-runtime/src/providers/cost-estimation.ts` (+ `.test.ts`) | `ModelPricing`, `PricingBasis`, `estimateCostUsd` |
| `packages/agent-runtime/src/tools/diagnostic-tool-catalog.ts` (+ `.test.ts`) | shared tool + description catalog |
| `apps/worker/src/providers/claude-config.ts` (+ `.test.ts`) | validated config, model allowlist, redaction |
| `apps/worker/src/providers/claude-pricing.ts` (+ `.test.ts`) | `claude-sonnet-5` price entry + basis metadata |
| `apps/worker/src/providers/create-llm-provider.ts` (+ `.test.ts`) | selection-driven `FAKE \| LIVE` factory |
| `apps/worker/src/providers/module-boundary.test.ts` | §3c rule 1 guard |
| `apps/worker/src/providers/claude-orchestrator.integration.test.ts` | two-turn flow, mocked client |
| `apps/worker/src/smoke/claude-live-smoke.ts` | fail-closed opt-in live smoke |

### Modify

| Path | Change |
|---|---|
| `packages/agent-runtime/src/providers/llm-provider.ts` | `+ signal?`, `+ CANCELLED`, `+ BILLING` |
| `packages/agent-runtime/src/agent/agent-orchestrator.ts` | thread optional `signal` (~4 lines) |
| `packages/agent-runtime/src/index.ts` | export new values/types via the plain-`const` idiom its header comment mandates |
| `apps/worker/src/providers/claude-llm-provider.ts` | accept config; extend `classifyError`; extend the log event; pass `{ signal }` |
| `apps/worker/src/providers/index.ts` | re-export the new surface |
| `apps/worker/package.json` | add `test:claude:live` |
| `apps/worker/.env.example` | `ANTHROPIC_MODEL=claude-sonnet-5`; add the two timeout/retry names as comments |
| `apps/worker/src/demo/run-claude-agent-spike.ts`, `run-rag-live-spike.ts` | consume the shared tool catalog |
| Docs | per §15 |

### Explicitly untouched

**`apps/api/**` — including `deterministic-provider-factory.ts`.** Keeping the enum as `FAKE | LIVE`
means its existing rejection message (`"AGENT_RUN_PROVIDER_MODE=LIVE is not supported by this API;
only FAKE is available."`) is already exactly correct, so the message-text edit the previous revision
proposed is no longer needed at all.

Also untouched: `apps/web/**` · Prisma schema and all migrations · `render.yaml` values ·
`.github/workflows/ci.yml` · `Dockerfile` · root `.env.example` · `packages/contracts/**` ·
RAG/retriever wiring · approval endpoints · root `package.json` · `pnpm-lock.yaml`.

---

## 14. Dependency strategy

**No dependency change. No lockfile change.** `@anthropic-ai/sdk@^0.112.0` is already declared by
`apps/worker` (§2.4), the only package that needs it under the §3 split.

- **Official SDK vs direct HTTP:** the official SDK, already adopted and already load-bearing for the
  spike's typed error classes, `_request_id` extraction, retry policy, and `RequestOptions.signal`.
- **Package location:** `apps/worker` only today; `packages/provider-claude` in PR 6B (§3b).
- **Version pinning:** the caret range is unchanged in this PR. Exact-pinning is a separate,
  repo-wide convention decision.
- **Node / ESM-CJS:** `apps/worker` is `"type": "module"` and already imports the SDK successfully
  under both `tsx` and Vitest; `packages/agent-runtime` is CJS, which is exactly why the SDK must not
  move there. Node ≥ 22.21.0 (Verified), which also provides `AbortSignal.timeout`.
- **Bundle impact and React-bundle risk: none.** `apps/web` has no dependency on `apps/worker`; the
  existing `check:bundle` guard remains.
- **The key and the SDK remain server-side**, enforced structurally by §2.4's image boundary check.
- **SDK testability:** the existing `AnthropicMessagesClient` interface is the seam; a real
  `new Anthropic(...)` satisfies it structurally, and tests inject a fake with zero live calls.

---

## 15. Documentation update map

| Document | Update |
|---|---|
| `README.md` | `AGENT_RUN_PROVIDER_MODE=LIVE` and the fail-closed smoke command; scope the standing "no live model calls" claim to `apps/api` |
| `docs/04-agent-design.md` §22 | adapter is config-selected; configuration table; **supported-model set of exactly `claude-sonnet-5`** and why; pricing basis and its refresh step |
| `docs/08-cicd-deployment.md` §7 / §240 / §601 | deployment stays FAKE; **why** the SDK is absent from the image and that the boundary check enforces it |
| `docs/12-agent-run-api.md` §191 / §248 | API still refuses `LIVE`; existing wording remains accurate |
| `docs/10-engineering-challenges.md` | the neutral/Anthropic split, the image-boundary constraint, single-owner retry, and the corrected duration model |
| `apps/worker/.env.example` | `ANTHROPIC_MODEL=claude-sonnet-5`; timeout and retry names as comments |

All carry: local live-provider setup; the fail-closed smoke command with its paid-call warning; the
configuration table; error behaviour including `BILLING`; the **corrected** timeout/retry/deadline
wording (bounded per attempt and bounded retries, **not** a `timeout × attempts` wall-clock bound,
with the caller-owned signal as the only total bound); token and cost metadata with the pricing
basis; "public deployment remains FAKE"; "RAG is still not browser-wired"; and "PR 6B is required
before public live-LLM deployment".

**No final portfolio screenshots and no Portfolio-Ready claim are produced in PR 6A.**

---

## 16. Verification commands

```bash
git diff --check
pnpm install --frozen-lockfile           # must be a no-op: no dependency added
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opspilot/web run check:bundle
pnpm test:integration:sequential         # requires docker compose up + pnpm db:test:ensure
pnpm db:migrate:drift                    # must report no drift: no migration in this PR
pnpm --filter @opspilot/worker run test   # focused provider suite
docker build -t opspilot:verify .
docker run --rm --entrypoint sh opspilot:verify -c '! test -d /app/node_modules/@anthropic-ai'
```

Opt-in, manual, **paid**, never in CI:

```bash
OPSPILOT_LIVE_SMOKE=1 \
AGENT_RUN_PROVIDER_MODE=LIVE \
ANTHROPIC_MODEL=claude-sonnet-5 \
pnpm --filter @opspilot/worker run test:claude:live
```

---

## 17. Implementation sequence

1. Write this artifact (uncommitted).
2. Neutral additions to `packages/agent-runtime` (§3a) plus `index.ts` exports.
3. `claude-config.ts` and its tests, including the model allowlist.
4. Adapter changes: `classifyError` (incl. `BILLING`), log event, config injection, `{ signal }`.
5. `claude-pricing.ts`, `estimateCostUsd`, and their tests incl. basis metadata and cache quantities.
6. `create-llm-provider.ts`, selection-based factory tests, `module-boundary.test.ts`.
7. Mocked orchestrator-through-Claude integration test.
8. Spike runners consume the shared tool catalog (removes the §2.9 duplication).
9. Fail-closed live smoke, `test:claude:live`, `.env.example` update.
10. Documentation.
11. Full verification (§16), then independent review.

---

## 18. Acceptance criteria

- [ ] FAKE remains deterministic; FAKE test suites are unchanged.
- [ ] Normal CI needs no Anthropic key and makes no Anthropic request.
- [ ] `AGENT_RUN_PROVIDER_MODE` accepts exactly `FAKE` and `LIVE`; `LIVE` selects `ClaudeLlmProvider`.
- [ ] No `CLAUDE` execution-mode value exists anywhere in config, code, docs, or tests.
- [ ] `ANTHROPIC_MODEL` is required and **validated at configuration time** against the supported set
      `{ claude-sonnet-5 }`; an unsupported value fails **before** any live request.
- [ ] `max_tokens` derives solely from `input.maxOutputTokens`; no `ANTHROPIC_MAX_TOKENS` exists.
- [ ] The key remains server-side, is never logged, and survives a redaction test.
- [ ] The existing two-turn tool workflow works through the Claude adapter (mocked).
- [ ] Text and tool-use responses map into provider-neutral types; malformed ones become
      `protocol_error`, not throws.
- [ ] Per-attempt timeout and retry count are explicit, SDK-owned, and tested; **no documentation or
      test asserts `timeout × attempts` as a wall-clock bound**.
- [ ] The live smoke enforces a caller-owned total deadline via `AbortSignal.timeout(120_000)`.
- [ ] Provider errors map to stable, sanitized categories, including `BILLING` for HTTP 402 and
      `CANCELLED` for abort; 402 is **not** mapped to `AUTHENTICATION`.
- [ ] Latency and token usage are captured; cache read and creation tokens are recorded as separate
      quantities.
- [ ] The log event records `configuredMaxRetries`; it records no unverifiable actual attempt count.
- [ ] Cost is reported with `pricingBasis` and `pricingBasisDate`, is computed from `message.model`,
      and is `null` when that model has no pricing entry.
- [ ] The neutral factory takes `LlmProviderSelection` and does not reference `AgentJobRecord`.
- [ ] The live smoke fails closed: it exits non-zero unless all four gate conditions hold, and never
      falls back to FAKE.
- [ ] The live smoke is opt-in, low-budget, and excluded from CI.
- [ ] Public Render remains FAKE-only.
- [ ] No RAG, action execution, authentication, or public-live safeguards are added.
- [ ] `apps/api/**`, `apps/web/**`, `render.yaml`, `Dockerfile`, `ci.yml`, root `.env.example`,
      Prisma schema and migrations, and `pnpm-lock.yaml` are unchanged.
- [ ] The docker-smoke image boundary check still passes.
- [ ] `apps/worker/src/providers/` still has zero `apps/worker/**` imports, guarded by a test.
- [ ] Full repository checks pass.

---

## 19. Risks and alternatives

| Decision | Chosen | Alternative rejected | Why |
|---|---|---|---|
| Execution-mode enum | `FAKE \| LIVE` | `FAKE \| CLAUDE` | DB already persists `LIVE`; vendor belongs in metadata, not the mode enum; `CLAUDE` would force a PR 6B migration |
| Supported models | Exactly `claude-sonnet-5`, validated at config time | Arbitrary explicit model | The unconditional `thinking: { type: "disabled" }` request shape is not capability-safe across the family |
| Output budget | `input.maxOutputTokens` only | `ANTHROPIC_MAX_TOKENS` | A second authority with no defined precedence would silently override a deliberate caller budget |
| Wall-clock bound | Caller-owned `AbortSignal` | `timeout × attempts` formula | Backoff and `retry-after` add time no per-attempt timeout bounds |
| Retry ownership | SDK only | Application-level retry | Prevents compounded retries; SDK honours `retry-after` |
| Retry metadata | `configuredMaxRetries` | actual `attempts` | No reliable standard response field; would require untested instrumentation |
| Factory input | `LlmProviderSelection` | `AgentJobRecord` | Keeps the adapter free of database types so PR 6B can move it |
| 402 handling | Distinct `BILLING` category | Fold into `AUTHENTICATION` | Different operator action; Anthropic exposes it as a distinct type |
| Pricing basis | `ACTIVE_RATE` + basis date | Bare `estimatedCostUsd` at future standard rate | An unlabelled number cannot be re-derived; the active rate is the realistic estimate |
| Metadata location | Log event only | Persistence schema change | Nothing consumes the fields yet; avoids a speculative migration |
| SDK vs direct HTTP | Official SDK | Hand-rolled HTTP | Would reimplement typed errors, `_request_id`, retries, `signal` |
| Live smoke | Standalone fail-closed script | Vitest case | Keeps real-provider assertions out of the test runner entirely |
| Production safety flag | Defer to PR 6B | Add a `NODE_ENV` gate now | Would be dead code; `apps/api` already refuses `LIVE` unconditionally |

Residual risks: the `claude-sonnet-5` introductory rate expires 2026-08-31 and the basis must be
rolled over (§20); PR 6B could still copy code (mitigated by §3a/§3c and the boundary test); the
caret SDK range admits a minor upgrade (unchanged in this PR).

---

## 20. Remaining owner questions

Only three remain genuinely unresolved. Everything else is recorded as decided at the top of this
document.

1. **PR 6B packaging destination.** Does the Anthropic adapter move into a new
   `packages/provider-claude` that both apps depend on, or move into `packages/agent-runtime` with
   the Docker image-boundary check retired? This determines whether the boundary assertion in
   `ci.yml` survives PR 6B.
2. **Pricing-basis rollover.** `claude-sonnet-5`'s introductory rate expires **2026-08-31**. Should
   PR 6A ship a test that fails once `pricingBasisDate` is older than the active rate's validity
   window — forcing a deliberate rollover — or is a documented manual refresh step sufficient?
3. **PR 6B deadline ownership.** Which layer of the API path constructs the `AbortSignal` that
   bounds a live run: the Nest controller, an interceptor, or `AgentRunService`? PR 6A ships only the
   seam and deliberately leaves this open.
