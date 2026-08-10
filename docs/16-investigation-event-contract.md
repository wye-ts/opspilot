# OpsPilot — Investigation Stage/Event Contract (Issue #36)

| Field | Value |
|---|---|
| Document | Investigation Stage/Event Contract — Implementation Record |
| Status | Contract layer implemented in `packages/contracts`. **Consumed in production as of issue #37**: the repository persists canonical events incrementally and reducer-validates every write, and the orchestrator emits them at the real transition points. **Consumed by frontend code as of issue #40**: the Progress Timeline nests observed events under the four canonical execution-stage rows. |
| Project | OpsPilot |
| Purpose | Define the canonical, provider-neutral execution-stage and event contract a live Timeline needs, shared by a future incremental persistence layer (#37) and polling/resume layer (#38), so neither invents its own shape |
| Related documents | `docs/04-agent-design.md` §16 (an aspirational, unimplemented queue/worker design this contract deliberately does not adopt — see §1), `docs/11-agent-run-persistence.md` (the implemented batch-at-completion persistence this contract's legacy layer stays compatible with), `docs/14-web-ui.md` (the frontend Timeline, which adopts this contract as of #40 via nested execution-stage event rows) |

---

## 0. What v1 models

**Issue #36 v1 models the current OpsPilot runtime exactly: two provider turns maximum, zero or one tool call, optional retrieval.** It does not model speculative multi-tool or generic workflow execution, because the runtime cannot produce those streams and a contract that accepts histories the system cannot generate is not validating anything.

The two supported successful paths:

```text
Direct no-tool report          One-tool finalization
─────────────────────          ─────────────────────
RUN_CREATED                    RUN_CREATED
AGENT_STARTED                  AGENT_STARTED
[RETRIEVAL_COMPLETED]          [RETRIEVAL_COMPLETED]
REPORT_SUBMITTED               TOOL_REQUESTED
REPORT_VALIDATED               TOOL_COMPLETED
RUN_COMPLETED                  REPORT_GENERATION_STARTED
                               REPORT_SUBMITTED
                               REPORT_VALIDATED
                               RUN_COMPLETED
```

Not supported in v1, and rejected: a second tool request (`TOOL_LIMIT_EXCEEDED`), multiple sequential tools, concurrent tools, provider reasoning between tools, and generic multi-turn workflow execution.

---

## 1. Why this exists, and what it deliberately does not adopt

Milestone 9 Phase A shipped a frontend-only progress Timeline (`apps/web/src/investigation-progress/investigation-progress-stages.ts`): stage labels and transitions are simulated from request lifecycle and the terminal run outcome, not from anything the backend persists incrementally. Issue #36 defines the contract that #37 (incremental persistence) and #38 (polling/resume) both need before either can be built without guessing.

`docs/04-agent-design.md` §16 already describes a larger, aspirational vocabulary (`RUN_STARTED`, `RUN_QUEUED`, `CLASSIFICATION`, an `AgentStep` table, a `nextStepSequence` counter, a queue-claiming worker). That design assumes an architecture that does not exist: `docs/11-agent-run-persistence.md` §9 is explicit that the shipped persistence slice is "a deliberately simpler precursor, not a partial implementation" of it — no queue, no worker, exactly one synchronous writer per run. This contract targets the architecture that actually exists.

**Scope of what is implemented here**: schemas, a pure reducer, a marker helper, and a projection helper — all in `packages/contracts`, plus tests and this document. No database, runtime, API, or frontend code is touched. Nothing in this change is reachable from running application code; it is inert until #37 imports it.

---

## 2. Execution stages vs. run status vs. frontend presentation stages

Three axes that must never be merged into one enum:

1. **Shared execution stages** — `InvestigationExecutionStageSchema` in `packages/contracts/src/investigation-execution-stage.ts`, exactly four backend-execution phases:

   ```text
   INVESTIGATION_CREATED
   AGENT_ANALYSIS
   DIAGNOSTIC_EXECUTION
   REPORT_GENERATION
   ```

2. **Run status** — `RUNNING | COMPLETED | FAILED`, the existing `AgentRun.status` / `AgentRunOutcome.type` (`packages/database/src/types.ts`, untouched). Orthogonal to stage: status answers "is the run still going," a stage answers "what is it doing." Never a member of the stage enum; it enters the reducer as a separate `runStatus` parameter.

3. **Frontend-only presentation stages** — LIVE-availability preflight and approval loading. Neither has a backend execution event behind it. They remain entirely in `apps/web` and are **not** referenced anywhere in `packages/contracts`. The frontend has not yet adopted this contract at all — that adoption is #38 work.

---

## 3. Event payload vs. persisted/read event record

Two explicit layers in `packages/contracts/src/investigation-event.ts`:

- **`InvestigationEventPayloadSchema`** — the immutable fact an orchestrator/service can construct *before persistence exists*. Contains `type` plus only that type's own fields. No `runId`, `sequence`, or `recordedAt`: `recordedAt` in particular does not exist until a row is inserted, so requiring it on an emitted payload would be a lie about what the emitter can know.
- **`InvestigationEventRecordSchema`** — the persisted/read shape, `{ runId, sequence, recordedAt, payload }`. Nested, matching the repository's existing `TraceEventCreateInput` convention (`packages/database/src/mappers.ts`).

`recordedAt` is the database `created_at` / recording time — named honestly, not `occurredAt`. Today's batch-persisted rows share one coarse value per run (`docs/11-agent-run-persistence.md` §4/§5); only #37's incremental one-append-per-event writes make it a meaningfully precise per-event time. **`sequence` is the sole ordering key.** The reducer validates contiguity against it and never sorts by `recordedAt`.

The reducer consumes **records**, never bare payloads — that is why the two schemas exist separately.

---

## 4. The 12 new-write event types + 1 legacy read-compat type

```text
RUN_CREATED
AGENT_STARTED
RETRIEVAL_COMPLETED
TOOL_REQUESTED
TOOL_COMPLETED
TOOL_FAILED
REPORT_GENERATION_STARTED
REPORT_SUBMITTED
REPORT_VALIDATED
REPORT_VALIDATION_FAILED
RUN_COMPLETED
RUN_FAILED

Legacy read compatibility only:
REPORT_GENERATED
```

`InvestigationEventPayloadSchema` (write-eligible) contains exactly the 12. `REPORT_GENERATED` is structurally absent from it, so nothing can construct a fresh one. `InvestigationEventRecordPayloadSchema` (used only by the record schema) contains all 13, because a persisted row may legitimately be a pre-#37 legacy row. Counts are asserted in code by `INVESTIGATION_EVENT_NEW_WRITE_TYPE_COUNT = 12` and `INVESTIGATION_EVENT_LEGACY_TYPE_COUNT = 1`, and by a test against `InvestigationEventPayloadSchema.options`.

`RETRIEVAL_COMPLETED`, `TOOL_REQUESTED`, `TOOL_COMPLETED`, and `REPORT_GENERATED` reuse the **exact schema objects** `packages/contracts/src/agent-trace-event.ts` exports (that file was refactored to export each branch individually for this reason), so the overlapping types cannot drift. A test asserts both unions accept byte-identical fixtures for these types.

**Strict failure-code subsets**, evidenced against `packages/agent-runtime/src/agent/agent-orchestrator.ts`:

- `TOOL_FAILED.failureCode` — `ToolFailureCodeSchema`: `TOOL_NOT_FOUND | TOOL_INPUT_INVALID | TOOL_EXECUTION_FAILED | TOOL_OUTPUT_INVALID` only.
- `REPORT_VALIDATION_FAILED.failureCode` — `ReportValidationFailureCodeSchema`: `REPORT_SCHEMA_INVALID | REPORT_EVIDENCE_INVALID` only.
- `RUN_FAILED.failureCode` — the full `AgentOrchestratorErrorCodeSchema`; a run can fail for any reason the orchestrator recognizes, so this is the one deliberate catch-all.

**`RUN_FAILED` carries no free-form message.** It has exactly `failureCode` and `failedStage`. A `failureMessage: string` field was removed from this contract: a persisted, browser-readable lifecycle event must not carry an unbounded text channel, because `.strict()` constrains which keys exist but cannot constrain what a caller puts inside a string — provider text, an authorization header, or a stack trace would all validate. Safe user-facing wording is derived from `failureCode` through a fixed mapping at the API/UI boundary (the existing `FAILURE_DISPLAY_MESSAGES` pattern in `packages/database`), never carried in the event. A test asserts a credential-bearing `failureMessage` is rejected.

**Legacy `REPORT_GENERATED` semantics**, traced rather than assumed: the orchestrator's `report_submission` branch pushes it only after both `ResolutionReportSchema` parsing and evidence validation succeed — either failure returns early with no trace push. So it has always meant "report already validated and accepted," read-compatible with `REPORT_VALIDATED` and never with `REPORT_SUBMITTED`. It is **rejected inside a canonical stream** (`LEGACY_EVENT_IN_CANONICAL_STREAM`), so one persisted type never carries two meanings within one contract.

**Explicit omissions**: no persisted `stage` field, no generic per-event `status` field (success/failure is the event *type*), no `eventId`, no `details: unknown`, no schema-version field.

---

## 5. `deriveExecutionStageProgress` — the reducer

`packages/contracts/src/investigation-stage-progress-reducer.ts`:

```ts
deriveExecutionStageProgress({ events, runStatus, now }): readonly ExecutionStageProgress[]
```

Returns exactly four entries, one per stage, in `INVESTIGATION_EXECUTION_STAGE_ORDER`. Each entry: `{ key, status: "pending"|"active"|"completed"|"failed"|"omitted", startedAt, completedAt, elapsedMs, failureCode? }`, with `failureCode` present iff `status === "failed"` (enforced by `ExecutionStageProgressSchema`'s refinement).

That list shape is enforced by `ExecutionStageProgressListSchema` itself, not merely documented: it requires exactly four entries whose `key`s match `INVESTIGATION_EXECUTION_STAGE_ORDER` positionally, so an empty list, a partial list, duplicate keys, a reordered list, or a fifth entry are all rejected.

**This reducer does not repair.** There is no sanity-closing of active stages, no omitting of stages to cover a missing fact, and no path from a stream containing a failure fact to a successful completion. A malformed canonical history is **rejected** with a typed `InvestigationEventContractError`, because a progress view that silently fixes a corrupt history is indistinguishable — to the person reading it during an incident — from one describing what actually happened.

It is also the **single place** where full validation happens. `hasCanonicalInvestigationLifecycleMarker` is only a marker check (§6) and deliberately does not repeat any of these rules.

### Transition rules

| Event | Effect |
|---|---|
| `RUN_CREATED` | completes `INVESTIGATION_CREATED`; must be first and unique |
| `AGENT_STARTED` | activates `AGENT_ANALYSIS`; unique; rejected after any retrieval, tool, or report event |
| `RETRIEVAL_COMPLETED` | informational; no stage boundary effect. **Optional — see "Retrieval is configuration-dependent" below.** When present: requires `AGENT_STARTED`, requires `AGENT_ANALYSIS` active, at most once in v1, rejected once the tool or report phase has begun |
| `TOOL_REQUESTED` | requires `AGENT_STARTED` and `AGENT_ANALYSIS` active; hands over to `DIAGNOSTIC_EXECUTION`; **at most one per run** — a second request is rejected with `TOOL_LIMIT_EXCEEDED` while the first is open or has completed. `TOOL_LIMIT_EXCEEDED` applies only while the run has not already entered a terminal failure path; after `TOOL_FAILED`, `EVENT_AFTER_FAILURE` takes precedence over any later non-terminal event, including a second `TOOL_REQUESTED` |
| `TOOL_COMPLETED` | closes its tool call as completed; no stage boundary effect |
| `TOOL_FAILED` | closes its tool call as failed **and immediately fails `DIAGNOSTIC_EXECUTION`** with the exact tool failure code |
| `REPORT_GENERATION_STARTED` | requires `AGENT_STARTED`, **at least one preceding tool call**, and no open tool call; closes analysis/diagnostics and activates `REPORT_GENERATION`; at most once |
| `REPORT_SUBMITTED` | requires `AGENT_STARTED` and no open tool call; **on any tool path also requires a prior `REPORT_GENERATION_STARTED`**; opens `REPORT_GENERATION` if not already open; unique |
| `REPORT_VALIDATED` | completes `REPORT_GENERATION`; requires a prior `REPORT_SUBMITTED` |
| `REPORT_VALIDATION_FAILED` | **immediately fails** `REPORT_GENERATION` with the exact report failure code; requires a prior `REPORT_SUBMITTED` |
| `RUN_COMPLETED` | validates strict completion (below); mutates nothing |
| `RUN_FAILED` | confirms an existing specific failure (exact `failedStage` + `failureCode` match required) or establishes one on the **currently active** stage (see the pre-agent exception below); then marks later still-pending stages `omitted` |
| legacy `REPORT_GENERATED` | rejected inside a canonical stream |

### Forward-only phases

Execution phases move forward only. Analysis precedes retrieval and tools; tools precede the report
phase; once the report phase begins no retrieval or tool event may occur; and **at most one execution
stage is ever active**. An event that would reactivate an earlier stage after a later one has begun is
rejected with `PHASE_ORDER_VIOLATION`.

A consequence worth stating explicitly: because a later stage can only activate by resolving the
earlier one, no earlier stage can still be `pending` while a later stage runs.

### Retrieval is configuration-dependent, and therefore optional

`RETRIEVAL_COMPLETED` is **not** required. The orchestrator's `retriever` and `retrievalInput` params
are optional and the event is pushed only inside the configured-retriever branch; the current API module
does not configure a retriever at all. So both shapes are canonical:

```text
retriever configured:    AGENT_STARTED → RETRIEVAL_COMPLETED → provider/tool/report activity
no retriever configured: AGENT_STARTED → provider/tool/report activity
```

What the contract constrains is only *where* the event may appear when it does appear (see the table).

### `REPORT_GENERATION_STARTED` is a finalization-turn fact

The orchestrator emits it only immediately before a `FINALIZATION` provider call, and under the current
execution model that turn is reached only after the investigation turn produced a diagnostic tool call.
So the event **requires a preceding tool phase** and is rejected on a no-tool run
(`PHASE_ORDER_VIOLATION`). On the direct no-tool path report generation begins at `REPORT_SUBMITTED`.

Conversely, on any tool path the event becomes mandatory, in two places:

- `REPORT_SUBMITTED` after a tool phase requires it (`MISSING_LIFECYCLE_FACT`);
- **`RUN_FAILED` after tools closed successfully with no `TOOL_FAILED` also requires it**
  (`MISSING_LIFECYCLE_FACT`). Once every tool succeeded, the next thing the orchestrator does is the
  finalization provider call, so a provider or protocol failure at that point belongs to
  `REPORT_GENERATION`. Without the report-start fact the stream would attribute it to
  `DIAGNOSTIC_EXECUTION`, which had already finished its work.

### Terminal failure names the stage that was running

`RUN_FAILED.failedStage` must equal the single currently active stage. Naming a future stage that never
started would invent a phase the run never reached, and is rejected with `FAILED_STAGE_NOT_TRUTHFUL`.

There is exactly **one** exception, for a failure between run creation and analysis: when the stream is
precisely `RUN_CREATED → RUN_FAILED`, `failedStage` may be `AGENT_ANALYSIS` even though no stage is
active. `INVESTIGATION_CREATED` stays `completed`; `DIAGNOSTIC_EXECUTION` and `REPORT_GENERATION` become
`omitted`. No other pending stage may be failed this way, and the only code permitted is
`RETRIEVAL_PARAMS_INVALID` — repository evidence shows `validateOrchestratorParams` is the sole failure
the orchestrator can produce before anything is traced (it returns with an explicitly empty trace).

### Failure code, stage, and context must be causally compatible

A code is rejected (`FAILURE_CODE_STAGE_MISMATCH`) when it could not have been produced in the stage it
names. The rules are derived from the actual `failed(...)` sites in
`packages/agent-runtime/src/agent/agent-orchestrator.ts`:

| Code group | Codes | Legal stage | Additional requirement |
|---|---|---|---|
| Retrieval | `RETRIEVAL_PARAMS_INVALID`, `RETRIEVAL_FAILED`, `RETRIEVAL_RESPONSE_INVALID` | `AGENT_ANALYSIS` | — |
| Tool | `TOOL_NOT_FOUND`, `TOOL_INPUT_INVALID`, `TOOL_EXECUTION_FAILED`, `TOOL_OUTPUT_INVALID` | `DIAGNOSTIC_EXECUTION` | a preceding `TOOL_FAILED` fact |
| Report validation | `REPORT_SCHEMA_INVALID`, `REPORT_EVIDENCE_INVALID` | `REPORT_GENERATION` | a preceding `REPORT_VALIDATION_FAILED` fact |
| Provider / protocol | `PROVIDER_PROTOCOL_INVALID`, `PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_CANCELLED` | `AGENT_ANALYSIS` **or** `REPORT_GENERATION` (after `REPORT_GENERATION_STARTED`, **before** `REPORT_SUBMITTED`) | never `DIAGNOSTIC_EXECUTION`; never after `REPORT_SUBMITTED` |
| Pre-agent exception | `RETRIEVAL_PARAMS_INVALID` only | `AGENT_ANALYSIS` | stream is exactly `RUN_CREATED → RUN_FAILED` |

**Once `REPORT_SUBMITTED` has occurred the provider has already returned a report payload**, so a
provider or protocol failure can no longer be what ended the run — only report validation can. The only
legal outcomes after submission are `REPORT_VALIDATED`, or `REPORT_VALIDATION_FAILED` with a matching
`RUN_FAILED`.

The tool and report-validation rules deliberately forbid a *terminal-only* failure code: a `RUN_FAILED`
cannot invent a tool or validation failure that no event witnessed. None of this can live in the payload
schema, because the same provider code is legal in different phases depending on lifecycle context — it
needs the reducer's accumulated state.

**The policy is compile-time exhaustive.** It is a single
`satisfies Record<AgentOrchestratorErrorCode, FailurePolicy>` record in the reducer, where each entry
declares `legalStages`, `requiresSpecificFact`, `allowedBeforeAgentStarted`, and
`allowedAfterReportSubmitted`. Adding a member to `AgentOrchestratorErrorCode` fails compilation until an
explicit policy is written for it — a `Set`-based classification would have silently treated an unknown
future code as unconstrained.

**Mandatory #37 obligation — early tool failures (SATISFIED in #37).** The legacy runtime detects `TOOL_NOT_FOUND` and
`TOOL_INPUT_INVALID` *before* its old `TOOL_REQUESTED` trace push. For the canonical stream, #37 moved
the canonical request emission earlier (the legacy push stayed where it was — see §9):

```text
provider returns a tool request
→ persist TOOL_REQUESTED
→ registry lookup / input validation
→ on failure persist TOOL_FAILED
→ persist matching RUN_FAILED
```

This is truthful — the provider genuinely did request the tool — and it is the emitter's obligation, not
a reason to relax this contract. #36 changes no runtime code.

### Terminal outputs are fully resolved

Before returning, any terminal result (`COMPLETED` or `FAILED`) must contain **zero active and zero
pending stages** — a run that has stopped has nothing still in progress and nothing still waiting.
Violations raise `UNRESOLVED_TERMINAL_STAGE`. A `RUNNING` run is legitimately partial and exempt.

### Strict completion

`RUN_COMPLETED` is rejected unless: no prior failure fact of any kind; no open tool call; `AGENT_STARTED` seen; `REPORT_SUBMITTED` seen; `REPORT_GENERATION` completed via `REPORT_VALIDATED`; and every stage already resolved by its own events (`completed`, or `omitted` for `DIAGNOSTIC_EXECUTION` on a no-tool run). Nothing is closed or omitted by `RUN_COMPLETED` itself.

### Timestamps and elapsed time

`startedAt`/`completedAt` come from the triggering event's `recordedAt`. An `active` stage's `elapsedMs = now - startedAt`; a settled stage's is `completedAt - startedAt` and is stable regardless of `now`. `pending`/`omitted` stages carry `null` for all three. **Negative clock skew is clamped to zero** — a caller-supplied `now` earlier than a recorded timestamp is a clock artifact, and a negative duration is never a truthful reading. This is tested.

### Runtime validation

Before reducing, the reducer validates `now` as an ISO-8601 datetime (`INVALID_NOW`), `runStatus` against `InvestigationRunStatusSchema` (`INVALID_RUN_STATUS` — status drives terminal agreement and the `RUNNING` exemptions, so a bogus value would silently skip those checks, and a TypeScript-only union does not survive a package boundary), every record against `InvestigationEventRecordSchema` (`INVALID_EVENT_RECORD` — this also rejects a malformed `recordedAt` or an unknown payload type smuggled past TypeScript), sequence contiguity from 1 (`SEQUENCE_NOT_CONTIGUOUS`, which covers gaps, duplicates, and out-of-order input), and a single shared `runId` (`MIXED_RUN_IDS`). Before returning, it validates its own output against `ExecutionStageProgressListSchema` (`INVALID_PROGRESS_OUTPUT`) — invariants that nothing executes are not invariants. No raw `RangeError` or `NaN` escapes.

### Error codes

`InvestigationEventContractErrorCode` has 27 members and **every one is thrown** in the reducer. A second terminal event raises the specific `MULTIPLE_TERMINAL_EVENTS`; any other event after a terminal one raises `EVENT_AFTER_TERMINAL`. Tests assert the exact `.code` rather than relying on a broad `.toThrow()`, and 25 of the 27 are directly asserted.

**Error messages never echo provider-controlled values.** `toolCallId`, `toolName`, and any other value the provider influences are excluded from exception text, which names only sequences, closed-enum codes, and stage names. A schema-valid `toolCallId` can still contain newlines, ANSI escapes, and credential-looking text, and these messages are log-facing — so the identifiers stay in the persisted payload, where they belong, and out of the exception. A security test drives a hostile id through three different rejections and asserts none of it appears in the message.

The two exceptions — `UNRESOLVED_TERMINAL_STAGE` and `INVALID_PROGRESS_OUTPUT` — are internal-defect guards that the other rules make unreachable through the public API: the phase-ordering and terminal rules already guarantee a fully resolved terminal result, and the reducer's own construction already satisfies the output schema. They are retained as executable assertions rather than comments, and their positive side is covered by tests asserting that every accepted terminal result has zero active and zero pending stages and that representative outputs satisfy the list schema.

---

## 6. Canonical origin marker vs. full validation

`hasCanonicalInvestigationLifecycleMarker(events)` in `packages/contracts/src/investigation-lifecycle-compatibility.ts` answers exactly one question — an **origin** question:

> Was this stream written in the canonical (#37) lifecycle format, rather than the historical four-type legacy format?

It returns `true` iff the first record is `RUN_CREATED` at sequence 1. Nothing else is consulted. `runStatus` is **not** a parameter: origin detection does not need status.

**A corrupt canonical stream is still canonical.** A missing terminal event, a runStatus/terminal mismatch, an event after a terminal event, and a duplicated lifecycle fact all leave the marker returning `true`; each is a *reducer validation failure*, not evidence of legacy origin. Reclassifying them as legacy would route genuinely broken canonical data into the frontend's legacy inference and silently render a plausible Timeline for a history that should have raised an error. Tests assert marker-`true` plus the reducer's exact rejection code for each of those four shapes.

An **empty stream returns `false`** — there is no origin evidence, so nothing can be proven, and #38 should use its legacy/empty fallback. The reducer separately accepts an explicitly selected empty `RUNNING` prefix, but that is the caller's choice, not something marker auto-detection establishes.

**It never throws on malformed input.** #38 will call it on data that just crossed an HTTP boundary, where a JavaScript caller can supply objects the TypeScript signature forbids (missing `payload`, `payload: null`, a non-object record). Those return `false`. A classifier that throws would strip the caller of its ability to route at all, whereas `false` falls cleanly through to the legacy/empty path. Full record validation stays the reducer's job — it rejects the minimal marker-passing record with `INVALID_EVENT_RECORD`.

**Passing the marker does not mean a stream is well-formed.** Full validation lives only in `deriveExecutionStageProgress`; the state machine is not duplicated. When the marker returns `false`, #38 must use the existing frontend legacy inference — the reducer will refuse (`RUN_CREATED_NOT_FIRST`) rather than fabricate a failed stage legacy data cannot support. **#36 does not change the frontend fallback.**

---

## 7. Canonical ledger → legacy agent-activity projection

`projectToLegacyAgentTraceEvent(record): AgentTraceEvent | null`, same file.

`AgentTraceEventSchema` is **not expanded**; `InvestigationEventRecordSchema` is a separate additive schema. Both can validate rows in the same physical `agent_trace_events` table (`event_type`/`payload` are untyped `String`/`Json`) — two purpose-built read projections over one ledger, not two competing systems.

The projection is an **exhaustive `switch` with an `assertNever` default**, not a membership test with casts. Every one of the 13 record payload types makes an explicit choice, and adding a 14th will not compile until its choice is made — a future activity-relevant event cannot silently fall through to `null`.

- `RETRIEVAL_COMPLETED` / `TOOL_REQUESTED` / `TOOL_COMPLETED` / `REPORT_GENERATED` → identity
- `REPORT_VALIDATED` → `{ type: "REPORT_GENERATED" }`
- `RUN_CREATED`, `AGENT_STARTED`, `REPORT_GENERATION_STARTED`, `REPORT_SUBMITTED`, `REPORT_VALIDATION_FAILED`, `RUN_COMPLETED`, `RUN_FAILED` → `null`
- `TOOL_FAILED` → `null`, a deliberate current choice: `TraceTimeline`'s exhaustive switch has no case for it, so emitting it would break that component. Changing this requires changing `TraceTimeline` (out of scope), this projection, its test, and this section together.

**#37 must call this from the database mapper** before producing the existing `run.trace` response, once incrementally persisted rows can include the wider vocabulary. It is not wired into `packages/database/src/mappers.ts` by #36 — that file is untouched.

---

## 8. Active-run discovery — decisions preserved for #38

Traced from the API and repository code, recorded here so #38 does not re-derive it:

- `jobId` is known to the browser immediately, before the run-creation request is sent.
- The run row commits — with its `runId`, already `RUNNING` — **before** provider execution begins, inside the same blocking `POST /v1/agent-jobs/:jobId/runs` request.
- `GET /v1/agent-jobs/:jobId` returns `runs[]` ordered by `attemptNumber` ascending, guaranteed. There is **no enforced invariant of at most one `RUNNING` run per job** — an orphaned `RUNNING` attempt can coexist with a later one.
- `?job=<uuid>` is the approved refresh-recovery identifier for #38: the URL carries only the non-secret `jobId`, set via `history.replaceState` after job creation and before the blocking run request.

Minimum selection rule for #38 (no API implemented in #36): during one submission session, snapshot the maximum `attemptNumber` before starting the run and prefer the first run with a strictly greater one; on reload via `?job=`, resume the latest attempt by maximum `attemptNumber`. **`clientRequestId` is not added to any public API response** and must be treated as an internal idempotency key, not presentation data. If #38 finds that exact LIVE ambiguous-replay disambiguation genuinely requires it, it must design a narrow authorized lookup rather than echo the key in job summaries.

---

## 9. #37 persistence handoff — IMPLEMENTED

Every item below shipped in issue #37. See
`docs/reviews/21-issue-37-incremental-event-persistence-plan.md` for the full
design and `docs/11-agent-run-persistence.md` §4/§5/§7/§10 for the persistence
record.

- **DONE** — An incremental append repository method (`appendInvestigationEvent`)
  replacing the single end-of-run `createMany`, preserving terminal-event/
  run-status atomicity. `toTraceEventCreateInputs` and the `trace` parameter on
  `finalizeCompleted`/`finalizeFailed` are gone.
- **DONE** — Orchestrator emission: `AGENT_STARTED` immediately after
  `validateOrchestratorParams` succeeds (not at function entry — see below);
  `REPORT_GENERATION_STARTED` immediately before the finalization-phase provider
  call; `RUN_CREATED` written by the run-creation transaction and
  `RUN_COMPLETED`/`RUN_FAILED` by the terminal transaction, both in
  `packages/database` rather than in `agent-run-service.ts`, because only the
  transaction that owns the run row can write them atomically with it.
- **DONE** — Sequence allocation and locking: `MAX(sequence_number) + 1` under
  the `agent_runs` row lock the transaction already holds.
- **DONE** — The database-mapper projection described in §7, wired into
  `fromTraceEventRows`.

### Two refinements this section's original wording did not anticipate

**`AGENT_STARTED` is emitted after `validateOrchestratorParams`, not at
orchestrator entry.** That check is the only failure the runtime can produce
before anything is traced, and the pre-agent exception below requires the
stream to be exactly `RUN_CREATED → RUN_FAILED`. Emitting `AGENT_STARTED` first
would not fail loudly — it would quietly make that hand-written exception
unreachable.

**The orchestrator keeps TWO independent output channels**, not one. Canonical
emission (`emitLifecycleEvent`) does not replace the legacy in-memory
`trace.push(...)` calls: `runAgentOrchestrator` has non-persistence callers
(evals, demos, unit tests) that read the returned `AgentTraceEvent[]` and never
supply an emitter. Their timing genuinely differs — canonical `TOOL_REQUESTED`
is emitted before registry lookup, while the legacy push stays at its old
post-validation point — so the two are kept separate rather than derived from
one another. For any event with both channels the canonical append happens
first and the legacy push second, so a failed canonical write never leaves the
in-memory trace claiming a transition whose durable record does not exist.

The visible consequence is documented in `docs/12-agent-run-api.md`: for
`TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` the API's projected trace now contains a
`TOOL_REQUESTED` that the pre-#37 response never carried, while the direct
orchestrator return value for those same paths is unchanged.

**The mandatory early-tool-failure obligation from §5 is satisfied**: the
canonical ledger records `TOOL_REQUESTED → TOOL_FAILED` for both early tool
failure codes.

## 10. #38 polling/URL-resume handoff — implemented

Active-run discovery per §8 via `GET /v1/agent-jobs/:jobId/investigation` (`docs/12-agent-run-api.md` §3); polling with bounded cadence (1s/2s/5s) and transient backoff via `useInvestigationPoll`; the `?job=` refresh/resume flow via `investigation-url.ts` helpers and mount-time/popstate handlers in `App.tsx`; frontend event-driven stage rendering via `deriveExecutionStageProgress`, falling back to the existing simulated inference exactly when `hasCanonicalInvestigationLifecycleMarker` returns `false` — never merely because a run predates #37. See `docs/reviews/22-issue-38-timeline-polling-resume-plan.md` for the full design record.

---

## 11. Explicit non-goals of this issue

Unimplemented and untouched by #36: incremental event persistence; orchestrator event emission (specified in §9, not written); an events HTTP endpoint; polling; URL-based refresh recovery; active-run discovery as running code; any database, API, or frontend change; the public LIVE trial (#39). `AgentTraceEventSchema`'s behavior is unchanged. `packages/database/src/mappers.ts` and `apps/web` are not modified. No CI run, merge, or deployment has occurred for this work.
