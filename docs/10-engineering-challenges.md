# OpsPilot — Engineering Challenges and Design Decisions

| Field | Value |
|---|---|
| Document | Engineering Challenges and Design Decisions |
| Version | 1.12 |
| Status | Living Document |
| Project | OpsPilot |
| Purpose | Capture difficult engineering problems, design decisions, tradeoffs, and interview-ready explanations |
| Related Documents | `docs/03-technical-design.md`, `docs/04-agent-design.md`, `docs/reviews/03-technical-design-feasibility-review.md`, `docs/reviews/03-technical-design-review-decisions.md`, `docs/reviews/04-agent-design-claude-spike-results.md`, `docs/12-agent-run-api.md`, `docs/13-approval-workflow.md`, `docs/08-cicd-deployment.md`, `docs/14-web-ui.md` |
| Revision note | v1.12 adds Challenge 13 from the investigation stage/event contract milestone (issue #36, `docs/16-investigation-event-contract.md`): a shared progress reducer that refuses to repair. An independent review of the first implementation found it would accept `RUN_CREATED → RUN_COMPLETED` as a successful run by silently closing and omitting the stages nobody had reported — the entry documents why "derive progress from events" quietly becomes "invent progress from gaps" unless completion is defined by explicit required facts, why the failure path must be immediate and exactly consistent between a stage fact and the run-level fact, and why a free-form `failureMessage` was removed from a browser-readable event rather than merely length-capped. v1.11 adds Challenge 10 from the shared-provider-package milestone (PR 6B1, `docs/12-agent-run-api.md` §7.1): two interop defects that type-checked cleanly and passed the affected package's own unit tests, and were caught only by artefacts that exercise the *built* output and the *real* event sequence — a CommonJS/ESM default-import inversion that appears when a package consumed by an ESM app is itself compiled to CommonJS, and a client-disconnect design built on `request.on("close")` that would have aborted every healthy live run before its first provider call. Both are now enforced by executable rules rather than convention. v1.10 adds Challenge 8 from the approval-workflow UX milestone (PR 5C, `docs/14-web-ui.md` §8): a completed agent run and a completed human approval decision were visually indistinguishable, because the sole decision control sat below the entire report in a 50/50-width column — a run-detail layout problem, not a persistence or API problem, distinguished here from Challenge 1's data-consistency scope precisely because nothing about the backend contract changed to fix it. v1.9 adds Challenges 5–7 from the production deployment milestone (PR 5B, `docs/08-cicd-deployment.md`): Challenge 5 documents the single-origin SPA-fallback design and a repository-verified correction to the design plan's stated claim about how far NestJS's catch-all route actually reaches under this exact NestJS 11 / Express 5 / path-to-regexp v8 combination; Challenge 6 documents two implementation-time bugs found only by running the real built container — a JavaScript default-parameter closure trap in web-dist path resolution, and a Prisma 7.9 CLI validation quirk around an unconditionally-declared `shadowDatabaseUrl` — neither caught by the existing source-level tests, both discovered by running the built image; Challenge 7 documents why the migration startup retry belongs in `docker/entrypoint.sh` rather than `PrismaLifecycleService`, and why an earlier draft's placement there would have been unreachable dead code. v1.8 adds a pointer, at the end of Challenge 1's "Idempotent State Changes" subsection, to `docs/13-approval-workflow.md` (Milestone 6C) — the actual, much simpler approval-workflow design now on record. It is **not** an implementation of Challenge 1's aspirational `pending_actions`/`PendingAction`/`APPROVAL_CREATED` concept (which remains exactly as described below: planned, unimplemented design tied to the future `AgentJob`-as-queue/`AgentStep` architecture); it is a standalone, deliberately smaller mechanism built directly on the actually-shipped `agent_jobs`/`agent_runs`/`agent_trace_events` schema (`docs/11-agent-run-persistence.md`), following the same "deliberately smaller precursor, not a partial implementation" relationship `docs/11` §9 already draws between that shipped persistence slice and this same aspirational future design — see `docs/13-approval-workflow.md` §2 for the exact reasoning. v1.2 aligns Challenge 1 with `docs/03-technical-design.md` v1.3: `AgentJob` now includes `CANCELLED`; the maintenance sweep sets `AgentRun.completedAt`; the corrected write-safety design is presented as two distinct repository transaction patterns (`withExecutionOwnership`, `withLockedRunState`) sharing one global lock order (`AgentJob` → `AgentRun` → child rows), not a single "ownership-fenced" pattern; and language implying the design has already been implemented or shipped has been replaced with language accurate to the project's current (pre-implementation) stage. v1.1's PostgreSQL-as-system-of-record-and-queue decision (D1, D2) and the corrected write-safety mechanism (D12) remain unchanged in substance. This entry is further updated within v1.2 to document concurrency-safe `AgentStep` sequence allocation (`AgentRun.nextStepSequence`, the shared `appendAgentStep(...)` helper, and why `SELECT MAX(sequence) + 1` is unsafe) and the `completeAgentRunWithReport` invariant that every `PendingAction` created during finalization has exactly one matching `APPROVAL_CREATED` trace event, created in the same transaction — still describing planned design, not implemented behavior. v1.3 adds Challenge 2, documenting the minimal RAG vertical slice's evidence-grounding and retriever-isolation design — unlike Challenge 1, this describes code that has actually been implemented and unit-tested in this revision, though the manual live spike against a real embedding provider and live Claude has not yet been run. v1.4 corrects that last clause: the manual live spike has now been run. Both the baseline-RAG scenario and the isolated injection-probe scenario passed against a real Voyage embedding provider and a real Claude model, with repeated rate limiting observed (and worked around via a scenario selector) but no RAG-correctness or evidence-grounding failure in any attempt — see `docs/05-rag-design.md` and `docs/reviews/05-rag-design-spike-results.md` for the full design record and measured results. This does not change any of Challenge 2's design, validation, or testing content below, which described planned/already-implemented behavior accurately; it only updates the one clause that described the live spike as not yet run. v1.5 adds Challenge 3, documenting the implemented Agent Run / Trace Persistence milestone (`packages/database`) — a deliberately smaller, already-built precursor to Challenge 1's full queue-claiming design, described in full in `docs/11-agent-run-persistence.md`. v1.6 adds Challenge 4, documenting a real implementation-time discovery in the Agent Run API milestone (`apps/api`, `docs/12-agent-run-api.md`): `nest build`/`nest start --watch` are architecturally incompatible with this monorepo's pinned `typescript@^7.0.2` (a native rewrite whose public npm export no longer exposes the classic TypeScript Compiler API `@nestjs/cli` depends on internally), resolved by bypassing the Nest CLI's build wrapper in favor of the same plain-`tsc` pattern already used successfully by every other package in this monorepo, rather than downgrading TypeScript. v1.7 revises Challenge 4's Decision/Tradeoffs/Implementation Notes at a focused pre-commit review pass: `@nestjs/cli`/`@nestjs/schematics` and `apps/api/nest-cli.json`, originally kept as an unused "possible future use" placeholder, are now removed entirely as dead configuration/dependencies with no actual justification to keep; `apps/api`'s `build` script now cleans stale `dist/` output before every build, and `start:dev` is now a reliable `pnpm run build && pnpm run start` (no automatic reload — deferred, not silently dropped) rather than the previously untested concurrent `tsc --watch`/`node --watch` pair. |

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

**Relationship to the actual Milestone 6C design (v1.8):** the `pending_actions`/`decided_by`/`RETURNING *` sketch above is planned design tied to the future `AgentJob`-as-queue/`AgentStep` architecture (§ this Challenge, throughout) and remains unimplemented. `docs/13-approval-workflow.md` designs the real, much smaller approval workflow built directly on the schema actually shipped in `docs/11-agent-run-persistence.md` — no `pending_actions` table, no `AgentStep`, no `decided_by`/`APPROVAL_CREATED` trace event. It borrows only the general shape of this SQL pattern (a conditional, row-locked transition guarding against duplicate/concurrent decisions), applied to its own `agent_run_approvals` table and its own lock/compare/exact-replay transaction (`docs/13-approval-workflow.md` §9), not to this table.

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

---

## 7. Challenge 5 — One Public Origin Without the SPA Fallback Swallowing the API

### Context

The production deployment milestone (`docs/08-cicd-deployment.md`) serves the built React app and the
NestJS API from one Render Web Service instead of two, so the browser only ever talks to one origin
and no CORS is needed. `apps/api` is already a `NestExpressApplication`, so `useStaticAssets` plus a
hand-written SPA fallback middleware were added ahead of the JSON body parser and Nest's own routing.

### Problem

Two failure directions exist simultaneously, and a fix for one can silently reintroduce the other:
the SPA fallback must never intercept a real `/v1/**` request destined for the API, and the API's own
catch-all route must never intercept `/` or a deep link before the SPA fallback gets a chance to serve
`index.html`.

### Why It Is Difficult

The approved design plan asserted that `NotFoundController`'s `@All("*splat")` catch-all "only ever
matches `/v1/**`" because of `app.setGlobalPrefix("v1")`, and that this alone made it structurally
impossible for the catch-all to intercept `/`. **Direct testing of the real application showed this
claim is false in this exact stack (NestJS 11 + Express 5 + path-to-regexp v8).** A minimal
reproduction — one controller registered only at an explicit `/v1/ping`, plus the real
`NotFoundController`, both under `setGlobalPrefix("v1")` — showed that `GET /ping` (no prefix) still
returned the application's own `ROUTE_NOT_FOUND` JSON envelope, not Express's default 404 page and not
a silent pass-through. Dumping the underlying Express router's registered layers showed the route
*is* correctly registered as `/v1/*splat`, yet still matched an unprefixed request path in practice —
a genuine, reproducible discrepancy between the registered pattern string and Express 5's actual
match behavior for this specific wildcard construct, not a mistake in how the prefix was configured.
This was found only by instrumenting a real running Nest application and inspecting both its observed
HTTP responses and its live router stack — it is not visible from reading the source of
`app.module.ts`, `not-found.controller.ts`, or `main.ts` in isolation.

### Failure Modes

- If the SPA fallback had been registered **after** Nest's routing (or omitted the `/v1` guard
  entirely), the over-broad catch-all above would swallow `/` and every deep link with a `404
  ROUTE_NOT_FOUND` JSON body before the fallback ever got a chance to serve the app shell — the
  opposite failure from the one the design plan was worried about.
- Conversely, an SPA fallback with **no** `/v1` guard, registered before Nest, would serve
  `index.html` for a genuinely unmatched `/v1/**` path (`/v1/nope`) instead of the API's JSON error
  envelope, silently breaking the "JSON errors under `/v1/**`" contract the frontend and any API
  client rely on.
- An SPA fallback with no extension guard would return `index.html` (200, `Content-Type: text/html`)
  for a missing built asset like `/assets/app-abc123.js`. Browsers send `Accept: */*` for `<script>`
  tags, which satisfies an `Accept`-only content-negotiation check, so this failure is invisible to a
  naive test and surfaces in production as a blank page plus a MIME-type console error, not a clean
  404.
- The `/v1abc` prefix-lookalike case: a naive guard checking `req.path.startsWith("/v1")` (no trailing
  slash) would incorrectly treat `/v1abc` as an API path and forward it into Nest, where it would
  fall through to the (surprisingly broad) catch-all and return a JSON 404 for what should have been
  an ordinary SPA route.
- A case-sensitive guard: Express's router is case-insensitive by default (case-sensitive routing is
  not enabled anywhere in this app), so a real request to `/V1/health/live` reaches the exact same
  Nest route `/v1/health/live` does. A guard comparing `req.path` against the literal lowercase
  string `/v1` would not recognize `/V1/health/live` as an API path, and would incorrectly serve it
  `index.html` — a real request to a real endpoint, silently answered with the wrong body. This was
  the initial implementation's actual behavior until it was corrected.

### Decision

Register `useStaticAssets` and a hand-written `spaFallbackMiddleware` as raw Express middleware,
**before** the JSON body parser and before Nest's routing is wired in, conditional on
`apps/web/dist/index.html` actually existing (so local API-only development is unaffected). The
fallback applies exactly three guards, in order: non-GET/HEAD requests fall through; any path equal
to `/v1` or starting with `/v1/` falls through, compared against a **lowercased copy** of the path
(never the raw path, which is still what the extension check and `sendFile` use) — so `/v1abc` is
correctly treated as *not* an API path (the trailing-slash-aware comparison), and `/V1/health/live`
is correctly treated as *the same API path* `/v1/health/live` is, matching Express's own
case-insensitive routing rather than a stricter rule the router itself does not enforce; any path
with a file extension falls through. Only a request that survives all three guards receives
`index.html` with `Cache-Control: no-cache`.

Because static serving and the fallback are registered **first** in the Express middleware chain
(added via `app.use()` before Nest's own routes are wired in), they get first right of refusal on
every request — this ordering is what actually protects `/` and deep links from the catch-all's
broader-than-expected scope, independent of whatever that catch-all's true matching behavior turns
out to be. The `/v1` guard inside the fallback is what protects the API in the other direction. Both
guards are necessary; neither depends on the (now known to be incorrect) assumption that the global
prefix alone scopes the catch-all.

A useful, unplanned side effect of the catch-all's actual broad scope: a missing static asset that
falls through the fallback's extension guard (`/missing.js`) still receives the application's own
JSON `ROUTE_NOT_FOUND` envelope rather than Express's raw default 404 HTML page — a stricter result
than the original design's stated goal ("missing assets must never return HTML"), reached for a
different reason than originally assumed.

### Alternatives Considered

#### Alternative A — Trust the design plan's stated scoping and add the `/v1` guard "for defense in depth" only

Would have been the wrong reasoning to record even though the resulting code (a `/v1` guard, static
middleware ordered first) happens to be identical to what was actually needed. Verifying the real
behavior mattered because a future change to route registration order or module structure could
silently remove the *actual* protection (middleware ordering) while leaving the guard that was
believed to be sufficient but is not, on its own, load-bearing without ordering.

#### Alternative B — `@nestjs/serve-static`

Rejected per the design plan: it is a new dependency for behavior `useStaticAssets` already provides,
with less explicit control over ordering relative to the existing middleware chain.

### Tradeoffs

- The middleware-ordering dependency is implicit — nothing in the type system enforces that
  `app.use(requestIdMiddleware)`, static serving, and the SPA fallback stay registered before
  `jsonBodyParser`/Nest's routing. This is mitigated by the transport-level integration test
  (`apps/api/test/static-assets.integration.test.ts`), which exercises the assembled pipeline exactly
  as `main.ts` constructs it, rather than testing the fallback middleware in isolation.
- The corrected understanding (the catch-all's real scope is broader than the design plan assumed)
  is recorded here rather than "fixed" in `not-found.controller.ts`, because the observed behavior is
  already exactly what the system needs — a stricter safety net for missing assets, not a bug to
  patch.

### Implementation Notes

`apps/api/src/common/web-assets.ts` (`resolveWebDistDir`, `isWebDistServable`),
`apps/api/src/common/spa-fallback.middleware.ts` (`createSpaFallbackMiddleware`), wired into
`apps/api/src/main.ts` immediately after `requestIdMiddleware` and before `jsonBodyParser`, both
conditional on `isWebDistServable(webDistDir)`.

### Testing Strategy

`spa-fallback.middleware.test.ts` — each guard independently, including `/v1abc` and its alternate-case
counterpart `/V1abc` as their own explicit cases (distinct from `/v1` and `/v1/nope`), plus
`/V1`, `/V1/`, and `/V1/health/live` proving the API-prefix guard falls through regardless of case.
`web-assets.test.ts` — `WEB_DIST_DIR` override, default resolution, and the missing-`index.html` case.
`static-assets.integration.test.ts` — the assembled pipeline via a real Nest test app and Supertest,
with and without a web-dist fixture present, covering `/`, `/deep/link`,
`/v1/definitely-not-a-route`, `/v1/agent-runs/not-a-uuid`, `/missing.js`, `POST /unknown`, and
`GET /V1/health/live` (asserting it reaches the real health route's JSON response, grounded in the
actual observed behavior, not the app shell) in one suite.

### Observability

No new logging — a wrongly-routed request is either a 404 JSON envelope (visible via the existing
request-ID-tagged structured error response) or a served `index.html` with a distinctive
`Cache-Control` header, both directly observable from the response itself without needing new
instrumentation.

### Interview Explanation

> The design I was handed said a global route prefix alone would keep the API's catch-all route from
> ever intercepting the root path, so an SPA fallback's `/v1` guard was framed as defense in depth. I
> didn't take that on faith — I wrote a minimal reproduction with just two routes and dumped the
> actual registered router patterns, and found the catch-all matched an unprefixed path even though
> its registered pattern string was correctly prefixed. That's a real discrepancy in this specific
> framework/HTTP-library version combination, not a config mistake. It didn't change what code I
> shipped — the same guard and the same middleware ordering were still exactly correct — but it
> changed *why* I could claim it was correct, and it meant the real protection was middleware
> registration order, not the prefix. That's the kind of thing you only find by testing the real
> system instead of trusting the design document's stated reasoning.

### Resume Relevance

This problem demonstrates:

- Verifying a design document's stated technical claim against the real running system instead of
  accepting it as ambient truth, by writing a minimal, targeted reproduction
- Distinguishing "the code I would write is unaffected" from "the reasoning I was given for why it
  works is correct" — and recording the corrected reasoning even when the resulting implementation
  does not change
- Designing a guard around the actual protective mechanism (middleware registration order) rather
  than an assumption (route-prefix scoping) that turned out not to hold

---

## 8. Challenge 6 — Reproducible Container Builds for a pnpm Workspace With a Generated Prisma Client

### Context

The production Dockerfile (`docs/08-cicd-deployment.md` §13) builds `apps/api` and its full workspace
dependency chain into a single runtime image, using a `--prod --filter "@opspilot/api..."` install to
keep `apps/worker`'s paid-provider SDKs out of the image entirely.

### Problem

Two independent, unplanned failures surfaced only when the actual built image was run — not when it
was merely built — despite the Dockerfile itself building successfully and passing every build-time
assertion on the first attempt.

### Why It Is Difficult

**Failure 1 — a JavaScript closure trap, not a Docker problem.** `resolveWebDistDir()` accepted an
optional `baseDir: string = __dirname` parameter, intended so `main.ts` could pass its own directory
and the function would resolve `apps/web/dist` relative to it. Inside the running container, `GET /`
returned the API's own `404 ROUTE_NOT_FOUND` JSON instead of the built React app, even though
`/app/apps/web/dist/index.html` demonstrably existed in the image (verified via `docker exec`) and
the default-parameter arithmetic looked correct on inspection. The actual cause: a default parameter
expression is evaluated in the scope where the **function is declared**, not the scope of the
**call site** — so `__dirname` in `resolveWebDistDir`'s default parameter always referred to
`web-assets.js`'s own directory (`apps/api/dist/common/`), one level deeper than `main.js`'s directory
(`apps/api/dist/`), regardless of where or how the function was called. The unit test for this
function did not catch it, because the test always passed `baseDir` explicitly — sidestepping the
exact code path (the default parameter) that was broken. Only running the real container and
observing the wrong HTTP response surfaced it.

**Failure 2 — a Prisma CLI validation quirk with no local reproduction.** After fixing Failure 1,
`docker/entrypoint.sh`'s `prisma migrate deploy` failed inside the container with `P1013`: "the
provided database string is invalid. `datasource.shadowDatabaseUrl` ... must not be an empty string."
`prisma.config.ts` unconditionally declares `datasource.shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? ""`
(needed only by `prisma migrate diff`, used in CI's drift check), and Prisma 7.9's CLI validates that
field for every command, including `migrate deploy`, which never actually connects to it. This
failure mode does not reproduce locally, because `scripts/run-prisma.mjs` loads the repository-root
`.env` (which sets a real `SHADOW_DATABASE_URL` for the drift check), and the container deliberately
ships no `.env` at all. A first attempted fix — defaulting `SHADOW_DATABASE_URL` to `DATABASE_URL`
when unset — produced a second, different Prisma error ("the shadow database you configured appears
to be the same as the main database"), discovered only by actually running that fix against the real
CLI.

### Failure Modes

- A default parameter silently resolving relative to the wrong module's directory, producing a path
  that is subtly wrong (`/app/apps/api/web/dist` instead of `/app/apps/web/dist`) rather than
  obviously broken — the function never threw, `isWebDistServable()` just correctly reported "not
  servable" for the wrong reason.
- A required-but-unused config field (`shadowDatabaseUrl`) blocking an entirely unrelated command
  (`migrate deploy`) with an error message that does not mention `migrate deploy` at all.
- A fix for one CLI validation ("must not be empty") tripping a second, independent CLI validation
  ("must not equal the main database") — the naive first fix looked complete until it was actually
  run.

### Decision

**Failure 1:** removed the default parameter entirely — `resolveWebDistDir(baseDir: string)` is now a
required parameter, and `main.ts` passes its own `__dirname` explicitly. This does not just fix the
bug; it removes the trap's precondition (a default parameter expression referencing a module-scoped
variable), so it cannot silently regress if another caller is ever added.

**Failure 2:** `docker/entrypoint.sh` now defaults `SHADOW_DATABASE_URL` — before invoking
`prisma migrate deploy` — to a fixed, obviously-fake placeholder using the `.invalid` TLD (RFC 2606,
guaranteed never to resolve), only when the variable is not already set. This satisfies both of
Prisma's validations (non-empty, and not identical to `DATABASE_URL`) without creating any real
second-database dependency, since `migrate deploy` never dereferences the value.

### Alternatives Considered

#### Alternative A (Failure 1) — Keep the default parameter, adjust the relative-path arithmetic to account for the extra `common/` subdirectory

Rejected: it would keep the trap in place for any future file that imports `resolveWebDistDir` from a
different directory depth, and would make the function's correctness depend on callers knowing an
implementation detail (its own file's location) that has nothing to do with their own code.

#### Alternative B (Failure 2) — Modify `packages/database/prisma.config.ts` to omit `shadowDatabaseUrl` entirely when `SHADOW_DATABASE_URL` is unset

Would fix the root cause more directly, but `prisma.config.ts` is shared by every consumer of the
database package (`migrate dev`, `migrate diff`/the CI drift check, local development), all of which
already work correctly today via the repository-root `.env`. Changing shared, already-working
configuration to fix a problem that is entirely specific to the container's "no `.env` file" runtime
environment was judged riskier than a fix scoped to the one script that actually has the problem —
`docker/entrypoint.sh`, which is new in this milestone and touches nothing else.

### Tradeoffs

- The `SHADOW_DATABASE_URL` placeholder is a small piece of "spooky action at a distance": a reader of
  `docker/entrypoint.sh` needs the accompanying comment to understand why a shadow-database URL is
  being set at all in a script that only ever runs `migrate deploy`. Mitigated with an explicit
  comment recording both Prisma error messages verbatim and the fact that they were found by running
  the real CLI, not inferred from documentation.
- Neither failure was caught by the existing source-level tests — both are genuinely
  runtime/environment-dependent (module-resolution scope in one case, Prisma CLI behavior with no
  `.env` present in the other), and both were discovered only by running the actual built image. This
  is not a claim that no regression test could ever be written for either one — `web-assets.test.ts`
  could exercise the removed default parameter's exact failure shape directly, and a narrower
  integration test could shell out to the real Prisma CLI with no `.env` present without needing a
  full container — only that the tests already in place before this milestone did not, and would not
  have, exercised either path. This is the concrete argument for why the `docker-smoke` CI job's full
  container run (`docs/08-cicd-deployment.md` §20) exists at all, rather than relying on unit and
  mocked-transport tests alone.

### Implementation Notes

`apps/api/src/common/web-assets.ts` — `resolveWebDistDir(baseDir: string)`, called as
`resolveWebDistDir(__dirname)` from `apps/api/src/main.ts`. `docker/entrypoint.sh` — the
`SHADOW_DATABASE_URL` default is set once, near the top of the script, before any Prisma invocation,
and exported so it reaches the `prisma migrate deploy` child process the same way `DATABASE_URL`
already does.

### Testing Strategy

Both failures were found by, and are now guarded against by, running the actual built image locally
end to end (`docker build`, then `docker run` against a real local PostgreSQL instance, then `curl`
against `/` and `/v1/health/ready`) before opening the pull request. The existing source-level test
suite did not catch either one — not because a regression test is impossible in principle (see the
Tradeoffs section above), but because neither the unit tests nor the mocked transport tests exercised
the real module-resolution path or the real Prisma CLI. The same full-container sequence is automated
in the `docker-smoke` CI job so it is proven on every pull request, not only when a human happens to
run it locally.

### Observability

`docker/entrypoint.sh` logs every failed migration attempt to stderr already (§ Challenge 7 below);
the `SHADOW_DATABASE_URL` default does not need its own log line, since a Prisma validation failure
against it would itself be loud and immediate, not silent.

### Interview Explanation

> Two bugs only showed up once I actually ran the built container, not when it built successfully or
> when unit tests passed. One was a JavaScript scoping trap — a default parameter of `= __dirname`
> silently resolves against the file where the function is *defined*, not where it's *called*, so a
> path-resolution helper was quietly looking one directory too deep. The fix wasn't to patch the
> arithmetic, it was to remove the default parameter entirely and make callers pass their own
> `__dirname` explicitly, so the trap can't come back. The other was a Prisma CLI quirk with no local
> reproduction: a config field only used by one command was still being validated by a completely
> different command, and my first fix for it tripped a second, different validation I only discovered
> by actually running it. Both are the reason I don't trust "it built" or "the unit tests pass" as
> proof a container actually works — I ran the real image against a real database before calling
> either one done, and that's exactly what the `docker-smoke` CI job now automates for every PR.

### Resume Relevance

This problem demonstrates:

- Recognizing a JavaScript/TypeScript default-parameter closure trap and fixing its root precondition
  rather than patching around the symptom
- Diagnosing a third-party CLI's undocumented validation behavior by running it directly against a
  minimal reproduction, twice, after the first attempted fix revealed a second independent check
- Understanding the limits of unit and mocked-integration testing for container-specific,
  environment-dependent failure modes, and building the CI coverage (a full container run) that
  actually closes that gap

---

## 9. Challenge 7 — Where a Startup Retry Actually Belongs

### Context

Render's free tier and Neon's free tier both auto-suspend after a period of idle traffic, so the
first request after idle needs to tolerate a database that takes a few seconds to wake up. The
production deployment needed exactly one place in the system that retries a database connection on
startup.

### Problem

The obvious home for "retry the database connection on startup" is the application's own lifecycle
hook — `PrismaLifecycleService.onModuleInit`, which already runs a `SELECT 1` and already fails the
whole application fast if it cannot reach the database. An early draft of the deployment design put
the retry there.

### Why It Is Difficult

In this container, the application's own `SELECT 1` is **not** the first thing that touches the
database. `docker/entrypoint.sh` runs `prisma migrate deploy` before `exec`-ing the Node process at
all — so by the time `PrismaLifecycleService.onModuleInit` would run, either the migration already
succeeded (in which case the database is demonstrably awake and a second retry is pure latency for no
benefit) or the migration already failed and the container has already exited via `set -e`, meaning
`onModuleInit` — and any retry logic inside it — would never execute at all. A retry placed in the
lifecycle service would have looked completely correct in every unit test (which exercises the
service directly, never the entrypoint script that runs before it) while being structurally
unreachable in the one scenario it was built for. Spotting this required reading the entrypoint script
and the lifecycle service together, as a sequence, rather than reviewing either file in isolation —
the bug is in the relationship between two files that individually look correct.

### Failure Modes

- A retry in `PrismaLifecycleService` with the entrypoint's migration step unmodified: the entrypoint
  either succeeds (retry never needed) or exits non-zero on migration failure before Node ever starts
  (retry never reached) — the retry code exists but no code path ever benefits from it.
- Two independent retry policies (one in the entrypoint around `migrate deploy`, one in the lifecycle
  service around the boot-time `SELECT 1`) would double the worst-case startup latency for no
  additional reliability, and would require keeping two sets of retry-budget environment variables
  synchronized in meaning if not in name.
- A retry that silently classifies "transient" vs. "permanent" PostgreSQL errors to retry the former
  and fail fast on the latter is more sophisticated, but a misclassification (retrying a genuinely
  broken migration for the full budget before giving up, or failing fast on a legitimately transient
  wake-up delay) is a worse outcome than a short, dumb, fixed delay applied uniformly.

### Decision

The retry lives entirely in `docker/entrypoint.sh`, around `prisma migrate deploy` — the actual first
database contact. `PrismaLifecycleService` stays exactly as it was: fail-fast, unmodified, no retry.
By the time Nest boots, the entrypoint's successful migration has already proven the database
reachable, so the lifecycle service's own `SELECT 1` needs no retry of its own — a failure there after
a successful migration would indicate the database went away *during* startup, a different condition
than "was asleep at the start," and one the API's existing fail-fast behavior already handles
correctly. The retry itself is deliberately unsophisticated: a fixed number of attempts (default 5), a
fixed delay (default 3 seconds, no backoff, no jitter), and no inspection of the underlying error at
all — a broken migration and a slow-to-wake database are retried identically and both eventually
either succeed or exhaust the budget (worst case roughly 12 seconds at the defaults) and exit
non-zero.

### Alternatives Considered

#### Alternative A — Retry in `PrismaLifecycleService.onModuleInit` (the original draft)

Rejected once the entrypoint/lifecycle-service ordering was traced end to end: structurally
unreachable in the scenario it exists for, per Why It Is Difficult above.

#### Alternative B — Classify PostgreSQL errors and retry only transient ones (connection refused / timeout), fail immediately on schema errors

Would in principle fail faster on a genuinely broken migration. Rejected for a single-instance
portfolio demo: correctly classifying transient-vs-permanent Postgres errors is its own nontrivial
problem, and getting that classification wrong (treating a permanent failure as transient, retrying it
uselessly, or the reverse) is a worse failure mode than a bounded ~12-second delay applied uniformly.

### Tradeoffs

- A genuinely broken migration surfaces roughly 12 seconds later (at default settings) than a
  no-retry design would, because the entrypoint cannot distinguish it from a slow database wake-up.
  Accepted explicitly — see `docs/08-cicd-deployment.md` §21.
- The retry logs every failed attempt to stderr specifically so a database that *routinely* needs
  2–3 attempts is visible in Render's logs as a signal to investigate, rather than silently absorbed
  into "the deploy just took a bit longer" — the retry is deliberately not tuned to hide a
  persistently degraded database.
- Both retry knobs (`MIGRATION_RETRY_ATTEMPTS`, `MIGRATION_RETRY_DELAY_SECONDS`) are
  environment-overridable specifically so the `docker-smoke` CI job can exercise the
  exhaustion path deterministically and quickly (`MIGRATION_RETRY_ATTEMPTS=2`,
  `MIGRATION_RETRY_DELAY_SECONDS=1`) without waiting through the production defaults.

### Implementation Notes

`docker/entrypoint.sh` — POSIX `sh`, `set -e`, a `run_migrations` function invoked as a bare command
(so a non-zero return trips `errexit` and the container exits before the final `exec`), with
`cmd && return 0` inside the retry loop being the one place failure is deliberately tolerated, and
only up to the configured budget. `PrismaLifecycleService`
(`apps/api/src/persistence/prisma-lifecycle.service.ts`) is untouched by this milestone — its
`onModuleInit`/`onModuleDestroy` and its own existing test coverage remain exactly as they were before
this container work began.

### Testing Strategy

The retry is verified behaviorally, not via a lifecycle-service unit test, because there is nothing
new to unit-test in the lifecycle service — it did not change. `docker-smoke` (§20) covers both
directions with the real container: the normal path (migrations apply against a genuinely empty
database on the first attempt) and the exhaustion path (an unreachable database,
`MIGRATION_RETRY_ATTEMPTS=2`/`MIGRATION_RETRY_DELAY_SECONDS=1`, asserting the container exits
non-zero, the exact configured number of failed attempts appear in the logs, and the API's
"listening" line never appears — i.e. it never bound a port).

### Observability

Every failed attempt logs `prisma migrate deploy attempt N/M failed; retrying in Ds` to stderr; final
exhaustion logs a distinct `prisma migrate deploy failed after N attempt(s); aborting startup` line —
both fixed, greppable strings a deploy-log viewer (Render's own log stream) surfaces without any
additional instrumentation.

### Interview Explanation

> The natural place to put "retry the database on startup" is the application's own lifecycle hook —
> that's where we already had a `SELECT 1` health check. But in this container, the application isn't
> the first thing that touches the database at all; a migration step runs before the app process even
> starts, inside the entrypoint script. A retry in the app would either never be needed (the migration
> already proved the database awake) or never be reached (the migration already failed and the
> container already exited). I found this by reading the entrypoint and the lifecycle service
> together as a sequence, not by reviewing either file alone — individually they both looked correct.
> The fix was moving the retry to the actual first point of contact and leaving the application's own
> fail-fast check untouched, so there's exactly one retry policy in the system instead of one that
> works and one that's silently dead code.

### Resume Relevance

This problem demonstrates:

- Tracing an actual runtime sequence across multiple files/processes (an entrypoint script, then an
  application lifecycle hook) rather than reviewing each file's correctness in isolation
- Recognizing when additional resilience logic (a retry) is dead code because the failure mode it
  targets can never reach it, and removing the wrong copy rather than keeping both "just in case"
- Choosing a deliberately simple, unclassified retry policy over a more sophisticated one, with an
  explicit argument for why the simpler policy's worst case is preferable to the sophisticated
  policy's failure mode

---

## 10. Challenge 8 — Agent Execution Complete != Human Workflow Complete

### Context

`apps/web`'s run-detail page (`docs/14-web-ui.md` §8) renders a completed investigation's timeline,
report, and an approval panel for runs with at least one suggested action. A live walkthrough of the
approval-demo flow surfaced a usability bug in this page's layout, not in any backend behavior.

### Problem

Once an approval-demo investigation finished, the page looked entirely done — a success-toned run
status badge, the full generated report, evidence — while a human decision (`PENDING`) was still
outstanding. The only decision control on the page, `ApprovalPanel`, was the literal last DOM node:
below the entire report, in a right-hand column that was a plain 50/50 split of the viewport width
even on desktop. A reviewer had to scroll past the whole report to discover that anything was still
required of them, and on any viewport narrower than the page's one existing breakpoint (1024px), that
was the full page's scroll length.

### Why It Is Difficult

The bug is not a missing feature — every piece of information a reviewer needs (the badge, the report,
the decision form) was already on the page, correctly rendered, fully tested. The problem is purely
about **where** that information sits and **how it competes for attention**, which is invisible to any
test that only checks for the presence of text or a control (`screen.getByText`/`getByRole`) — exactly
the kind of test this codebase already had in abundance (`App.approval.test.tsx`'s 16 cases). None of
them failed, because none of them encoded "and it must be reachable without scrolling." A second,
subtler difficulty: the obvious naive fixes each traded one usability problem for a worse one —
auto-scrolling to the decision on page load solves discoverability by taking control away from the
reader mid-report; duplicating the Approve/Reject buttons at both the top and bottom of the page solves
discoverability by creating two live, irreversible-decision buttons that must somehow stay
synchronized; and a sticky panel with no width limit solves visibility but pushes the actual report —
the thing a reviewer is there to read — into a cramped remainder column.

### Failure Modes

- **Auto-scroll/auto-focus on run completion.** Immediately jumping the reader to the decision as soon
  as a run finishes actively fights a reader who is still reading the report top-to-bottom, and is
  disorienting for a screen-reader user who did not initiate the movement.
- **Duplicated Approve/Reject controls** (one copy near the top, one near the bottom). Two live buttons
  for the same one-time, irreversible action is a double-submission hazard in its own right and forces
  every future change to the decision form to be kept in sync in two places.
- **An unconstrained-width sticky panel.** Making the context column sticky without a width cap (a
  naive first pass literally used `1fr 1fr`, giving the decision panel half the page) fixes visibility
  at the cost of compressing the actual report — the primary reading surface — to match it.
- **A single flat "not eligible" state used for two different facts.** Presenting `approval === null`
  (no approval data yet — still loading, or the last fetch failed) identically to a permanent,
  backend-computed `NOT_ELIGIBLE` would tell a reviewer "this run will never have anything to approve"
  when the real, transient cause might be a dropped network request.

### Decision

A frontend-only, backend-contract-unchanged redesign (`ApprovalStatus`, `ApprovalView`,
`presentApproval`'s inputs/outputs, and the `201`/`200`/`409`×2 handling in `App.tsx` are all reused
exactly as they were): a two-column run-detail grid, `minmax(0, 1fr) minmax(18rem, 22rem)`, keeping the
timeline/report as the flexible, visually dominant main reading surface while a new, reusable
`RunContextPanel` occupies a width-capped, sticky-on-desktop side column. `RunContextPanel` is a thin,
three-way switch — `approval === null` and `approval.status === "NOT_ELIGIBLE"` both render a new
`RunOverviewPanel` (run facts only for `null`; run facts plus the *reused* `presentApproval` eligibility
badge/copy/hint for `NOT_ELIGIBLE`, explicitly never conflated with each other), while `PENDING` /
`APPROVED` / `REJECTED` render the existing `ApprovalPanel`, whose decision semantics remain unchanged. A stateless `ActionRequiredBanner`
— a single native link to `#approval-heading`, never a second copy of the decision buttons — appears
only while `approval?.status === "PENDING"`, and the existing accessible notice region (not a new live
region) announces the pending state with wording that distinguishes a fresh completion from an explicit
refresh (see Implementation Notes).

### Alternatives Considered

#### Alternative A — Auto-scroll to the decision panel on run completion

Rejected outright: takes control away from a reader still reviewing the report, and moves focus/scroll
position without any user-initiated action — a poor experience for both sighted and assistive-technology
users.

#### Alternative B — Duplicate Approve/Reject controls at both the top and bottom of the page

Rejected: two live buttons for one irreversible decision is a correctness hazard (which one did the
reviewer mean to click, and did both fire?), not only a code-duplication concern.

#### Alternative C — Modal/drawer for the decision form

Rejected: blocks reading the report and the decision side by side, which is plausibly the most
important capability for an actual reviewer, and is a materially larger diff (focus trap, backdrop,
dismiss handling) for no stated benefit over a sticky column.

#### Alternative D — Accordion / collapsed-by-default decision section

Rejected: requires an extra click just to discover a decision is even needed, which re-creates a milder
version of the original "buried" bug rather than fixing it.

#### Alternative E — Whole-context-column `max-height`/`overflow-y: auto` sticky region

An earlier draft made the entire sticky context column internally scrollable, bounded to the viewport
height. Rejected on review: real context-panel content (a badge, a sentence or two, a short form or a
short record) is only ever a few hundred pixels tall, so a column-wide scroll region added a nested
page-scroll/column-scroll interaction for no benefit in the common case. The one place content can
genuinely exceed a short viewport — a reviewer note up to 1000 characters — is handled narrowly instead:
`white-space: pre-wrap; overflow-wrap: anywhere;` lets the terminal panel simply grow taller, relying on
ordinary page scrolling rather than a second, internally-scrollable region that would need its own
keyboard/focus handling to stay accessible.

### Tradeoffs

- The banner and the sticky panel are deliberately complementary, not redundant: the banner solves
  discoverability at the instant a run completes; the sticky panel solves staying visible while the
  reviewer subsequently scrolls a long report. Removing either reintroduces a version of the original
  problem.
- Sticky positioning applies uniformly to the context column regardless of which of its three states is
  showing, rather than only while `PENDING`. This is simpler (one CSS rule, no state-dependent class)
  and avoids layout jank exactly when a decision is submitted and the panel's content changes shape
  mid-scroll — accepted as a reversible, one-line judgment call.
- No second (tablet) breakpoint was introduced. Sticky positioning only makes sense once the two-column
  grid already exists at the same width the grid itself activates at (`64rem`); container-width
  arithmetic at exactly that breakpoint (`.app-shell`'s `max-width: 84rem` and `padding: var(--space-6)
  var(--space-5)`, worked through against the `minmax(18rem, 22rem)` context-column bound) showed no
  squeeze occurs there, so a second breakpoint would be unjustified complexity.

### Implementation Notes

The main-column wrapper is a `<div role="region" aria-label="Run detail">`, not a `<section>` —
deliberately, because the stylesheet's existing `.investigation-content section` rule gives any nested
`<section>` card styling, and using a `<section>` for the outer wrapper would have produced an
unintended outer card wrapping the already-carded timeline and report sections one level down.
`RunOverviewPanel`'s `NOT_ELIGIBLE` copy/hint is never a second hand-written string — it calls the
existing, exported `presentApproval("NOT_ELIGIBLE", suggestedActionCount)` directly, so the "Approval
workflow demo" checkbox hint text stays defined in exactly one place. The accessible pending
announcement reuses the one existing `role="status" aria-live="polite"` notice region rather than
adding a second live region; `loadApproval()`'s return type changed from `Promise<void>` to
`Promise<ApprovalView | null>` specifically so `runInvestigation`/`retryRun`/`refreshRun` could each
choose the right wording — `"Investigation completed. Human approval required."` for a fresh
completion/retry, `"Run refreshed. Human approval required."` for an explicit refresh that is still
pending (never implying the investigation just completed), and the unchanged `"Run refreshed."` for a
refresh that resolves to anything else. The `Action required` banner links to `#approval-heading` via a
plain native anchor; `tabIndex={-1}` was added to the timeline, report, and approval headings, making
each one programmatically focusable and giving the native fragment link its baseline mechanism with
zero JavaScript. Real-browser confirmation that activating the link both scrolls to and visibly focuses
the target heading remains an open manual-verification item (Testing Strategy, below) — a small,
explicit `scrollIntoView`/`.focus({ preventScroll: true })` fallback was deliberately *not* added
preemptively, and would only be introduced if that verification showed the native behavior unreliable.

### Testing Strategy

Structural/DOM-order assertions (`App.run-context-layout.test.tsx`) verify what jsdom actually can:
banner presence keyed to `PENDING`, the banner preceding the named "Run detail" region in source order,
exactly one Approve/Reject button while pending, the `RunContextPanel` three-way switch (including the
direct regression case for `approval === null` never showing an eligibility claim), all three notice
wordings, `tabindex="-1"` on the three section headings, and a long reviewer note remaining a single,
non-duplicated `<dd>`. The one `compareDocumentPosition()` call in that file is explicitly a structural
DOM-order check, not a simulation of visual order — both compared elements are still located via
`getByRole`, not a CSS selector. What jsdom cannot prove — real `position: sticky` behavior, real
no-scroll initial visibility on an actual viewport, real fragment scrolling and focus landing, and real
`prefers-reduced-motion` behavior — are open manual-verification items (`docs/14-web-ui.md` §11), not
yet performed as of this implementation session, and are documented here as such rather than silently
assumed or claimed as done. All five pre-existing web test suites pass with zero modifications,
confirmed by grep before making any change: none of their assertions depended on `ApprovalPanel`'s DOM
ancestry, any CSS class name, or the notice region's exact text.

### Observability

This is a client-only layout change with no server-side logs, metrics, or alerts to add — the existing
accessible notice region (`role="status" aria-live="polite"`) is itself the only user-facing "signal"
this change touches, and its wording accuracy (fresh completion vs. refresh) is covered by the automated
tests above rather than any runtime telemetry, since `apps/web` has no analytics/telemetry pipeline to
begin with (`docs/14-web-ui.md` §1's non-goals).

### Interview Explanation

> We had a subtle usability bug where a finished investigation and a finished *human decision* looked
> identical on the page, because the one decision control sat below an entire report in a plain 50/50
> column — nothing was missing, it just wasn't reachable without scrolling. The interesting part wasn't
> the fix itself, it was ruling out the obvious-looking fixes first: auto-scrolling to the decision
> fights a reader who's still reviewing the report, and duplicating the Approve/Reject buttons top and
> bottom creates a real hazard for an irreversible action. We landed on a banner that just links to the
> decision, paired with a sticky, width-capped context column so the report stays the dominant thing on
> the page while the decision stays reachable. None of it touched the backend at all — the whole fix is
> a routing/layout decision one level above already-correct, already-tested components.

### Resume Relevance

This problem demonstrates:

- Distinguishing "the information is on the page" from "the information is discoverable," and treating
  the latter as a real, testable requirement rather than a subjective polish item
- Recognizing that the naive fixes for a discoverability bug (auto-scroll, duplicated controls, an
  unconstrained sticky panel) each trade it for a worse, more hazardous problem, and choosing a design
  that avoids all three failure modes at once
- Keeping a frontend-only UX fix strictly decoupled from its backend contract, reusing an existing,
  independently-tested presentation seam (`presentApproval`) rather than duplicating its copy
- Separating what an automated (jsdom) test can prove from what only a real browser can, and reporting
  the difference explicitly rather than letting a passing test suite imply more coverage than it has

---

## 11. Challenge 9 — A Live Provider That Cannot Quietly Become a Fake One

### Context

The agent runtime was provider-neutral from the start: `LlmProvider` → `AgentTurnResult`, with a
deterministic `FakeLlmProvider` behind it. A working Claude adapter existed, but only as something
two hand-run spike scripts could reach — it read `process.env` inline and had no timeout, retry,
cancellation, cost, or configuration story. This milestone promoted it to a configuration-selected
provider while leaving the deployed HTTP API and the public deployment deterministic.

### Problem

Adding a real, billed, non-deterministic dependency to a codebase whose entire test and deployment
story depends on determinism, without weakening either.

Four constraints pulled against each other:

1. CI must need no credential and make no provider call.
2. The public deployment must stay fake-only, provably, not by convention.
3. The live path must be genuinely exercisable, or it proves nothing.
4. The adapter must be reusable by a second consumer later without being copied.

### Why It Is Difficult

The failure mode that matters is not "the live call breaks." It is "the live call silently does not
happen and everything looks green." A fallback-to-fake path, an unset environment variable, or a
default that resolves to the deterministic provider all produce a passing run that proves nothing —
and the more safety scaffolding you add, the more places that silent downgrade can hide.

The second difficulty is that "correct" for cost and duration is not what it first appears. A
per-attempt timeout multiplied by an attempt count looks like a wall-clock bound and is not one. A
token count multiplied by a headline rate looks like a cost and is not one, if a promotional rate has
expired or the response reported cache tokens without the detail needed to price them.

### Failure Modes

- A live smoke that runs green against the deterministic provider because a variable was unset.
- An adapter placed in the shared runtime package, pulling the vendor SDK into the production image.
- A documented "worst case duration" that the system can exceed, because backoff was not counted.
- A cancellation seam described as a whole-run deadline when it only reaches provider calls.
- A cost figure computed at a rate that expired, reported with the same confidence as a valid one.
- Cache-creation tokens priced at one TTL's rate when the response never said which TTL applied.
- A retry stack compounding across SDK, application, and orchestrator layers.
- A credential reaching a log line through a validation error, a `JSON.stringify`, or SDK debug output.

### Decision

**Fail closed at every boundary, and make the impossible states unrepresentable.**

- The execution mode stays the provider-neutral `FAKE | LIVE` the database already persists. The
  vendor lives in model metadata, not in the mode enum.
- Provider selection is a discriminated union, so a LIVE selection cannot omit its model and a FAKE
  selection cannot carry one. It references no database type, which is what keeps the adapter movable.
- There is no fallback anywhere. Invalid LIVE configuration throws; a LIVE selection the factory
  cannot satisfy throws; the smoke's gate exits non-zero. None of them degrade to FAKE.
- The supported model set is exactly one, validated at configuration time, because the request policy
  (thinking disabled alongside a forced tool choice) is validated for that model only.
- The SDK is the sole retry owner. A caller-owned `AbortSignal` bounds Anthropic
  provider calls across the run; tool, retrieval, and persistence cancellation are
  deliberately not wired in this milestone, so it is not a whole-run deadline.
- An estimate that cannot be produced correctly is `null` with a reason, never a number.

### Alternatives Considered

#### Alternative A — put the adapter in `packages/agent-runtime`

Rejected. That package is copied into the production image, and CI asserts the vendor SDK is absent
from it. Moving the adapter there would delete a structural guarantee to save one directory hop.

#### Alternative B — add `AGENT_RUN_PROVIDER_MODE=CLAUDE`

Rejected. The database persists `FAKE | LIVE`; introducing a third value would create a
config/schema mismatch needing a later migration, to express something that belongs in model
metadata anyway.

#### Alternative C — record the SDK's actual retry count

Rejected. The response exposes no reliable standard field for it. Reporting one would be invention
dressed as telemetry; the configured ceiling is recorded instead, which is true by construction.

#### Alternative D — a second output-token budget variable

Rejected. The turn input already carries `maxOutputTokens`. A second authority with no defined
precedence would silently override a caller that had deliberately lowered its budget.

### Tradeoffs

Supporting exactly one model is a real limitation, taken deliberately: a validated narrow claim is
worth more than a broad unvalidated one, and the constraint is enforced where it is cheap to relax.
Cost estimates expire by design rather than drifting silently, which means someone must update a
table — the alternative is a number that is confidently wrong.

### Implementation Notes

- Rates are integer nanoUSD per token, so five token categories sum exactly rather than accumulating
  floating-point noise. Every published rate lands on an integer in those units.
- The estimator takes an injected observation time, so no test depends on the calendar and nothing
  starts failing on a promotional rate's expiry date.
- Error classification order is load-bearing three times over: abort extends the base API error;
  the timeout class extends the connection class; and the SDK maps every 5xx to one class, so a 504
  must be caught by status before that check.
- The API key is stored non-enumerably with `toJSON` and `inspect.custom` overridden — covering
  serialization, logging, enumeration, and spreads. Validation errors name variables, never values.
- A boundary test parses every adapter source and rejects any import outside the directory, which is
  what keeps a future package move mechanical.

### Testing Strategy

Mocked-transport unit tests for every error category, signal forwarding, cache-usage extraction, and
secret redaction; an integration test driving the unmodified orchestrator's two-turn flow through the
real adapter against scripted response fixtures; gate tests that prove the smoke refuses every
invalid invocation without a network call; and cost tests covering each pricing status with injected
dates.

The boundary test earned its place immediately — it caught a violation on first run (its own doc
comment cited a forbidden import as an example), which proved the detection worked before it had
anything real to catch.

### Observability

One sanitized log event per turn: provider, model, request and message IDs, latency, stop reason, the
five token categories, the configured retry ceiling, and the cost estimate with its full pricing
basis. No raw payload, prompt, ticket content, header, or credential — enforced by test, and by
constructing the SDK client with logging disabled so its own debug output can never leak a body.

### Interview Explanation

> The interesting risk in adding a live model provider wasn't that the call might fail — it was that
> it might silently *not happen*. A smoke test that falls back to the deterministic provider passes,
> looks like proof, and proves nothing. So the design rule was fail-closed everywhere: no fallback
> path exists, invalid configuration throws before a client is constructed, and provider selection is
> a discriminated union so a live selection can't be missing its model in the first place.
>
> Three things I'd flagged as "done" turned out to be wrong under scrutiny. I'd documented worst-case
> duration as per-attempt timeout times attempts — but retry backoff and `retry-after` add time no
> per-attempt timeout bounds. I then overcorrected and called the caller's abort signal the total
> bound on the run, which it also isn't: it reaches the provider calls, while tool, retrieval, and
> persistence cancellation stay unwired, so it is a deadline covering Anthropic calls and nothing
> more. And I'd
> planned to log the SDK's actual retry count, which the response doesn't reliably expose; I record
> the configured ceiling instead, because a number you can't source is worse than no number. Cost
> follows the same rule: it expires rather than drifting, and returns null with a reason when the
> response lacks the detail to price it.

### Resume Relevance

This problem demonstrates:

- Treating "silently passes without doing the work" as the primary risk of adding a live dependency,
  and designing every boundary to fail closed rather than degrade
- Using the type system to make invalid states unrepresentable, and keeping database types out of a
  provider abstraction so it stays relocatable
- Correcting three plausible-but-wrong claims — a duration formula, an overstated cancellation
  scope, and an unobservable metric — rather than shipping documentation the system does not honour
- Treating a source-scanning guard's own false positive as evidence the guard works, and fixing the
  scanner rather than loosening the rule it enforces
- Enforcing an architectural boundary with an executable test instead of a convention, so a future
  package move stays mechanical

---

## 12. Challenge 10 — Two Interop Traps That Type-Check Perfectly and Fail at Runtime

### Context

PR 6B1 moved the Claude adapter out of `apps/worker/src/providers/` into
`packages/provider-claude` so both `apps/worker` and `apps/api` could consume it, and gave the API a
caller-owned deadline plus client-disconnect cancellation for live runs.

Challenge 9 had already made the move mechanical: `module-boundary.test.ts` existed specifically so
that nothing in the directory reached back into the worker, and the move was indeed a clean
`git mv` of 17 files. The two defects below were not in the moved code at all. They were in the
*consequences* of moving it, and both had the same shape — code that satisfies the compiler, passes
the package's own unit tests, and is wrong.

### Problem

**Trap 1 — the module-format inversion.** `apps/worker` is ESM and consumes CommonJS workspace
packages through a *default* import (`import pkg from "@opspilot/agent-runtime"`), because
`packages/agent-runtime/src/index.ts` deliberately uses plain-`const` exports so vite-node's interop
forwards them. Four of the moved files did exactly that. Once they lived in a package that
*compiles to CommonJS*, the same line inverted: TypeScript emits `agent_runtime_1.default`, and
because the imported module sets `exports.__esModule = true`, the `__importDefault` helper passes it
through unwrapped, so `.default` is `undefined`.

**Trap 2 — the disconnect signal.** The obvious way to notice a caller going away is
`request.on("close")`. `IncomingMessage` emits `close` when its readable side finishes, which for an
ordinary `POST` with a small JSON body is as soon as the body has been read — before the handler has
done any work. Guarding it with `response.writableEnded` does not help, because nothing has been
written yet either, so the guard is false and the abort fires anyway.

### Why It Is Difficult

Neither is visible where you would look for it.

Trap 1 type-checks cleanly, and `pnpm --filter @opspilot/provider-claude run test` passes — because
vite-node transforms the `.ts` *source* with ESM semantics rather than loading the built `.js`. The
failure appears only when a consumer loads `dist/`, which is why it surfaced as an unrelated-looking
worker test failure: `Cannot destructure property 'estimateCostUsd' of 'agent_runtime_1.default' as
it is undefined`, thrown from `packages/provider-claude/dist/claude-pricing.js`.

Trap 2 is worse, because its failure mode is plausible. A live run cancelled immediately looks like a
provider timeout, a network problem, or a flaky test — not like a listener on the wrong object. And
it would have been *masked* in every unit test that mocks the response, since a mock never emits
`close` at all.

### Failure Modes

| Trap | Symptom | Where it would have been caught |
| --- | --- | --- |
| 1 | `undefined` destructured from a workspace package, only via `dist/` | The worker's existing test suite — by accident |
| 1 | `Object.keys()` lists the export; reading it yields `undefined` | Nowhere, if the package had no ESM consumer |
| 2 | Every live run aborts before its first provider call | Nowhere — mocked responses never emit `close` |
| 2 | Recorded as `PROVIDER_CANCELLED`, indistinguishable from a real client disconnect | Nowhere |

### Decision

**Trap 1: named imports inside the CommonJS package, and a test that enforces it.** All eight files
were converted to `import { x } from "@opspilot/agent-runtime"` — the same style `apps/api` (also
CommonJS) already uses. The four *test* files were converted too, even though they were not broken,
because leaving two import styles side by side in one package is an invitation to copy the wrong one
into a source file.

Enforcement is `module-boundary.test.ts`'s new "never default-imports a workspace package" case. A
comment is not sufficient here: the correct style is *opposite* in two packages of the same
repository, so the rule cannot be remembered, only checked.

`packages/provider-claude/src/export-surface.test.ts` covers the mirror-image risk in the package's
own barrel — no value re-exported through a getter — and `apps/worker/src/smoke/cjs-interop-smoke.ts`
gained six checks, because it is the only place that exercises the built CommonJS output under the
real `tsx` runtime rather than under Vitest.

**Trap 2: observe the response, never the request.** `createRequestAbortHandle(response)` takes only
a `ServerResponse` — the request object is not a parameter, so the wrong listener cannot be attached
by mistake. `finish` marks the handle settled and never aborts; `close` aborts only when
`!response.writableFinished`. `writableFinished` rather than `writableEnded` is deliberate: the
former is true only once data has actually flushed, so a socket dying mid-flush is correctly a
disconnect rather than a clean finish.

### Alternatives Considered

- **Keep default imports and add `esModuleInterop` shims.** Rejected: it would make the package's
  emitted output depend on a helper's behaviour that is itself the thing that broke.
- **Compile `packages/provider-claude` to ESM.** Rejected: `apps/api` is CommonJS and
  `@opspilot/database`'s generated Prisma client is `moduleFormat = "cjs"`. Introducing a dual-format
  package to avoid an import-style rule is a much larger commitment than the rule.
- **`request.aborted`.** Rejected: deprecated, and it answers the same question the wrong object was
  being asked.
- **A wall-clock timer alone, with no disconnect detection.** Rejected: it would hold a live provider
  call open for the full 120-second budget after the caller had already left.

### Tradeoffs

The import-style rule is genuinely counterintuitive — "use named imports here, default imports one
directory over" — and a reviewer who knows only the worker's convention will read the diff as a
regression. That cost is accepted because the alternative is a runtime failure that no amount of
type-checking catches. The test comment carries the explanation, so the answer arrives with the
failure rather than requiring archaeology.

`createRequestAbortHandle`'s narrow signature means it cannot ever report a disconnect that happens
after the handler returns. That is a real limitation and it is stated in the module's own doc comment
rather than left for someone to discover.

### Testing Strategy

Trap 2's suite is written against a `FakeResponse` extending `EventEmitter`, so all six cases are
deterministic and the one that matters most — *normal finish does not abort* — is asserted first. It
would have failed against the `request.on("close")` design. Listener counts are asserted directly,
because a handle that aborts correctly but leaks listeners is still a defect.

Trap 1's enforcement is a source scan rather than a runtime assertion, since the runtime symptom
appears only in a built artefact consumed from another package — too far from the mistake to be a
useful failure message.

### Interview Explanation

Two bugs, one lesson: the compiler and the unit-test runner can agree with each other and both be
wrong about what the shipped artefact does. The ESM/CommonJS bug passed `tsc` and passed Vitest
because Vitest transformed the source instead of loading the build. The disconnect bug would have
passed every mocked-response test because a mock never emits the event that triggers it.

What made both survivable was that the repository already had places where a *built artefact* and a
*real event sequence* are exercised — a CJS-interop smoke script run under the actual runtime, and a
boundary test that scans source rather than trusting convention. The fix in each case was to extend
that existing mechanism, not to add a new layer of mocking.

### Resume Relevance

- Diagnosing a module-format bug that inverts between two packages in the same monorepo, and
  encoding the resolution as an executable rule rather than a comment
- Rejecting an intuitive-but-wrong cancellation design by reasoning about when Node's stream events
  actually fire, before shipping it
- Recognising that a green unit-test suite proved nothing here, because the transform under test was
  not the transform that ships

---

## 13. Challenge 11 — A Structurally Valid Report That Still Fails Schema Validation

### Context

A controlled LIVE smoke against `main` reached real Claude execution, ran one diagnostic tool call,
and then failed at finalization with `REPORT_SCHEMA_INVALID` — a well-formed tool call the persisted
`ResolutionReportSchema` (`packages/contracts`) nonetheless rejected. Every existing test that
exercised this failure code passed, and had passed since the code was introduced.

### Problem

`submit_resolution_report`'s tool `input_schema` is generated from the same Zod schema
(`ResolutionReportSchema`) that validates the result, via `toStrictInputSchema`
(`packages/provider-claude/src/claude-tool-schemas.ts`). The two are supposed to be one contract
expressed twice. They were not: Anthropic's strict-tool-use JSON Schema subset rejects
`minLength`/`maxLength`/`minimum`/`maximum`/`maxItems` outright, so `stripUnsupported` deletes them
before the schema reaches the model. Zod still enforces the real bounds on the way back in. A
structurally well-typed report — right keys, right types, right enum values — can still violate a
bound the model was never told existed: `confidence` given as a 0–100 percentage instead of a 0–1
fraction, more than 3 suggested actions, more than 10 evidence entries, a field past its length cap.

### Why It Is Difficult

The deterministic `FakeLlmProvider` cannot reproduce this failure by construction. Every fixture that
exercises `REPORT_SCHEMA_INVALID` is a hand-authored `rawInput`, and a human author who wants to
write an "invalid" report reaches for the obvious kind of invalid — missing fields, wrong enum value
— which is also the kind Zod's `invalid_type` branch catches regardless of what the model schema
conveys. Nobody hand-writes a fixture that is structurally complete and correctly typed but exceeds a
count or length bound, because doing so requires already knowing the exact gap between the two
schemas. That gap is invisible from either schema in isolation: `ResolutionReportSchema`'s source
looks authoritative, and the generated tool schema looks like a faithful projection of it, unless you
read `stripUnsupported`'s key list and notice what it removes.

The second difficulty is that "make validation less strict" is the wrong fix and also the easiest one
to reach for under pressure — a production failure with real cost attached creates pressure to make
the failure go away, and loosening `.max()`/`.min()` bounds would make it go away for this run while
making every future run's data quality worse.

### Failure Modes

- Widening `ResolutionReportSchema`'s bounds to stop rejecting what Claude sends, which stops
  catching genuinely malformed reports too.
- Adding a coercion/repair step that rewrites an out-of-bounds value into something that passes,
  which persists a report describing something Claude did not actually say.
- Adding a second Claude call to retry finalization, which spends money automatically in response to
  a schema mismatch, with no accounting or product decision behind that spend.
- Fixing the specific field this one incident hit (`confidence`) and leaving every other stripped
  bound (string lengths, `evidence`/`suggestedActions` counts) equally invisible to the model.
- A diagnostic that logs the issue by re-serializing the failing Zod issue, which reintroduces
  exactly the raw-model-content-in-logs risk this fix exists to avoid.

### Decision

**State the bounds as prose where the JSON schema cannot carry them; validate exactly as strictly as
before; make the mismatch observable without retaining what caused it.**

- `ResolutionReportSchema` is untouched. Nothing was widened, made optional, or given a permissive
  fallback. A report violating any bound still fails `safeParse` and still finalizes as
  `REPORT_SCHEMA_INVALID`.
- The shared system prompt (`REPORT_FIELD_BOUNDS`, appended to `BASE_SYSTEM_PROMPT` in
  `packages/provider-claude/src/claude-message-mapping.ts`) now states every bound
  `toStrictInputSchema` strips, explicitly, as the only remaining channel that can reach the model:
  exact field lengths — including the ones nested inside `evidence` entries and `suggestedActions`
  payloads — `confidence` as a fraction and *not* a percentage, `evidence` 1–10, `suggestedActions`
  0–3, plus a compact valid example. It reaches BOTH phases, not only the forced finalization turn:
  `submit_resolution_report` is offered as a tool during INVESTIGATION too (`tool_choice: "auto"`,
  so Claude may submit voluntarily as soon as it judges the investigation complete), and a voluntary
  early submission needs the same bounds a forced final one does. `FINALIZATION_SUFFIX` now carries
  only the "call it now" forcing instruction, appended on top of the shared bounds.
- `agent-orchestrator.ts` captures a sanitized diagnostic at the moment of failure
  (`summarizeReportValidationIssues`, `packages/contracts`) — issue paths, Zod issue codes, and
  expected/received *type names* derived via `typeof`/`Array.isArray`, never a value. It is surfaced
  through an optional `onReportSchemaInvalid` hook on `AgentRunService.executeAndPersist`, logged by
  `apps/api` as one JSON line, the same pattern `logProviderEvent` already uses for provider
  telemetry. The hook is invoked inside its own `try`/`catch` in `AgentRunService` itself, so a
  throwing caller-supplied hook can never skip `finalize()` — observability must not be able to
  affect execution, persistence, accounting, or HTTP behavior.
- No retry, no second Claude call, no coercion. A schema-repair turn is a paid-accounting and product
  decision, deliberately out of scope for this fix.

### Alternatives Considered

#### Alternative A — restore the stripped bounds so Claude's tool schema is the real contract

Rejected, at least for now. Anthropic's strict-tool-use subset rejects those keywords outright; a
schema carrying them would either fail at the provider or force dropping `strict: true`, trading a
structural guarantee (the model literally cannot return the wrong shape of object) for a numeric one
it can still ignore. Prose is the available channel until the provider's strict-schema subset
supports more of JSON Schema.

#### Alternative B — coerce or clamp out-of-bounds values (e.g. divide a >1 confidence by 100)

Rejected. A guessed transformation is Claude's actual claim, silently rewritten into something
different, and persisted as if Claude had said that. The prompt's own constraint ("do not weaken
validation merely to make this output pass") names this exact failure mode.

#### Alternative C — add a schema-repair retry turn when validation fails

Rejected for this fix. It spends money automatically in direct response to a schema mismatch, which
is a product and budget-accounting decision this fix does not have authority to make silently, and it
would need its own reservation/attempt-limit story rather than borrowing the existing one.

#### Alternative D — log the full Zod issue for debuggability

Rejected. `ZodIssue.input`/`.message` can echo the offending value verbatim (an enum mismatch's
default message includes the received string). The diagnostic only ever reads `.path`, `.code`, this
codebase's own static bound, and a derived type name.

### Tradeoffs

Prose instructions are a weaker guarantee than a schema constraint — a model can still ignore prose,
where it structurally cannot return a `tool_use` block missing a required key under `strict: true`.
This fix accepts that weaker guarantee because the alternative (loosening the real schema, or
inventing a repair step) trades away something the codebase should not give up. The sanitized
diagnostic is deliberately generic — a type name and a bound, not a value — which makes some failures
harder to root-cause from logs alone than a raw dump would; that cost is accepted for the same reason
the codebase never logs raw provider content anywhere else.

### Implementation Notes

- `reportInput: true` is now passed to `ResolutionReportSchema.safeParse` in `agent-orchestrator.ts`
  specifically so the summarizer can derive a real `receivedType` — Zod v4 omits `.input` from issues
  by default. This exposes nothing new: the raw value was already fully in memory as the function's
  own argument; enabling it only lets the summarizer read a `typeof` off data it already held.
- `packages/agent-runtime` still performs zero logging of its own, by design (see Challenge 9's
  provider-adapter boundary). The new diagnostic reaches the log the same way the provider's own
  telemetry does: an optional callback threaded in from `apps/api`, invoked once, before
  `finalize()` persists the run.

### Testing Strategy

A contracts-level test drives `summarizeReportValidationIssues` through every relevant Zod issue code
and asserts the sanitized output never contains the value that triggered it — including a combined
case with two simultaneous violations. An orchestrator test reproduces the actual failure class (a
structurally complete report with an out-of-range `confidence`) rather than only the pre-existing
missing-fields case, and asserts on the attached `reportValidationIssues`. Service-level tests assert
the hook fires exactly once with the sanitized diagnostic, that the run still persists as
`REPORT_SCHEMA_INVALID` normally, that the hook never fires for an unrelated failure code, and —
separately — that a hook which *throws* still leaves `finalize()` running exactly once with usage/cost
recorded and no second provider call, with the thrown error never reaching the caller. A
provider-level test asserts BOTH phases' prompts state every bound (including the nested ones), since
`submit_resolution_report` is offered as a tool on both and a voluntary INVESTIGATION-turn submission
must see them too; a separate assertion confirms only FINALIZATION carries the "call it now" forcing
instruction. Another provider-level test confirms a markdown/prose-wrapped response normalizes to
`protocol_error` rather than being parsed as an embedded report — there is no markdown/JSON-in-prose
extraction path anywhere in this codebase to begin with.

### Observability

One sanitized log line per `REPORT_SCHEMA_INVALID` failure: run id, provider mode, model, and the
sanitized issue list (path, code, expected/received type name, this codebase's own static bound).
Never a value, never the raw report, never a secret, never the idempotency key — matching the
existing `logProviderEvent` convention rather than adding a second logging shape.

### Outcome

The real first LIVE smoke exposed a genuine prompt/schema contract gap: strict tool-use validation
correctly rejected a structurally well-formed but bound-violating report, rather than silently
accepting it. Restating the shared bounds in prose alongside the sanitized diagnostic fixed the
failure class without loosening `ResolutionReportSchema` or adding a coercion path. A second, controlled
production LIVE re-test after the fix completed successfully — see
[`docs/evidence/06c-live-claude-smoke-success.md`](evidence/06c-live-claude-smoke-success.md). No
automatic paid retry was added anywhere in this fix; `ANTHROPIC_MAX_RETRIES` stays `0`.

### Interview Explanation

> The bug wasn't in the schema and wasn't in the parser — it was in the gap between two things that
> looked like the same contract. The tool schema Claude sees and the Zod schema that validates its
> answer are generated from one source, but Anthropic's strict tool-use mode rejects length/count/range
> keywords, so they get silently stripped before the model ever sees them. A structurally perfect
> `tool_use` call can still violate a bound nobody told the model about — a confidence given as 70
> instead of 0.7, say. No FAKE fixture can catch that, because a human writing a fixture reaches for
> an obviously-wrong report, not a correctly-typed one with one bound quietly exceeded.
>
> The tempting fixes were all wrong in the same direction: loosen the schema, coerce the value, or
> retry with a second paid call. All three make the specific failure disappear while making the
> system worse — accepting bad data, inventing what the model didn't say, or spending money
> automatically in response to a validation error. The fix that survives scrutiny is duller: tell the
> model the bounds in prose, since that's the only channel left that can carry them, leave the actual
> validation exactly as strict as before, and make sure that if this happens again, the exact
> validation issue is recoverable from a log line — as a path and a type name, never a value.

### Resume Relevance

This problem demonstrates:

- Finding a contract-drift bug that neither schema exposes in isolation, by reading the code that
  projects one into the other
- Refusing the three fixes that make a production failure disappear while making the system's
  guarantees worse — loosening validation, coercing a value, and adding a silent paid retry
- Designing a diagnostic that is useful specifically because of what it deliberately omits, and
  proving that omission with a test rather than a comment
- Recognising that a deterministic test double can structurally never reproduce a class of bug, and
  writing the regression test against the real validation boundary instead
- Extending an existing sanitized-logging convention rather than inventing a second one, so the two
  log shapes stay greppable together

## 14. Challenge 12 — A Required Field the Model Simply Did Not Send

### Context

A protected production LIVE run (`runId 179848c0-cac1-4fcc-a248-72b9860029e5`, `claude-sonnet-5`)
reached the second Claude turn, completed `get_service_status` successfully, and then failed
`REPORT_SCHEMA_INVALID` on a single issue:

```json
{ "path": ["suggestedActions"], "code": "invalid_type", "expectedType": "array", "receivedType": "undefined" }
```

The same run also left the frontend Timeline reading `Pending — Loading approval state…` under a
terminally `FAILED` investigation.

### Problem

This is *not* Challenge 11's failure class, and the distinction is the whole point. There, the tool
schema could not carry the constraint (`stripUnsupported` deletes every bound Anthropic's strict
subset rejects), so the model was never told. Here the model **was** told, by every channel available:
`suggestedActions` is non-optional in `ResolutionReportSchema`, appears in the generated tool schema's
`required` array, sits under `additionalProperties: false`, and the tool is sent with `strict: true`.
It was omitted anyway.

That falsifies an assumption stated in Challenge 11's own Alternative A — that `strict: true` buys "a
structural guarantee (the model literally cannot return the wrong shape of object)". A `required`
array in a provider-exposed tool schema is a strong constraint on the model's grammar, not a
transport-level guarantee your parser can lean on. **Provider-exposed schema and canonical runtime
schema remain two different things even when one is generated from the other and even when the
provider claims to enforce it.** The canonical schema is the only contract that actually holds.

Empty collections are the specific shape most exposed to this. `[]` carries no information a model
feels obliged to state; omitting it and sending it are the same assertion to a reader, so "say nothing"
is a natural completion when there is nothing to suggest.

### Why It Is Difficult

The generated schema is *correct* — a schema-conversion test asserting the exact `required` array
passed before this incident and still passes. Reading either schema, the transformer, or the tool
definition tells you nothing is wrong, because nothing is wrong with them. The defect only exists in
the gap between what a required field means to a validator and what it means to a sampler.

The deterministic `FakeLlmProvider` cannot reproduce it, for the same structural reason as Challenge
11: fixtures are hand-authored, and nobody writes a report that is complete except for one empty array.

### Decision

**Keep the canonical contract strict; repair exactly one semantically-empty omission at the provider
boundary; say it in the prompt as well.** Defense in depth, because the schema layer had already been
proven insufficient by the incident itself:

- **Schema (unchanged).** `suggestedActions` was already present, required, and correctly typed in the
  generated tool schema. A focused regression test now asserts those two facts by name, so the
  incident's premise cannot silently regress inside a broader field-list assertion.
- **Prompt.** `REPORT_FIELD_BOUNDS` said "Empty is allowed" — permissive wording a model can read as
  *optional*. It now states the field is always required and names the value to send when there is
  nothing to suggest (`"suggestedActions": []`), matching the worked example already in the prompt.
- **Narrow normalization.** `normalizeSubmittedReportInput`
  (`packages/provider-claude/src/claude-response-normalization.ts`) turns a **missing**
  `suggestedActions` into `[]` at the provider/tool-input boundary, before validation.

The normalization is deliberately the narrowest repair that can exist, and the constraints matter more
than the change: only `undefined` triggers it (`null`, strings, objects, and malformed arrays are
values the model *did* assert and must still fail); no other field is repaired, including the equally
required `evidence`, whose omission is not equivalent to any particular value; a non-object tool input
is returned untouched rather than grown into a report. `ResolutionReportSchema` is not widened, made
optional, or given a `.default()` — persistence and the domain keep the strict contract, and an
unrepaired invalid report still produces a `REPORT_SCHEMA_INVALID` diagnostic pointing at the real
problem rather than at a value the boundary invented.

This is the line between **narrow normalization and weakening the domain contract**: a `.default([])`
on the Zod schema would have fixed this incident in one character and simultaneously made every
consumer of `ResolutionReport` unable to distinguish "no actions suggested" from "field lost in
transit" — including persistence, the API projection, and the evaluation harness.

### The Frontend Half — A Stage That Could Never Run

The same failed run left the approval stage at `Pending — Loading approval state…`. `App.tsx` was
already correct: `settleRunOutcome` returns for a `FAILED` outcome *before* any approval fetch, and no
path (initial submission, FAKE retry, LIVE recovery, or Refresh) issues one for a permanently
ineligible run. The bug was purely in the Timeline's rendering contract: stage rows are labelled by
what they were *about* to do (`STAGE_LABELS`), which is truthful for a stage still ahead of the
workflow and a lie for one that will never happen.

`deriveInvestigationProgressStages` now omits the approval row entirely once the investigation is
terminally failed — mirroring how `availability` is already omitted for FAKE runs: the Timeline lists
the stages an investigation actually has and says nothing about the ones it does not. An
approval-*load* failure is deliberately excluded from that condition, because it does not stop the
workflow and its row must still render as Failed.

### Production Diagnostics

The incident was diagnosable at all only because of Challenge 11's sanitized diagnostic: one JSON line
carrying `path`, `code`, `expectedType`, and `receivedType` was sufficient to identify the exact field
and the exact failure mode, with no access to the report and no raw model content in the logs. A
generic "report validation failed" line would have required reproducing a paid LIVE run to learn what
this one told us for free. `receivedType: "undefined"` — a derived `typeof`, not a value — is what
distinguishes *omitted* from *malformed*, and therefore what made a narrow repair defensible instead
of a guess.

### Testing Strategy

Provider-level tests cover the boundary: a missing `suggestedActions` normalizes to `[]`; `null`, a
string, an object, and a malformed array are each left untouched; no other missing field is repaired;
a non-object tool input is passed through. A prompt test asserts both phases state the requirement and
name `[]`, and that the old permissive "Empty is allowed" wording cannot return. Contract-level tests
lock the production diagnostic exactly as emitted, assert an empty array is a valid report (the
premise the normalization rests on), and assert `null`/wrong-typed values still fail. Frontend tests
assert that a terminal `FAILED` run — initial, refreshed, and LIVE-recovered — never calls the approval
endpoint, renders no approval surface, and shows no approval stage row, while a `COMPLETED` eligible
run still loads approval exactly once and an approval-load failure still renders its row as Failed.

### Outcome

Fixed locally; **not** verified in production. No LIVE request was made as part of this fix, and no
claim is made here about post-fix production behavior — the failing run remains the only production
evidence, and a controlled LIVE re-test is still outstanding.

### Interview Explanation

> We had a run fail validation because Claude omitted a field that was marked `required` in the tool
> schema, under `strict: true`. The instinct is that this is impossible — so the interesting part is
> what you conclude when it happens. The wrong conclusion is "the schema is broken," and we checked:
> the generated schema was correct, and the test asserting it had been passing the whole time.
>
> The right conclusion is that a provider-exposed schema and your canonical runtime schema are still
> two different artifacts, even when you generate one from the other and the provider says it enforces
> it. `required` constrains sampling; it isn't a transport guarantee. Empty arrays are where that leaks
> first, because omitting `[]` and sending `[]` mean the same thing to a reader.
>
> The one-character fix is `.default([])` on the Zod schema, and it's wrong — it makes the whole system
> unable to tell "no actions suggested" from "field lost in transit," forever, everywhere. So we
> repaired exactly one thing at the provider boundary — a *missing* `suggestedActions` becomes `[]`,
> while `null` or a wrong type still fails — strengthened the prompt from "empty is allowed" to
> "always send it, send `[]` when there's nothing," and left the domain contract strict. The
> diagnostic is what made that defensible: `receivedType: "undefined"` told us the field was omitted
> rather than malformed, which is the difference between a narrow repair and a guess.

### Resume Relevance

This problem demonstrates:

- Distinguishing model noncompliance from schema-conversion drift by verifying the generated artifact
  directly, instead of assuming the layer that "should" be wrong is
- Treating a vendor's enforcement guarantee as a strong prior rather than an invariant, and finding the
  documented assumption in our own design notes that the incident falsified
- Scoping a compatibility repair to the one case where it invents nothing — and encoding the exclusions
  (`null`, wrong types, every other field) as tests rather than as a comment
- Refusing a one-character fix that would have permanently destroyed a distinction the domain needs
- Recognising that a progress UI which labels a stage by what it was *about* to do becomes a liar the
  moment that stage can no longer happen

---

## 15. Challenge 13 — A Progress Reducer That Refuses to Repair

### Context

Issue #36 (`docs/16-investigation-event-contract.md`) defines the shared execution-stage/event contract
a future live Timeline needs, without yet persisting anything incrementally (#37) or polling anything
(#38). Its centrepiece is `deriveExecutionStageProgress`, a pure function turning an ordered event
stream into four stage rows a user will read during an incident.

An independent review of the first implementation returned `MATERIAL FINDINGS — FIX BEFORE COMMIT`.
The findings were not edge cases; they were the difference between a contract that reports history and
one that invents it.

### Problem

The first implementation was written to be *tolerant* of incomplete streams, because a `RUNNING` run is
legitimately incomplete — you must be able to render a run that is only halfway through. That tolerance
was implemented as generic leniency, and it leaked into the terminal path:

- `RUN_CREATED → RUN_COMPLETED`, with no analysis, no report, and no validation, produced a
  fully "successful" four-stage Timeline. `RUN_COMPLETED` sanity-closed whatever stage was active and
  omitted whatever was still pending, so a stream asserting almost nothing rendered as a clean success.
- `TOOL_FAILED` recorded no stage failure of its own; it only closed the tool call. The stage was
  failed later, by `RUN_FAILED`. So `TOOL_FAILED → RUN_COMPLETED` was accepted, and a `RUN_FAILED`
  naming a *different* code than the tool failure that preceded it was accepted too.
- Tool calls were tracked in a `Set` of open ids, which cannot detect a duplicate request id, a
  request/outcome tool-name mismatch, or a second outcome for the same call.
- `RUN_FAILED` carried a free-form `failureMessage: string`, capped at 500 characters, in an event
  intended to be readable by a browser.
- The reducer trusted its TypeScript types at runtime and validated neither its inputs nor its own
  output, so a bad `now` produced `NaN` elapsed times, and `ExecutionStageProgressSchema`'s ~50 lines
  of invariants were never executed by anything.
- One declared error code, `MULTIPLE_TERMINAL_EVENTS`, was never thrown.

### Why It Is Difficult

Every one of these behaviours is individually defensible as "being forgiving with imperfect data," and
the tests all passed, because the tests asserted the forgiving behaviour. The failure is only visible
if you ask a different question: *when this row says the investigation completed successfully, what
exactly is that claim resting on?* For the first implementation the honest answer was "on the absence
of contradicting events," which is not the same thing as evidence — and is indistinguishable, to the
person reading the Timeline during an outage, from a claim resting on real facts.

The genuinely hard part is that the tolerance is not wrong everywhere. A partial `RUNNING` stream must
still reduce. So the fix cannot be "reject anything incomplete"; it has to separate *incomplete because
it is still happening* from *incomplete because the history is corrupt*.

### Failure Modes

- A corrupt or truncated terminal history renders as a successful investigation.
- A run that failed in a diagnostic tool displays a report-stage failure code, or completes.
- Two different tool calls sharing an id are silently treated as one.
- A provider error string, an authorization header, or a stack trace reaches a browser inside
  `failureMessage`.
- A schema whose invariants nothing runs gives false confidence that outputs satisfy them.

### Decision

Completion is defined by **required positive facts**, never by the absence of contradictions.
`RUN_COMPLETED` is rejected unless `AGENT_STARTED`, `REPORT_SUBMITTED`, and `REPORT_VALIDATED` were all
seen, no failure fact exists, no tool call is open, and every stage was already resolved by its own
events. `RUN_COMPLETED` now mutates nothing — there is no sanity-close and no omit-to-repair.

Failure facts became immediate and consistent. `TOOL_FAILED` fails `DIAGNOSTIC_EXECUTION` at once with
the exact tool code; `REPORT_VALIDATION_FAILED` fails `REPORT_GENERATION` at once with the exact report
code; a subsequent `RUN_FAILED` may only *confirm* that fact, and must repeat its stage and code
exactly or be rejected as `FAILURE_FACT_MISMATCH`.

Tool calls are tracked as `Map<toolCallId, { toolName, state }>`, which makes duplicate ids, name
mismatches, duplicate outcomes, and open-call-at-terminal all detectable — and keeps the contract
correct if more than one tool call per run is ever allowed.

`failureMessage` was **removed**, not shortened. `.strict()` governs which keys exist; it cannot govern
what a caller puts inside a string. The event now carries only `failureCode` and `failedStage`, and
user-facing wording is derived from the code at the API/UI boundary.

The reducer validates `now`, every record, sequence contiguity, and single-`runId` before reducing, and
validates its own output against the stage-progress schema before returning — with typed codes
(`INVALID_NOW`, `INVALID_EVENT_RECORD`, `MIXED_RUN_IDS`, `INVALID_PROGRESS_OUTPUT`) instead of `NaN` or
a raw `RangeError`. All 27 error codes are now thrown somewhere; a code that cannot occur is a false
claim about what the contract enforces.

Partial `RUNNING` streams still reduce normally. Incompleteness is an error only when the stream claims
to be terminal.

### Alternatives Considered

#### Alternative A — Keep terminal leniency, document it

Rejected: the documentation would have had to say "a completed Timeline may describe stages no event
reported," which is precisely the claim the Timeline exists to make trustworthy.

#### Alternative B — Length-cap and sanitise `failureMessage`

Rejected: sanitising free text is an arms race against every future caller. Removing the field ends it,
and nothing is lost, because a closed code set plus a boundary mapping produces better user-facing copy
than an ad-hoc string anyway.

#### Alternative C — Validate in the marker helper as well as the reducer

Rejected: two copies of a state machine drift. The helper was renamed
`hasCanonicalInvestigationLifecycleMarker` and documented as *only* a canonical-vs-legacy marker, with
a test that deliberately shows a marker-passing stream the reducer rejects.

### Tradeoffs

Emitters must now be exact: #37 cannot write a terminal success without the full lifecycle, and cannot
write a `RUN_FAILED` that disagrees with a preceding stage failure. That is more constraint on
unwritten code, accepted deliberately — a contract that is easy to satisfy incorrectly is not a
contract. Runtime validation costs a Zod parse per event; at the bounded event counts this contract
targets, that is not a real cost.

### Implementation Notes

The legacy projection was also rewritten from a `Set` membership test plus two `as` casts into an
exhaustive `switch` with an `assertNever` default, so adding a future event type fails compilation
until its projection is chosen rather than silently defaulting to `null`.

A second review round found four residual defects of the same family — each a place where the contract
still accepted a history it could not have observed:

1. **A terminal failure could name any future pending stage.** `RUN_FAILED` accepted a `failedStage`
   that was merely `pending`, so `RUN_CREATED → RUN_FAILED(REPORT_GENERATION)` claimed a run failed in a
   phase it never reached. `failedStage` must now equal the single currently active stage, with one
   narrow exception for a failure between run creation and analysis (stream exactly
   `RUN_CREATED → RUN_FAILED`, naming `AGENT_ANALYSIS`).
2. **Phases could move backward.** Nothing rejected `AGENT_STARTED` after tool execution, retrieval
   during diagnostics, or a tool request before analysis began — so two stages could be active at once,
   or an earlier stage could reactivate. Phase order is now forward-only, with at most one active stage,
   enforced by `PHASE_ORDER_VIOLATION`.
3. **A tool path could skip `REPORT_GENERATION_STARTED`.** The documented emitter contract says a tool
   run reaches its report through a distinct finalization call; the reducer treated that fact as
   optional, so the very event that makes report generation visible during a long provider call could be
   dropped without consequence. It is now required on tool paths and still optional on the direct
   no-tool path, where nothing could have announced it in advance.
4. **The list schema did not enforce its advertised shape.** `ExecutionStageProgressListSchema` was a
   plain array, so it would have accepted an empty, partial, duplicated, or reordered list while its
   documentation promised exactly four ordered entries. The shape is now encoded in the schema.

A third round found six more of the same kind, and one of them inverted an earlier assumption:

1. **The canonical-origin marker rejected corrupt canonical rows as "legacy."** It consulted `runStatus`
   and terminal shape, so a canonical stream missing its terminal event was reported as legacy-format —
   routing genuinely broken data into the frontend's legacy inference, which would render a plausible
   Timeline for a history that should have raised an error. The marker is now origin-only
   (`RUN_CREATED` at sequence 1, no `runStatus` parameter): corruption is a reducer failure, never a
   reclassification.
2. **`REPORT_GENERATION_STARTED` was accepted on no-tool runs**, which the orchestrator cannot produce —
   the finalization turn is only reached after a tool call.
3. **Tool-path *failures* could omit it**, so a provider timeout during finalization was attributed to
   `DIAGNOSTIC_EXECUTION` — a stage that had already finished successfully.
4. **Overlapping tool requests were accepted** despite the contract documenting sequential calls. (A
   later round narrowed this further — see the v1 scoping below — from "sequential" to "at most one.")
5. **`runStatus` was never runtime-validated**, so a bogus value silently skipped every terminal check.
6. **Failure codes and stages were not checked for causal compatibility** — `TOOL_EXECUTION_FAILED` could
   be attributed to `AGENT_ANALYSIS`, and a terminal event could invent a tool failure no event
   witnessed. The compatibility rules were then derived by reading every `failed(...)` site in the
   orchestrator rather than by guessing, which is also how the pre-agent exception was narrowed to the
   single code (`RETRIEVAL_PARAMS_INVALID`) that can actually occur before anything is traced.

One reviewed hypothesis was **not** a defect and was documented rather than "fixed": `RETRIEVAL_COMPLETED`
is optional because the orchestrator's retriever is optional and the current API module configures none.
Making it mandatory would have rejected the shape production actually emits.

A fourth, release-gate round produced the sharpest correction, and it was a **scoping** decision rather
than a bug fix. The contract had been generalising: it accepted multiple sequential tool calls, and it
accepted a provider failure after `REPORT_SUBMITTED`. Neither is producible by the runtime it models —
`MAX_PROVIDER_TURNS = 2` allows one investigation turn and one finalization turn, so at most one tool
call; and once a report has been submitted the provider has already returned its payload, so only
validation can end the run. Both were "supporting a more general system than we have," which sounds like
prudence and is actually the same failure as before: accepting histories the system cannot generate means
the contract is not validating anything in those regions.

v1 was therefore narrowed to exactly the two paths the runtime executes (direct no-tool report, and
one-tool finalization), with `TOOL_LIMIT_EXCEEDED` for any second tool request. Narrowing also made
`DUPLICATE_TOOL_CALL_ID` unreachable — a second request now fails on the limit first — so it was deleted
rather than left as an error that can never be thrown.

The same round replaced four independent `Set<AgentOrchestratorErrorCode>` classifications with one
`satisfies Record<AgentOrchestratorErrorCode, FailurePolicy>` record, so a future error code fails
compilation until its policy is written; made the origin marker total (it returns `false` instead of
throwing on malformed JavaScript input, because a classifier that throws denies its caller the ability to
route at all); and removed provider-controlled `toolCallId`/`toolName` values from exception messages,
which are log-facing and can carry newlines, ANSI escapes, and credential-looking text.

The pattern across all four rounds is the same: each defect was a rule that existed in prose — in a
comment, a doc table, or a type name — but not in executable form. The third round adds a corollary: a
classifier that answers "what format is this?" must not also answer "is this valid?", because callers
act on the first answer by routing away from the code that would have produced the second. The fourth
adds another: a contract should model the system that exists, not the system someone might build, because
generality it cannot test is indistinguishable from a gap.

### Testing Strategy

222 tests across the package. Every rejection test asserts the exact
`InvestigationEventContractError.code` through a helper rather than a broad `.toThrow()`, because
"threw something" would have passed against several of the defects above. Every reducer output in a
representative fixture set is validated against the stage-progress schema, closing the gap where those
invariants were never executed. Clocks are fixed offsets from a constant; there are no sleeps, provider
calls, or database access.

### Observability

None yet — a contract-only milestone with no running code to observe. #37 inherits the obligation to
carry `InvestigationEventContractError.code` into whatever logging it adds around incremental
persistence.

### Interview Explanation

> We had a function that turned an event stream into a progress Timeline, and it passed its tests. A
> review pointed out that a stream containing nothing but "run created" and "run completed" rendered as
> a fully successful investigation — because the reducer closed whatever was open and omitted whatever
> was missing. That's the whole bug in one sentence: it was deriving progress from the *absence* of
> contradicting events instead of the presence of facts. The fix was to define completion by required
> positive facts and delete every repair path, while still allowing a half-finished run to render,
> because a running investigation is legitimately incomplete. The distinction that made it tractable
> was "incomplete because it's still happening" versus "incomplete because the history is corrupt" —
> the first is normal, the second is an error, and only the terminal events can tell you which one
> you're looking at.

### Resume Relevance

This problem demonstrates:

- Recognising that tolerance of missing data silently becomes fabrication of data at exactly the point
  where a user reads the output as ground truth
- Defining a terminal state by required evidence rather than by absence of contradiction
- Removing an unbounded text field from a public record instead of trying to sanitise it
- Treating an unexecuted schema and an unthrowable error code as defects, not as harmless surplus
- Keeping a single source of validation truth when a cheap marker check and a full state machine both
  appear to answer the same question
