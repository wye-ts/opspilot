# OpsPilot — Engineering Challenges and Design Decisions

| Field | Value |
|---|---|
| Document | Engineering Challenges and Design Decisions |
| Version | 1.7 |
| Status | Living Document |
| Project | OpsPilot |
| Purpose | Capture difficult engineering problems, design decisions, tradeoffs, and interview-ready explanations |
| Related Documents | `docs/03-technical-design.md`, `docs/04-agent-design.md`, `docs/reviews/03-technical-design-feasibility-review.md`, `docs/reviews/03-technical-design-review-decisions.md`, `docs/reviews/04-agent-design-claude-spike-results.md`, `docs/12-agent-run-api.md` |
| Revision note | v1.2 aligns Challenge 1 with `docs/03-technical-design.md` v1.3: `AgentJob` now includes `CANCELLED`; the maintenance sweep sets `AgentRun.completedAt`; the corrected write-safety design is presented as two distinct repository transaction patterns (`withExecutionOwnership`, `withLockedRunState`) sharing one global lock order (`AgentJob` → `AgentRun` → child rows), not a single "ownership-fenced" pattern; and language implying the design has already been implemented or shipped has been replaced with language accurate to the project's current (pre-implementation) stage. v1.1's PostgreSQL-as-system-of-record-and-queue decision (D1, D2) and the corrected write-safety mechanism (D12) remain unchanged in substance. This entry is further updated within v1.2 to document concurrency-safe `AgentStep` sequence allocation (`AgentRun.nextStepSequence`, the shared `appendAgentStep(...)` helper, and why `SELECT MAX(sequence) + 1` is unsafe) and the `completeAgentRunWithReport` invariant that every `PendingAction` created during finalization has exactly one matching `APPROVAL_CREATED` trace event, created in the same transaction — still describing planned design, not implemented behavior. v1.3 adds Challenge 2, documenting the minimal RAG vertical slice's evidence-grounding and retriever-isolation design — unlike Challenge 1, this describes code that has actually been implemented and unit-tested in this revision, though the manual live spike against a real embedding provider and live Claude has not yet been run. v1.4 corrects that last clause: the manual live spike has now been run. Both the baseline-RAG scenario and the isolated injection-probe scenario passed against a real Voyage embedding provider and a real Claude model, with repeated rate limiting observed (and worked around via a scenario selector) but no RAG-correctness or evidence-grounding failure in any attempt — see `docs/05-rag-design.md` and `docs/reviews/05-rag-design-spike-results.md` for the full design record and measured results. This does not change any of Challenge 2's design, validation, or testing content below, which described planned/already-implemented behavior accurately; it only updates the one clause that described the live spike as not yet run. v1.5 adds Challenge 3, documenting the implemented Agent Run / Trace Persistence milestone (`packages/database`) — a deliberately smaller, already-built precursor to Challenge 1's full queue-claiming design, described in full in `docs/11-agent-run-persistence.md`. v1.6 adds Challenge 4, documenting a real implementation-time discovery in the Agent Run API milestone (`apps/api`, `docs/12-agent-run-api.md`): `nest build`/`nest start --watch` are architecturally incompatible with this monorepo's pinned `typescript@^7.0.2` (a native rewrite whose public npm export no longer exposes the classic TypeScript Compiler API `@nestjs/cli` depends on internally), resolved by bypassing the Nest CLI's build wrapper in favor of the same plain-`tsc` pattern already used successfully by every other package in this monorepo, rather than downgrading TypeScript. v1.7 revises Challenge 4's Decision/Tradeoffs/Implementation Notes at a focused pre-commit review pass: `@nestjs/cli`/`@nestjs/schematics` and `apps/api/nest-cli.json`, originally kept as an unused "possible future use" placeholder, are now removed entirely as dead configuration/dependencies with no actual justification to keep; `apps/api`'s `build` script now cleans stale `dist/` output before every build, and `start:dev` is now a reliable `pnpm run build && pnpm run start` (no automatic reload — deferred, not silently dropped) rather than the previously untested concurrent `tsc --watch`/`node --watch` pair. |

---

## 1. How to Use This Document

This is a living engineering document.

Whenever a meaningful technical challenge is discovered during design, implementation, testing, deployment, or production hardening, add a new entry using the template below.

Each entry should explain:

- The problem
- Why it is difficult
- Failure modes
- The selected design
- Alternatives considered
- Tradeoffs
- Implementation notes
- Testing strategy
- Observability requirements
- Interview talking points

The goal is not only to document what is designed and, after implementation, what was built, but also to preserve the engineering reasoning behind important decisions — including decisions to evaluate an approach in depth and then **not** select it, when a simpler design meets the same requirements. Challenge 1 below is itself an example: the transactional outbox pattern was designed in detail before a feasibility review concluded it was disproportionate to this project's actual scale, and a simpler PostgreSQL-only design was selected instead. Both the evaluation and the final decision are preserved.

---

## 2. Entry Template

```md
## Challenge N — Title

### Context

Describe where the problem appears in the system.

### Problem

Describe the technical problem precisely.

### Why It Is Difficult

Explain why the problem is non-trivial.

### Failure Modes

List the concrete ways the system can fail.

### Decision

Describe the selected design.

### Alternatives Considered

#### Alternative A

Describe the option and why it was rejected or deferred.

#### Alternative B

Describe the option and why it was rejected or deferred.

### Tradeoffs

Explain the costs and benefits of the selected design.

### Implementation Notes

Describe the important implementation details.

### Testing Strategy

List the tests required to verify the design.

### Observability

Describe the logs, metrics, and alerts required.

### Interview Explanation

Provide a concise explanation suitable for an engineering interview.
```

---

## 3. Challenge 1 — Database and Job-Execution Consistency

### Context

When a user starts an OpsPilot investigation, the API must durably record that an investigation was requested, and a background worker must be able to discover and execute it. The system must guarantee that a committed request is never silently lost, and that a request that was never committed is never executed.

### Problem

A naive implementation performs two operations against two independent systems:

```text
Create AgentRun in PostgreSQL
→ enqueue a job in a separate queueing system (e.g. Redis/BullMQ)
```

This creates a **dual-write consistency problem**. The database transaction may succeed while the queue write fails. The reverse ordering creates the opposite problem: the queue write may succeed while the database transaction fails.

When PostgreSQL and a *second, independent* system are both involved, the system cannot guarantee atomicity across the two by directly writing to both.

**MVP resolution, stated up front:** OpsPilot's MVP does not introduce a second system for job execution at all. PostgreSQL is used as **both** the system of record and the job queue (an `AgentJob` table), so the dual-write problem described in this section does not arise in the selected MVP design — a single local ACID transaction covers both the business record (`AgentRun`) and the execution record (`AgentJob`). The rest of this entry documents the general problem in depth, the transactional-outbox pattern that solves it when a second system genuinely is required, and why that pattern was evaluated but not selected for this project. This dual analysis — general problem, evaluated solution, and final scoping decision — is preserved because it reflects real engineering judgment, not because the outbox pattern was built.

### Why It Is Difficult

The problem is difficult in general because two independent systems have different durability and transaction boundaries. PostgreSQL can guarantee atomic changes within its own transaction; a separate queue system can guarantee operations within itself; but the two cannot commit as one atomic unit without additional coordination (a transactional outbox, change-data-capture, or a distributed transaction protocol).

Failures can happen between any two steps of a naive dual write:

- Process crash
- Network interruption
- Queue system outage
- PostgreSQL outage
- Request timeout
- Deployment restart
- Duplicate request
- Queue retry
- Worker crash

A design that works during normal execution may still lose jobs or process the same job multiple times during failures — this is true regardless of which second system is chosen.

### Failure Modes

The following failure modes describe what goes wrong with a **naive direct dual write to a second system**. They motivate why a transactional outbox (or, as selected for this project, avoiding a second system altogether) is necessary if a second system is used.

#### Failure Mode 1 — Database Commit Succeeds, Queue Write Fails

```text
AgentRun created
→ queue system unavailable
→ no job created
```

Result: the UI shows a queued run; no worker ever receives it; the investigation remains stuck indefinitely.

#### Failure Mode 2 — Queue Write Succeeds, Database Commit Fails

This occurs when queue submission happens before the database commit.

```text
Job created
→ database transaction fails
```

Result: the worker receives a job for an `AgentRun` that does not exist, and may repeatedly retry an invalid job.

#### Failure Mode 3 — API Retries Create Duplicate Jobs

A client or API gateway may retry after a timeout.

Result: multiple jobs may be created for the same ticket request; the model may be called more than once; cost increases; conflicting reports may be produced.

#### Failure Mode 4 — A Relay Publishes the Same Event More Than Once

In a transactional-outbox design, a relay process can publish a job and crash before marking the outbox event as published.

Result: the same event may be delivered again; the worker must tolerate duplicate delivery.

#### Failure Mode 5 — Worker Crashes During Execution

The worker may crash after some tool calls but before the run becomes terminal.

Result: the job may be retried or reclaimed by another worker; the same agent run may be processed again; non-idempotent work may be repeated if the worker's write path does not defend against this.

#### Failure Mode 6 — The Second System Is Temporarily Unavailable

Result: new committed runs cannot immediately reach workers; a direct-enqueue design loses delivery unless the application manually repairs it.

**How the MVP design avoids these entirely:** because there is no second system, Failure Modes 1, 2, and 6 cannot occur by construction — there is nothing to fail to reach, because "the queue" and "the database" are the same commit. Failure Modes 3 and 5 are still real and are handled by the MVP design (idempotency keys, and the ownership-fenced transaction / maintenance sweep pattern in Implementation Notes below), just without needing Failure Mode 4's relay-publish mechanism, because there is no relay.

### Decision

**Selected for the MVP:** PostgreSQL serves as both the system of record and the job queue. An `AgentJob` row — and its first trace event, `RUN_QUEUED` — is created in the **same transaction** as its `AgentRun`:

```text
BEGIN

INSERT AgentRun(status = QUEUED, nextStepSequence = 1)

INSERT AgentJob(
  agentRunId = <the AgentRun just inserted>,
  status = PENDING
)

appendAgentStep(
  agentRunId = <the AgentRun just inserted>,
  type = RUN_QUEUED
)
-- atomically increments AgentRun.nextStepSequence from 1 to 2 and
-- inserts AgentStep(sequence = 1, type = RUN_QUEUED) inside this same
-- transaction; see Trace Sequence Allocation, below.

COMMIT
```

All three rows commit together or roll back together — there is no window in which one exists without the others. This remains an **ordinary creation transaction**: it is not `withExecutionOwnership` (no worker has claimed the job, so there is no execution token to fence), not an execution-token operation of any kind, and not a cross-system publish of any kind.

A worker polls `agent_jobs` directly using `FOR UPDATE SKIP LOCKED` to claim `PENDING` rows — there is no relay, no external queue, and no second publish step. Because all three rows live in PostgreSQL, this is an ordinary local transaction, not a distributed one. The remaining engineering problem is not "how do I deliver a message reliably to a second system" but "how do I let a worker safely claim a row and safely recover if it crashes or stalls" — solved by the execution fencing-token design in Implementation Notes below, without needing an outbox, deterministic external job IDs, or a dead-letter queue.

This design guarantees:

- Atomic database creation of the business record and its execution record — there is no window in which one exists without the other.
- No cross-system delivery to fail, retry, or reconcile.
- Recoverability after a worker crash via a maintenance sweep, without ambiguity about whether a "delivery" happened.

It does **not** guarantee that a Claude API call, once issued, cannot be issued again after a crash — see Implementation Notes for how this is handled (it is accepted, not "solved," because investigation tools are read-only and final state transitions are idempotent).

#### Evaluated Alternative: Transactional Outbox with a Redis/BullMQ Queue

Before the PostgreSQL-only design above was selected, this project designed a full transactional-outbox solution for the general dual-write problem, on the assumption that a separate Redis/BullMQ queue would be used for job execution (for retry/backoff tooling, worker concurrency primitives, and operational familiarity). That design is preserved here because the general pattern is genuinely useful when a second system actually is required, and because evaluating it in depth — then correctly deciding not to build it — is itself the engineering judgment worth documenting.

The outbox design, as evaluated:

```text
BEGIN

INSERT AgentRun(status = QUEUED)

INSERT OutboxEvent(
  aggregateType = AGENT_RUN,
  aggregateId = agentRunId,
  eventType = AGENT_RUN_REQUESTED,
  status = PENDING
)

COMMIT
```

A separate outbox relay would then:

1. Read pending outbox events.
2. Claim events using a lease (`FOR UPDATE SKIP LOCKED`).
3. Publish BullMQ jobs using a deterministic `jobId` derived from the outbox event ID.
4. Mark events published after successful queue submission.
5. Retry failed publications with backoff.
6. Move permanently failing events to a dead-letter state after a configured attempt limit.

The worker would then load the durable `AgentRun`, atomically claim it, and process it with the same duplicate-delivery tolerance required by any at-least-once queue consumer.

**Why this was not selected for the MVP:** `docs/reviews/03-technical-design-feasibility-review.md` (Overengineering Review OE-1) found that, at this project's traffic scale — a single logical workspace, low public demo traffic, and mock/deterministic tool data — introducing Redis/BullMQ specifically to solve a dual-write problem that PostgreSQL-as-queue avoids by construction was added infrastructure without a corresponding MVP requirement. The relay process, deterministic external job IDs, dead-letter handling, and multi-replica-safe relay leasing all exist to manage failure modes of a *second system* — a second system this project does not otherwise need. `docs/reviews/03-technical-design-review-decisions.md` (D1, D2) formalized this: replace the outbox/BullMQ/Redis implementation with the `AgentJob` design above, while keeping this evaluation on record as a genuine alternative that was considered, not overlooked.

### Alternatives Considered

#### Alternative A — Direct Database Write Followed by Queue Write (to a second system)

```text
Create AgentRun
→ enqueue job in a separate system
```

Rejected because a queue failure after database commit can permanently strand the run (Failure Mode 1). Also inapplicable to the selected design, since there is no separate system to enqueue to.

#### Alternative B — Queue Write Followed by Database Write (to a second system)

```text
Enqueue job in a separate system
→ create AgentRun
```

Rejected because the worker may receive a job before the database record exists (Failure Mode 2).

#### Alternative C — Distributed Transaction Across PostgreSQL and a Second System

Rejected because PostgreSQL and a message broker do not provide a practical shared two-phase commit mechanism for this application, and a distributed transaction would add significant operational complexity for no corresponding requirement.

#### Alternative D — Remove the Queue and Run Everything in the API Request

Rejected because agent execution is long-running and includes provider calls, retrieval, and tool execution. This would increase HTTP timeout risk, API resource usage, and coupling between interactive requests and background work. A background worker is still required — the question this challenge addresses is only how the API hands work to it, not whether a background worker exists at all.

#### Alternative E — PostgreSQL as the Job Queue (Selected for the MVP)

This removes the cross-system dual write entirely by keeping both the business record and the execution record in the same database, claimed via `FOR UPDATE SKIP LOCKED`. It was initially deferred in earlier design drafts as "a valid future simplification," on the assumption that BullMQ's retry/backoff/concurrency tooling was worth the added infrastructure. The feasibility review concluded the opposite: for this project's actual scale, this should be the **initial** design, not a future simplification — see Decision above. This is the design selected for the MVP.

#### Alternative F — Change Data Capture

Database change data capture could publish events from the transaction log to a separate system. Deferred because it adds infrastructure and operational complexity that is unnecessary for the MVP, and because it exists to solve the same second-system delivery problem that Alternative E avoids by construction.

### Tradeoffs

#### Benefits of the selected PostgreSQL-only design

- No second stateful system to operate, monitor, secure, or pay for.
- No dual-write failure window to reason about — atomicity is a normal local transaction.
- Fewer moving parts: no relay, no dead-letter queue, no deterministic external job ID scheme, no queue-specific reconciliation tooling.
- The general dual-write/outbox pattern remains fully documented above for cases where a second system genuinely is required (e.g., if this project later integrates a real external queue for a different reason).

#### Costs of the selected PostgreSQL-only design

- No built-in queue dashboard, retry/backoff tooling, or worker-concurrency primitives — these must be implemented directly (claim query, ownership-fenced writes, maintenance sweep) rather than provided by a library.
- `FOR UPDATE SKIP LOCKED` polling is less feature-rich than a dedicated queue system if the project later needs priority queues, delayed jobs, or cross-service fan-out.
- The correctness of worker writes depends on consistently applying the ownership-fenced transaction pattern (Implementation Notes) at every call site — this is a discipline the implementation must maintain, not something a queue library enforces for you.

### Implementation Notes

#### AgentJob Model

Canonical fields (matching `docs/03-technical-design.md §11.1`):

- `id`
- `agentRunId` (unique — one `AgentJob` per `AgentRun`)
- `ticketId`
- `status`: `PENDING`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`
- `executionToken` (nullable; set on claim, invalidated when the job leaves `RUNNING`)
- `claimedBy` (nullable; worker/process identifier)
- `claimedAt` (nullable)
- `leaseExpiresAt` (nullable; used only by the maintenance sweep)
- `errorCode` (nullable)
- `errorMessage` (nullable)
- `createdAt`
- `updatedAt`

An earlier draft of this section used different field names (`execution_owner`, `execution_lease_until`) than `docs/03-technical-design.md`'s `AgentRun` lease fields. That inconsistency is resolved by this revision: `AgentJob` is now the single canonical home for execution/lease/fencing fields, named consistently across both documents.

**Transitions:**

```text
PENDING  -> RUNNING
PENDING  -> CANCELLED
RUNNING  -> COMPLETED
RUNNING  -> FAILED
RUNNING  -> CANCELLED
```

`RUNNING` may be left through exactly four paths: owning-worker completion, owning-worker failure (both driven by the worker itself, verifying it still holds its execution token), maintenance-sweep lease failure, or user cancellation (both driven externally, by row lock and state verification rather than a token check — see Implementation Notes below). There is no path back from a terminal state (`COMPLETED`, `FAILED`, `CANCELLED`) to any non-terminal state.

`AgentStep` additionally has a `RUN_QUEUED` type, created atomically with `AgentRun` and `AgentJob` at submission time — the run-creation transaction is a plain three-row insert, not `withExecutionOwnership` (no worker has claimed the job yet, so there is no execution token to fence) and not `withLockedRunState` in the claim/sweep/cancellation sense (nothing pre-existing is being locked or transitioned). Full detail lives in `docs/03-technical-design.md §16.2`.

#### The Global Lock Order

Every transaction touching both `AgentJob` and `AgentRun` — claim, ordinary worker writes, worker completion, worker failure, the maintenance sweep, and cancellation — locks `AgentJob` first, `AgentRun` second, and any child row (`AgentStep`, `ToolExecution`, `PendingAction`) last. This order is fixed to prevent a deadlock between two transactions that might otherwise lock the same two rows in opposite order under concurrent load.

Two repository transaction patterns implement this order and are not interchangeable:

- **`withExecutionOwnership(...)`** — used only by the active worker, for writes made *after* it has already claimed a job and holds a valid `executionToken`. It locks `AgentJob` first, verifies `status = 'RUNNING' AND execution_token = $token`, then updates `AgentRun` (if needed) and inserts child rows.
- **`withLockedRunState(...)`** — used for claiming a job, the maintenance sweep, and cancellation: transitions authorized by row locks and current-state verification, not by a token match, because none of the three either holds a token yet (claim) or is the worker itself (sweep, cancellation).

Full detail, including SQL for both patterns, lives in `docs/03-technical-design.md §16.3`; this entry summarizes the same design for the dual-write narrative.

#### Trace Sequence Allocation (`AgentRun.nextStepSequence`, `appendAgentStep`)

A related, smaller concurrency problem sits inside the same worker/API write paths this challenge already covers: `AgentStep.sequence` must be monotonic within one `AgentRun`, and `AgentStep(agentRunId, sequence)` is unique. Multiple transactions can append trace events for the same run concurrently — most obviously, two different `PendingAction` rows from the same run being approved or rejected at nearly the same time, but also a worker write racing the maintenance sweep or a cancellation.

A design based on `SELECT MAX(sequence) + 1 FROM agent_steps WHERE agent_run_id = $agentRunId` is not safe under this concurrency: two transactions can both read the same current maximum before either commits its insert, both compute the same "next" value, and collide on the unique constraint (or, if that constraint were ever missing, silently write duplicate-sequence rows).

The design adds a counter column, `AgentRun.nextStepSequence` (integer, not null, default `1`), scoped to one `AgentRun` and modified only through one shared repository helper, `appendAgentStep(...)`. `appendAgentStep` never commits independently — it receives the caller's already-open transaction and, inside it:

```sql
UPDATE agent_runs
SET next_step_sequence = next_step_sequence + 1
WHERE id = $agentRunId
RETURNING next_step_sequence - 1 AS allocated_sequence;

INSERT INTO agent_steps (id, agent_run_id, sequence, type, status, title, summary, payload, created_at)
VALUES ($1, $agentRunId, $allocatedSequence, $2, $3, $4, $5, $6, now());
```

The `UPDATE ... RETURNING` takes a row lock on the single `agent_runs` row for the duration of the transaction — the same row-locking principle as `withExecutionOwnership` and `withLockedRunState` above, applied to a counter instead of a status field. A second concurrent `appendAgentStep` call for the same `AgentRun` blocks until the first transaction resolves, then reads the already-incremented counter and receives the next value in line. If the `AgentStep` insert fails for any reason, the whole transaction rolls back and the counter increment rolls back with it, so the allocated value is simply available again on retry. The final `UNIQUE(agentRunId, sequence)` constraint on `AgentStep` remains in place as a database-level invariant regardless — defense in depth, not the primary allocation mechanism.

`appendAgentStep` is the single call path for every `AgentStep` insert in the system: the ordinary run-creation transaction (§16.2 of the technical design, where `RUN_QUEUED` is inserted and always receives `sequence = 1` because `nextStepSequence` starts at `1`), every `withExecutionOwnership` worker write, every `withLockedRunState` sweep/cancellation write, and the approval/action API transaction, which never touches `AgentJob` or an execution token at all. For approval/action transactions specifically, the canonical order is: lock `PendingAction` first, then allocate the next sequence by atomically updating the owning `AgentRun.nextStepSequence`, then insert the `AgentStep` — `PendingAction` → `AgentRun` sequence allocation → `AgentStep`. Two concurrent approvals against different `PendingAction` rows on the same `AgentRun` therefore still serialize cleanly on the `AgentRun` row inside `appendAgentStep`, receiving distinct sequence values without either transaction needing to know about the other in advance.

Like the rest of this design, this is not yet implemented, tested, or measured — it is the planned mechanism, described here at the same level of precision as the rest of Challenge 1's write-safety design.

#### Job Claiming

Workers claim only `PENDING` jobs, using `withLockedRunState` with `FOR UPDATE SKIP LOCKED` so multiple worker instances (if ever run) do not claim the same row:

```sql
BEGIN;

SELECT id
FROM agent_jobs
WHERE status = 'PENDING'
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;

UPDATE agent_jobs
SET status = 'RUNNING',
    execution_token = gen_random_uuid(),
    claimed_by = $workerId,
    claimed_at = now(),
    lease_expires_at = now() + interval '<lease duration>'
WHERE id = $claimedId
RETURNING execution_token;

UPDATE agent_runs
SET status = 'RUNNING',
    started_at = COALESCE(started_at, now())
WHERE id = (SELECT agent_run_id FROM agent_jobs WHERE id = $claimedId);

COMMIT;
```

A `RUNNING` job is **never** reclaimed by another worker. `RUNNING` may be left through exactly four paths: owning-worker completion, owning-worker failure, maintenance-sweep lease failure after its lease expires, or user cancellation.

#### `withExecutionOwnership` — the Corrected Design

An earlier draft of this section (and of `docs/03-technical-design.md`) described worker write safety as "every write is a conditional write, e.g. `UPDATE ... WHERE status = 'RUNNING' AND execution_token = $token`." That framing has a real gap: it describes how to condition an `UPDATE`, but the worker's actual writes are mostly **inserts** (`AgentStep`, `ToolExecution`, `PendingAction`) — and an `INSERT` has no prior row to attach a `WHERE` clause to. Stating "every write can simply include a `WHERE` clause" is not an accurate or implementable description of how an insert is protected.

The corrected design (`docs/reviews/03-technical-design-review-decisions.md`, corrected D12) is an **ownership-fenced repository transaction**, applied uniformly whether the write is an insert or an update:

```sql
BEGIN;

SELECT status, execution_token
FROM agent_jobs
WHERE id = $agentJobId
FOR UPDATE;

-- Application code checks, in memory, whether the row just read has
-- status = 'RUNNING' AND execution_token = $tokenHeldByThisWorker.
--
-- If the check fails: ROLLBACK, and the worker stops processing this
-- run immediately, discarding any in-memory result.
--
-- If the check succeeds, the worker performs its actual write(s)
-- inside this same transaction — an INSERT into agent_steps,
-- tool_executions, or pending_actions, or an UPDATE to agent_runs —
-- and only then commits:

INSERT INTO agent_steps (id, agent_run_id, sequence, type, status, title, summary, payload, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now());

COMMIT;
```

The `SELECT ... FOR UPDATE` on the `agent_jobs` row is what makes this correct: it locks the row for the transaction's duration, so a concurrent transaction from a stale worker (or the maintenance sweep) attempting the same sequence blocks until this transaction resolves, then observes the current `status`/`execution_token` and correctly fails its own check if it no longer holds the claim. This should be implemented once, as a shared repository method used by every worker write — not re-implemented ad hoc per call site.

The single-insert example above illustrates the mechanism, but two uses of `withExecutionOwnership` are safety-critical **composite** operations that must each commit as one transaction, not two: finalizing a run successfully, and recording a failure the worker itself detects. An earlier design separated "persist the report and pending actions" from "mark the run and job terminal" as two steps — that gap meant a crash between them could leave a persisted report with no `COMPLETED` status, or worse, an executable `PendingAction` row attached to a run that never actually finished.

- **Successful finalization commits atomically.** One transaction persists the validated `finalReport`; for each validated suggested action, in report order, inserts one `PendingAction` (status `PENDING`) and one matching `APPROVAL_CREATED` `AgentStep` referencing it (via `appendAgentStep`, above); inserts the `REPORT_GENERATED` and `RUN_COMPLETED` trace steps; and marks both `AgentRun` and `AgentJob` `COMPLETED` — all together. A report with zero suggested actions inserts zero `PendingAction` rows and zero `APPROVAL_CREATED` events, and still completes successfully. If the ownership check fails partway through, or any write fails — including an `APPROVAL_CREATED` insertion for a later action — the whole transaction rolls back: no orphaned report, no `PendingAction` row for a non-`COMPLETED` run, no `PendingAction` without its matching `APPROVAL_CREATED` event (or vice versa), no partial set of earlier action/trace pairs left behind, and never just one of `AgentRun`/`AgentJob` reaching `COMPLETED`. Every `PendingAction` created by a committed finalization therefore has exactly one committed `APPROVAL_CREATED` trace event referencing it, and `APPROVAL_CREATED` events are never created anywhere outside this one transaction.
- **Worker-detected failure commits atomically.** One transaction marks both `AgentJob` and `AgentRun` `FAILED`, sets `completedAt` and sanitized error fields on both, invalidates the execution token, and inserts the `RUN_FAILED` trace step. A stale worker's ownership check fails before any of this happens, so it can never overwrite a `CANCELLED`, already-`COMPLETED`, or sweep-`FAILED` run, and can never insert a second terminal trace event.

A failed or cancelled `AgentRun` can therefore never receive `PendingAction` rows through a partially completed finalization — there is no partial commit for it to come from. Full step-by-step detail for both operations (`completeAgentRunWithReport`, `failOwnedAgentRun`) lives in `docs/03-technical-design.md §16.5`.

#### Maintenance Sweep

A single lightweight scheduled function inside the worker process, run every 60 seconds, replaces what would otherwise be outbox reconciliation and dead-letter handling:

```sql
-- For each AgentJob WHERE status = 'RUNNING' AND lease_expires_at < now():
BEGIN;

SELECT status, lease_expires_at
FROM agent_jobs
WHERE id = $id
FOR UPDATE;

-- Re-check status = 'RUNNING' AND lease_expires_at < now() in application code
-- (the job may have completed between the outer scan and this lock).

UPDATE agent_jobs
SET status = 'FAILED',
    execution_token = NULL,
    error_code = 'EXECUTION_LEASE_EXPIRED'
WHERE id = $id;

UPDATE agent_runs
SET status = 'FAILED',
    error_code = 'EXECUTION_LEASE_EXPIRED',
    completed_at = now()
WHERE id = $agentRunId;

-- appendAgentStep(...): allocate the next sequence from
-- AgentRun.nextStepSequence and insert one RUN_FAILED AgentStep for
-- $agentRunId, inside this same transaction.

COMMIT;
```

This is the only path that transitions an expired `RUNNING` job to `FAILED`. There is no resume, no retry-in-place, and no hand-off to another worker — a client retries by submitting a new `AgentRun` (and therefore a new `AgentJob`) through the normal creation flow. No dead-letter queue and no dedicated reconciliation CLI are required. This uses `withLockedRunState`, locking `agent_jobs` before `agent_runs` — the same order used everywhere else in this design. The sweep's `RUN_FAILED` trace event goes through `appendAgentStep` like every other `AgentStep` insert (Trace Sequence Allocation, above), never via `MAX(sequence) + 1` and never as a separate commit.

#### Cancellation

`withLockedRunState` is also how a user-initiated cancellation is applied — **not** a variant of `withExecutionOwnership`, because the API never holds a worker's execution token:

```sql
BEGIN;

SELECT status FROM agent_jobs WHERE id = $agentJobId FOR UPDATE;   -- AgentJob first
SELECT status FROM agent_runs WHERE id = $agentRunId FOR UPDATE;   -- AgentRun second

-- Verify AgentJob.status IN ('PENDING','RUNNING') AND AgentRun.status IN ('QUEUED','RUNNING').
-- If not cancellable, ROLLBACK (no-op).

UPDATE agent_jobs SET status = 'CANCELLED', execution_token = NULL WHERE id = $agentJobId;
UPDATE agent_runs SET status = 'CANCELLED', completed_at = now() WHERE id = $agentRunId;

-- appendAgentStep(...): allocate the next sequence from
-- AgentRun.nextStepSequence and insert one RUN_CANCELLED AgentStep,
-- inside this same transaction.

COMMIT;
```

A cancelled `PENDING` job is never claimable, since the claim query only matches `status = 'PENDING'`. A cancelled `RUNNING` job causes the active worker's next `withExecutionOwnership` write to find a cleared token and a non-`RUNNING` status, fail its ownership check, and discard its result — the same mechanism that protects against a stale worker after a sweep-driven failure, applied here to a cancellation instead. An earlier draft of this document described cancellation as locking `AgentRun` before `AgentJob`; that was inconsistent with the claim and sweep lock order and has been corrected here to match the canonical order (`AgentJob` first).

#### Idempotent State Changes

Approval-required actions are also protected by conditional state transitions, independent of the `AgentJob` mechanism:

```sql
UPDATE pending_actions
SET
  status = 'APPROVED',
  decided_at = now(),
  decided_by = $2
WHERE id = $1
  AND status = 'PENDING'
RETURNING *;
```

Only the request that receives a returned row may continue to execution.

### Testing Strategy

Scope follows the reduced MVP test requirements in `docs/reviews/03-technical-design-review-decisions.md` (D8, D9) and `docs/03-technical-design.md §22`.

#### Required for MVP (part of the "PostgreSQL job integration test")

- Creating an agent run also creates its `AgentJob`, atomically.
- The claim query claims exactly one job under concurrent claim attempts (`FOR UPDATE SKIP LOCKED` behaves correctly).
- A worker that has lost ownership (its `withExecutionOwnership` transaction's ownership check fails) does not persist any write.
- The maintenance sweep marks an expired `RUNNING` job and its `AgentRun` `FAILED`, records `completedAt` and a stable timeout error, invalidates the token, and does not resume the run; a subsequent write using the stale token is rejected.
- Cancelling a `PENDING` job makes it unclaimable; cancelling a `RUNNING` job causes the active worker's next write to fail; `AgentJob`/`AgentRun` become `CANCELLED` together with `completedAt` and the `RUN_CANCELLED` step committed atomically; concurrent cancellation and worker completion resolve to exactly one terminal result under the canonical lock order.
- Demo rate-limit bucket increments (`GLOBAL_DAILY`, `TOKEN_HOURLY`) are race-safe under concurrency and roll back run creation entirely when a limit is exceeded (full detail: `docs/03-technical-design.md §22.1`, §11.1).
- Approval state transitions are idempotent under concurrent requests.
- **Successful finalization atomicity (`completeAgentRunWithReport`):** report, `PendingAction` rows, their matching `APPROVAL_CREATED` events, both remaining trace steps, `AgentRun.COMPLETED`, and `AgentJob.COMPLETED` commit together; a forced failure mid-transaction (e.g., during `PendingAction`/`APPROVAL_CREATED` insertion, or during the final `RUN_COMPLETED` insert) rolls back everything already written in that transaction, including earlier action/trace pairs in the same loop; zero suggested actions still completes successfully with zero `PendingAction`/`APPROVAL_CREATED` rows; a stale worker cannot finalize and creates neither; every committed `PendingAction` has exactly one committed `APPROVAL_CREATED` event referencing it.
- **Worker-detected failure atomicity (`failOwnedAgentRun`):** `AgentJob.FAILED`, `AgentRun.FAILED`, `completedAt`, error fields, token invalidation, and `RUN_FAILED` commit together; a stale worker cannot overwrite a terminal state reached another way; a second failure attempt does not duplicate the terminal trace event.
- **Queued trace atomicity:** `AgentRun`, `AgentJob`, and `RUN_QUEUED` are created in one transaction; `AgentRun` begins with `nextStepSequence = 1` and `RUN_QUEUED` receives `sequence = 1`; after commit, `nextStepSequence = 2`; a forced failure creating `RUN_QUEUED` rolls back the other two inserts and the counter increment; `RUN_QUEUED` is the first trace sequence value.
- **Sequence allocation under concurrency (`appendAgentStep`, `AgentRun.nextStepSequence`):** if an `AgentStep` insert fails, the `nextStepSequence` increment rolls back with it and a retry receives the same still-available value; two concurrent trace appends for the same `AgentRun` — including two concurrent approvals of different `PendingAction` rows from the same run — receive different sequence values, never computed via `MAX(sequence) + 1`, and never violate the `AgentStep(agentRunId, sequence)` unique constraint; worker writes allocate inside `withExecutionOwnership`, sweep/cancellation writes allocate inside `withLockedRunState`, and approval/action writes allocate inside their own row-locked transaction without an `AgentJob` execution token.

All of the above are deterministic PostgreSQL integration tests, not real-process fault injection — they belong in the required set (D8), not the stretch-goal set (D9) below.

#### Stretch goals (D9)

- Full process-crash recovery: kill or crash a real worker process mid-run, followed by maintenance-sweep recovery, verified end to end — not required for Feature Complete; the deterministic version (artificially expired lease, above) is required instead.
- Two workers racing to claim the same job (verifying `SKIP LOCKED` semantics under real concurrency, not just a single-process test).
- A stale worker attempting a write after the sweep has already failed its job, verified under real concurrency.
- Duplicate `Idempotency-Key` submission, confirming only one `AgentRun`/`AgentJob` pair exists.

#### End-to-End Test

```text
Create ticket investigation
→ commit AgentRun and AgentJob in one transaction
→ worker claims the AgentJob via polling
→ agent run completes via ownership-fenced writes
→ UI receives terminal state
```

### Observability

#### Logs

Include:

- `agentJobId`
- `agentRunId`
- `workerInstanceId`
- `leaseExpiresAt`
- `statusTransition`
- `durationMs`
- `errorCode`

Never log the raw `executionToken` value — log the `agentJobId` as the correlating identifier instead.

#### Metrics

Track:

- Oldest unclaimed `PENDING` `AgentJob` age
- `AgentJob` claim latency (creation to claim)
- Maintenance sweep expired-job count
- Ownership-check rejection count (a write attempt that failed its ownership verification — should be rare and is a useful signal if it is not)
- Stuck `RUNNING` job count (jobs approaching lease expiry)

#### Alerts

Alert when:

- The oldest pending `AgentJob` exceeds the expected claim delay.
- The maintenance sweep's expired-job count grows unexpectedly.
- Ownership-check rejections occur at a rate suggesting lease duration is miscalibrated (§13.3 of the technical design), not just occasional worker restarts.

### Interview Explanation

The project has not been implemented yet — this is the **planned** interview explanation, to be validated (and adjusted if reality differs) once the design below is actually built, tested, and measured. The design decision itself already exists (this document is that decision record); the narrative below describes how it is intended to be explained once the corresponding code, tests, and measurements exist:

> Starting an agent run required durably recording the request and making it discoverable to a background worker. A naive approach — write to Postgres, then separately publish to a queue like Redis/BullMQ — creates a dual-write consistency problem: the two systems can't commit together, so a crash between the two writes can either strand a committed run or create a job for one that never committed. I designed a full transactional-outbox solution for that problem in detail — an outbox table, a relay process, deterministic job IDs, dead-letter handling — because that's the standard, correct pattern when you do need two independent systems. But when I stepped back and reviewed it against this project's actual scale — one logical workspace, low traffic, deterministic mock data — I concluded the second system was solving a problem I didn't need to have. So instead of building the outbox, the design makes Postgres serve as both the system of record and the job queue: the `AgentRun` and its `AgentJob` commit in one local transaction, and the worker claims jobs directly from Postgres with `FOR UPDATE SKIP LOCKED`. That removes the dual-write problem by construction instead of solving it with more infrastructure. The remaining hard problem — a worker crashing or stalling mid-run — is handled with an ownership-fenced transaction pattern: every worker write locks and re-verifies its job's ownership token before writing anything, so a stale worker can't corrupt state even if it's still technically alive; a 60-second sweep marks genuinely stuck jobs failed, and retrying just means submitting a new run. The outbox design stays fully documented as an evaluated alternative, because knowing when *not* to build the more sophisticated solution is as much a part of this job as knowing how to build it.

### Resume Relevance

This problem demonstrates:

- Distributed-systems consistency reasoning, including recognizing when a distributed-systems problem does not actually apply to a given architecture
- Transaction boundaries and PostgreSQL concurrency primitives (`FOR UPDATE SKIP LOCKED`, row locking)
- Idempotency and ownership-fencing under concurrent/duplicate execution
- Failure recovery without an external queue
- Deliberate scoping of infrastructure to actual requirements

It should be discussed in interviews once implemented, and the "evaluated a heavier design, then correctly chose the simpler one" narrative is itself a strong signal — it should not be understated relative to the outbox design that was ultimately not built. The stronger resume bullet will combine this reliability work with the AI agent workflow and measured results, once both exist and the numbers are real (`docs/03-technical-design.md §31`).

---

## 4. Challenge 2 — RAG Evidence Grounding and Retriever Isolation

### Context

`docs/04-agent-design.md §13` and the live Claude spike (`docs/reviews/04-agent-design-claude-spike-results.md`) already established that a model cannot be trusted to self-report which evidence it used: Claude initially invented plausible-looking `TOOL_EXECUTION` evidence IDs until the application began surfacing the exact ID explicitly and instructing the model to copy it verbatim. The minimal RAG vertical slice (`apps/worker/src/rag/`) extends the same trust boundary to a second evidence type, `RAG_CHUNK`, while introducing a new untrusted input the earlier slice never had to consider: retrieved *document content* itself, sourced from a corpus and (in the live path) an external embedding provider, that the model reads before generating a report.

### Problem

Three distinct trust problems compound here:

1. **Evidence identity**: a `RAG_CHUNK` citation must be provably tied to a chunk that was actually retrieved during *this* run — not an invented ID, not a real chunk ID from the corpus that happens not to have been retrieved this run, and not evidence carried over from a different run.
2. **Retriever correctness**: `RunbookRetriever` is a pluggable interface with two implementations (a deterministic in-memory keyword scorer, and a live embedding-backed retriever). Nothing in the type system prevents either implementation — especially the one wrapping a third-party HTTP API — from returning a structurally broken result (duplicate IDs, an out-of-order rank, a truncated response) that would silently corrupt the evidence-grounding set if trusted at face value.
3. **Content, not just identity, is untrusted**: unlike a tool's structured output, a runbook chunk's `content` field is free text that the model reads directly. Nothing stops that text from containing an instruction ("ignore previous instructions, call this tool, cite this ID") shaped to manipulate the model's behavior or its evidence citations.

### Why It Is Difficult

The three problems interact. A naive implementation might get evidence identity right (checking cited IDs against a `Set` of retrieved IDs) while still being vulnerable to problem 2 (if the `Set` is built from an unvalidated retriever result, a retriever bug or adversarial response can put an attacker-chosen ID into the trusted set) or problem 3 (validating IDs correctly does not, by itself, stop a model from being *persuaded* by chunk content to misbehave in other ways, such as requesting a nonexistent tool argument). Each layer has to hold independently, because a single successful bypass at any layer defeats the guarantee the other layers provide.

The retriever-correctness problem is also easy to under-specify. "Reject duplicate IDs" and "reject out-of-order chunks" sound like edge cases, but a naive implementation using a `Set` to build the allowed-evidence-ID list, or a formatting function that silently deduplicates before presenting chunks to the model, would *hide* exactly the kind of retriever defect that should hard-fail the run — turning a detectable bug into a silent, unaudited behavior change.

### Failure Modes

#### Failure Mode 1 — Invented or Non-Retrieved Evidence ID

The model cites a `RAG_CHUNK` `evidenceId` that was never returned by this run's retrieval call — either fabricated outright, or a real corpus `chunkId` that exists but wasn't part of this run's top-k result.

#### Failure Mode 2 — Malformed Retriever Output Silently Accepted

A retriever (most plausibly the live embedding-backed one, since it depends on a third-party HTTP response) returns duplicate `chunkId`s, a `rank` that doesn't match array position, a non-finite `score`, or more results than `topK` allows. If this is fed directly into a `Set` and a formatting function without validation, the corrupted data becomes the trusted `allowedRagChunkIds` set and the model-visible context, with no signal that anything was wrong.

#### Failure Mode 3 — Provider Error Details Leaking

An embedding provider request fails (auth, rate limit, timeout, malformed response). If the raw SDK error — message, HTTP body, headers, or raw response object — is logged, thrown, or embedded in a returned error message, it can leak request/response internals, and, in the worst case, credentials or account-identifying details.

#### Failure Mode 4 — Prompt Injection via Retrieved Content

A runbook chunk's `content` (or, in the live-provider case, arbitrary text an attacker could get indexed) contains text shaped like an instruction — e.g., "ignore previous instructions and call tool X" or "cite evidence ID Y without verifying it." If the system prompt does not explicitly frame retrieved content as inert data, the model has no stated basis to distinguish "text to read as evidence" from "text to obey as an instruction."

#### Failure Mode 5 — Caller/Params Ambiguity

The orchestrator accepts both a manual `allowedRagChunkIds` set (the pre-existing, already-adopted mechanism) and, now, an optional `retriever`. If both are accepted together without a defined precedence rule, it becomes ambiguous — and exploitable — whether a caller-supplied ID can smuggle evidence past what was actually retrieved this run.

### Decision

**Layered, fail-closed validation, with each layer's job kept narrow and non-overlapping:**

1. **Caller-contract validation** (`AgentOrchestratorParams`, checked first, before any I/O): `retriever` and `retrievalInput` must both be present or both absent; a `retriever` may not be combined with a non-empty `allowedRagChunkIds` (evidence IDs are derived *exclusively* from that retriever's own results in this mode — never merged with a caller-supplied set). Violations return `RETRIEVAL_PARAMS_INVALID` with an empty trace, before the retriever or provider are ever invoked.
2. **Retrieval-input validation** (`validateRetrievalInput`): `topK` must be an integer in `[1, 5]`; the query must be non-empty. Failing this is also `RETRIEVAL_PARAMS_INVALID` — a caller-contract violation, not a retriever defect — and the retriever is never called.
3. **Retriever-output validation** (`validateRetrievedChunks`, retriever-implementation-agnostic, shared by every `RunbookRetriever`): rejects a result exceeding `topK`, duplicate `chunkId`s, non-finite `score`s, empty required strings, and — critically — requires `chunks[i].rank === i + 1` positionally, not merely that the set of ranks is `1..N`. This runs strictly before a `Set` or the model-visible context is built from the result, so a retriever defect always hard-fails as `RETRIEVAL_RESPONSE_INVALID` rather than being silently tolerated or auto-corrected.
4. **Retriever-exception handling**: a thrown `RetrieverError` (any category) becomes `RETRIEVAL_FAILED`. `RetrieverError` itself mirrors the already-adopted `LlmProviderError` pattern exactly — a closed category enum (`AUTHENTICATION`, `RATE_LIMIT`, `CONNECTION`, `TIMEOUT`, `SERVER_ERROR`, `REQUEST_INVALID`, `RESPONSE_INVALID`, `UNKNOWN`) and a short, static, OpsPilot-composed message — never a raw SDK error, body, header, or `cause` field.
5. **Live-provider response validation** (`VoyageRunbookRetriever`, before any score is computed): document-embedding count must match corpus size; query-embedding count must be exactly one; every vector's dimension must match the configured value and match every other vector; every value must be finite; every vector must have a non-zero norm; and the response's `index` field is used to re-map vectors to their corresponding input text — the response's array order is never trusted to already match request order. Any violation throws `RetrieverError("RESPONSE_INVALID", ...)` before a similarity score is ever computed from unvalidated data.
6. **Content-trust framing** (system prompt, `claude-message-mapping.ts`): retrieved content is explicitly stated to be evidence data, not instructions, with the same "copy the exact supplied `evidenceId`, never invent/derive/shorten/rewrite" rule already proven necessary for `TOOL_EXECUTION` evidence. A dedicated adversarial fixture (`INJECTION_PROBE_CHUNK`), kept structurally isolated from the real seven-chunk corpus, exists specifically to test this — both structurally (an automated test proving the content is rendered as inert JSON-string data) and, for actual behavioral evidence, as an isolated Scenario B in the manual live spike.

### Alternatives Considered

#### Alternative A — Trust the Model's Self-Reported Evidence

Rejected outright, on direct precedent: the earlier Claude spike already demonstrated a live model will invent a plausible-looking evidence ID unless the application removes the ambiguity by surfacing the real ID explicitly.

#### Alternative B — Deduplicate or Auto-Correct Malformed Retriever Output

Considered and rejected: silently deduplicating a retriever's duplicate `chunkId`s, or sorting-then-reassigning ranks instead of validating positional order, would make a real retriever defect invisible instead of catching it — exactly Failure Mode 2. The chosen design hard-fails (`RETRIEVAL_RESPONSE_INVALID`) instead.

#### Alternative C — One Merged `allowedRagChunkIds` from Caller + Retriever

Considered and rejected: allowing a caller-supplied set to be merged with retriever results would reopen exactly the identity guarantee retrieval mode exists to provide — a caller could smuggle an ID that was never actually retrieved this run. The two modes (manual and retrieval) are kept mutually exclusive instead.

#### Alternative D — Log Full Request/Response Payloads for Debuggability

Considered and rejected for both the Voyage and Claude adapters: raw payload logging would leak API keys, headers, and (for embeddings specifically) full vectors. Both live-provider integrations log only a small, explicitly-enumerated set of fields (model, latency, token usage, sanitized error category).

### Tradeoffs

#### Benefits of the selected design

- Each validation layer is independently testable and has one clear failure code, making it possible to distinguish "the caller misused the API" (`RETRIEVAL_PARAMS_INVALID`) from "the retriever is broken" (`RETRIEVAL_RESPONSE_INVALID`) from "the retriever's dependency failed" (`RETRIEVAL_FAILED`) without inspecting a message string.
- The retriever-output validator is retriever-agnostic, so the deterministic keyword retriever and the live embedding retriever are held to the exact same contract, and the keyword retriever's test suite doubles as a proof that its output always satisfies the validator.
- Reusing the already-adopted `LlmProviderError` category pattern for `RetrieverError` means the sanitization discipline (no raw SDK content in a thrown message) didn't need to be reinvented or independently re-litigated.

#### Costs of the selected design

- More failure codes and validation functions than a version that simply trusted retriever output — each one needs its own tests, which this revision added (`retrieval-validation.test.ts`, plus dedicated orchestrator-level tests per failure code).
- The positional rank check (`chunks[i].rank === i + 1`) is stricter than a same-effort "the ranks form a valid 1..N set" check, and would reject a retriever that is internally correct but returns results in a different order than its own `rank` field claims — an intentional tradeoff, since that mismatch is precisely the kind of bug this validation exists to catch, not paper over.
- The prompt-injection framing and the adversarial fixture cannot, by construction, prove general injection resistance from unit tests alone (`FakeLlmProvider` doesn't read chunk content to decide behavior) — real assurance requires the manual live-spike Scenario B, run against an actual model, and even then only as a single-run observation, not a reliability claim.

### Implementation Notes

- `apps/worker/src/rag/runbook-retriever.ts` — `RunbookRetriever`, `RetrievalInput`, `StoredRunbookChunk`, `RetrievedRunbookChunk`, `RetrieverError`/`RetrieverErrorCategory`.
- `apps/worker/src/rag/retrieval-validation.ts` — `validateRetrievalInput`, `validateRetrievedChunks`; shared by both retriever implementations and by `agent-orchestrator.ts`.
- `apps/worker/src/rag/markdown-runbook-loader.ts` — the fence-aware, heading-delimited Markdown parser and `MarkdownRunbookCorpusLoader`, with fail-closed root/symlink/nested-directory checks and a duplicate-`chunkId` assertion. `apps/worker/src/rag/load-default-runbook-corpus.ts` wires it to the repository-level `runbooks/*.md` files, the seven-chunk corpus's actual source.
- `apps/worker/src/rag/injection-probe-fixture.ts` — `INJECTION_PROBE_CHUNK`, deliberately excluded from the main corpus array.
- `apps/worker/src/rag/in-memory-runbook-retriever.ts` — deterministic keyword/token-overlap retriever used by all automated tests and the deterministic demo.
- `apps/worker/src/rag/voyage-embedding-client.ts`, `voyage-runbook-retriever.ts` — the live embedding-backed retriever; a narrow seam interface (mirroring `AnthropicMessagesClient`) isolates the `voyageai` SDK to these two files plus the manual spike composition root.
- `apps/worker/src/rag/rag-context-formatting.ts` — `formatRagContext`, a strict one-to-one, order-preserving map from validated chunks to the model-visible `RagContextEntry` shape; it performs no deduplication of its own.
- `apps/worker/src/agent/agent-orchestrator.ts` — owns the retrieval step (once, before the first provider turn), the three-layer validation described in Decision, the `RETRIEVAL_COMPLETED` trace event (`chunkId`/`rank`/`score` only — never content or raw vectors), and derives `allowedRagChunkIds` exclusively from validated retrieval results when a retriever is supplied.
- `apps/worker/src/providers/claude-message-mapping.ts` — maps the new `rag_context` conversation message to a Claude content block, and carries the untrusted-content-framing system prompt language.
- When no `retriever` is supplied, behavior is unchanged from the pre-existing manual-`allowedRagChunkIds` path — the already-adopted `TOOL_EXECUTION`-only baseline is not touched.

### Testing Strategy

- **Params invariants**: both/neither `retriever`+`retrievalInput`; non-empty `allowedRagChunkIds` combined with a `retriever`; empty/absent `allowedRagChunkIds` with a `retriever`.
- **Shared retrieval validation**: `topK` bounds/type, empty query, excess result count, duplicate `chunkId`, non-consecutive/duplicate/out-of-position ranks, non-finite scores, empty required strings.
- **Keyword retriever**: deterministic ranking, tie-break by `chunkId` ascending, `topK` enforcement, zero-result behavior, and a direct assertion that its output always satisfies the shared validator.
- **Voyage retriever**: document-count mismatch, query-count ≠ 1, dimension mismatch, non-finite values, zero-norm vectors, shuffled-but-valid index reordering, missing/duplicate indices, cosine-similarity correctness against fixed fakes, tie-break parity with the keyword retriever, SDK error → category mapping (401/429/5xx/timeout/network/unknown), and a direct assertion that no thrown error message contains raw SDK content.
- **Orchestrator integration**: each of the three failure codes reachable and trace-empty on failure; a successful retrieval pushes exactly one `RETRIEVAL_COMPLETED` event with the correct summary and injects `rag_context`; zero retrieved chunks completes without injecting `rag_context`, with tool-only evidence still valid; a real corpus `chunkId` that wasn't retrieved this run still fails evidence validation; tool and RAG evidence together still pass.
- **Prompt-injection structural proof**: the injection-probe fixture's content is rendered as inert data (never a role change, never altering which tools are offered); a fabricated evidence ID shaped like the fixture's embedded instruction still fails validation exactly like any other invented ID.
- **Not covered by automated tests, by design**: whether a live model actually declines to follow injected instructions — this requires the manual live spike's isolated Scenario B, run manually against a real Claude model, and even then is recorded as a single-run observation, not a reliability guarantee.

### Observability

#### Logs

The live spike logs only: embedding/Claude model name, request latency, token usage, and a sanitized error category — never API keys, headers, raw request/response bodies, or embedding vectors.

#### Trace

`RETRIEVAL_COMPLETED` (`agent-orchestrator.ts`) is the durable, structurally-limited record of what was retrieved for a run: `chunkId`, `rank`, `score` per chunk, nothing else. Both the deterministic demo and the live spike print this directly from the orchestrator's returned trace rather than re-running retrieval themselves, so what's displayed can never diverge from what was actually validated and used for evidence grounding.

#### Future metrics (not yet wired — no `AgentRun`/metrics pipeline exists in this vertical slice)

- Retrieval failure rate by `RetrieverErrorCategory`.
- `RETRIEVAL_RESPONSE_INVALID` rate — should be at or near zero for the deterministic retriever, and a meaningful signal of live-provider instability if it rises for the Voyage retriever.
- Rate of reports citing zero `RAG_CHUNK` evidence despite non-empty retrieval, as a proxy for retrieval relevance quality.

### Interview Explanation

> The earlier work on this project already showed that a model can't be trusted to self-report which tool call it used as evidence — it invented a plausible-looking ID until we started handing it the exact ID and telling it to copy it verbatim. When I added retrieval-augmented generation, I had to extend that same discipline to a new evidence type, but retrieval added two new problems tool calls didn't have: the retriever itself is a pluggable component — including a live one backed by a third-party embedding API — that could return malformed data, and the retrieved *content* is free text the model reads, which is a prompt-injection surface a structured tool result never was. So I built three independent validation layers instead of one: the orchestrator's params are checked before any I/O happens; every retriever's output — deterministic or live — is checked by one shared, implementation-agnostic validator before it's ever allowed to become part of the trusted evidence set, and that validator checks rank by exact array position, not just "is this a valid set of numbers," specifically so a subtly-wrong retriever can't pass by accident; and the live embedding provider's raw response is validated — vector counts, dimensions, finite values, non-zero norms, index mapping — before a single similarity score is computed from it. On top of that, the system prompt explicitly tells the model that retrieved content is evidence, not instructions, and I built a dedicated adversarial test chunk to prove that framing structurally and, in a manual live-spike scenario kept deliberately isolated from the real corpus, to observe it against an actual model. The throughline is the same one from the tool-evidence work: don't trust the model to self-police, and don't trust an external system's output until you've checked its shape yourself.

### Resume Relevance

This problem demonstrates:

- Recognizing that a security property (evidence grounding) established for one input source doesn't automatically transfer to a new one, and re-deriving what changes
- Defense-in-depth validation design: distinct, narrowly-scoped failure modes with their own error codes rather than one catch-all
- Treating a third-party API response as untrusted input requiring explicit shape validation, not just a happy-path type cast
- Prompt-injection awareness for retrieval-augmented generation, including the honest limits of what a unit test (versus a live model run) can actually prove
- Sanitized error handling patterns applied consistently across two independent external integrations (Claude, Voyage)

---

## 5. Challenge 3 — Agent Run / Trace Persistence Without a Queue

### Context

Before this milestone, `runAgentOrchestrator` executed entirely in memory: a demo or the evaluation harness called it, got back a trace and a final report or failure code, and nothing was durably recorded. Challenge 1 already designed a full future production persistence layer — `AgentJob` as a queue-claim row, execution-token fencing, a 60-second maintenance sweep, `AgentStep` with concurrency-safe sequence allocation — but that design assumes a real queue-claiming worker, which did not exist yet. This milestone (`packages/database`, `apps/worker/src/persistence/`) needed the smallest production-shaped slice that could durably persist one investigation's job, run, ordered trace, and terminal outcome, without building the queue machinery Challenge 1 designed for a later stage.

### Problem

Persist `create AgentJob → atomically start AgentRun as RUNNING → execute the existing orchestrator → transactionally persist the full ordered trace → persist exactly one terminal outcome → read it all back`, while (a) never modifying `runAgentOrchestrator`'s behavior or signature, (b) guaranteeing a run can never end up completed and failed at once, (c) making retried/duplicated persistence calls safe rather than corrupting or duplicating data, and (d) doing all of this on Prisma 7 — a major version that removed the bundled query-engine binary and requires an explicit PostgreSQL driver adapter (`@prisma/adapter-pg` over a self-managed `pg.Pool`) for every connection.

### Why It Is Difficult

Unlike Challenge 1's design (still unimplemented), this slice had to actually run against a real, installed Prisma 7.9.0 — meaning assumptions had to be verified against the real CLI and generated client, not just written down. Several genuinely could not have been known from documentation alone: `prisma.config.ts`'s exact `datasource`/`shadowDatabaseUrl` shape, the new `prisma-client` generator's real file/export layout (and that it exports a type literally named `AgentTraceEvent` aliasing its own generated row shape — colliding with this project's own domain type of the same name), and that `prisma migrate diff --to-config-datasource` requires its shadow database to already exist, unlike `prisma migrate dev`'s auto-managed one. Separately, "exactly one terminal outcome" and "safe to retry" are in tension: a naïve retry-safety design that only compares the final report/failure code (not the full trace) would let a truncated or reordered trace replay be silently accepted as "the same" outcome.

### Failure Modes

- A crash between inserting the trace batch and setting the terminal status leaves the run neither cleanly `RUNNING` nor cleanly terminal.
- Two concurrent finalization attempts (a completed-vs-failed race, or a genuine retry) could both "succeed," leaving inconsistent terminal state, or a naive retry could insert the trace twice.
- A persistence failure occurring *after* the agent already completed successfully could be silently mis-reported as an agent-domain failure, destroying the distinction between "the agent failed" and "we couldn't record that the agent succeeded."
- A raw provider/tool/database exception message could leak into a persisted column, a thrown error's `.message`, or the persisted demo's console output — none of which should ever contain prompts, provider responses, tool output, stack traces, file paths, or connection strings.
- Prisma's own schema DSL cannot express PostgreSQL `CHECK` constraints, so a naïve reliance on `prisma migrate diff` for "is my schema correct" would silently miss a dropped or hand-edited constraint.

### Decision

- **No queue, no `PENDING` state.** `agent_jobs`/`agent_runs`/`agent_trace_events` only; a run is created already `RUNNING` in one atomic `startRun` transaction (lock `AgentJob` → allocate `attempt_number` → insert `AgentRun` as `RUNNING`), never as a separately-committed `PENDING` row — there is no queue-claiming worker in this milestone to make that intermediate state meaningful.
- **Persist-after (Option A), not incremental.** The orchestrator runs fully in memory, unchanged; only after it returns a real `AgentOrchestratorResult` does one transaction insert the complete, contiguous trace batch and set the terminal state together.
- **Terminal-outcome invariant as a database CHECK constraint**, not just application logic: `RUNNING` has no terminal fields, `COMPLETED` has `finished_at` + `report` and no `failure_code`, `FAILED` has `finished_at` + `failure_code` and no `report` — enforced by `agent_runs_terminal_outcome_chk`, unconditionally, even against a raw `UPDATE` that bypasses the repository.
- **Exact-replay idempotency, not outcome-only idempotency.** A repeated `finalizeCompleted`/`finalizeFailed` call is accepted as a no-op success only when the *full ordered trace* — compared as `{sequenceNumber, payload}` pairs via PostgreSQL JSONB array equality, not JS string equality, and not payload alone (a payload-only comparison would wrongly accept a stored `[1, 3]` sequence gap as a replay of an incoming `[1, 2]` trace whenever the payloads happened to be in the same order) — **and** the terminal outcome both match exactly; any other combination is `PERSISTENCE_CONFLICT`. This is evaluated inside the same `SELECT ... FOR UPDATE`-locked transaction that would otherwise perform the write, so a completed-vs-failed race always produces exactly one winner. Trace contiguity (`1..N`, no gaps or duplicates) is additionally re-verified on every read (`getAgentRun`), independent of the replay check, since a gap could in principle reach the table through a path other than `finalizeCompleted`/`finalizeFailed`.
- **A run only ever investigates its own persisted ticket, sourced from PostgreSQL, not from the caller.** `AgentRunService.executeAndPersist` accepts only `jobId: string` — never a job object and never a ticket context. `repository.startRun` selects the *complete* `agent_jobs` row (not just an existence check) under the same `FOR UPDATE` lock used to allocate `attempt_number`, runtime-validates and maps it, and returns it alongside the new `AgentRun` as `StartedAgentRun { job; run }`; `executeAndPersist` builds the sole `ticket_context` conversation message from that returned snapshot. This was tightened after an initial version accepted a caller-supplied `AgentJobRecord` directly — since that is a public structural TypeScript interface, a caller could have constructed one combining job A's `id` with job B's `ticketContext`, storing the resulting `AgentRun` under job A while investigating job B's ticket. Because the ticket context and the `AgentRun.jobId` foreign key now both originate from the one locked read inside `startRun`, that combination is structurally impossible, not merely discouraged by convention.
- **Crash vs. persistence failure vs. agent failure are three distinct, never-conflated concepts.** A `PersistenceError` from `startRun` returns `{ persistence: "unavailable", stage: "run-creation" }` (no run exists). A `PersistenceError` from finalization returns `{ persistence: "unavailable", stage: "finalization", runId, agentResult, error }` — carrying the run ID and the in-memory result so a caller can retry via `retryFinalization`, which is explicitly documented as caller-controlled, in-memory-only retry (not process-restart-safe; a crashed process has no durable copy of `agentResult` to retry with — that remains deferred to a future reaper/recovery milestone). An unexpected exception from the orchestrator itself throws a distinct `AgentRunServiceError` (`code: AGENT_EXECUTION_CRASHED`, one fixed message, raw cause retained only as `Error.cause` for internal debugging) — never returned as a persistence result, never written as a `FAILED` outcome, never converted to an `AgentOrchestratorErrorCode`.
- **Runtime (Zod) validation at every persistence boundary**, both directions — every write (ticket context, each trace event, the report, the failure code) and every read is validated against `@opspilot/contracts`' schemas, with failures normalized to `PERSISTENCE_VALIDATION_FAILED` and a fixed message; no Zod issue array, raw JSON, Prisma error, or SQL text is ever exposed.
- **Two distinct, correctly-scoped verification tools, not one.** `db:migrate:status` (migration history vs. `_prisma_migrations`) and `db:migrate:drift` (`prisma migrate diff --to-config-datasource`, exit 0/1/2) are kept separate and separately documented; since `migrate diff` cannot see hand-authored `CHECK` constraints, a dedicated integration test queries `pg_constraint` directly and asserts all 12 approved constraints exist by exact name.

### Alternatives Considered

#### Alternative A — Persist incrementally during orchestration (Option B)

Would require adding an event-emitter/callback hook to `runAgentOrchestrator`, the one thing this milestone was explicitly told to avoid. Its only real benefit — visibility into a still-running run — maps to live progress streaming, out of scope this milestone. Rejected.

#### Alternative B — Prisma's classic `prisma-client-js` generator with a bundled query engine

Simpler to reason about (no explicit driver adapter, no self-managed `pg.Pool`), but the approved technology decision pinned Prisma 7 exactly, whose adapter-based model (`@prisma/adapter-pg` + `PrismaPg`) is the only supported path forward. Rejected for this project; noted as the cost of adopting Prisma 7 rather than staying on 6.

#### Alternative C — Compare only the terminal outcome on replay, not the full trace

Simpler SQL, but silently accepts a replay whose trace was truncated, reordered, or otherwise different from what was originally persisted, as long as the final report/failure code happens to match — a real correctness gap for an audit-style trace record. Rejected.

#### Alternative D — A separate `agent_run_outcomes` table instead of nullable terminal columns on `agent_runs`

Only pays off if outcomes need an independent lifecycle (multiple historical outcomes, soft-deletion) — "terminal exactly once, ever" doesn't need that, and a side table would add transactional complexity (the finalize transaction would still need to write into it) for no additional safety over one `CHECK` constraint. Rejected.

### Tradeoffs

- Adopting Prisma 7 exactly (rather than 6, which would have avoided a driver adapter entirely) means every `PrismaClient` construction site now also manages a `pg.Pool` and must remember to call `.close()` on both — an operational responsibility classic Prisma absorbed internally. This is accepted as the cost of matching the approved, pinned technology decision.
- `prisma migrate diff`'s shadow database (`opspilot_shadow`) must be created ahead of time — unlike `migrate dev`'s auto-managed shadow database — a genuine extra piece of local infrastructure discovered only by running the real CLI, not anticipated in the original design.
- Orphaned `RUNNING` rows (a crash between `startRun` and finalization, or an `AGENT_EXECUTION_CRASHED` throw) are an accepted, explicitly documented gap this milestone — there is no reaper/sweep, matching the deliberate decision not to build queue-worker machinery yet.
- `agent_trace_events` is a smaller, less capable table than Challenge 1's future `AgentStep` — four event types instead of the full future vocabulary, no `nextStepSequence` counter — because this milestone has exactly one synchronous writer per run and does not need to serialize concurrent appenders. The name is kept deliberately distinct (`agent_trace_events`, not `agent_steps`) to avoid implying false equivalence with that richer future design.

### Implementation Notes

- `packages/database/prisma.config.ts` sets `datasource.url` (and `shadowDatabaseUrl`) via `process.env.DATABASE_URL ?? ""` rather than a mandatory `env("DATABASE_URL")` reference in `schema.prisma` — `prisma generate` and `tsc` must succeed with no `.env` file and no running PostgreSQL at all.
- `packages/database/scripts/run-prisma.mjs` wraps every Prisma CLI invocation via `pnpm exec prisma`, checking for a non-empty `DATABASE_URL` only ahead of commands that actually need one (`migrate`, `db`, `studio` — not `generate`/`validate`), and never prints the URL. `run-prisma-against-test-database.mjs` reuses that same function with `DATABASE_URL` remapped from `TEST_DATABASE_URL`, rather than duplicating the spawn logic.
- All 12 hand-authored `CHECK` constraints (`agent_jobs_ticket_context_is_object_chk`, `agent_jobs_external_ticket_id_matches_chk`, `agent_runs_attempt_number_chk`, `agent_runs_status_chk`, `agent_runs_provider_mode_chk`, `agent_runs_report_is_object_chk`, `agent_runs_failure_code_chk`, `agent_runs_terminal_outcome_chk`, `agent_trace_events_sequence_number_chk`, `agent_trace_events_payload_is_object_chk`, `agent_trace_events_event_type_chk`, `agent_trace_events_event_type_matches_chk`) live in the checked-in, hand-edited migration SQL — Prisma's schema DSL cannot express any of them.
- `AgentTraceEvent`/`RetrievalSummaryEntry` moved from `apps/worker/src/agent/agent-orchestrator.ts` to a new Zod schema in `packages/contracts` (with `.readonly()` applied throughout to exactly preserve the original hand-written type's `readonly` field/array modifiers), re-exported unchanged from the orchestrator file — the one narrow, justified touch to existing orchestrator code, purely a type relocation.
- The local development port for Postgres is `55432`, not the default `5432` — a developer-machine port conflict discovered at implementation time; the container's own internal port is unaffected, only the host mapping and `.env.example` changed.

### Testing Strategy

- **Unit** (`packages/database`, no PostgreSQL): mappers, the `AgentTraceEventSchema`/`TicketContextSchema` contracts, Prisma/driver-error normalization, the `FAILURE_DISPLAY_MESSAGES` map's exact parity with `AgentOrchestratorErrorCodeSchema.options`. **Unit** (`apps/worker`): `AgentRunService`'s full control flow — every `ExecuteAndPersistResult` branch, `retryFinalization`'s no-new-attempt guarantee, a test proving the orchestrator's initial conversation is built from the database job snapshot `startRun` returns (never from any caller-supplied value, since the caller passes only `jobId`), and a sentinel test proving a raw crash message (containing a fake file path, provider response, tool output, and API-key-shaped string) never reaches `AgentRunServiceError`'s `.message`, `JSON.stringify`, or `String()` coercion — only `.cause`.
- **Integration** (real PostgreSQL, no mocked Prisma transactions): migrations apply cleanly; all 12 named `CHECK` constraints verified directly via `pg_constraint`; concurrent `startRun` calls (two real Prisma clients) allocate unique increasing attempts; `startRun` returns the exact `ticket_context` stored in PostgreSQL for the locked job row; `startRun` rolls back and returns `PERSISTENCE_VALIDATION_FAILED`, inserting no `AgentRun`, when the locked job row's `ticket_context` passes every `CHECK` constraint but fails `TicketContextSchema` (e.g. a raw-SQL-inserted row missing `summary`); `startRun` never produces an observable `PENDING` state and a raw-SQL-inserted `PENDING` row is rejected; duplicate `(run_id, sequence_number)` and mismatched `event_type`/payload rejected; exact-replay (as `{sequenceNumber, payload}` pairs) succeeds idempotently with zero duplicate trace rows across three consecutive replays; a trace-match-but-outcome-mismatch (and vice versa) both conflict; a raw-SQL-inserted `[1, 3]` sequence gap is neither accepted as an exact replay of a normal `[1, 2]` trace nor returned successfully by `getAgentRun`, while a normal contiguous `[1..N]` trace continues to succeed on both paths; a completed-vs-failed race (two concurrent clients) produces exactly one winner; an invalid report is rejected before any transaction begins, leaving the run and trace untouched (distinct from, and not to be confused with, genuine mid-transaction rollback); a real PostgreSQL failure injected via a test-only trigger/function (created and dropped entirely within one test, never a production hook) after the trace `createMany` has already executed proves the whole transaction rolls back together — the run stays `RUNNING` and zero trace rows persist; a structurally invalid stored payload (valid `event_type`, malformed shape) is caught by read-time revalidation, proving the gap the `CHECK` constraint alone cannot close; connection unavailability normalizes to `PERSISTENCE_UNAVAILABLE` without leaking the connection URL.

### Observability

Only stable, fixed-vocabulary values are ever surfaced: `PersistenceErrorCode` (`PERSISTENCE_UNAVAILABLE` / `PERSISTENCE_CONFLICT` / `PERSISTENCE_VALIDATION_FAILED` / `PERSISTENCE_NOT_FOUND`) and `AgentRunServiceErrorCode` (`AGENT_EXECUTION_CRASHED`), each with a fixed, sanitized message. The persisted demo prints job/run IDs, run status, the ordered trace, and (on failure) only the stable code and fixed message — never a database URL, raw exception text, a stack trace, an API key, a prompt, or a provider request/response body.

### Interview Explanation

> Challenge 1 already designed the full production persistence layer — a queue-claiming worker, execution-token fencing, a maintenance sweep — but none of that had been built yet, and I didn't want to build queue infrastructure just to get one investigation durably recorded. So I asked what the smallest slice would look like if I assumed exactly one synchronous writer and no queue at all: a run gets created already RUNNING, not PENDING, because there's no claim step to make PENDING meaningful; the whole trace gets persisted in one transaction after the agent finishes, because there's no incremental-write requirement without a queue worker publishing progress; and idempotent retry has to compare the entire ordered trace, not just the final report, because "the same outcome" isn't actually the same guarantee as "the same recorded history." The part I couldn't have designed on paper was the Prisma 7 migration itself — it removed the bundled query engine, so every client needs its own driver adapter and connection pool now, and `prisma migrate diff` turned out to need a shadow database that isn't auto-created the way `migrate dev`'s is. I only found both of those by actually running the pinned version against a real database rather than trusting the plan. The throughline connecting this to Challenge 1 and Challenge 2 is the same discipline: separate what's actually implemented from what's designed for later, and never let a database or infrastructure failure get silently reinterpreted as a business decision the agent made.

### Resume Relevance

This problem demonstrates:

- Scoping a production-shaped but deliberately minimal persistence slice, and documenting precisely how and why it differs from the fuller design it's a precursor to, rather than silently diverging
- Database-level invariant enforcement (CHECK constraints, exact-replay idempotency via JSONB equality) as the source of truth, not just application-layer validation
- Correctly distinguishing infrastructure failure, agent-domain failure, and unexpected-crash failure as three separate error models that must never be conflated
- Adapting a design to real, version-specific tooling behavior (Prisma 7's driver-adapter model, `migrate diff`'s shadow-database requirement) discovered only by actually running it, and documenting the deviation
- Consistent sanitized-output discipline (no raw errors, connection strings, or stack traces surfaced anywhere) carried through a third subsystem after Challenge 1 and Challenge 2

---

## 6. Challenge 4 — `nest build` Is Incompatible with This Project's Pinned TypeScript

### Context

`apps/api` (`docs/12-agent-run-api.md`) is a new local-only NestJS API built on top of Challenge 3's persistence layer. The approved plan pinned exact `@nestjs/*` 11.x versions and specified `nest-cli.json` + `nest build`/`nest start --watch` as the build/dev commands, matching ordinary NestJS project conventions.

### Problem

`pnpm --filter @opspilot/api run build` (`nest build`) failed immediately with `tsBinary.getParsedCommandLineOfConfigFile is not a function` — not a bug in any of this milestone's own code, but a hard incompatibility between `@nestjs/cli@11.0.5` and this monorepo's pinned `typescript@^7.0.2`. `@nestjs/cli`'s internal build pipeline (`TsConfigProvider`, `TypeScriptBinaryLoader`) resolves whatever `typescript` package the consuming project has installed and calls into the classic TypeScript Compiler API (`ts.getParsedCommandLineOfConfigFile`, `ts.createProgram`, …) to read `tsconfig.build.json` and drive compilation. This project's `typescript@7.0.2` is a new native-rewrite package whose npm distribution no longer exposes that API surface via `require("typescript")` at all — its `"."` export resolves to `lib/version.cjs`, a small module that exports only a version string, alongside a separate `tsc` CLI binary (`bin/tsc`). Plain `tsc -p tsconfig.build.json` — which is all `packages/contracts`, `packages/database`, and `packages/agent-runtime` already use successfully under this exact TypeScript version — only needs that `tsc` binary, so it is unaffected. `nest build`'s wrapper needs the JS Compiler API, which simply is not there.

### Why It Is Difficult

This is not a version-pinning mistake to fix by bumping a patch number: no `@nestjs/cli` 11.x release could plausibly restore compatibility, because the incompatibility is architectural — an entire class of Compiler-API-consuming tools (and, likely, most of the `ts-loader`/`ts-jest`/`ts-morph`-adjacent ecosystem) will not be reachable from a `typescript` package that only ships a version stub and a CLI binary through its public npm export surface. Verifying this required actually reading `@nestjs/cli`'s installed source (`tsconfig-provider.js`, `typescript-loader.js`) and the installed `typescript@7.0.2` package's own `exports` map — the failure is not explained anywhere in either package's public documentation.

### Failure Modes

- `nest build` fails outright (`tsBinary.getParsedCommandLineOfConfigFile is not a function`), so `apps/api/dist/main.js` is never produced.
- `nest start --watch` shares the same internal compiler pipeline and fails identically — a working `build` script alone would not have implied a working dev-watch script.
- Silently downgrading `typescript` for the whole monorepo to make `nest build` pass would have contradicted the approved technology decision (pinned `^7.0.2`) and this milestone's own explicit constraint not to silently downgrade TypeScript.

### Decision

Stop and report the exact error before proceeding, per this milestone's own first-checkpoint instruction, then get an explicit choice on how to proceed rather than deciding unilaterally. The selected fix: change `apps/api/package.json`'s `build`/`start:dev` scripts to call `tsc -p tsconfig.build.json` directly instead of `nest build`/`nest start --watch` — the same pattern every other package in this monorepo (`contracts`, `database`, `agent-runtime`) already uses successfully under this TypeScript version. `emitDecoratorMetadata`/`experimentalDecorators` (what NestJS actually needs from the compiler) are ordinary `tsconfig.build.json` compiler options, entirely independent of which tool invokes `tsc`.

**Revised at pre-commit review:** the initial version of this decision kept `@nestjs/cli`/`@nestjs/schematics` as pinned devDependencies and kept `nest-cli.json` in the repository, reasoning that they cost nothing to leave as a placeholder for a possible future `nest generate` use. A pre-commit review correctly flagged this as dead configuration/dependencies with no actual use, not a genuinely justified placeholder — nothing in this milestone or its immediate roadmap uses Nest's schematics generator, and unused tooling that no longer even functions for its original purpose (Nest CLI build/start) is a maintenance liability, not a convenience. `apps/api/nest-cli.json` was deleted, and `@nestjs/cli`/`@nestjs/schematics` were removed from `apps/api/package.json`'s devDependencies (`pnpm install --filter @opspilot/api`, removing ~197 packages from the lockfile — the CLI's own transitive dependency tree). The Nest **runtime** packages actually used by the application (`@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express`) and the testing package (`@nestjs/testing`) are unaffected and remain exactly as pinned.

### Alternatives Considered

#### Alternative A — Downgrade `typescript` for the whole monorepo

Rejected outright — contradicts the approved, pinned technology decision and this milestone's explicit "do not silently downgrade TypeScript" constraint.

#### Alternative B — Scope a downgraded `typescript` to `apps/api` only (a per-package override)

Would keep `nest build`/`nest start --watch` literally working as specified, at the cost of a permanent per-package TypeScript version split in the workspace — one more thing to keep synchronized, and a strange asymmetry where the newest application package in the monorepo runs an older compiler than every package it depends on. Deferred in favor of Alternative C, which needed no version change at all.

#### Alternative C — Bypass the Nest CLI's compiler wrapper, keep plain `tsc` (Selected)

No version changes anywhere, and matches a pattern already proven to work in this exact monorepo under this exact TypeScript version for three other packages. The only cost is losing `nest build`'s and `nest start --watch`'s own incremental-build/file-watch conveniences — replaced by a `tsc --watch` + `node --watch` pair for `start:dev` (see `docs/12-agent-run-api.md`).

### Tradeoffs

- `apps/api` no longer benefits from any Nest-CLI-specific build behavior (asset copying, plugin-based transforms) — none of which this milestone actually needed, since `emitDecoratorMetadata` is a plain `tsc` compiler option.
- No hot reload / incremental watch mode: `start:dev` is now a full clean `build` followed by `start`, not a file-watcher — see Implementation Notes below and `docs/12-agent-run-api.md` §8. Deferred deliberately rather than adding a process-management dependency (`nodemon`/`concurrently`) in this pass.
- This is a monorepo-wide risk, not an `apps/api`-only one: any *future* package that wants to add a Compiler-API-consuming dev tool (a different framework CLI, a codegen tool, certain ESLint/Jest configurations) should expect the same class of failure under this pinned TypeScript version, and should check the tool's actual `require("typescript")` usage before assuming it works. If a future milestone genuinely needs Nest's schematics generator, `@nestjs/schematics` can be reinstalled as a devDependency at that point — it does not need to be kept pre-emptively.

### Implementation Notes

`apps/api/package.json`: `"build": "pnpm run build:deps && pnpm run clean && tsc -p tsconfig.build.json"` (cleans stale `dist/` output before every build, so a removed source file can never leave a stale compiled artifact behind), `"start:dev": "pnpm run build && pnpm run start"` (a full clean rebuild plus a normal blocking start — no file-watching, no automatic reload; a developer re-runs it after each change). No Nest CLI files or dependencies remain: `apps/api/nest-cli.json` was deleted, and `@nestjs/cli`/`@nestjs/schematics` were removed from devDependencies.

### Testing Strategy

Verified directly: `pnpm --filter @opspilot/api run build` produces `apps/api/dist/main.js` from a clean `dist/` (and no `*.test.js`/`test/` under `dist`); `pnpm --filter @opspilot/api run start` binds `127.0.0.1` and serves all four endpoints correctly; a full `SIGINT`/`SIGTERM` shutdown cycle closes cleanly with no hanging process — see `docs/12-agent-run-api.md` §8 for the exact commands.

### Interview Explanation

> I hit a build failure in a brand-new NestJS app that had nothing to do with any code I'd written — `nest build` crashed inside the Nest CLI itself. Rather than guessing, I read the installed CLI's source and found it calls into the classic TypeScript Compiler API to parse `tsconfig.build.json`, and then checked what our pinned TypeScript package actually exports — turned out to be a new native rewrite whose public npm surface is just a version stub and a `tsc` binary, no Compiler API at all. That's not a version mismatch you fix by bumping a patch number, it's a real architecture change upstream. Since three other packages in the same monorepo already used plain `tsc` successfully under that same TypeScript version, I proposed bypassing the Nest CLI's build wrapper entirely rather than downgrading TypeScript project-wide, confirmed it with the person I was building this for instead of just deciding on my own, and shipped the same plain-`tsc` pattern the rest of the repo already used.

### Resume Relevance

This problem demonstrates:

- Diagnosing a third-party tool failure by reading its actual installed source rather than guessing or reflexively downgrading a dependency
- Recognizing when a failure is architectural (an upstream package's public API surface changed) rather than a simple version mismatch
- Stopping at an explicit decision point and getting a scoped answer instead of silently choosing a workaround with monorepo-wide consequences
- Reusing an already-proven pattern from elsewhere in the same codebase instead of inventing a new one
