# OpsPilot — Technical Design Review: Approved Decisions

| Field | Value |
|---|---|
| Document | Review Decisions Record |
| Source review | `docs/reviews/03-technical-design-feasibility-review.md` |
| Source documents | `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md` (v1.1), `docs/10-engineering-challenges.md` |
| Status | Decisions approved; document and implementation changes not yet applied |
| Scope | Maps every finding in the feasibility review to an approved architecture decision (or records that none was made) |

This document records the disposition of every finding in `docs/reviews/03-technical-design-feasibility-review.md` against ten approved architecture decisions. It does not modify `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md`, or `docs/10-engineering-challenges.md` — required changes to those documents are recorded here as pending work, not applied.

---

## Decision Legend

| ID | Decision |
|---|---|
| **D1** | Replace Redis, BullMQ, and the transactional outbox implementation with a PostgreSQL-backed `agent_jobs` table for the MVP. |
| **D2** | Keep the transactional outbox discussion in `docs/10-engineering-challenges.md` as an evaluated alternative, but note that the MVP eliminates the dual-write problem by using PostgreSQL as both the system of record and job queue. |
| **D3** | Use a forced `submit_resolution_report` tool for the final structured report. |
| **D4** | Permit one bounded schema-repair attempt before failing the run. |
| **D5** | Do not resume a partially completed agent loop after a worker crash. Mark the run failed after lease expiration and require a new `AgentRun` for retry. |
| **D6** | Use only these approval-required actions: `UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, `DRAFT_CUSTOMER_REPLY`. |
| **D7** | Approval occurs only after the final report. The MVP does not pause and resume an agent loop for human approval. |
| **D8** | Reduce required MVP tests to: core unit tests; PostgreSQL job integration test; RAG retrieval integration test; fake-provider agent integration test; one Playwright happy-path flow; initial agent eval cases. |
| **D9** | Treat advanced fault-injection tests as stretch goals. |
| **D10** | Mark Render pricing, Neon cold starts, and SSE proxy behavior as deployment spikes requiring later external verification. |

---

## P0 Blocking Issues

### P0-1 — Structured final-report elicitation method is unspecified
- **Decision:** D3, D4
- **Reason:** D3 answers the "how" question the review flagged as missing — Claude is forced to call `submit_resolution_report`, eliminating prose-wrapped/free-text parsing risk. D4 supplies the repair path the review recommended in place of the blanket "reject without retry" policy.
- **Required document changes:** `docs/03-technical-design.md §13.5 Structured Output` — state the forced tool-call mechanism explicitly and name the tool. `§13.2 Agent Loop` step 6 — describe the one-attempt repair loop (feed Zod validation error back to Claude, retry once, then fail) instead of implying a single validation pass. `§20.1 Failure Categories` — carve out "final-report schema validation failure" as a distinct row with one retry, separate from the general "invalid model output → reject without retry" row.
- **Required implementation changes:** Define `submit_resolution_report` as a tool with `tool_choice` forcing its use on the final turn; implement a single repair round-trip on Zod validation failure before marking the run `FAILED`.
- **Technical spike still necessary:** Downgraded, not blocking. Spike 1 (structured-output reliability) is still worth running as a lightweight validation of the forced-tool-choice approach across varied tickets, but the design question itself is resolved by D3 — it no longer blocks implementation start.

### P0-2 — Agent-loop resume semantics after a lease reclaim are undefined
- **Decision:** D5
- **Reason:** D5 directly resolves the ambiguity by removing the "resume" branch entirely — lease expiration is a terminal failure, not a hand-off to a second worker. This also resolves the run-lifetime tool-call-counter question the review raised, since there is no partial-run resume path to seed counters for.
- **Required document changes:** `docs/03-technical-design.md §16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery` — rewrite to state that an expired lease transitions the run directly to `FAILED` (not reclaimed by a new worker attempt) and that retry means the client submits a new `AgentRun`. `§17.1 Agent Run State` state diagram — remove or amend the `RUNNING → QUEUED: retriable failure` transition if it implies automatic reclaim-and-continue. `docs/10-engineering-challenges.md §"Agent Run Claiming"` and `§"Execution Lease"` — align the SQL/prose with fail-on-expiry semantics instead of reclaim-on-expiry.
- **Required implementation changes:** On lease-expiry detection (via reconciliation sweep or next claim attempt), transition the run to `FAILED` with a stable `errorCode`; remove any "second worker claims stale lease and continues the loop" code path from the worker implementation.
- **Technical spike still necessary:** No — the correctness question is resolved by policy, not by measurement.

### P0-3 — Deterministic BullMQ `jobId` reuse interacts unclearly with retention and reconciliation
- **Decision:** D1
- **Reason:** D1 removes BullMQ (and therefore the `jobId`/retention/reconciliation ambiguity) entirely by replacing it with a PostgreSQL-backed `agent_jobs` table. The finding is moot under the approved architecture — there is no external queue with its own retention semantics to reconcile against.
- **Required document changes:** `docs/03-technical-design.md §16.5 Queue` — remove BullMQ job-payload and `jobId` content; replace with the `agent_jobs` claim/lease design. `§16.9 Reconciliation` — rewrite to describe reconciliation over `agent_jobs` rows only (no outbox/queue cross-system reconciliation).
- **Required implementation changes:** No BullMQ job-ID or retention logic to build. Implement `agent_jobs` claim via `UPDATE ... WHERE status = 'PENDING' ... RETURNING *` (or `FOR UPDATE SKIP LOCKED` for a polling worker loop).
- **Technical spike still necessary:** No — Spike 2 (BullMQ jobId reconciliation behavior) is no longer applicable.

### P0-4 — Execution lease duration vs. single Claude call latency is not validated
- **Decision:** D1, D5
- **Reason:** D5 changes the failure mode from "silent duplicate concurrent execution by two workers" (a correctness bug) to "visible terminal failure requiring a new `AgentRun`" (a UX/cost cost, not a correctness bug). A too-short lease under D5 now only causes spurious failures and re-run friction, not duplicate billed Claude calls from two simultaneously active workers. D1 also means the lease lives on the `agent_jobs`/`AgentRun` row in the same database as the claim logic, simplifying the mechanism itself.
- **Required document changes:** `docs/03-technical-design.md §16.6 Job Options` and `§16.7` — restate lease duration guidance as a UX-tuning parameter ("set comfortably above expected p99 single-call latency to avoid spurious failures") rather than a correctness-critical value. `docs/10-engineering-challenges.md §"Execution Lease"` — update to reflect fail-on-expiry semantics per P0-2/D5.
- **Required implementation changes:** Size the lease duration using real latency data (see spike below); no heartbeat-driven reclaim-and-continue logic needs to be built at all, which also resolves Overengineering Review OE-3.
- **Technical spike still necessary:** Downgraded, recommended not blocking. Spike 3 (lease vs. real Claude call latency) is still useful to avoid an annoyingly high spurious-failure rate in the demo, but it is no longer a correctness-blocking spike — it can run after core implementation, not before.

### P0-5 — PRD tool taxonomy is internally inconsistent and doesn't match downstream documents
- **Decision:** D6
- **Reason:** D6 makes the three-action list in `docs/03-technical-design.md §14.4` and `docs/02-mvp-scope.md §4.6` canonical, resolving the ambiguity by fiat rather than by further debate.
- **Required document changes:** `docs/01-prd.md §9.2 State-Changing Tools` — replace the five-item list ("update ticket status," "create escalation," "send customer reply," "assign ticket owner," "mark ticket as resolved") with exactly `UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, `DRAFT_CUSTOMER_REPLY`, matching `§8.3 Tool Calling`'s naming. `docs/01-prd.md §8.3` — confirm its two-item state-changing subset is consistent with (a subset of) the canonical three.
- **Required implementation changes:** None beyond building exactly the three action types already specified in `docs/03-technical-design.md §14.4`.
- **Technical spike still necessary:** No.

---

## P1 High-Risk Issues

### P1-1 — Render background-worker free-tier availability is unverified and load-bearing
- **Decision:** D10
- **Reason:** Explicitly named in D10 as a deployment spike for later external verification.
- **Required document changes:** `docs/03-technical-design.md §4.1 Assumptions` and `§25.2 Service Configuration` — add a note that Render worker-tier cost/availability is an open, unverified assumption pending a spike, not a settled fact.
- **Required implementation changes:** None until the spike resolves; if no low-cost worker tier exists, revisit whether the `agent_jobs` worker can run co-located with the API process instead of as a separate Render service.
- **Technical spike still necessary:** Yes — retained as Spike (Render pricing/tier verification) per D10.

### P1-2 — Upstash Redis free-tier request budget likely can't sustain the recommended poll interval
- **Decision:** D1
- **Reason:** D1 removes Redis/Upstash from the architecture entirely, so the request-quota question no longer applies.
- **Required document changes:** `docs/03-technical-design.md §25.2 Service Configuration` and `§25.1 Recommended Portfolio Deployment` — remove the Upstash Redis component from the deployment diagram and service list.
- **Required implementation changes:** None — no Redis client, no Upstash account needed for the MVP.
- **Technical spike still necessary:** No — moot under D1.

### P1-3 — Neon autosuspend cold-start could break the demo's first interaction
- **Decision:** D10
- **Reason:** Explicitly named in D10 as a deployment spike for later external verification.
- **Required document changes:** `docs/03-technical-design.md §27 Performance and Cost Targets` — note that the "excluding cold start" carve-out is provisional pending the Neon spike, and a keep-warm decision follows from it.
- **Required implementation changes:** None until the spike resolves; a keep-warm ping or loading-state UX fix may follow.
- **Technical spike still necessary:** Yes — retained as Spike (Neon cold-start verification) per D10.

### P1-4 — Mid-investigation approval gating is implied by the PRD but not built
- **Decision:** D7
- **Reason:** D7 confirms the technical design's existing behavior (approval only after the final report) as the approved decision, rather than building the PRD's implied pause/resume flow.
- **Required document changes:** `docs/01-prd.md §7 Flow 2` and `docs/02-mvp-scope.md §4.4 Agent Trace Panel` — add a clarifying note that `approval_required`/action approval always follows a completed investigation and final report; the agent never pauses mid-loop awaiting a decision.
- **Required implementation changes:** None beyond what `docs/03-technical-design.md §13.1` and `§14.4` already specify — confirms no mid-loop suspend/resume mechanism needs to be built.
- **Technical spike still necessary:** No.

### P1-5 — Reject-without-retry policy for invalid model output has no repair loop
- **Decision:** D4
- **Reason:** Directly resolved — D4 is the repair-loop policy the review recommended.
- **Required document changes:** `docs/03-technical-design.md §20.1 Failure Categories` — add the one-repair-attempt carve-out for final-report schema validation failures (same change as recorded under P0-1).
- **Required implementation changes:** Same as P0-1 — implement the single repair round-trip.
- **Technical spike still necessary:** No.

### P1-6 — Test pyramid breadth exceeds MVP scope's own stated bar
- **Decision:** D8, D9
- **Reason:** D8 defines the reduced required test set directly; D9 explicitly demotes the fault-injection-grade integration tests the review flagged as excessive to stretch-goal status.
- **Required document changes:** `docs/03-technical-design.md §22 Testing Strategy` — rewrite to list D8's six items as the MVP-required test set and explicitly label the existing Redis-outage/relay-crash/duplicate-delivery/stale-lease integration tests as stretch goals (also partly moot under D1, since there is no Redis/relay to fault-inject against — see OE-5). `docs/02-mvp-scope.md §4.10`–`§4.11`, `§8 MVP Acceptance Criteria` — confirm alignment with the reduced D8 test set so the two documents no longer conflict.
- **Required implementation changes:** Build exactly D8's six test items for MVP completion; defer everything else.
- **Technical spike still necessary:** No.

### P1-7 — Rate limiting and demo-abuse controls are named but not specified
- **Decision:** None of the ten approved decisions addresses this.
- **Reason:** Not in scope of this decision round.
- **Required document changes:** None recorded yet — `docs/03-technical-design.md §19.2 API Security` and `§25.4 Public Demo Protection` remain as-is (a named requirement with no committed mechanism or numbers).
- **Required implementation changes:** None decided.
- **Technical spike still necessary:** Not applicable — this is an open product/ops decision, not a technical spike. **Remains open; needs a follow-up decision before public deployment.**

---

## P2 Improvements

### P2-1 — Cursor pagination for list endpoints
- **Decision:** None of the ten approved decisions addresses this. **Remains open**, no document or implementation change recorded.

### P2-2 — OpenAPI documentation generation
- **Decision:** None of the ten approved decisions addresses this. **Remains open.**

### P2-3 — Four-way test-mode matrix (`test`/`local`/`eval-live`/`production-demo`)
- **Decision:** Indirectly touched by D8 (which defines the required test set) but not explicitly resolved.
- **Reason:** D8 narrows what must be *built and passing*, but does not collapse the number of named test modes in `docs/03-technical-design.md §22.4`.
- **Required document changes:** None recorded this round.
- **Required implementation changes:** None recorded this round.
- **Technical spike still necessary:** No. **Remains open** as a documentation simplification, not decided.

### P2-4 — Full accessibility requirements
- **Decision:** None of the ten approved decisions addresses this. **Remains open.**

### P2-5 — Separate `agent-evals.yml` CI workflow with budget guardrails
- **Decision:** None of the ten approved decisions addresses this directly, though D8's "initial agent eval cases" confirms eval cases are in scope for MVP; the separate CI workflow question is not decided. **Remains open.**

### P2-6 — ADR backlog (`§32`)
- **Decision:** No change needed — already correctly scoped as deferred, post-hoc documentation in the original review. No action required.

---

## Cross-Document Inconsistencies

### XDOC-1 — Tool taxonomy mismatch (three-way)
- **Decision:** D6
- **Reason / required changes:** Same as P0-5.
- **Technical spike still necessary:** No.

### XDOC-2 — Field-naming mismatch for the execution lease (`leaseOwner`/`leaseExpiresAt` vs. `execution_owner`/`execution_lease_until`)
- **Decision:** D1 (supersedes the underlying schema)
- **Reason:** D1 replaces the `AgentRun` lease fields and the `OutboxEvent` model entirely with a new `agent_jobs` design, so this specific naming drift is superseded rather than reconciled — the new schema needs its own consistent naming from the start.
- **Required document changes:** `docs/03-technical-design.md §11.1 Core Entities` — define the `agent_jobs` table schema with one canonical set of field names (e.g., `leaseOwner`, `leaseExpiresAt`) and use it consistently everywhere, including `docs/10-engineering-challenges.md`.
- **Required implementation changes:** Implement the new schema once, matching the doc, rather than porting the old inconsistent naming forward.
- **Technical spike still necessary:** No.

### XDOC-3 — Mid-run approval gating implied vs. not built
- **Decision:** D7
- **Reason / required changes:** Same as P1-4.
- **Technical spike still necessary:** No.

### XDOC-4 — Prompt injection scope (PRD excludes "detection," tech design requires MVP-baseline defenses and injection eval cases)
- **Decision:** None of the ten approved decisions addresses this. **Remains open.**
- **Required document changes:** None recorded this round — `docs/01-prd.md §17` and `docs/03-technical-design.md §19.3` remain as-is and still read as contradictory about MVP scope.

### XDOC-5 — Test-depth mismatch (MVP scope "basic tests" vs. tech design fault-injection suite)
- **Decision:** D8, D9
- **Reason / required changes:** Same as P1-6.
- **Technical spike still necessary:** No.

### XDOC-6 — Deployment-as-optional (MVP scope `§5.7`) vs. deployment-as-required (tech design `§30` Definition of Done, PRD goal #1)
- **Decision:** None of the ten approved decisions addresses this. **Remains open.**
- **Required document changes:** None recorded this round — `docs/02-mvp-scope.md §5.7` still literally contradicts `docs/03-technical-design.md §30` and `docs/01-prd.md §4`.

### XDOC-7 — "Free/low-cost services" assumption vs. the architecture actually specified
- **Decision:** D1, D10
- **Reason:** D1 removes the Upstash/Redis cost risk entirely (the largest contributor to this concern, per P1-2). D10 retains the remaining Render/Neon cost-and-behavior questions as explicit spikes rather than unvalidated assumptions.
- **Required document changes:** `docs/03-technical-design.md §4.1 Assumptions` — narrow the claim to "Render and Neon low-cost tiers are assumed pending verification (see spikes); Redis/Upstash is no longer part of the architecture."
- **Required implementation changes:** None beyond D1's architecture change.
- **Technical spike still necessary:** Yes, for the Render/Neon portion — see P1-1 and P1-3.

---

## Overengineering Review

### OE-1 — Redis + BullMQ + full transactional outbox
- **Decision:** D1, D2
- **Reason:** D1 is precisely the simplification the review recommended as highest-leverage. D2 preserves the distributed-systems reasoning as documented interview material without gating implementation on building it.
- **Required document changes:** `docs/03-technical-design.md §5.2 Transactional Outbox for Database-to-Queue Delivery` — replace with a short section describing the `agent_jobs` design and explicitly stating that PostgreSQL is both the system of record and the job queue, eliminating the cross-system dual-write problem by construction. All of `§16 Queue, Outbox, and Worker Design` — rewrite around `agent_jobs` claim/lease/retry, removing outbox-specific content (relay, `OutboxEvent`, dead-letter, deterministic BullMQ `jobId`). `docs/10-engineering-challenges.md §3 Challenge 1` — per D2, keep as an "alternatives evaluated" writeup, but add a note (see below) that the MVP did not build it because PostgreSQL serves both roles.
- **Required implementation changes:** Build a single `agent_jobs` table with `PENDING`/`RUNNING`/`COMPLETED`/`FAILED` status, claimed via conditional `UPDATE ... RETURNING` or `FOR UPDATE SKIP LOCKED`; remove BullMQ, Redis client, and outbox relay code entirely from the MVP.
- **Technical spike still necessary:** No — this is a settled architecture decision, not an open question.

### OE-2 — Multi-replica-safe outbox leasing (`FOR UPDATE SKIP LOCKED`, multiple relay replicas)
- **Decision:** D1
- **Reason:** Moot — there is no outbox relay under the approved architecture. The same `FOR UPDATE SKIP LOCKED` primitive may still be used for `agent_jobs` claiming if multiple workers are ever run, but the outbox-specific multi-replica design is gone.
- **Required document changes:** Same as OE-1.
- **Required implementation changes:** None beyond the single `agent_jobs` claim query.
- **Technical spike still necessary:** No.

### OE-3 — Execution-lease heartbeating at call boundaries
- **Decision:** D5
- **Reason:** D5's fail-on-expiry policy removes the need for reclaim-and-continue logic, and therefore the need for heartbeat-driven lease renewal to prevent false reclaim. A single lease set at job start is sufficient.
- **Required document changes:** Same as P0-2/P0-4.
- **Required implementation changes:** No heartbeat-refresh code path; set lease duration once at claim time.
- **Technical spike still necessary:** No (see P0-4 for the related, non-blocking tuning spike).

### OE-4 — Full reconciliation CLI + dead-letter alerting + the `§21.3` metrics list
- **Decision:** D1 (reduces scope), no explicit decision on remaining depth
- **Reason:** D1 removes the outbox-specific dead-letter and relay-reconciliation surface entirely. What remains — detecting stuck `agent_jobs` rows — is much smaller, but the ten approved decisions do not specify how much reconciliation tooling to build for the simplified table.
- **Required document changes:** `docs/03-technical-design.md §16.9 Reconciliation` and `§21.3 Metrics` — rewrite to cover only `agent_jobs` stuck-row detection; remove outbox-specific dead-letter metrics.
- **Required implementation changes:** Not decided this round beyond "smaller than before."
- **Technical spike still necessary:** No. **Remaining scope (how much reconciliation tooling is required) is open**, not decided by this round.

### OE-5 — Four-framework test pyramid + fault-injection integration tests
- **Decision:** D8, D9
- **Reason / required changes:** Same as P1-6. Note that several of the specific fault-injection tests named in the original review (Redis outage, relay crash-before-publish, duplicate BullMQ delivery) are additionally moot under D1, since there is no Redis or relay to inject faults into; the surviving stretch-goal fault-injection tests (per D9) should focus on `agent_jobs` claim races and lease-expiry behavior instead.
- **Technical spike still necessary:** No.

### OE-6 — Cursor pagination, OpenAPI generation, four test modes
- **Decision:** None of the ten approved decisions addresses this. **Remains open** — see P2-1, P2-2, P2-3.

---

## Missing Design Details

### MDD-1 — How the final structured report is elicited from Claude
- **Decision:** D3. Same as P0-1. Resolved.

### MDD-2 — Agent-loop resume behavior after a lease reclaim
- **Decision:** D5. Same as P0-2. Resolved.

### MDD-3 — Exact BullMQ semantics for reconciliation's "republish with the same jobId"
- **Decision:** D1. Same as P0-3. Moot — no BullMQ.

### MDD-4 — Repair/retry policy for schema-invalid model output
- **Decision:** D4. Same as P1-5. Resolved.

### MDD-5 — Concrete rate-limit numbers and the chosen demo-protection mechanism
- **Decision:** None of the ten approved decisions addresses this. **Remains open** — same gap as P1-7.

### MDD-6 — Whether prior-turn tool results remain in context across all subsequent turns
- **Decision:** None of the ten approved decisions addresses this. **Remains open.**
- **Required document changes:** None recorded this round — `docs/03-technical-design.md §13.7 Context Assembly` still only specifies initial-context exclusions, not turn-over-turn context management.

### MDD-7 — Concrete Claude model identifier and embedding dimension
- **Decision:** None of the ten approved decisions addresses this. **Remains open** — still an open question per `docs/03-technical-design.md §33 Open Questions` items 1–2. Note this blocks the first stable `RunbookChunk.embedding` schema regardless of the D1 job-queue simplification, since embedding dimension is unrelated to the queue architecture.

---

## Required Technical Spikes — Final Disposition

| Spike (from the original review) | Disposition under approved decisions | Still necessary? |
|---|---|---|
| Spike 1 — Structured-output elicitation reliability | Design question resolved by D3; spike downgraded to a lightweight, non-blocking validation of forced-tool-choice reliability | Recommended, not blocking |
| Spike 2 — BullMQ deterministic-jobId reconciliation behavior | Moot — BullMQ removed by D1 | No |
| Spike 3 — Execution lease vs. real Claude call latency | Correctness risk resolved by D5 (fail-on-expiry, not reclaim); remaining value is UX tuning (avoiding spurious failures) | Recommended, not blocking |
| Spike 4 — Render background-worker tier and cold-start behavior | Retained explicitly by D10 | **Yes** |
| Spike 5 — Upstash Redis request-quota math | Moot — Redis/Upstash removed by D1 | No |
| Spike 6 — Neon autosuspend impact on demo latency | Retained explicitly by D10 | **Yes** |
| Spike 7 — SSE connection survival through the deployment proxy path | Retained explicitly by D10 | **Yes** |

---

## Summary — Findings With No Decision This Round

The following findings from `docs/reviews/03-technical-design-feasibility-review.md` are not addressed by any of the ten approved decisions and remain open for a future decision round:

- P1-7 — Rate limiting and demo-abuse controls (concrete mechanism and numbers)
- P2-1 — Cursor pagination for list endpoints
- P2-2 — OpenAPI documentation generation
- P2-3 — Four-way test-mode matrix collapse
- P2-4 — Full accessibility requirements sequencing
- P2-5 — Separate eval CI workflow with budget guardrails
- XDOC-4 — Prompt injection scope reconciliation (PRD "future enhancement" vs. tech design MVP-baseline defenses)
- XDOC-6 — Deployment-as-optional (MVP scope) vs. deployment-as-required (tech design, PRD)
- OE-4 (remaining scope) — How much `agent_jobs` reconciliation tooling is required, beyond "smaller than the outbox version"
- OE-6 — Cursor pagination, OpenAPI generation, four test modes (see P2-1/P2-2/P2-3)
- MDD-5 — Concrete rate-limit numbers and demo-protection mechanism (same as P1-7)
- MDD-6 — Turn-over-turn context management for accumulated tool results
- MDD-7 — Concrete Claude model identifier and embedding dimension

No files other than this one were modified in producing this record.
