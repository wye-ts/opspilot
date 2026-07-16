# OpsPilot — Engineering Challenges and Design Decisions

| Field | Value |
|---|---|
| Document | Engineering Challenges and Design Decisions |
| Version | 1.2 |
| Status | Living Document |
| Project | OpsPilot |
| Purpose | Capture difficult engineering problems, design decisions, tradeoffs, and interview-ready explanations |
| Related Documents | `docs/03-technical-design.md`, `docs/reviews/03-technical-design-feasibility-review.md`, `docs/reviews/03-technical-design-review-decisions.md` |
| Revision note | v1.2 aligns Challenge 1 with `docs/03-technical-design.md` v1.3: `AgentJob` now includes `CANCELLED`; the maintenance sweep sets `AgentRun.completedAt`; the corrected write-safety design is presented as two distinct repository transaction patterns (`withExecutionOwnership`, `withLockedRunState`) sharing one global lock order (`AgentJob` → `AgentRun` → child rows), not a single "ownership-fenced" pattern; and language implying the design has already been implemented or shipped has been replaced with language accurate to the project's current (pre-implementation) stage. v1.1's PostgreSQL-as-system-of-record-and-queue decision (D1, D2) and the corrected write-safety mechanism (D12) remain unchanged in substance. This entry is further updated within v1.2 to document concurrency-safe `AgentStep` sequence allocation (`AgentRun.nextStepSequence`, the shared `appendAgentStep(...)` helper, and why `SELECT MAX(sequence) + 1` is unsafe) and the `completeAgentRunWithReport` invariant that every `PendingAction` created during finalization has exactly one matching `APPROVAL_CREATED` trace event, created in the same transaction — still describing planned design, not implemented behavior. |

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
