# Issue #38 — Live Investigation Timeline Polling and Resume

## Context

Issue #37 shipped an incremental canonical event ledger: `appendInvestigationEvent`
writes each lifecycle event as it happens, and a `RUNNING` run now has real rows in
`agent_trace_events` before it terminates. Nothing in the browser can see them.

Today the Progress Timeline is derived entirely from frontend request boundaries
(`apps/web/src/investigation-progress/investigation-progress-stages.ts`): one "Agent
investigation in progress…" row that stays Active from the moment `POST
/v1/agent-jobs/:jobId/runs` is sent until it returns. That POST executes the whole
run synchronously (`AgentRunService.executeAndPersist`), so for a LIVE run the user
watches a single unchanging row for the entire investigation, and a page refresh
loses the investigation completely — there is no URL identity and no way back.

#38 makes the Timeline reflect persisted server facts, and makes `?job=<uuid>`
restore an investigation after refresh. The outcome: the existing run row expands
with four live child rows as the agent actually progresses, and a reload mid-run
picks the same run back up.

Non-negotiable constraints taken from the repo, not invented here:

- The run row commits `RUNNING` **before** provider execution, inside the blocking
  POST (docs/16 §8). So polling must run **concurrently with** that request, and
  either the POST or a poll tick may observe the terminal outcome first.
- `jobId` is known to the browser before the run request is sent; `runId` is not.
  That is why the resume key is `?job=` (docs/16 §8, approved).
- `deriveExecutionStageProgress` (`packages/contracts/src/investigation-stage-progress-reducer.ts`)
  is the single place stage transitions are decided. React must not re-derive them.
  It **throws** `InvestigationEventContractError` on a malformed stream rather than
  repairing it.
- `clientRequestId` is never added to any public API response (docs/16 §8).

**Decisions approved and preserved across every revision** — not reopened here:
`GET /v1/agent-jobs/:jobId/investigation`, one `RepeatableRead` snapshot for
job/latest-run/rows, latest-attempt selection, unchanged legacy run/job response
shapes, no approval embedding, no `clientRequestId`, one self-scheduling
`setTimeout` chain (never `setInterval`), a dedicated polling `AbortController` +
generation pair, `?job=<uuid>`, use of the shared reducer, no SSE/WebSocket, no #39
work, no provider/LIVE calls during implementation tests, the run row expanding in
place with four child rows rather than being replaced, the fail-closed
`ExecutionStageDerivation` tri-state, and `invalidateInFlightWorkflows` obsoleting a
stale POST/capability/poll response on navigation.

This revision resolves the two remaining correctness gaps found in final review: the
terminal-settlement coordinator must reject a **contradictory** terminal observation
(poll says `COMPLETED`, a late POST says `FAILED` for the same run attempt) rather
than treating it as a second, different settlement; and the run row's expand/collapse
state must be scoped to a stable run identity rather than one component-local
boolean, so a RUNNING run cannot be collapsed and a collapsed terminal run's choice
never leaks onto the next run, attempt, or job.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Canonical read | `packages/database/src/repositories/agent-run-repository.ts:748` `getInvestigationEventRecords` | Repository-only, keyed by `runId`, own `RepeatableRead` transaction. No service, no DTO, no route. |
| Run read | same file `:1074` `getAgentRun` | One `RepeatableRead` transaction: run + job + trace rows → `fromTraceEventRows` + `buildOutcome`. |
| Job read | same file `:1048` `getAgentJob` | Job + run summaries, `attemptNumber` ASC. No trace/report. |
| Row → record | `packages/database/src/mappers.ts:150` `fromInvestigationEventRows` | Contiguity check from 1, then `InvestigationEventRecordSchema` per row. |
| Row → legacy | same file `:196` `fromTraceEventRows` | Marker check → canonical projection, else byte-identical legacy path. |
| Reducer | `packages/contracts/src/investigation-stage-progress-reducer.ts:352` | `(events, runStatus, now) → ExecutionStageProgress[4]`. Accepts partial RUNNING prefixes; **throws** on a malformed stream. Never repairs. |
| Origin marker | `packages/contracts/src/investigation-lifecycle-compatibility.ts:42` | `RUN_CREATED` at sequence 1 ⇒ canonical. Corrupt canonical stays canonical, deliberately. |
| Service | `packages/agent-runtime/src/persistence/agent-run-service.ts:63` `createPrismaAgentRunRepository` | Exposes `getAgentRun`/`getAgentJob`; **no** canonical event read. |
| API | `apps/api/src/agent-jobs/agent-jobs.controller.ts`, `apps/api/src/agent-runs/agent-runs.controller.ts` | `POST /agent-jobs`, `GET /agent-jobs/:jobId`, `POST /agent-jobs/:jobId/runs`, `GET /agent-runs/:runId`, approval GET/POST. |
| Error catalog | `apps/api/src/errors/api-error-catalog.ts` | Closed `ApiErrorCode` union with fixed status/message, including `AGENT_JOB_NOT_FOUND` (404), `INTERNAL_DATA_INVALID` (500), `PERSISTENCE_UNAVAILABLE` (503), `ROUTE_PARAMETER_INVALID` (400) — every error this new endpoint can produce already exists. |
| Web http client | `apps/web/src/api/http-client.ts` | `ApiRequestError { status, code, message, requestId }`. A `fetch` throw (not `AbortError`) is normalized to `code: "NETWORK_UNAVAILABLE"`. This is the one place a poll error is classified from. |
| Web state | `apps/web/src/App.tsx:104` | Sole stateful component. `job`, `run: AgentRunDetail`, `approval`, `phase`, plus two independent abort/generation pairs: main (`controllerRef`/`generationRef`, via `beginWorkflow()`) and capabilities (`capabilityControllerRef`/`capabilityGenerationRef`). |
| Web stages | `apps/web/src/investigation-progress/investigation-progress-stages.ts:187` | `deriveInvestigationProgressStages` → flat rows for `availability`/`job`/`run`/`approval`. `runStageStatus` comments explicitly defer to #38. |
| Timeline component | `apps/web/src/components/InvestigationProgressTimeline.tsx` | Renders one flat `<ol>` of `<li>` rows, keyed by `stage.key`, each a `StatusBadge` + label. **No nesting exists today.** |
| Web contracts use | `apps/web/src/api/types.ts` | **Type-only** import of `@opspilot/contracts`. No value import exists yet. |
| Bundle guard | `apps/web/src/build-guard/forbidden-patterns.ts` | Forbidden-string rules only (no size budget); nothing here blocks a contracts value import. |

Two consequences worth stating plainly:

1. **No API change is needed to *discover* the run.** `GET /v1/agent-jobs/:jobId`
   already returns run summaries with status. What is missing is the canonical
   `events[]`, without which the shared reducer cannot be used at all.
2. **A two-call read is unsafe.** Reading the run row and the event rows in separate
   transactions can pair `runStatus: "RUNNING"` with a stream that already contains
   `RUN_COMPLETED`; the reducer rejects that pair with `RUN_STATUS_MISMATCH`. The new
   read must take one snapshot.

`InvestigationProgressTimeline.tsx` **does** require a structural change: rendering
the four canonical stages as child rows under the existing run row needs a
parent/child shape the component does not have today, plus a stable per-run identity
so expand/collapse state behaves correctly across a live run, a terminal run, and a
navigation to a different run or job (§5). §5 scopes that change to the minimum — one
optional field, one nested list, one collapse toggle gated on run status, one identity
prop — not a new component or a second Timeline section.

---

## 2. Proposed API contract — unchanged, approved

### `GET /v1/agent-jobs/:jobId/investigation`

Anonymous, like every other read on this demo. `jobId` is a v4 UUID and unguessable;
no new authorization concept is introduced (consistent with `GET /v1/agent-jobs/:jobId`).

```jsonc
{ "data": {
  "job":     { "id", "ticketId", "summary", "createdAt" },
  "run":     { "id", "jobId", "attemptNumber", "status", "providerMode",
               "modelIdentifier", "startedAt", "finishedAt", "createdAt",
               "estimatedCostUsd" } | null,
  "trace":   [ /* legacy AgentTraceEvent, stored order */ ],
  "outcome": { "type": "RUNNING" | "COMPLETED" + report | "FAILED" + code/message } | null,
  "events":  [ { "runId", "sequence", "recordedAt", "payload" } ]   // sequence ASC
} }
```

- `run`/`outcome` are `null` and `trace`/`events` are `[]` when the job has no run yet
  (the window between `createAgentJob` resolving and the run-creation transaction
  committing). That is a real, expected state, not an error.
- **Latest attempt only**, selected by `MAX(attemptNumber)`. There is no
  at-most-one-`RUNNING`-run invariant (docs/16 §8), so the client additionally applies
  a `minAttemptNumber` floor during a retry — see §3.
- `trace` is included so the existing `TraceTimeline`, `ReportPanel`,
  `SuggestedActionsPanel` and `RunContextPanel` can be fed from a poll response with
  no new render paths. It is produced by the **same** `fromTraceEventRows` the legacy
  endpoint uses.
- **`GET /v1/agent-runs/:runId` is not touched.** Its `{ job, run, trace, outcome }`
  shape, and every legacy consumer of it, stay exactly as they are.

Deliberately **absent**: `clientRequestId`, approval state, provider prompts/responses,
raw tool input/output, database column names, internal ids beyond `runId`/`jobId`,
persistence error text. Response construction is explicit field-by-field mapping —
never a spread of a domain record — matching the existing mapper convention and its
key-set tests.

**No `eventsFormat` field.** The client calls the exported
`hasCanonicalInvestigationLifecycleMarker(events)` itself; adding a server-side verdict
would be a second place the canonical/legacy decision is made.

**Approval is deliberately not embedded.** Approval only becomes meaningful at
terminal `COMPLETED`, polling stops there, and the terminal-settlement path (§5) already
owns the "run just settled → load approval, freeze the clock, announce" sequence.
Reusing it costs exactly one extra request per investigation and keeps the shipped
approval flow untouched.

### Errors

| Case | Response |
| --- | --- |
| `jobId` not a UUID | 400 `ROUTE_PARAMETER_INVALID` (existing `ZodParamValidationPipe`) |
| Job absent | 404 `AGENT_JOB_NOT_FOUND` (existing `mapDomainError`, context `getAgentJob`) |
| Stored stream fails validation/contiguity | 500 `INTERNAL_DATA_INVALID` |
| Database outage | 503 `PERSISTENCE_UNAVAILABLE` |

No new `ApiErrorCode` is added. The 500 on corrupt stored data is the honest,
existing behavior (`fromTraceEventRows` already 500s the legacy endpoint the same
way), and it is preferable to serving `events: []`, which would silently route
corrupt canonical data into the frontend's legacy inference path — precisely what
docs/16 §6 argues against, and precisely what §4/§5 below make structurally impossible
on the client too.

---

## 3. Polling state machine

One self-scheduling `setTimeout` chain; never `setInterval`. The next tick is
scheduled only from the previous response's settle handler, so **overlap is
structurally impossible** rather than guarded against.

```
        idle ──start(jobId)──► polling ──terminal claimed (§5)──► stopped(terminal)
                                 │
                                 ├── 400/404 (permanent) ────────► stopped(gone|invalid)
                                 ├── INTERNAL_DATA_INVALID ──────► paused(data-corrupt)
                                 ├── transient (5xx/network) ─┐
                                 │        ≤5 consecutive       ├─ backoff, retry
                                 │        ◄────────────────────┘
                                 │        6th consecutive ─────► paused(retryable)
                                 └── 5 min continuous polling ──► paused(retryable)
```

**Cadence** (bounded, deliberately not exponential while healthy — #39 shares this
server):

| Time since polling started | Delay after each response settles |
| --- | --- |
| < 10 s | 1 000 ms |
| < 60 s | 2 000 ms |
| ≥ 60 s | 5 000 ms (ceiling) |

**Transient failure backoff**: 2 s → 4 s → 8 s → 15 s → 15 s, reset to the healthy
cadence on the first success. The last good snapshot stays on screen untouched, so a
blip never resets the visible Timeline.

### Error classification (resolves the transient-vs-permanent contradiction)

A pure function, `classifyInvestigationPollError(error): PollErrorClassification`,
lives in `apps/web/src/api/poll-error-classification.ts` and is the **only** place
this decision is made — the state machine above and the failure table in §7 both
describe its output, not a second independent rule.

```ts
export type PollErrorClassification =
  | { readonly kind: "transient" }
  | { readonly kind: "permanent-invalid" }   // 400 ROUTE_PARAMETER_INVALID, or any
                                              // other 4xx this endpoint is not
                                              // documented to return
  | { readonly kind: "not-found" }           // 404 AGENT_JOB_NOT_FOUND
  | { readonly kind: "data-corrupt" };       // 500 INTERNAL_DATA_INVALID

export function classifyInvestigationPollError(error: unknown): PollErrorClassification {
  if (!(error instanceof ApiRequestError)) return { kind: "transient" }; // network/fetch failure
  switch (error.code) {
    case "AGENT_JOB_NOT_FOUND": return { kind: "not-found" };
    case "INTERNAL_DATA_INVALID": return { kind: "data-corrupt" };
    case "ROUTE_PARAMETER_INVALID": return { kind: "permanent-invalid" };
    case "PERSISTENCE_UNAVAILABLE": return { kind: "transient" };
    default:
      // Any other 5xx (including one this endpoint is not documented to
      // produce): bounded retry, same as PERSISTENCE_UNAVAILABLE — a
      // conservative default that never silently retries a KNOWN
      // non-recoverable data-corruption code forever, and never gives up
      // on a genuinely transient server hiccup on its first observation.
      // Any other 4xx: permanent-invalid — fail closed rather than retry
      // a request the server has told us, in a documented way, it will
      // never accept.
      return error.status >= 500 ? { kind: "transient" } : { kind: "permanent-invalid" };
  }
}
```

This directly drives the diagram above: `transient` retries with backoff;
`data-corrupt` pauses **immediately**, with **zero** automatic retries, keeping the
last good snapshot (§4 governs what "last good" means for the stage rows
specifically); `not-found` stops and strips `?job=`; `permanent-invalid` stops with an
error state (unreachable in practice once a job is validated before polling starts,
but classified rather than left to fall through).

**Stop conditions**, all of them:
- terminal outcome **claimed** by this observation (§5's settlement coordinator) — the
  normal exit;
- `not-found` / `permanent-invalid` — permanent; no retry;
- 6 consecutive `transient` failures → `paused(retryable)`
- 5 minutes of continuous polling → `paused(retryable)`. This is the bound for a run
  left `RUNNING` by an event-emission persistence failure or a service crash — no
  terminal event will ever arrive, so polling must not run forever.
- unmount, new submission, `startNewInvestigation`, `popstate` to a different job
  (§6 — this now also invalidates the blocking POST, not only polling)

**"Check again"** is offered in both `paused` states and always starts a **new
bounded polling session**: the 5-minute budget, the consecutive-failure counter, and
the backoff delay all reset to their starting values. It never resumes the old
session's counters — a stale failure streak from before the pause must not make the
very next tick look like it is already close to giving up again. For `paused(data-corrupt)`
this is a deliberate, honest exception to "no automatic retries": the user explicitly
asked, once, and a fresh manual check is not an automatic retry loop.

**Isolation.** Polling gets its own third `AbortController` + generation pair
(`pollControllerRef`/`pollGenerationRef`), following the reasoning already written on
`capabilityControllerRef` in `App.tsx`: sharing `controllerRef` would let a poll tick
abort the in-flight blocking POST, or let a new submission's abort silently kill
polling in a way the state machine cannot observe. This internal generation exists
**solely** to let the poll hook detect and drop its own overlapping/stale fetches; it
is never read outside the hook, and — critically, per §5 — it is a **different
number** from the main App workflow generation and must never be used as the terminal
settlement identity's `generation` field.

**Stale-response rules** (pure helper `isNewerInvestigationSnapshot(current, incoming)`,
unit-tested on its own — used only to decide whether a **poll** response may update
`run`/`events`; §5 covers the separate question of who performs terminal side effects):
- discard if `incoming.job.id !== currentJobId` or the poll generation is stale;
- discard if `incoming.run === null` while a run is already known;
- discard if `incoming.run.attemptNumber < minAttemptNumber` (set from the previous
  attempt before `retryRun`/`retryLiveRunWithToken`, implementing docs/16 §8's
  "prefer a strictly greater attempt" rule);
- discard if the incoming run is `RUNNING` for a run already known terminal, or
  carries fewer `events` than the currently held snapshot for the same `runId`.

Monotonic by construction: a late tick can never walk the Timeline backwards.

---

## 4. Canonical stage derivation — fail-closed, never silently legacy

The reducer's output is wrapped in an explicit, exhaustively-handled state so that
"we don't currently have valid canonical detail" can **never** be represented the
same way as "this run predates #37 and was never canonical" — those are different
facts and must render differently.

`packages/contracts` is unchanged; this type lives in
`apps/web/src/investigation-progress/execution-stage-derivation.ts`:

```ts
export type ExecutionStageDerivation =
  | { readonly kind: "legacy" }
  | { readonly kind: "canonical"; readonly stages: readonly ExecutionStageProgress[] }
  | { readonly kind: "canonical-invalid"; readonly lastGoodStages: readonly ExecutionStageProgress[] | null };

export function deriveExecutionStageDerivation(
  events: readonly InvestigationEventRecord[],
  runStatus: InvestigationRunStatus,
  now: string,
  previous: ExecutionStageDerivation,
): ExecutionStageDerivation {
  if (!hasCanonicalInvestigationLifecycleMarker(events)) return { kind: "legacy" };
  try {
    return { kind: "canonical", stages: deriveExecutionStageProgress({ events, runStatus, now }) };
  } catch {
    const lastGoodStages =
      previous.kind === "canonical" ? previous.stages
      : previous.kind === "canonical-invalid" ? previous.lastGoodStages
      : null; // previous was "legacy" — a marker flip from false to true never
               // happens for one run, so this branch is only reachable on a
               // run's FIRST snapshot.
    return { kind: "canonical-invalid", lastGoodStages };
  }
}
```

`now` is computed once, at the moment a snapshot is accepted — the reducer's
`elapsedMs` field is not rendered per-row today (only the existing top-level elapsed
clock is, driven by `submittedAt`/`submittedFinishedAt`, untouched), so there is no
need to recompute this on a ticking timer.

Rendering rule, enforced in `deriveInvestigationProgressStages` (§5):

| Derivation | Run row | Child rows |
| --- | --- | --- |
| `legacy` | today's rendering, unchanged | none — exactly today's behavior |
| `canonical` | today's status logic (from `runOutcomeType`/`failedStage`, unaffected) | the four reducer stages, mapped 1:1 |
| `canonical-invalid`, `lastGoodStages` present | same status logic | the **frozen** last-good stages (visibly the same rows as before the corruption was detected; polling is `paused(data-corrupt)`, which already surfaces the "something needs attention" signal) |
| `canonical-invalid`, `lastGoodStages` null | same status logic | **none** — plus one small, explicit note rendered directly under the Timeline (not fabricated per-row state): *"Detailed step-by-step progress isn't available for this run right now."* |

No branch of this table ever infers a stage's status from a timer, a percentage, or
"probably completed by now" — the `canonical-invalid`/null case explicitly renders
*nothing* for the steps rather than guessing. `report`, `trace`, and the run's own
outcome badge remain visible in every row of this table; only the four child rows are
affected.

---

## 5. Frontend changes

### New files

- `apps/web/src/url/investigation-url.ts` — `readJobParam(search)`, `isUuid`,
  `withJobParam` / `withoutJobParam`. Pure string functions; History API calls stay
  in `App.tsx`.
- `apps/web/src/hooks/useInvestigationPoll.ts` — the state machine in §3. Owns the
  timer, controller, its own internal generation, backoff counter and start time;
  exposes `{ status, start(jobId, opts), stop(), resume() }` and calls back with
  `{ snapshot, classification }` on each settle. No React state derived inside it
  beyond `status`. Never exposes its internal generation to a caller.
- `apps/web/src/api/poll-error-classification.ts` — `classifyInvestigationPollError`
  (§3), unit-tested in isolation against constructed `ApiRequestError`s and a plain
  network throw.
- `apps/web/src/investigation-progress/investigation-snapshot.ts` —
  `isNewerInvestigationSnapshot`, and `toAgentRunDetail(snapshot)` which builds the
  existing `AgentRunDetail` shape from a snapshot with a non-null run.
- `apps/web/src/investigation-progress/execution-stage-derivation.ts` — §4's type and
  function.
- `apps/web/src/investigation-progress/execution-stage-rows.ts` — canonical child-row
  labels + `ExecutionStageProgress[] → ExecutionStageRowViewModel[]`.
- `apps/web/src/investigation-progress/terminal-settlement.ts` — the terminal
  settlement coordinator described below: `TerminalSettlementIdentity`,
  `TerminalObservationDecision`, and `resolveTerminalObservation`. Pure and
  ref-free (the ref that holds the last claim lives in `App.tsx`; this module is
  just the decision function, unit-tested with a plain object standing in for the
  ref's current value).

### Changed files

**`apps/web/src/api/types.ts` / `endpoints.ts`** — add `InvestigationStateResponse`
(mirroring §2, reusing the existing `AgentRunRecordView`/`AgentRunOutcomeView`/
`AgentTraceEvent` types plus a type-only `InvestigationEventRecord` from
`@opspilot/contracts`) and `getInvestigationState(jobId, signal)`.

**`apps/web/src/investigation-progress/investigation-progress-stages.ts`**

- add `"omitted"` to `InvestigationProgressStageStatus` and to
  `presentInvestigationProgressStage` (tone `neutral`, glyph `–`, badge "Not
  applicable") — the switch is exhaustive, so this fails to compile until handled;
- add a new, exported `ExecutionStageRowViewModel { key: InvestigationExecutionStage;
  status: InvestigationProgressStageStatus; label: string }`;
- widen `InvestigationProgressStageViewModel` with one optional field:
  `readonly children?: readonly ExecutionStageRowViewModel[]`. Present **only** on
  the `"run"` row, and **only** when `executionStageDerivation.kind` is `"canonical"`
  or `"canonical-invalid"` with non-null `lastGoodStages`. Every other row, and every
  legacy run, carries no `children` at all — structurally identical to today's flat
  row for every case that isn't canonical;
- `DeriveInvestigationProgressStagesInput` gains
  `executionStageDerivation: ExecutionStageDerivation` (§4);
- `deriveInvestigationProgressStages`'s existing `run`-row branch is unchanged for
  computing **status** (still `runStageStatus`, still driven by real request-lifecycle
  and outcome signals only — this is exactly the signal §5's expansion rule reuses to
  decide "is this run currently live"). It is extended to additionally attach
  `children` per the §4 table, and to expose the "detail unavailable" note as a
  second, optional return value `{ stages, executionDetailNote: string | null }`
  rather than folding that note into any one row's `label` — it is Timeline-adjacent
  context, not a stage fact.
- `EXECUTION_STAGE_CHILD_LABELS` (in the new `execution-stage-rows.ts`, imported here):
  `INVESTIGATION_CREATED → "Investigation created"`, `AGENT_ANALYSIS → "Agent analysis"`,
  `DIAGNOSTIC_EXECUTION → "Diagnostic execution"`, `REPORT_GENERATION → "Report
  generation"` — one label per stage (no separate active/completed wording): these
  are factual step names, and status is carried entirely by the badge, exactly as the
  approved hierarchy diagram writes them.

A failed canonical stage renders the existing Failed badge only. **No new
failure-code→text map is added to the browser**; `outcome.message` (already a safe,
server-mapped string) and the `ErrorBanner` remain the only failure prose.

**`apps/web/src/components/InvestigationProgressTimeline.tsx`** — the minimum
structural change that makes nesting, and correctly-scoped expansion, real:

```ts
export interface InvestigationProgressTimelineProps {
  readonly stages: readonly InvestigationProgressStageViewModel[];
  readonly elapsedLabel: string;
  readonly executionDetailNote: string | null;
  /**
   * A stable identity for the CURRENT run attempt — `${jobId}:${runId}:
   * ${attemptNumber}` — or `null` when no run exists yet. Its only job is to
   * tell this component's local collapse state when the underlying run has
   * genuinely changed, so a user's manual collapse choice resets exactly
   * once per run/attempt/job and never leaks onto the next one, and never
   * resets on an ordinary poll tick or re-render for the SAME run.
   */
  readonly runExpansionKey: string | null;
}
```

- one local `collapsed` boolean, reset by `useEffect(() => setCollapsed(false),
  [runExpansionKey])` — the **only** place `collapsed` is ever written back to
  `false` automatically. It is never reset by a new `stages`/`children` array, a new
  poll tick, or a re-render for the same run — only by `runExpansionKey` changing,
  which happens exactly when the run itself changes (a new attempt, a new job, or a
  fresh submission), never while the same run is merely progressing;
- the run row's own `status` (already computed by `runStageStatus`, unaffected by any
  of this) doubles as the "is this run currently live" signal: `isRunning = runRow.status
  === "active"`. While `isRunning`, the disclosure control is **omitted** and the child
  `<ol>` always renders — a RUNNING run's steps can never be collapsed, satisfying
  "child rows are forced expanded and the collapse control is disabled or omitted"
  without needing a second piece of state to track "forced" vs. "user-chosen";
- once the run is terminal (`isRunning === false`), the disclosure `<button>`
  (`aria-expanded`, toggling `collapsed`) appears, and the effective expansion is
  `!collapsed` — default `false` (expanded), so a terminal run is expanded by default
  and only a user click ever collapses it;
- when `stage.children` is `undefined` (legacy, or `canonical-invalid` with no
  last-good rows) — no disclosure control and no nested `<ol>` at all, regardless of
  `runExpansionKey` or run status. "No empty disclosure" falls out for free: there is
  nothing to disclose;
- one nested `<ol className="investigation-progress-children-list">` inside the run
  `<li>`, each child a `<li className="investigation-progress-item
  investigation-progress-item--child investigation-progress-item--{status}">` with a
  `StatusBadge` + label, exactly like a top-level row;
- one new CSS rule for indentation (`investigation-progress-item--child { margin-left:
  1.5rem }`), added to `apps/web/src/styles.css` next to the existing
  `.investigation-progress-item` rules;
- `executionDetailNote` renders as one `<p className="investigation-progress-note">`
  directly under the `<ol>`, only when non-null.

This is a real structural change to the file — a second, nested list, a toggle, and
one identity prop that scopes that toggle's reset — but it is not a new component, not
a second Timeline section, and not a container/card: the run `<li>` is still one row
in the same `<ol>` it is in today.

**`apps/web/src/App.tsx`**

New refs/state:
- `pollControllerRef`/`pollGenerationRef` — owned inside `useInvestigationPoll`, not
  in `App.tsx` directly.
- `events: readonly InvestigationEventRecord[]`.
- `executionStageDerivation: ExecutionStageDerivation` (starts at `{ kind: "legacy" }`).
- `minAttemptNumber: number` — the attempt floor from §3, bumped by
  `retryRun`/`retryLiveRunWithToken`.
- `terminalSettlementClaimRef: MutableRef<TerminalSettlementClaim | null>` — see below.
- `runExpansionKey` — **not stored state**, a derived value computed inline on every
  render as `job !== null && run !== null ? \`${job.id}:${run.run.id}:${run.run.attemptNumber}\`
  : null` and passed straight to `InvestigationProgressTimeline`. It needs no
  memoization: it is a cheap string template, and recomputing it every render is what
  makes it correctly track `job`/`run` with no separate effect of its own.
- new phase `"resuming"`, label "Restoring investigation…".

**Terminal settlement coordinator** (resolves the POST/poll race, including a
**contradictory** one). The blocking POST and the poller are two independent
observers of the same run; either may see the terminal outcome first, and — because
they are separate requests against a system that a persistence bug or a corrupted read
could theoretically disagree with itself over — they must not be assumed to agree.

**Identity is separated from status.** A run attempt has exactly one true terminal
status; two observations that disagree about it are not "two different settlements",
they are an impossible internal-consistency failure that must be detected, not
silently overwritten:

```ts
interface TerminalSettlementIdentity {
  readonly jobId: string;
  readonly runId: string;
  readonly attemptNumber: number;
  /**
   * The MAIN App workflow generation from `beginWorkflow()` — the same number
   * `isStale(generation)` already checks at every call site. NEVER
   * `useInvestigationPoll`'s own internal generation (§3): that number exists
   * purely for the poll hook's own overlap bookkeeping and is not visible
   * outside it. If the two observers' identities were built from different
   * generation sources, they could never compare equal and this coordinator
   * could never deduplicate anything.
   */
  readonly generation: number;
}

interface TerminalSettlementClaim {
  readonly identity: TerminalSettlementIdentity;
  readonly terminalStatus: "COMPLETED" | "FAILED";
}

type TerminalObservationDecision =
  | { readonly kind: "owner" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "inconsistent-terminal-status" };

function resolveTerminalObservation(
  priorClaim: TerminalSettlementClaim | null,
  identity: TerminalSettlementIdentity,
  terminalStatus: "COMPLETED" | "FAILED",
): { readonly decision: TerminalObservationDecision; readonly nextClaim: TerminalSettlementClaim } {
  const sameIdentity =
    priorClaim !== null &&
    priorClaim.identity.jobId === identity.jobId &&
    priorClaim.identity.runId === identity.runId &&
    priorClaim.identity.attemptNumber === identity.attemptNumber &&
    priorClaim.identity.generation === identity.generation;

  if (!sameIdentity) {
    return { decision: { kind: "owner" }, nextClaim: { identity, terminalStatus } };
  }
  return priorClaim.terminalStatus === terminalStatus
    ? { decision: { kind: "duplicate" }, nextClaim: priorClaim }
    : { decision: { kind: "inconsistent-terminal-status" }, nextClaim: priorClaim };
}
```

`resolveTerminalObservation` is pure (§5 "New files") and takes the ref's current
value as a plain argument rather than reading a ref itself, so it is trivially unit-
testable; `App.tsx` wraps it with the one line that reads/writes
`terminalSettlementClaimRef.current`. The ref is cleared to `null` **inside
`beginWorkflow()` itself** (one edit, one place) — so every new workflow generation
(a fresh submission, a retry, or a resume — see §6) starts with a clean claim slot,
and a claim from a superseded generation can never block the real settlement of a new
run.

**The consistency decision happens BEFORE any terminal state is applied.** Both
observers funnel through one function:

```
applyObservedRunOutcome(candidate, events, signal, generation, source):
  if isStale(generation): return                              // superseded workflow
  if source === "poll" and not isNewerInvestigationSnapshot(current, candidate):
    return                                                     // stale/regressive poll tick

  if candidate.outcome.type === "RUNNING":
    setRun(candidate); setEvents(events); recompute executionStageDerivation
    return                                                     // unchanged from §3/§4 — no
                                                                 // settlement is involved

  // candidate is terminal (COMPLETED or FAILED) — decide FIRST, apply SECOND.
  identity = { jobId: candidate.job.id, runId: candidate.run.id,
               attemptNumber: candidate.run.attemptNumber, generation }
  { decision, nextClaim } = resolveTerminalObservation(
    terminalSettlementClaimRef.current, identity, candidate.outcome.type)
  terminalSettlementClaimRef.current = nextClaim

  if decision.kind === "inconsistent-terminal-status":
    poll.stop()
    setNotice(TERMINAL_INCONSISTENCY_NOTICE)   // fixed, safe string — no raw
                                                 // payload, code, or message from
                                                 // either observation
    setPhase("idle")
    return                                       // run/outcome/events are NOT
                                                   // touched — the FIRST accepted
                                                   // terminal state stands exactly
                                                   // as it was

  // "owner" or "duplicate": both apply state (harmless even when duplicate —
  // it is the SAME status, so re-applying it changes nothing visible) —
  // only "owner" performs the once-only side effects below.
  setRun(candidate); setEvents(events); recompute executionStageDerivation
  poll.stop()
  if decision.kind === "owner":
    fetch approval; setSubmittedFinishedAt(Date.now()); compose/setNotice(...)
  setPhase("idle")
```

`TERMINAL_INCONSISTENCY_NOTICE` is one fixed constant in `App.tsx`, e.g. *"This
investigation reported inconsistent results and could not be settled. Refresh or
start a new investigation."* — worded exactly like every other stage-failure
announcement (`stageFailureAnnouncement`), never interpolating either observation's
code, message, or report.

This design satisfies every rule from both revisions:
- **exactly one path performs terminal side effects** for a genuinely-agreeing run —
  the claim has exactly one `"owner"`;
- **a contradictory second observation neither overwrites nor re-settles** — it is
  routed to its own branch before any state write, the first accepted terminal state
  is never touched, and no side effect (approval fetch, announcement, clock freeze)
  repeats;
- **an older terminal POST cannot overwrite a newer submission/resumed job/higher
  attempt** — `isStale(generation)` (bumped by every `beginWorkflow()`, including
  resume — §6) rejects it before the function's body even runs;
- **direct POST success still works when polling never observes terminal** — the
  claim is empty, the POST trivially becomes `"owner"`;
- **terminal polling still works when the POST is lost/aborted** — an aborted/never-
  resolving POST promise is ignored (`isAbortError`) or never reaches this function at
  all; the poller becomes `"owner"` on its own;
- **duplicate terminal poll snapshot** (two ticks both observe the SAME terminal
  status, e.g. because a tick already in flight when `poll.stop()` is requested still
  resolves) — `"duplicate"`, state re-applied harmlessly, no side effect repeats;
- **contradictory terminal poll/POST** (one says `COMPLETED`, the other `FAILED`, same
  identity) — `"inconsistent-terminal-status"`, the first stands, a safe notice is
  shown, polling stops, nothing about the run is silently rewritten.

**Submit path** (`runInvestigation`): after `createAgentJob` resolves → write the URL
(§6) → `poll.start(job.id, { onSnapshot, onError })`, where `onSnapshot` is a closure
over **this call's** `generation` (from this workflow's `beginWorkflow()`) that invokes
`applyObservedRunOutcome`. Polling runs while the blocking `startAgentRun` POST is
awaited; that POST's own resolution is fed through the exact same
`applyObservedRunOutcome` function, closing over the same `generation`. Every other
entry point that starts polling (retry, resume — §6) follows the identical pattern:
capture `generation` from that entry point's own `beginWorkflow()` call, and hand it
to both the POST continuation and `poll.start`'s callback. There is exactly one
function that decides terminal ownership, and every caller feeds it the same kind of
generation number by construction.

**Known, accepted limitation to document:** `liveRequestKey` lives only in memory, so a
LIVE job resumed after a reload cannot offer idempotent recovery — minting a fresh key
would risk a second paid run. A resumed LIVE job with no run shows "start a new
investigation" instead of "Recover Live Run". Within a session, Milestone 8 recovery is
completely unaffected.

**Bundle note:** this introduces the first *value* import of `@opspilot/contracts` in
the browser, which pulls zod into the bundle. The bundle guard has no size budget and
none of its forbidden patterns are triggered; `check:bundle` is run in verification to
confirm.

---

## 6. URL and navigation behavior

Param: `?job=<uuid>`. Rewrites go through `apps/web/src/url/investigation-url.ts`
using `URLSearchParams`, so any unrelated query parameter is preserved.

| Event | History action |
| --- | --- |
| Job created, URL has no `job` | `replaceState` — the same view gaining an identity, not a navigation |
| Job created, URL has a **different** `job` | `pushState` — so Back returns to the previous investigation |
| `startNewInvestigation` (abandon) | `replaceState`, param removed |
| `popstate` → `job` present and different | resume that job (below) |
| `popstate` → `job` absent | reset to the fresh form, without touching history |

`replaceState` fires immediately after `createAgentJob` resolves and **before** the
blocking run POST, so a refresh during execution already has the identity.

Malformed `job` value (not a v4 UUID, matched by a local regex — no zod parse and no
request): show "That investigation link isn't valid.", strip the param via
`replaceState`, render the ordinary fresh form. A bad link never becomes a 400.

### Navigation must obsolete the blocking POST, not only polling

`popstate` firing while an earlier submission's `POST /agent-jobs/:jobId/runs` (or a
capability preflight, or an approval fetch) is still in flight is a real case: the
existing `isStale(generation)` guard already protects every one of those call sites,
so the fix is to make navigation go through the **same** generation-bump-and-abort
entry point every other workflow transition uses — not a new mechanism.

```ts
function invalidateInFlightWorkflows(): { signal: AbortSignal; generation: number } {
  const next = beginWorkflow();               // bumps main generation, aborts the
                                                // main controller — covers
                                                // createAgentJob/startAgentRun/
                                                // getAgentRun/loadApproval/
                                                // recordApproval in flight, AND
                                                // clears terminalSettlementClaimRef
                                                // (see §5)
  capabilityControllerRef.current?.abort();     // a capability response is not
  capabilityGenerationRef.current += 1;         // job-scoped and is harmless to
                                                 // apply late, but aborting it
                                                 // avoids an unnecessary state
                                                 // write racing the resume hydration
  poll.stop();                                  // stops AND invalidates polling —
                                                 // bumps the hook's OWN internal
                                                 // generation, never the identity
                                                 // above, same convention
  return next;
}
```

`popstate`'s handler, the mount-time `?job=` resume, and `startNewInvestigation` (which
today calls bare `beginWorkflow()`) all call this **before** hydrating or resetting
any target state — so step order is always: (1) bump generation / abort main /
clear the terminal claim, (2) abort/invalidate capabilities, (3) stop/invalidate
polling, (4) only then read or reset. The `generation` this returns is exactly the one
a subsequent `poll.start(...)` callback and the resume read's own continuation both
close over, per §5's rule. No global state manager is introduced; this is
`beginWorkflow()`'s existing convention extended to the two other controller/
generation pairs `App.tsx` already owns.

---

## 7. Failure handling summary

One table, consistent with §3's classifier and §5's settlement coordinator — no case
appears twice with different answers.

| Failure | Classification (§3) | Behavior |
| --- | --- | --- |
| Network blip | `transient` | Backoff, retry, last good snapshot untouched |
| `PERSISTENCE_UNAVAILABLE` / other 5xx | `transient` | Backoff, retry; ≥6 consecutive → `paused(retryable)` |
| `INTERNAL_DATA_INVALID` (corrupt canonical stream, server-detected) | `data-corrupt` | `paused(data-corrupt)` **immediately**, zero automatic retries, last good snapshot kept (§4) |
| `AGENT_JOB_NOT_FOUND` | `not-found` | Stop; "This investigation is no longer available."; strip `?job=` |
| `ROUTE_PARAMETER_INVALID` / other 4xx | `permanent-invalid` | Stop; error state; no retry |
| Malformed `?job=` (client-side, before any request) | — | No request; notice; param stripped |
| Reducer throws client-side (`canonical-invalid`) | — | §4 table: keep last good stages, or the explicit "detail unavailable" note on a first snapshot; polling `paused(data-corrupt)`; never legacy inference |
| Legacy / pre-#37 run (marker false) | — | Today's frontend-inferred single row, byte-identical to current behavior |
| Run left `RUNNING` (event-emission failure, crash) | — | Polling stops at the 5-minute bound; Timeline stays Active and truthful; Refresh remains available |
| Stale poll response (older job/generation/attempt/fewer events) | — | Discarded by `isNewerInvestigationSnapshot` (§3) |
| Duplicate terminal observation, **same** status (poll vs. POST, either order) | — | State applied either way; side effects performed exactly once via `resolveTerminalObservation` → `"owner"`/`"duplicate"` (§5) |
| **Contradictory** terminal observation, **opposite** status for the same run attempt/generation | — | `resolveTerminalObservation` → `"inconsistent-terminal-status"`; first accepted terminal state preserved untouched; no state applied from the second; polling stopped; one safe, fixed notice shown; no side effect repeats (§5) |
| Stale POST/capability/poll response after `popstate` | — | Discarded by `invalidateInFlightWorkflows` (§6) |

---

## 8. Test matrix

**`packages/database` (integration, needs PostgreSQL)** — `agent-run-repository.integration.test.ts`
1. job with no run → `run`/`outcome` null, `trace`/`events` empty
2. mid-flight `RUNNING` run → partial ordered `events`, `outcome.type === "RUNNING"`
3. `COMPLETED` and `FAILED` runs → terminal event last, report/failure surfaced
4. multiple attempts → the highest `attemptNumber` is returned
5. events strictly `sequence` ASC and contiguous
6. legacy (pre-#37) stream → records returned, marker false, no throw
7. corrupt stream (sequence gap) → `PERSISTENCE_VALIDATION_FAILED`
8. missing job → `PERSISTENCE_NOT_FOUND`

**`apps/api` (unit + controller)** — `agent-jobs.controller.test.ts`, new mapper test
9. RUNNING partial-state response shape; COMPLETED; FAILED
10. **exact key-set assertions** on the response object (existing convention)
11. no `clientRequestId` anywhere in the response, including inside `events[].payload`
12. no raw persistence/provider/tool text; failure surfaces only as `outcome.code` +
    the fixed `outcome.message`
13. malformed `jobId` → 400; unknown job → 404; corrupt stored stream → 500
14. `mapAgentRunResponse` output unchanged after the `mapAgentRunRecordResponse` extraction

**`packages/contracts`** — no production change; add a regression case asserting a
partial `RUNNING` prefix ending at each of `AGENT_STARTED` / `TOOL_REQUESTED` /
`REPORT_GENERATION_STARTED` reduces to the expected active stage (this is the exact
shape polling will feed it).

**`apps/web`** — fake timers (`vi.useFakeTimers({ shouldAdvanceTime: true })` +
`advanceTimersByTimeAsync`) exactly as `App.progress-timeline.test.tsx` already does;
no wall-clock assertions.

*Pure modules* (`poll-error-classification.test.ts`, `investigation-snapshot.test.ts`,
`execution-stage-derivation.test.ts`, `investigation-url.test.ts`,
`terminal-settlement.test.ts`):
15. `classifyInvestigationPollError` — each of `AGENT_JOB_NOT_FOUND` →
    `not-found`, `INTERNAL_DATA_INVALID` → `data-corrupt`, `ROUTE_PARAMETER_INVALID`
    → `permanent-invalid`, `PERSISTENCE_UNAVAILABLE` → `transient`, an unmapped 5xx →
    `transient`, an unmapped 4xx → `permanent-invalid`, a plain network throw →
    `transient`
16. `isNewerInvestigationSnapshot` — older job, stale generation, lower attempt,
    `RUNNING` after known-terminal, fewer events than held — each rejected
17. `deriveExecutionStageDerivation` — marker false → `legacy`; marker true + valid →
    `canonical`; marker true + reducer throw on the **first** snapshot → `canonical-invalid`
    with `lastGoodStages: null`; marker true + reducer throw **after** a valid snapshot →
    `canonical-invalid` with the prior stages preserved
18. `investigation-url` helpers — read/write/strip, non-UUID rejected, other params preserved
19. `resolveTerminalObservation` — no prior claim → `"owner"`; same identity + same
    status → `"duplicate"`; same identity + opposite status → `"inconsistent-terminal-status"`
    (tested with `COMPLETED`-then-`FAILED` **and** `FAILED`-then-`COMPLETED`); different
    `attemptNumber` or different `generation` with everything else equal → treated as a
    **new** identity (`"owner"`), never conflated with the previous run/workflow

*Timeline component + `investigation-progress-stages.test.ts`*:
20. `canonical` derivation → run row renders four child rows with correct statuses,
    including `omitted` for a no-tool run's `DIAGNOSTIC_EXECUTION`
21. `legacy` derivation → run row renders with no children, byte-identical to today
22. `canonical-invalid` with `lastGoodStages` present → the frozen prior child rows
    still render
23. `canonical-invalid` with `lastGoodStages: null` → no child rows; the
    "detail unavailable" note renders; report/trace/outcome still render when present
24. **RUNNING canonical run cannot be collapsed** — no disclosure control is rendered,
    child `<ol>` is always present regardless of any prior click
25. **terminal canonical run can be collapsed** — disclosure control appears, default
    expanded, one click hides the child `<ol>`, a second click restores it
26. **collapsed terminal run → start a new run → new run is expanded** — collapse a
    terminal run's rows, then feed a new `runExpansionKey` (new attempt) with its own
    `canonical` stages; the new run's child rows render expanded with no click needed
27. **collapsed run A → popstate/resume run B → run B is expanded** — same assertion
    as #26, triggered via a `runExpansionKey` change from a different `jobId`
28. **poll updates for the same run do not erase a user's terminal collapse choice** —
    collapse a terminal run, then feed several more snapshots that keep the same
    `runExpansionKey` (same job/run/attempt) but a newly-allocated `stages`/`children`
    array each time; the collapsed state persists across all of them

*`App.polling.test.tsx`*:
29. submit → URL becomes `?job=<id>` via `replaceState`
30. `RUNNING` snapshot → polling continues; a delayed fixture that adds events across
    ticks advances the child rows incrementally
31. terminal snapshot via poll → polling stops (no further fetches after advancing time)
32. transient 5xx → retried after backoff, **exactly one** timer chain (assert fetch
    call count per interval), Timeline unchanged during the failure
33. `INTERNAL_DATA_INVALID` on a poll tick → `paused(data-corrupt)` immediately, with
    **zero** further fetches while advancing time, distinct from the
    `paused(retryable)` path
34. 6 consecutive transient failures → `paused(retryable)`; "Check again" issues a
    fetch and resets both the failure counter and the 5-minute budget (assert a
    subsequent run of failures again takes 6 ticks to re-pause, not fewer)
35. new submission cancels the previous job's polling (no fetches for the old jobId)

*`App.terminal-settlement.test.tsx`* — same-status duplicates, then the two
contradictory-status races required by this revision:
36. poll observes `COMPLETED` first, POST observes `COMPLETED` second (**same**
    status) — approval is fetched exactly once, the terminal notice is set exactly
    once, `submittedFinishedAt` is set exactly once
37. POST observes `FAILED` first, poll observes `FAILED` second (**same** status) —
    same three single-occurrence assertions, source order reversed
38. old POST resolves terminal after navigation to another job (via
    `invalidateInFlightWorkflows`) — the resumed job's state is not mutated; no
    approval fetch is issued against the old run
39. duplicate terminal poll snapshot (two ticks both carry the **same** terminal
    status) — the second is accepted as state but performs no approval fetch/announcement
40. **poll observes `COMPLETED` first; a late POST observes `FAILED` for the same run
    attempt and workflow generation** — the first (`COMPLETED`) run/outcome/events are
    preserved exactly, no second approval fetch or announcement occurs, the fixed
    `TERMINAL_INCONSISTENCY_NOTICE` is shown, and polling is stopped
41. **POST observes `FAILED` first; a late poll observes `COMPLETED` for the same run
    attempt and workflow generation** — symmetric to #40: the first (`FAILED`) state
    is preserved, the same notice appears, no state is overwritten

*`App.resume.test.tsx`*:
42. load with `?job=` → state restored from one `getInvestigationState`
43. malformed `?job=` → no request, notice shown, param stripped
44. 404 on resume → "no longer available", fresh form
45. Back/Forward restores the correct job (`popstate` with a different `job`)
46. a stale POST, capability response, or poll response arriving after `popstate`
    cannot mutate state (three cases, per §6)
47. approval / report / suggested-actions / recovery-mode behavior unchanged —
    existing `App.approval.test.tsx`, `App.reveal-boundaries.test.tsx`,
    `App.live-retry.test.tsx`, `App.new-submission-reset.test.tsx` must pass untouched

No provider or LIVE request is used by any automated test.

---

## 9. Phased implementation order

Each phase compiles, passes its own tests, and leaves the app usable.

1. **Repository read** — `getInvestigationState` + `PersistedInvestigationState` +
   integration tests (§8 #1–8). No caller yet.
2. **Service pass-through** — repository interface, prisma factory, `AgentRunService`.
3. **API route** — mapper extraction, new DTO/mapper, controller route, tests (§8
   #9–14), and the docs/12 §3 entry. Backend complete and independently verifiable
   with `curl`.
4. **Web pure modules, zero wiring** — `investigation-url.ts`,
   `poll-error-classification.ts`, `investigation-snapshot.ts`,
   `execution-stage-derivation.ts`, `execution-stage-rows.ts`,
   `terminal-settlement.ts` (the pure `resolveTerminalObservation` decision function),
   plus `types.ts`/`endpoints.ts`. Unit tests (§8 #15–19). **Nothing imports these
   from `App.tsx` yet — no visible change.**
5. **Timeline widening, still zero visible change** — `omitted` status,
   `ExecutionStageRowViewModel`, the `children`/`executionDetailNote` additions to
   `investigation-progress-stages.ts`, and the child-row/`runExpansionKey`-scoped
   collapse-toggle rendering in `InvestigationProgressTimeline.tsx` + its CSS. The
   single existing `App.tsx` call site passes `executionStageDerivation: { kind:
   "legacy" }` and `runExpansionKey: null` — behavior is byte-identical to today
   because no canonical events exist yet to feed it. Component/derivation tests (§8
   #20–28), including the five expansion-identity tests.
6. **Polling + terminal settlement coordinator** — `useInvestigationPoll`,
   `terminalSettlementClaimRef` + the `App.tsx`-level wrapper around
   `resolveTerminalObservation`, and `applyObservedRunOutcome` wiring for the submit
   path only: start polling after job creation (closing over that call's
   `beginWorkflow()` generation, never the poll hook's own), apply snapshots,
   recompute `executionStageDerivation`, decide terminal ownership/consistency before
   applying terminal state, stop polling once resolved either way. `runExpansionKey`
   now derives from real `job`/`run` state, so the Timeline's run row genuinely
   expands live. Tests (§8 #29–41), including both contradictory-status races.
7. **URL + resume + navigation invalidation** — history writes,
   `invalidateInFlightWorkflows`, mount-time `?job=` resume, `popstate` handling,
   `startNewInvestigation` updated to call the new invalidation helper,
   `retryRun`/`retryLiveRunWithToken` updated to set `minAttemptNumber`. Every one of
   these entry points captures its own `beginWorkflow()` generation and feeds it to
   `applyObservedRunOutcome` exactly like the submit path. `runExpansionKey` changing
   across a resume/navigation is what resets the Timeline's collapse state — no
   additional plumbing needed beyond what phase 5 already built. Tests (§8 #42–47).
8. **Docs** — docs/12 §3 (new endpoint + explicit "legacy trace unchanged"), docs/14
   §6 (run-row expansion, collapse toggle and its `runExpansionKey` scoping, the
   terminal-settlement coordinator including the contradictory-status case, polling
   cadence/classification, resume, paused affordances, the LIVE-recovery limitation),
   docs/16 §10 marked implemented, and
   `docs/reviews/22-issue-38-timeline-polling-resume-plan.md` recording this design in
   full, including both final-review fixes.

---

## 10. Verification

```bash
# Types + unit tests across the workspace
pnpm typecheck
pnpm test

# Integration (local PostgreSQL)
pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:test
pnpm test:integration:sequential

# Browser bundle guard (first contracts value import)
pnpm --filter @opspilot/web run build
pnpm --filter @opspilot/web run check:bundle

# Manual end-to-end (FAKE, no provider call)
pnpm api:start:dev            # terminal 1
pnpm --filter @opspilot/web run dev   # terminal 2 → http://127.0.0.1:5173
# submit → URL gains ?job=<uuid> → reload mid-view → state restores from the server
curl -s localhost:3000/v1/agent-jobs/<jobId>/investigation | jq '.data | {run, events: (.events | length)}'
```

Honest caveat: a FAKE run finishes in milliseconds, so a locally observable multi-tick
`RUNNING` window does not exist. Automated coverage uses delayed fetch fixtures
(§8 #30). A real observable incremental Timeline requires a LIVE run — that is the
**separate, post-merge, manually operated** validation, explicitly not part of the
automated suite and not run during implementation.

---

## 11. Non-goals and compatibility

**Out of scope:** SSE/WebSockets (polling satisfies every acceptance criterion here;
nothing in the repository argues otherwise), the public LIVE trial (#39), provider
behavior, multi-tool/multi-turn expansion, any new approval workflow, the visual
redesign tracked separately, deployment changes, a global/shared state manager (the
terminal-settlement coordinator and navigation invalidation both deliberately extend
`App.tsx`'s existing ref/generation conventions instead).

**Compatibility guarantees:**
- `GET /v1/agent-runs/:runId` — response unchanged, byte for byte.
- `GET /v1/agent-jobs/:jobId` — unchanged.
- `POST /v1/agent-jobs/:jobId/runs` — unchanged, including 200-vs-201 replay semantics
  and the `Idempotency-Key` contract. Polling neither sends nor observes that key.
- Approval endpoints and the shipped approval UX — untouched.
- Pre-#37 runs — marker returns false, the legacy read path and today's inferred
  single run row apply exactly as now, with no child rows and no disclosure control
  attached.
- No new `ApiErrorCode`, no schema/migration change, no change to
  `AgentTraceEventSchema` or `appendInvestigationEvent`.
- `clientRequestId` remains absent from every public response.

FINAL PLAN REVISION COMPLETE — READY FOR HQ APPROVAL
