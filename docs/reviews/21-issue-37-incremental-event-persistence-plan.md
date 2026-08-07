# Issue #37 — Incremental Investigation Event Persistence (final revision)

| | |
| --- | --- |
| Scope | #37 "Persist investigation stages and trace events incrementally" |
| Basis | `main` @ `db40737` (#46, the #36 contract merge), working tree clean, in sync with `origin/main` |
| Status | Plan only. No repository source modified, no branch, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Revision | Final, compatibility-corrected. Adds all-12-type exact replay, an atomic vertical integration phase, explicit terminal-corruption behavior, and a two-channel orchestrator design that preserves legacy in-memory trace callers. |
| Committed location | `docs/reviews/21-issue-37-incremental-event-persistence-plan.md` (not written during this plan-mode session) |

---

## Context

Today a run's Timeline exists only *after* the run ends. `runAgentOrchestrator` accumulates an
`AgentTraceEvent[]` purely in memory and returns it; `finalizeCompleted`/`finalizeFailed` then insert
the whole array with `createMany` in the transaction that flips the run terminal. This is "Option A —
persist-after", chosen deliberately in Challenge 3 (`docs/10-engineering-challenges.md` §5), whose
rejected "Alternative A — persist incrementally" is exactly what #37 now builds.

The consequence: a `RUNNING` run has zero rows in `agent_trace_events`, so nothing about a live
investigation is queryable, nothing survives a refresh, and #38 has nothing to poll.

#36 shipped the whole contract — schemas, a strict reducer, an origin marker, a legacy projection —
inert in `packages/contracts`. `docs/16-investigation-event-contract.md` §9 is an explicit handoff list
for this issue. #37 is the wiring.

**What this final revision changes.** A material contradiction in the previous draft is resolved: it
said canonical emissions "replace" the orchestrator's existing `trace.push(...)` calls, while also
claiming an omitted emitter leaves the returned legacy trace identical to today. Both cannot be true —
`runAgentOrchestrator` has non-persistence callers (evals, demos, orchestrator unit tests, any other
direct caller) that read the returned `AgentTraceEvent[]` and never supply an emitter. The orchestrator
now maintains **two separate output channels** — canonical persistence and legacy in-memory trace — kept
deliberately independent rather than derived from one another, because their timing is not identical for
every failure path. The plan's claim about API-served trace content is also corrected: it is **not**
byte-for-byte identical to today for every canonical run — `TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` now
project a `TOOL_REQUESTED` the pre-#37 API response never showed, because canonical persistence records
it before validation runs and the API trace is now sourced from the canonical ledger, not the
orchestrator's in-memory return value.

Everything else previously resolved — one physical ledger, all-12 exact replay, transactional reducer
validation, atomic terminal event/status, current-runtime one-tool/two-turn V1, service-owned usage
accounting, event-emission failure aborting and leaving `RUNNING`, the atomic vertical integration phase,
and repository-only canonical reads — is preserved unchanged.

---

## 1. Current-state findings

### Contract layer (exists, unwired)

- `packages/contracts/src/investigation-event.ts` — `InvestigationEventPayloadSchema` (12 write-eligible
  types), `InvestigationEventRecordPayloadSchema` (those 12 + legacy `REPORT_GENERATED`), and the
  persisted envelope `InvestigationEventRecordSchema = { runId, sequence, recordedAt, payload }`.
  `RUN_FAILED` carries exactly `failureCode` + `failedStage`, no free-form message.
- `packages/contracts/src/investigation-stage-progress-reducer.ts` — `deriveExecutionStageProgress({
  events, runStatus, now })`, throwing `InvestigationEventContractError` with one of 27 codes. Does not
  repair.
- `packages/contracts/src/investigation-lifecycle-compatibility.ts` —
  `hasCanonicalInvestigationLifecycleMarker(events)` and `projectToLegacyAgentTraceEvent(record)`.
- `packages/contracts/src/investigation-execution-stage.ts` — the 4-stage enum and progress schemas.

### Orchestrator — `packages/agent-runtime/src/agent/agent-orchestrator.ts` (390 lines)

`runAgentOrchestrator` (171) is pure and persistence-free. `MAX_PROVIDER_TURNS = 2` (35) is what makes
V1 "≤2 turns, ≤1 tool". Trace pushes today: `RETRIEVAL_COMPLETED` (217), `REPORT_GENERATED` (308),
`TOOL_REQUESTED` (341), `TOOL_COMPLETED` (363). Fourteen `failed(...)` return sites.

Two facts shape the emission design, and both now describe the **legacy in-memory trace channel
specifically** — the one direct callers (evals, demos, orchestrator unit tests) read today and must keep
reading unchanged (§5):

- `TOOL_REQUESTED` is pushed at 341, **after** the registry lookup (323) and input validation (332), so
  `TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` produce a legacy trace with no tool event at all — true today,
  and (per §5) still true after #37 for this channel. docs/16 §5 names moving the **canonical**
  persistence point earlier as the mandatory #37 obligation; it does not ask for the legacy push to move.
- `validateOrchestratorParams` (174) can fail with `RETRIEVAL_PARAMS_INVALID` and an explicitly empty
  trace, before anything happens — exactly the reducer's one pre-agent exception, reachable only if
  `AGENT_STARTED` has not been emitted yet.

### Service — `packages/agent-runtime/src/persistence/agent-run-service.ts` (748 lines)

`executeAndPersist` (497) is the only caller of `runAgentOrchestrator` and the only layer seeing both
the creation transaction (507–559) and finalization (`finalize`, 442). It creates exactly one usage
collector per LIVE run (579), takes exactly one snapshot on the happy path (690), resolves abort
provenance once (682), and already snapshots the collector mid-flight in its crash catch (652).

### Persistence — `packages/database`

- Prisma 7.9.0, driver adapter; `prisma.$transaction(async (tx) => …)`; row locks via raw
  `tx.$queryRaw … FOR UPDATE`. Global lock order `AgentJob → AgentRun → AgentTraceEvent`.
- `agent_trace_events` already has `run_id`, `sequence_number` with `UNIQUE(run_id, sequence_number)`
  and `CHECK >= 1`, untyped `payload JSONB`, untyped `event_type TEXT`, and `created_at TIMESTAMPTZ NOT
  NULL DEFAULT now()` — the storage-generated `recordedAt`. The only blocker is
  `agent_trace_events_event_type_chk` restricting `event_type` to the 4 legacy variants (init migration
  line 108). `agent_trace_events_event_type_matches_chk` (`event_type = payload->>'type'`) already works
  for the new types.
- `finalizeTerminal` (`agent-run-repository.ts:591`) locks the run row, and on `RUNNING` does
  `createMany(trace)` + the terminal `update` in one transaction; otherwise runs exact-replay comparison
  (JSONB array equality on the trace, `IS NOT DISTINCT FROM` on report/failure_code).
- `startRun` allocates `attempt_number` with `COALESCE(MAX(...),0)` **under the job's `FOR UPDATE`
  lock** — the in-repo precedent for the sequence allocation kept in §4.
- **`packages/database/package.json` already declares `"@opspilot/contracts": "workspace:*"`** — what
  makes transactional reducer validation resolvable in place (§4).
- No `failed_stage` column on `agent_runs`; that fact lives only in the event payload.

### API — `apps/api`

`GET /v1/agent-runs/:runId` already returns `outcome: RUNNING` and forwards `trace` verbatim in
`sequence_number` order. `clientRequestId` is excluded from every response DTO. `mapDomainError`
(`errors/map-domain-error.ts:34`) switches on a closed `DomainErrorContext`; `respond` (controller:514)
picks the context from `result.stage`; `reconciliationFor` (controller:~75–100) decides what the
`finally` block reconciles.

---

## 2. Scope and non-goals

**In scope** — canonical lifecycle event persistence into `agent_trace_events`, one row per event as it
happens; deterministic per-run `sequence`; storage-generated `recordedAt`; emission at the real runtime
transition points including the early canonical `TOOL_REQUESTED` move; transactional reducer
enforcement; all-12-type exact replay; the orchestrator's two-channel output design (canonical +
unmodified legacy in-memory trace); read mapping sufficient to verify persisted rows plus the legacy
`run.trace` projection; focused tests.

**Non-goals** — frontend adoption, polling/refresh recovery, `?job=` URL recovery, a canonical events
HTTP endpoint, SSE, public LIVE access, visitor quotas, deployment, #38, #39, orphan reconciliation. No
broadening of V1 beyond two provider turns and one tool call. `clientRequestId` stays out of every public
response.

---

## 3. Data-model decision

**One physical ledger — reuse `agent_trace_events`.** docs/16 §7 endorses this: `event_type` and
`payload` are untyped, so `AgentTraceEventSchema` and `InvestigationEventRecordSchema` are two
purpose-built read projections over one ledger. A second table would fork the ordering key and break the
existing `run.trace` read.

**One migration** —
`prisma/migrations/<timestamp>_widen_agent_trace_events_for_canonical_lifecycle/migration.sql`, with the
house header block:

1. Drop and re-add `agent_trace_events_event_type_chk` listing all **13** record types (12 write-eligible
   + legacy `REPORT_GENERATED`). Widening only; every historical row still satisfies it.
2. Add a partial unique index covering **all 12 canonical write types**, excluding only the legacy
   read-only type:

```sql
CREATE UNIQUE INDEX "agent_trace_events_run_id_canonical_event_type_key"
  ON "agent_trace_events" ("run_id", "event_type")
  WHERE "event_type" IN (
    'RUN_CREATED', 'AGENT_STARTED', 'RETRIEVAL_COMPLETED',
    'TOOL_REQUESTED', 'TOOL_COMPLETED', 'TOOL_FAILED',
    'REPORT_GENERATION_STARTED', 'REPORT_SUBMITTED',
    'REPORT_VALIDATED', 'REPORT_VALIDATION_FAILED',
    'RUN_COMPLETED', 'RUN_FAILED'
  );
```

This is the database half of the all-12 exact-replay policy (§4). Under current-runtime V1 every one of
the 12 is at-most-once per run — retrieval events 0 or 1, tool calls 0 or 1, tool outcomes 0 or 1 — so
the index states a real invariant, not a convenience.

`REPORT_GENERATED` is excluded because it is legacy read-only and never written again; every historical
row satisfies the index anyway, since a legacy trace carries `RETRIEVAL_COMPLETED`, `TOOL_REQUESTED`,
`TOOL_COMPLETED`, and `REPORT_GENERATED` at most once each.

**This index is deliberately current-runtime-specific.** A future multi-tool or repeated-retrieval
contract version replaces or narrows it in a coordinated migration alongside the #36 contract change that
permits those streams. Narrowing it *now* to avoid that future migration would weaken correctness today
for a version that does not exist.

`schema.prisma` is **unchanged**: CHECK constraints and partial indexes are inexpressible in Prisma's
DSL, and `db:migrate:drift` compares migrations-applied-to-shadow against the live database — both sides
get this SQL from the same migration, so drift stays clean. Same treatment as
`agent_runs_job_id_client_request_id_key`.

**No `next_event_sequence` counter column** (§4) and **no `failed_stage` column on `agent_runs`** — the
failed stage is a fact of the `RUN_FAILED` event; duplicating it on the run row would create two sources
of truth.

`schema-constraints.integration.test.ts` gains: the new index by exact name, and the widened `event_type`
value list asserted equal to `InvestigationEventRecordPayloadSchema`'s options (the file already does
this enum-parity style for `failure_code`).

---

## 4. Repository API

### One exact-replay policy, all 12 canonical write types

A transaction can commit and *still* leave the caller with an ambiguous driver/network failure before it
sees the returned row. A retry of that append must return the original row, not create a second
candidate event that the reducer would then reject. That risk applies to `TOOL_REQUESTED` and
`TOOL_COMPLETED` exactly as much as to `REPORT_SUBMITTED` — arguably more, since those retries follow
real side-effecting work.

One helper, one policy, used by both write paths:

```ts
// packages/database/src/repositories/investigation-event-ledger.ts (internal)
type CanonicalEventReplay =
  | { kind: "replay"; sequenceNumber: number; createdAt: Date }
  | { kind: "absent" };

async function resolveCanonicalEventReplay(
  tx, runId: string, payload: InvestigationEventPayload,
): Promise<CanonicalEventReplay>;   // throws PERSISTENCE_CONFLICT on payload mismatch
```

Comparison happens in PostgreSQL, not JavaScript — the same reasoning that made `finalizeTerminal` use
JSONB equality rather than JS string comparison (JSONB normalizes object key order; JS does not):

```sql
SELECT sequence_number, created_at,
       (payload IS NOT DISTINCT FROM $3::jsonb) AS payload_matches
FROM agent_trace_events
WHERE run_id = $1 AND event_type = $2
```

- no row → `absent`
- row, `payload_matches` → `replay`: return the original `sequence_number` and `created_at`, insert
  nothing, **consume no sequence number**
- row, not `payload_matches` → **`PERSISTENCE_CONFLICT`**, nothing inserted

The candidate payload is parsed through `InvestigationEventPayloadSchema` first, so the JSONB compared is
the identical normalized value that would have been inserted. This is what stops a retry from silently
accepting a different `toolCallId`, `toolName`, `REPORT_VALIDATION_FAILED.failureCode`, or a `RUN_FAILED`
that disagrees about `failedStage`, as "the same event".

Because the replay check runs **before** allocation and before the insert, an ambiguous-success retry
short-circuits and never reaches the reducer — it can never surface as
`PERSISTENCE_EVENT_STREAM_INVALID`.

**Division of labour between the two write paths.** `appendInvestigationEvent` handles the ten
non-terminal types. `RUN_COMPLETED`/`RUN_FAILED` are rejected outright by the generic append (a
programming-error guard): a terminal event written without its status update is precisely the corruption
described in §"Terminal transaction", so it must only ever be written by `finalizeTerminal`.
`finalizeTerminal` calls the *same* `resolveCanonicalEventReplay` for its terminal event. Between them
all 12 types share one policy — the split is about which transaction owns the write, never about which
replay rule applies.

### New — `packages/database/src/repositories/agent-run-repository.ts`

```ts
export async function appendInvestigationEvent(
  prisma: PrismaClient,
  runId: string,
  payload: InvestigationEventPayload,
): Promise<InvestigationEventRecord>;
```

Payload validated **before** the transaction opens (house rule: an invalid write never touches the
database), and terminal types rejected here. Then one transaction:

```text
BEGIN
  1. SELECT status FROM agent_runs WHERE id = $runId FOR UPDATE
       missing           -> PERSISTENCE_NOT_FOUND
       status <> RUNNING -> PERSISTENCE_CONFLICT   (nothing may follow a terminal event)
  2. resolveCanonicalEventReplay(...)
       replay   -> COMMIT, return the original record (no insert, no sequence consumed)
       conflict -> ROLLBACK, PERSISTENCE_CONFLICT
  3. SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM agent_trace_events WHERE run_id = $runId
  4. INSERT ... RETURNING sequence_number, created_at
  5. SELECT the full canonical stream for $runId ORDER BY sequence_number ASC
  6. deriveExecutionStageProgress({ events, runStatus: "RUNNING", now: latestRecordedAt })
       throws -> ROLLBACK, PERSISTENCE_EVENT_STREAM_INVALID
COMMIT
```

- **Sequence allocation is `MAX+1` under the `agent_runs` row lock.** Challenge 1's warning (`docs/10`
  §352–374) is about `MAX+1` *without* a shared lock; the run row is already locked here for the
  terminal-status check, which serializes every appender for that run. Same shape as `startRun`'s
  `attempt_number`. `UNIQUE(run_id, sequence_number)` stays as defense in depth.
- **The replay check precedes allocation**, so an idempotent replay never burns a sequence number and the
  next genuinely new event stays contiguous.
- `recordedAt` is `created_at.toISOString()` from `RETURNING`, or from the replayed row. Never assigned
  in application code.
- The new partial unique index is defense in depth: the row lock means the application check always wins,
  but a concurrent duplicate would hit `23505` → `normalizeDatabaseError` → `PERSISTENCE_CONFLICT`.

```ts
export async function getInvestigationEventRecords(
  prisma: PrismaClient,
  runId: string,
): Promise<readonly InvestigationEventRecord[]>;
```

`RepeatableRead`, `ORDER BY sequence_number ASC`, contiguity `1..N` verified, every row revalidated
against `InvestigationEventRecordSchema`. Repository-only; not exposed over HTTP by this issue.

### Changed

| Function | Change |
| --- | --- |
| `startRun` | Inserts `RUN_CREATED` at `sequence_number = 1` **inside the existing transaction** that inserts the `agent_runs` row. No reducer call needed — a one-event `RUN_CREATED` prefix is valid by construction. |
| `startLiveRunWithAttemptLimit` | Same, in its own single transaction. The `replayed` branch inserts nothing (it creates no run). |
| `finalizeCompleted` | `(prisma, runId, report, usage?)` — `trace` removed. |
| `finalizeFailed` | `(prisma, runId, code, failedStage, usage?)` — `trace` removed, stage added. |
| `finalizeTerminal` | Rewritten per below. |
| `mappers.ts` | Add `toInvestigationEventCreateInput`, `fromInvestigationEventRows`. Rewrite `fromTraceEventRows` (§7). Delete `toTraceEventCreateInputs` with its last caller. |
| `errors.ts` | Add `PERSISTENCE_EVENT_STREAM_INVALID` to `PersistenceErrorCode`. |
| `AgentRunRepositoryInterface` | Add `appendInvestigationEvent`, `getInvestigationEventRecords`; update both finalize signatures. |

### Terminal transaction, including corruption behavior

```text
BEGIN
  1. SELECT status FROM agent_runs WHERE id = $runId FOR UPDATE
       missing -> PERSISTENCE_NOT_FOUND
  2. IF status = 'RUNNING':
       a. SELECT 1 FROM agent_trace_events
            WHERE run_id = $runId AND event_type IN ('RUN_COMPLETED','RUN_FAILED')
          FOUND -> internal persistence corruption:
                   ROLLBACK, PERSISTENCE_EVENT_STREAM_INVALID
                   -- do NOT promote the run status
                   -- do NOT insert a second terminal event
                   -- do NOT treat it as a replay, whatever the payload says
       b. allocate MAX+1; INSERT the RUN_COMPLETED / RUN_FAILED row
       c. SELECT the full canonical stream ORDER BY sequence_number
       d. deriveExecutionStageProgress({ events, runStatus: "COMPLETED" | "FAILED",
                                          now: latestRecordedAt })
          throws -> ROLLBACK (event AND status), PERSISTENCE_EVENT_STREAM_INVALID
       e. UPDATE agent_runs SET status, report | failure_code, finished_at, <usage columns>
  3. ELSE (already terminal):
       resolveCanonicalEventReplay(terminal payload)   -- same helper, same policy
         conflict -> PERSISTENCE_CONFLICT
         absent   -> terminal status with no terminal event: PERSISTENCE_EVENT_STREAM_INVALID
         replay   -> additionally compare stored report / failure_code via IS NOT DISTINCT FROM
                     -> idempotent success, or PERSISTENCE_CONFLICT
COMMIT
```

**Why `RUNNING` + an existing terminal event is corruption, not a replay.** The terminal event and the
terminal status commit in one transaction, so that combination is unreachable through this code. If it
is observed, something wrote outside the repository — and the honest response is to refuse, exactly as
`getAgentRun` already refuses a non-contiguous stored trace rather than returning a plausible partial
one. Promoting the status would repair a history nobody can vouch for; inserting a second terminal event
would make the stream permanently reducer-invalid. **An exact terminal replay is valid only when the run
row is already terminal and the stored event and outcome columns both match.**

The run status is updated **only after** the reducer accepts the completed stream. That is what makes the
production invariant true rather than merely tested:

> a terminal database row can never commit with a reducer-invalid canonical stream

**Why the replay comparison is not weaker than before.** The old check compared the whole incoming trace
because the trace *was* the payload being written. Under incremental persistence the trace is already
durable before finalization, and `appendInvestigationEvent` refuses to write to a non-`RUNNING` run — so
no replay can alter it. What a retry genuinely re-supplies is the terminal fact, and `RUN_FAILED`'s
payload carries both `failureCode` and `failedStage`, so a retry disagreeing about *where* the run failed
conflicts. This is not the rejected "Alternative C — compare only the terminal outcome".

### Dependency direction

`packages/database` **already depends on `@opspilot/contracts`** and already imports
`AgentTraceEventSchema`, `ResolutionReportSchema`, and `AgentOrchestratorErrorCodeSchema` from it. So
`deriveExecutionStageProgress` is importable directly in the repository, inside the same `tx`, with no
inversion, no callback seam, and no new package. The transaction-owning layer and the validating layer
are the same function. Nothing moves.

Cost: the stream is re-read and re-reduced on every append — O(n²) in events per run, with n ≤ 9 under
V1. Negligible, and it buys an invariant a future caller cannot bypass.

### Transaction-boundary summary

| Concern | Boundary |
| --- | --- |
| `RUN_CREATED` + run creation | One transaction; a failure of either rolls back both — no run row without its first event, no event without its run |
| Generic append | One short transaction per event, committed immediately (this is the visibility the issue exists for) |
| Exact replay, all 12 types | Inside the writing transaction, before allocation; commits nothing |
| Terminal event + run status | One transaction; reducer validation sits between the insert and the status update |
| Terminal event found while `RUNNING` | Corruption → rollback, no status promotion, no second event |
| Reducer validation | Always pre-commit, always inside the same `tx` as the write it validates |
| Already-terminal exact replay | Inside the same locked transaction that would otherwise write |
| Concurrent appends | Serialized by `SELECT … FROM agent_runs … FOR UPDATE`; distinct contiguous sequences |
| DB failure after paid/side-effecting work | Never retried automatically, never re-executed (§6) |
| Lock order | `AgentJob → AgentRun → AgentTraceEvent`, unchanged everywhere |

---

## 5. Runtime emission map

### The seam

`AgentOrchestratorParams` gains one optional field:

```ts
readonly emitLifecycleEvent?: (payload: InvestigationEventPayload) => Promise<void>;
```

Optional so every existing caller — evals, demos, orchestrator unit tests — is unchanged and emits
nothing. Awaited because the ordering claim must be real: if `TOOL_REQUESTED` is not durable before the
registry lookup runs, the ledger is not describing what happened.

`emitLifecycleEvent` governs **only** the canonical persistence channel. It has no effect on the
orchestrator's existing in-memory `trace: AgentTraceEvent[]` accumulator or on the `trace` field of
`AgentOrchestratorResult` — that channel keeps its own independent `trace.push(...)` calls, present
today, and is returned unconditionally to every caller whether or not an emitter is supplied.

`executeAndPersist` supplies the closure, binding the `runId` the orchestrator never learns and
constructing the error where `payload.type` is in scope:

```ts
emitLifecycleEvent: async (payload) => {
  try { await repository.appendInvestigationEvent(started.run.id, payload); }
  catch (cause) {
    throw new InvestigationEventEmissionError({
      runId: started.run.id,
      attemptedEventType: payload.type,
      cause,
    });
  }
}
```

`InvestigationEventEmissionError` lives in `packages/agent-runtime/src/persistence/` and carries:

```ts
{
  runId: string;
  attemptedEventType: InvestigationEventPayload["type"];
  cause: unknown;          // the original PersistenceError, internal only
}
```

**No `sequence`** — allocation happens inside the transaction that failed, so the caller cannot know
whether one was assigned; fabricating one would be a lie. **No persistence code is added to
`AgentOrchestratorErrorCode`** — execution failure and ledger-infrastructure failure stay separate
domains. The message is fixed; the cause is retained only via `Error.cause`.

The orchestrator never catches it: its only `catch` (264) rethrows anything that is not an
`LlmProviderError`, so it propagates unchanged and the loop unwinds immediately — no further provider
turn, no further tool execution.

`failed(...)` gains a required `failedStage: InvestigationExecutionStage` parameter, and the `failed`
variant of `AgentOrchestratorResult` gains the same field, so every failure site must state its stage —
compile-enforced, matching this repo's preference for exhaustive records over inferred defaults.

### Two output channels

The previous draft's per-event table said several canonical emissions "replace" the existing
`trace.push(...)` calls, while also claiming an omitted emitter leaves the returned trace "identical to
today." Both cannot hold: `runAgentOrchestrator` has non-persistence callers — evals, demos, orchestrator
unit tests, and any other direct caller — that depend on the returned legacy `AgentTraceEvent[]` and
never supply an emitter at all. If canonical emission replaced the legacy push, an omitted emitter would
leave those callers with no push whatsoever.

The orchestrator therefore maintains two channels, kept deliberately separate rather than derived from
one another, because their timing is not identical for every failure path:

1. **Canonical persistence channel** — `await params.emitLifecycleEvent?.(canonicalPayload)`, feeding
   #37's ledger through `AgentRunService`.
2. **Legacy in-memory trace channel** — `trace.push(legacyAgentTraceEvent)`, unconditional, preserved
   exactly for direct callers.

### Per-event map — both channels

`AO` = `packages/agent-runtime/src/agent/agent-orchestrator.ts`;
`REPO` = `packages/database/src/repositories/agent-run-repository.ts`.

| Event | Where | Canonical emission point | Payload source | Transaction | Run state | Legacy `trace.push` |
| --- | --- | --- | --- | --- | --- | --- |
| `RUN_CREATED` | `REPO` `startRun` / `startLiveRunWithAttemptLimit` | With the `agent_runs` INSERT | constant | **Same transaction as run creation**, sequence 1 | `→ RUNNING` | n/a — repository-owned, never part of the orchestrator's in-memory trace |
| `AGENT_STARTED` | `AO` after 177 | Right after `validateOrchestratorParams` returns `null`, before the retrieval block | constant | own | — | none — no legacy `AgentTraceEvent` variant exists |
| `RETRIEVAL_COMPLETED` | `AO` 217 | Configured-retriever branch only, after input **and** output validation | the `{chunkId, rank, score}` summary built there | own | — | `trace.push` immediately after, same point (217) — only reached if the canonical emission did not throw |
| `TOOL_REQUESTED` | `AO` **321** (canonical only, moved from 341) | Right after `const { toolCallId, toolName, input } = result.request`, **before** `toolRegistry.find` (323). Stays after the final-turn guard (313). | `result.request` | own | — | **unmoved** — `trace.push` stays at 341, only after successful input validation; not adjacent to the canonical emission |
| `TOOL_COMPLETED` | `AO` 363 | After output validation succeeds | `toolCallId`, `toolName` | own | — | `trace.push` immediately after, same point (363) |
| `TOOL_FAILED` | `AO` 326 / 335 / 348 / 357 | Before each of the four tool `failed(...)` returns | `toolCallId`, `toolName`, + the site's `ToolFailureCode` | own | — | none — no legacy `AgentTraceEvent` variant exists for this type; none is added |
| `REPORT_GENERATION_STARTED` | `AO` between 238 and 241 | When `phase === "FINALIZATION"`, immediately before `provider.runAgentTurn`, outside its `try` | constant | own | — | none — no legacy counterpart |
| `REPORT_SUBMITTED` | `AO` 274 | On entering the `report_submission` branch, **before** `ResolutionReportSchema.safeParse` (281) | constant | own | — | none — no legacy counterpart |
| `REPORT_VALIDATED` | `AO` 308 | After schema **and** evidence validation succeed | constant | own | — | `trace.push({ type: "REPORT_GENERATED" })` immediately after, same point (308) — the legacy type name is unchanged; canonical and legacy record the same fact under different names, one is not derived from the other |
| `REPORT_VALIDATION_FAILED` | `AO` 287 / 302 | Before each report `failed(...)` return | `REPORT_SCHEMA_INVALID` / `REPORT_EVIDENCE_INVALID` | own | — | none — no legacy counterpart |
| `RUN_COMPLETED` | `REPO` `finalizeTerminal` | Inserted, stream reduced, then status updated | constant | **Same transaction as `status='COMPLETED'`** | `RUNNING → COMPLETED` | n/a |
| `RUN_FAILED` | `REPO` `finalizeTerminal` | Same | `failureCode` = the abort-provenance-resolved code; `failedStage` = `agentResult.failedStage` | **Same transaction as `status='FAILED'`** | `RUNNING → FAILED` | n/a |

**Consequence for the two early tool failures.** Because canonical `TOOL_REQUESTED` is emitted before
registry lookup and the legacy `trace.push` is not, `TOOL_NOT_FOUND` and `TOOL_INPUT_INVALID` now produce
two different pictures of the same run:

- the **canonical ledger** (and therefore anything persisted) contains `TOOL_REQUESTED → TOOL_FAILED`,
  truthfully — the provider did request the tool;
- the orchestrator's **returned in-memory `trace`** — what evals, demos, and any other direct caller
  see — contains **no** `TOOL_REQUESTED`, exactly as it does today (`trace: []` for a fixture that fails
  this way with no retrieval configured).

This is intentional, not an oversight. It is what makes "emitter omitted → identical to today" actually
true, and it is what makes the canonical ledger truthful about a fact the legacy trace was never designed
to record. §7 works through the corresponding API-visible consequence, since the API's projected trace is
sourced from the canonical ledger, not from this in-memory return value.

### Ordering on emission failure

For every event with both channels, the canonical append happens **first**, the legacy push **second**:

```ts
await params.emitLifecycleEvent?.(canonicalPayload);   // may throw
trace.push(legacyPayload);
```

If `emitLifecycleEvent` rejects, the `await` throws before `trace.push` runs, and the orchestrator's only
`catch` (264) rethrows anything that is not an `LlmProviderError` — the function unwinds immediately. So:

- the legacy trace never claims a transition happened that could not be persisted — nothing is pushed for
  a step whose durable record does not exist;
- no further provider turn or tool execution occurs;
- a direct caller with no emitter is unaffected, since `params.emitLifecycleEvent?.(...)` is a no-op and
  the push always runs.

This governs `RETRIEVAL_COMPLETED`, `TOOL_COMPLETED`, and `REPORT_VALIDATED` directly, the three events
with an adjacent legacy counterpart. `TOOL_REQUESTED`'s canonical-then-legacy relationship is positional
rather than adjacent (see the table above), but the same rule holds transitively: a canonical
`TOOL_REQUESTED` failure aborts before the registry lookup is ever reached, so the legacy `trace.push` at
341 — which only runs after that lookup and validation succeed — can never fire either.

### `failedStage` for all 14 failure sites

Let `activeStage = phase === "FINALIZATION" ? "REPORT_GENERATION" : "AGENT_ANALYSIS"`.

| `AO` line | Code | `failedStage` |
| --- | --- | --- |
| 176 | `RETRIEVAL_PARAMS_INVALID` (caller contract) | `AGENT_ANALYSIS` — the pre-agent exception; no `AGENT_STARTED` emitted |
| 195 | `RETRIEVAL_PARAMS_INVALID` (`validateRetrievalInput`) | `AGENT_ANALYSIS` |
| 203 | `RETRIEVAL_FAILED` | `AGENT_ANALYSIS` |
| 208 | `RETRIEVAL_RESPONSE_INVALID` | `AGENT_ANALYSIS` |
| 265 | `PROVIDER_UNAVAILABLE` / `_TIMEOUT` / `_CANCELLED` | `activeStage` |
| 271 | `PROVIDER_PROTOCOL_INVALID` | `activeStage` |
| 287 | `REPORT_SCHEMA_INVALID` | `REPORT_GENERATION` |
| 302 | `REPORT_EVIDENCE_INVALID` | `REPORT_GENERATION` |
| 315 | `PROVIDER_PROTOCOL_INVALID` (tool request on final turn) | `REPORT_GENERATION` |
| 326 | `TOOL_NOT_FOUND` | `DIAGNOSTIC_EXECUTION` |
| 335 | `TOOL_INPUT_INVALID` | `DIAGNOSTIC_EXECUTION` |
| 348 | `TOOL_EXECUTION_FAILED` | `DIAGNOSTIC_EXECUTION` |
| 357 | `TOOL_OUTPUT_INVALID` | `DIAGNOSTIC_EXECUTION` |
| 386 | `PROVIDER_PROTOCOL_INVALID` (unreachable) | `REPORT_GENERATION` |

Checked against the reducer's failure-code/stage policy (docs/16 §5): provider codes are legal in
`AGENT_ANALYSIS`, or in `REPORT_GENERATION` after `REPORT_GENERATION_STARTED` and before
`REPORT_SUBMITTED` — exactly when 265/271/315 can fire on the finalization turn; tool codes require a
preceding `TOOL_FAILED`, which the four tool sites now emit; report-validation codes require a preceding
`REPORT_VALIDATION_FAILED`, which 287/302 now emit.

### Resulting streams — canonical ledger (persisted, API-projected)

```text
direct no-tool        one-tool                    early tool failure   report invalid
────────────────      ──────────────────────      ──────────────────   ────────────────────────
RUN_CREATED           RUN_CREATED                 RUN_CREATED          RUN_CREATED
AGENT_STARTED         AGENT_STARTED               AGENT_STARTED        AGENT_STARTED
[RETRIEVAL_COMPLETED] [RETRIEVAL_COMPLETED]       TOOL_REQUESTED       REPORT_SUBMITTED
REPORT_SUBMITTED      TOOL_REQUESTED              TOOL_FAILED          REPORT_VALIDATION_FAILED
REPORT_VALIDATED      TOOL_COMPLETED              RUN_FAILED           RUN_FAILED
RUN_COMPLETED         REPORT_GENERATION_STARTED
                      REPORT_SUBMITTED
                      REPORT_VALIDATED
                      RUN_COMPLETED
```

### The same fixtures — orchestrator's returned legacy `trace` (direct callers)

```text
direct no-tool              one-tool                          early tool failure   report invalid
──────────────────────      ──────────────────────────────    ──────────────────   ──────────────────────
[RETRIEVAL_COMPLETED]       [RETRIEVAL_COMPLETED]              []                   []
REPORT_GENERATED            TOOL_REQUESTED
                            TOOL_COMPLETED
                            REPORT_GENERATED
```

Every one of these four is byte-for-byte what `runAgentOrchestrator` returns **today**, before #37. The
`early tool failure` and `report invalid` columns are empty because none of the four legacy event types
was ever pushed on those paths, then or now. This is the "identical to today" claim made precise: it
holds for the legacy channel's own callers, unconditionally; it does not extend to the API's
canonical-ledger-derived trace, which is a different read path (§7).

---

## 6. Failure and retry behavior

### Emission failure — abort, leave `RUNNING`

If `appendInvestigationEvent` fails mid-run, the run **aborts and stays `RUNNING`**: no terminal event,
no terminal status, and nothing the provider or a tool already did is re-executed. `executeAndPersist`
returns a new variant:

```ts
| { persistence: "unavailable"; stage: "event-emission"; runId: string;
    attemptedEventType: InvestigationEventPayload["type"];
    error: PersistenceError;
    usageSummary: RunProviderUsageSummary | null;
    reservation: LiveRunBudgetReservation | null }
```

There is deliberately **no retry path**: unlike finalization there is no durable in-memory result to
replay, and forcing a terminal write would require a failure code that is not in
`AgentOrchestratorErrorCode` plus a `failedStage` the ledger never shows as active
(`FAILED_STAGE_NOT_TRUTHFUL`). The run lands in the documented orphaned-`RUNNING` gap (`docs/11` §10) —
no new class of defect, and no lie written. This is the same abort captured by §5's "Ordering on emission
failure" — the legacy channel never advances past a canonical emission that failed, and neither does
execution.

A `RUN_CREATED` emission failure is **not** this case: it happens inside `startRun`'s transaction, so the
run creation rolls back entirely and the existing `stage: "run-creation"` variant applies. No run row
exists, nothing to reconcile.

### Paid-usage accounting on emission failure — service-owned accumulator

The mechanism already exists in the code; nothing new is invented.

- **Owner:** `executeAndPersist`, `packages/agent-runtime/src/persistence/agent-run-service.ts:579` —
  `const collector = live === null ? undefined : live.usageHooks.createCollector();` Exactly one per LIVE
  run, none for FAKE.
- **Who writes it:** the Claude adapter, wired in at `createProvider(started.job, collector)` (618).
  `AgentRunUsageCollector` (`run-provider-usage.ts`) deliberately exposes only `snapshot()` to the
  service; `record` belongs to the adapter. The accumulator is **mutable and live** — updated as each
  provider turn completes, before the orchestrator proceeds to the next emission point.
- **The read:** the emission error surfaces in the existing try/catch at line 637, where `collector` is in
  scope. The service calls `collector?.snapshot() ?? null` there — byte-for-byte the mechanism the
  `AGENT_EXECUTION_CRASHED` path already uses at line 652
  (`executionContext: { usageSummary: collector?.snapshot() ?? null, reservation }`):

```ts
} catch (rawError) {
  if (rawError instanceof InvestigationEventEmissionError) {
    return {
      persistence: "unavailable", stage: "event-emission",
      runId: started.run.id,
      attemptedEventType: rawError.attemptedEventType,
      error: rawError.cause as PersistenceError,
      usageSummary: collector?.snapshot() ?? null,   // <- the data path
      reservation,
    };
  }
  throw new AgentRunServiceError("AGENT_EXECUTION_CRASHED", started.run.id, { … });
}
```

- **Why the immediately preceding provider call is included:** the adapter records into the collector
  when a turn completes, and the orchestrator only reaches an emission point after that turn has
  returned. So any call that could have been billed before the failed append is already in the
  accumulator. The orchestrator never holds usage and never returns it — which is precisely why the
  accumulator, not the orchestrator result, is the source.
- **Zero-usage failures before the first provider call** (e.g. `AGENT_STARTED` fails to persist): the
  collector exists but has observed nothing, so the snapshot reports `providerCallsObserved: 0` and its
  own zero/unknown cost state. FAKE has no collector at all → `null`. Reconciliation still runs, which
  matters: an unreconciled reservation latches the day closed (`docs/12` §10.1.1).
- **Reconciliation still runs:** `reconciliationFor` (controller ~75–100) gains an `event-emission` branch
  returning `{ usageSummary, reservation, runId }` — identical to its `finalization` branch. The
  controller's existing `finally` then reconciles the budget and releases the lease exactly as today.
  `recordAdmitted()` is the correct admission outcome (the run was created and did execute).
- **Structured log fields** (one sanitized line, following `logProviderEvent`/`report-validation-log.ts`):
  `runId`, `attemptedEventType`, `failedStage`/phase if known, and the `PersistenceErrorCode`. Never a
  prompt, report, tool payload, provider response, connection string, or secret. Where the failure came
  from a reducer rejection, the `InvestigationEventContractError.code` is carried too — discharging the
  obligation Challenge 13 assigns to #37.

### Paired transitions and partial writes

Only the terminal pair must be atomic. `TOOL_FAILED → RUN_FAILED` and `REPORT_VALIDATION_FAILED →
RUN_FAILED` cross transactions, and the intermediate state is contract-valid on purpose: a `RUNNING` run
carrying a stage failure and no terminal event reduces cleanly (`RUNNING` is exempt from the
terminal-resolution rule) and is the honest description of a process that died between the two. Deferring
`TOOL_FAILED` into the finalize transaction would buy atomicity by hiding the failure from a live
viewer — the thing this issue exists to fix.

### Idempotent retries

1. `startLiveRunWithAttemptLimit`'s `clientRequestId` replay still short-circuits before any provider
   call; a replayed run creates no run and therefore no `RUN_CREATED`.
2. All 12 canonical appends are idempotent through `resolveCanonicalEventReplay` (application) and the
   partial unique index (database). An exact replay returns the original row and consumes no sequence; a
   conflicting one is `PERSISTENCE_CONFLICT`.
3. `finalizeTerminal`'s already-terminal branch confirms both the terminal event payload and the run
   columns. `retryFinalization` is unchanged in shape — `agentResult` now also carries `failedStage`, so
   a retry names the same stage the first attempt would have.

### Per-source failures

Provider errors (transport or protocol) → `RUN_FAILED` at `activeStage`. Retrieval failures →
`AGENT_ANALYSIS`, with no `RETRIEVAL_COMPLETED` (only emitted after both validations pass, which keeps it
truthful, on both channels). Tool failures → `TOOL_REQUESTED` (canonical only, for the early two codes),
`TOOL_FAILED`, `RUN_FAILED`. Report validation → `REPORT_SUBMITTED`, `REPORT_VALIDATION_FAILED`,
`RUN_FAILED`. `AGENT_EXECUTION_CRASHED` is unchanged: still not a persistence result, still leaves the row
`RUNNING`, now with a partial canonical stream showing how far it got.

### `apps/api` changes

- `DomainErrorContext` gains `"event-emission"`; `mapDomainError` maps `PERSISTENCE_UNAVAILABLE` → 503 and
  `PERSISTENCE_NOT_FOUND` → 500 `INTERNAL_DATA_INVALID` at that context (the run demonstrably existed),
  mirroring `finalization`.
- `PERSISTENCE_EVENT_STREAM_INVALID` maps to 500 `INTERNAL_DATA_INVALID` — an emitter or corruption
  defect, not a client error and not a transient outage. The public error catalog does not grow.
- `respond`'s two-way context ternary (controller:514) becomes a three-way switch.
- `reconciliationFor` and the admission-outcome helper each gain an `event-emission` branch.

No response shape or DTO changes.

---

## 7. Legacy compatibility and the read surface

There are now **two distinct legacy-trace surfaces**, and they can genuinely differ in content — this
section replaces the previous draft's blanket "identical to today" claim with a precise one.

1. **The orchestrator's direct in-memory return** (`AgentOrchestratorResult.trace`) — read by evals,
   demos, orchestrator unit tests, and any other caller that invokes `runAgentOrchestrator` without going
   through `AgentRunService`. Per §5, this channel is unmodified: its content and timing are unchanged
   from today, for every fixture, with or without an emitter supplied.
2. **The API-served `run.trace`** (`GET /v1/agent-runs/:runId`) — sourced, after #37, from the persisted
   canonical ledger via `fromTraceEventRows` → `projectToLegacyAgentTraceEvent`, not from the
   orchestrator's in-memory return value. **This is the surface that changes content for two specific
   failure codes.**

Canonical and legacy rows share one physical table and one ordering key. `fromTraceEventRows` becomes:

1. Enforce raw `sequence_number` contiguity `1..N` (unchanged, applied to rows, never to projected
   output).
2. Build `InvestigationEventRecord[]` and call `hasCanonicalInvestigationLifecycleMarker`.
3. **Canonical** → map through `projectToLegacyAgentTraceEvent`, drop the `null`s.
4. **Legacy** (pre-#37 rows) → the existing `AgentTraceEventSchema` path, byte-for-byte unchanged.

### The corrected compatibility claim

For normal successful paths and later tool failures, the projected trace preserves the existing legacy
shape and ordering.

For `TOOL_NOT_FOUND` / `TOOL_INPUT_INVALID`, the projected trace now truthfully includes `TOOL_REQUESTED`
because canonical persistence must precede validation. This is a content change within the existing
`AgentTraceEvent` union, not a response-shape change.

**Do not read this as byte-for-byte identical trace content for every canonical run — it is not, for
exactly these two failure codes.**

**Before/after, concretely.** Before #37, a `TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` run's persisted (and
therefore API) trace had no `TOOL_REQUESTED`, because it was derived from `finalizeFailed`'s `trace`
parameter — the orchestrator's own in-memory array, which never reached the old `trace.push` at line 341.
After #37, `finalizeFailed` no longer takes a `trace` parameter at all: every prior canonical event was
already persisted incrementally, and the API trace is projected from those rows. The canonical ledger
contains `TOOL_REQUESTED` for these two codes by design (§5), so the projected API trace now does too.

This is accepted as an intentional, shape-compatible content improvement:

- the event type is already supported by old consumers — `TOOL_REQUESTED` is one of the four legacy
  variants `TraceTimeline` already renders;
- no new public event type is exposed;
- `TOOL_FAILED` remains hidden by projection (projects to `null`, per §"Legacy `REPORT_GENERATED`
  semantics" in docs/16 §4/§7);
- the run's terminal outcome still communicates failure via `outcome.code`/`outcome.message`, unchanged;
- #38 will later provide canonical progress that supersedes reading this signal from `trace` at all.

Old consumers are otherwise unaffected: `REPORT_VALIDATED` → `REPORT_GENERATED`, the other three
overlapping types pass through as identity, and every lifecycle-only event (`RUN_CREATED`,
`AGENT_STARTED`, `REPORT_GENERATION_STARTED`, `REPORT_SUBMITTED`, `REPORT_VALIDATION_FAILED`,
`RUN_COMPLETED`, `RUN_FAILED`) plus `TOOL_FAILED` projects to `null`. A completed run's `run.trace` — and
therefore `apps/web`'s `TraceTimeline`, whose exhaustive switch has no case for the new types — is
identical to today. New runs stop writing `REPORT_GENERATED` as a fresh fact (structurally absent from
`InvestigationEventPayloadSchema`); the projection is what still produces it on the wire from
`REPORT_VALIDATED`.

**Read surface, stated explicitly:**

- `getInvestigationEventRecords(runId)` is **repository-only**. No controller, no service method, no DTO.
- `GET /v1/agent-runs/:runId` keeps its existing `{ job, run, trace, outcome }` shape.
- Canonical rows reach that response only through the legacy projection; lifecycle-only events stay
  hidden.
- A `RUNNING` response may now carry a **partial projected legacy trace**, because the rows exist
  incrementally. This is the behavior change, and it is the point of the issue.
- For a canonical run failing with `TOOL_NOT_FOUND` or `TOOL_INPUT_INVALID`, the terminal API trace now
  includes `TOOL_REQUESTED` where the pre-#37 API response for the same failure never did — the content
  divergence explained above, not a shape change.
- **No public `events[]`, no new endpoint, no `clientRequestId` exposure.** Canonical progress and polling
  design belong to #38.

This content divergence is proven by mapper-level tests (§9), since `fromTraceEventRows` is where the
projection actually runs; the `apps/api` regression test stays scoped to the RUNNING-partial-trace GET
path, which mapper and repository tests cannot cover end to end.

---

## 8. Implementation phases

### Why phases 4–6 of the previous draft cannot be separate commits

Converting `startRun`/`finalizeTerminal` before the orchestrator and service emit anything would leave the
repository in a half-converted production state: `startRun` writes `RUN_CREATED`, finalization no longer
batch-writes the in-memory trace, but no intermediate canonical events are ever persisted — so a normal
completion reaches terminal reducer validation with a stream of `RUN_CREATED → RUN_COMPLETED` and **must**
fail. The changed finalize and repository-interface signatures would also no longer match the unchanged
service, so the workspace would not even typecheck. **The conversion, the emitter, and the service wiring
are one change.**

### Revised phases

Each commit compiles and keeps the current execution path operational.

1. **Migration and constraints.** Widen `agent_trace_events_event_type_chk`, add the all-12 partial unique
   index, extend `schema-constraints.integration.test.ts`. No behavior change.
2. **Canonical mappers and projection.** `toInvestigationEventCreateInput`, `fromInvestigationEventRows`,
   marker/projection rewrite of `fromTraceEventRows`, unit tests. No writer yet; `fromTraceEventRows`'s
   legacy branch keeps every existing read working.
3. **Inert append/read repository APIs with transactional reducer validation.**
   `resolveCanonicalEventReplay`, `appendInvestigationEvent`, `getInvestigationEventRecords`,
   `PERSISTENCE_EVENT_STREAM_INVALID`. Nothing in production calls them; `startRun` and `finalizeTerminal`
   are untouched, so the existing batch path still works end to end. Repository integration tests land
   here, including replay, rollback, and concurrency.
4. **Atomic current-runtime vertical integration** — one commit, because it cannot be split:
   `RUN_CREATED` in both start transactions; all orchestrator emissions on both channels, including the
   canonical-only `TOOL_REQUESTED` move (§5's two-channel design, with the legacy `trace` accumulator and
   its `AgentOrchestratorResult` field **preserved, not deleted**); `failedStage` on `failed(...)` and the
   result type; the service emitter closure and `InvestigationEventEmissionError`; `finalizeTerminal`
   conversion and the new finalize signatures; the `event-emission` result variant;
   `AgentRunRepositoryInterface` and fake-repo updates; API error mapping and reconciliation wiring.
   **Must leave green:** direct no-tool success, one-tool success, every current failure path,
   reducer-valid terminal streams, the existing API test suites, and every direct orchestrator caller
   (evals, demos, orchestrator unit tests) unchanged when no emitter is supplied. The service may stop
   *consuming* the returned trace for database finalization (the finalize signatures already drop `trace`
   per §4) — it must not stop the orchestrator from *producing* it.
5. **Cross-layer integration and failure-boundary tests.** The reducer-validity matrix across every
   runtime fixture, the emission-failure boundary matrix, the corruption case, and the compatibility set
   including the two-channel and projected-trace-divergence tests.
6. **Docs and final verification.** Update `docs/11` (§5, §9, §10), `docs/16` §9 status, add Challenge 14
   to `docs/10`, and run the full sweep.

If phase 4 proves too large in review, the fallback is the backward-compatible dormant path: keep the old
finalize path live while the new one is built behind it, and flip only once orchestrator, service,
terminal finalization, and API handling are all wired. **A half-converted production path is not an
option either way.**

---

## 9. Test plan

### Repository / database (integration, real Postgres)

- Event-type CHECK parity with `InvestigationEventRecordPayloadSchema.options`; unknown type rejected;
  `event_type_matches_chk` still rejects a payload whose `type` disagrees.
- Partial unique index exists by exact name and rejects a duplicate canonical type inserted by raw SQL.
- **Exact replay, per type** — `RETRIEVAL_COMPLETED`, `TOOL_REQUESTED`, `TOOL_COMPLETED`, `TOOL_FAILED`,
  `REPORT_VALIDATION_FAILED` (plus the lifecycle singletons). Each proves: the original `sequence` and
  `recordedAt` are returned; **no row is added**; the next genuinely new event remains contiguous.
- **Conflicting replay, per type** — a changed `toolCallId`, a changed `toolName`, a changed
  `TOOL_FAILED.failureCode`, a changed `REPORT_VALIDATION_FAILED.failureCode`, and changed retrieval chunk
  data each raise `PERSISTENCE_CONFLICT` and insert nothing.
- **An ambiguous-success retry never becomes `PERSISTENCE_EVENT_STREAM_INVALID`** — the replay check
  short-circuits before the reducer runs.
- Concurrent contiguous allocation: two real Prisma clients appending to the same run receive distinct,
  contiguous sequences and never violate `UNIQUE(run_id, sequence_number)`.
- Append after terminal → `PERSISTENCE_CONFLICT`; a terminal payload passed to the generic append is
  rejected outright.
- **Invalid prefix rollback through the reducer**: an out-of-phase append (e.g. `TOOL_REQUESTED` after
  `REPORT_SUBMITTED`) raises `PERSISTENCE_EVENT_STREAM_INVALID` and leaves zero new rows.
- **Valid partial prefix commits**: `RUN_CREATED` alone; `+AGENT_STARTED`; an open `TOOL_REQUESTED`; a
  failure-fact prefix (`TOOL_FAILED` with no terminal yet) — all commit under `runStatus: "RUNNING"`.
- Terminal event/status atomicity, via the existing test-only-trigger pattern: a Postgres failure on the
  terminal `UPDATE` rolls back the terminal event too — the run stays `RUNNING` with no terminal row.
- **Reducer-invalid terminal rollback**: a `RUN_COMPLETED` on a stream missing `REPORT_VALIDATED`, and a
  `RUN_FAILED` whose stage/code are incompatible, both roll back the event **and** leave the run
  `RUNNING`.
- **Corrupted `RUNNING` + terminal event** (raw-SQL setup: insert a `RUN_FAILED` row against a `RUNNING`
  run): `finalizeTerminal` raises `PERSISTENCE_EVENT_STREAM_INVALID`, the run status is **not** promoted,
  and **no second terminal event** is inserted.
- Terminal status with no terminal event (raw-SQL setup) → `PERSISTENCE_EVENT_STREAM_INVALID`, never a
  silent success.
- All valid direct and one-tool terminal streams commit.
- Exact terminal replay including `failedStage`; a differing stage conflicts.
- `RUN_CREATED` commits at sequence 1 in the run-creation transaction; a forced failure rolls both back.
- `getInvestigationEventRecords` on a mid-flight `RUNNING` run returns the partial prefix — the direct
  proof of the issue's headline criterion.

### Orchestrator (unit)

- Every canonical event's exact emission point, asserted as an ordered payload list per fixture.
- **Early canonical tool request**: an unknown tool name yields canonical emitted order `TOOL_REQUESTED,
  TOOL_FAILED` — proving canonical persistence precedes lookup/validation.
- One tool maximum: a second tool request on the finalization turn emits no second `TOOL_REQUESTED` on
  either channel.
- `failedStage` correct for every one of the 14 failure sites.
- **With `emitLifecycleEvent` omitted**: every existing orchestrator fixture (no-tool success, one-tool
  success, each of the 14 failure sites) returns the identical legacy `trace: AgentTraceEvent[]` it does
  today — this is the regression proof that the two-channel split is correct, matching §5's "same
  fixtures" table exactly.
- **`TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` still omit legacy `TOOL_REQUESTED`** from the returned in-memory
  trace, with or without an emitter supplied — proving the legacy push point did not move.
- **Successful tool path still contains legacy `TOOL_REQUESTED → TOOL_COMPLETED`**, in that order, at the
  unmoved positions.
- **A validated report still contains legacy `REPORT_GENERATED`** (not `REPORT_VALIDATED`) in the returned
  trace.
- **With a recording emitter**: canonical events are recorded in the required order; the legacy trace is
  still returned and matches the no-emitter case for every event with a legacy counterpart; for every
  dual-channel event, the canonical record resolves before the corresponding legacy push (asserted via a
  recording emitter whose calls are interleaved with `trace`'s contents at each step).
- **Emitter rejection stops immediately**: no further provider turn, no further tool execution, and **no
  legacy `trace.push` for the event whose canonical emission failed** — a rejecting emitter on, say,
  `RETRIEVAL_COMPLETED` must leave `trace` exactly as it was before that call.

### Service (unit, fake repository)

- **Reducer-validity matrix**: ~14 fixtures (no-tool success, no-tool + retrieval, one-tool success,
  `TOOL_NOT_FOUND`, `TOOL_INPUT_INVALID`, `TOOL_EXECUTION_FAILED`, `TOOL_OUTPUT_INVALID`,
  `REPORT_SCHEMA_INVALID`, `REPORT_EVIDENCE_INVALID`, provider error turn 0 and turn 1, protocol error
  turn 0 and turn 1, tool-request-on-final-turn, params-invalid pre-agent). For each: run
  `executeAndPersist`, feed recorded records + final status to `deriveExecutionStageProgress`, assert no
  throw, zero `active`/`pending` stages on terminal results, and the expected failed stage.
- **Emission failure at four paid-work boundaries** — before any provider call; immediately after an
  investigation provider call; after a tool completed; after the finalization provider returned. Each
  asserts: result is `stage: "event-emission"`; run left `RUNNING`; `finalizeCompleted`/`finalizeFailed`
  never called; **no additional provider or tool calls occurred**; `usageSummary` reflects exactly the
  calls observed up to that point; `reservation` is carried for reconciliation.
- Zero-usage emission failure before the first provider call reports `providerCallsObserved: 0` and still
  carries the reservation.
- `attemptedEventType` on the error matches the event that failed; no `sequence` is fabricated.
- Regression: LIVE replay still executes nothing and appends nothing; `retryFinalization` allocates no new
  attempt and writes the original usage.

### Compatibility

- Historical legacy rows read back unchanged through the legacy branch.
- Canonical projection hides all lifecycle-only events and `TOOL_FAILED`; `REPORT_VALIDATED` surfaces as
  `REPORT_GENERATED`.
- A `RUNNING` run's partial projected legacy trace is a valid `AgentTraceEvent[]`.
- **Mapper**: a successful canonical event stream projects to the expected legacy trace, unchanged from
  today.
- **Mapper**: a canonical `TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` stream (containing `TOOL_REQUESTED →
  TOOL_FAILED`) projects a legacy trace containing `TOOL_REQUESTED` and **no** `TOOL_FAILED` — pinning
  down the one deliberate content divergence from pre-#37 behavior explicitly, not leaving it to
  incidental coverage. The projected result is asserted to remain a valid `AgentTraceEvent[]`.
- No public `events[]` field appears on any response.
- No `clientRequestId` in any response DTO.
- `apps/api` unit: `event-emission` → 503 with the budget still reconciled; existing
  `apps/api/test/live-run-*.postgres.integration.test.ts` pass unchanged (the no-duplicate-paid-execution
  regression).

---

## 10. Verification commands

Focused per phase — not the full workspace suite on every iteration.

```bash
# no database needed
pnpm --filter @opspilot/database run typecheck
pnpm --filter @opspilot/agent-runtime run test
pnpm --filter @opspilot/database run test

# migration validation (requires local Postgres)
pnpm infra:up && pnpm db:test:ensure
pnpm db:migrate:test
pnpm db:migrate:status
pnpm db:migrate:drift            # expect exit 0
pnpm --filter @opspilot/database run test:integration

# hygiene before committing
git diff --check
```

Full sweep once, at the end of phase 4 and again before opening the PR:
`pnpm -r run typecheck && pnpm -r run test && pnpm -r run build && pnpm test:integration:sequential`.

---

## 11. Risks and open questions

- **Phase 4 is a large commit by design.** That is the cost of not shipping a half-converted production
  path. Mitigation: phases 1–3 land everything that *can* be isolated, so phase 4 is wiring plus the
  finalize conversion rather than new mechanism design. The fallback dormant-path strategy is written down
  in §8 if review prefers smaller pieces.
- **The all-12 unique index is current-runtime-specific.** Lifting V1's one-tool or one-retrieval bound
  requires a coordinated migration that replaces or narrows it, alongside the #36 contract change that
  permits those streams. This is accepted deliberately rather than weakening today's correctness.
- **The `event-emission` failure mode makes orphaned `RUNNING` rows more likely** — ~8 write points per run
  instead of 1. The rows are more *useful* than before (real partial progress), but there is still no
  reaper. Recommend noting the increased exposure in `docs/11` §10 rather than growing #37 into a recovery
  milestone.
- **Reducer-in-transaction adds a hard failure mode for emitter bugs.** That is the intent — a malformed
  stream fails at write time instead of at read time in front of a user during an incident — but it means
  an emission-ordering defect surfaces as a run that cannot finalize. Phase 4's orchestrator tests are what
  keep this from reaching production.
- **The two-channel orchestrator design is a small but permanent maintenance burden.** Every new event
  type added in a future contract version needs a conscious decision about whether it has a legacy
  counterpart and, if so, at exactly which point the legacy push belongs — it does not fall out
  automatically from adding a canonical emission. Worth a short code comment at the top of the orchestrator
  pointing future contributors at §5 of this plan (or its eventual doc home) rather than re-deriving the
  rule.
- **The `TOOL_REQUESTED` API-trace content divergence needs a line in `docs/12-agent-run-api.md`.** It is a
  real, intentional behavior change for two specific failure codes and deserves to be documented where API
  consumers would look, not only in this plan and in `docs/16`.
- **`apps/web`'s `TraceTimeline` is untested against a partial trace, and now against a
  `TOOL_NOT_FOUND`/`TOOL_INPUT_INVALID` trace containing `TOOL_REQUESTED` with no matching completion.**
  The projection guarantees only element types it already handles; a lone `TOOL_REQUESTED` with no
  `TOOL_COMPLETED`/`TOOL_FAILED` pair is new content shape, not just new timing. #38 owns proper
  consumption; worth a manual check that this renders sanely, not new frontend tests here.
- **Open question — revise `docs/11-agent-run-persistence.md` in place or supersede it?** Its §5 and §9
  describe persist-after as the shipped design and will be materially wrong after this issue. Recommend
  revising in place with a dated note, matching how §1 was amended when `apps/api` landed.
- **Open question — should the reducer-rejection log carry the offending sequence number?** It is known
  inside the transaction and would make emitter defects far cheaper to diagnose. It is not
  provider-controlled, so it is safe to log. Cheap to add; genuinely optional.

---

## 12. Branch and commit strategy

Branch `feat/37-incremental-event-persistence` off `main`. One commit per phase in §8, in that order, each
independently typechecking and leaving the current execution path operational — the migration lands before
anything reads the wider union, the validated repository APIs land inert before anything calls them, and
the production switchover happens in exactly one atomic commit. Conventional commits matching repo history
(`feat(database):`, `feat(agent-runtime):`, `feat(api):`, `docs:`). One PR into `main` referencing #37,
with the phase list as the description, and the transactional reducer gate, the all-12 replay policy, and
the two-channel orchestrator design called out as the correctness argument. No temporary review artifacts
committed.
