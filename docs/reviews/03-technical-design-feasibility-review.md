# OpsPilot — Technical Design Adversarial Feasibility Review

| Field | Value |
|---|---|
| Document | Adversarial Feasibility Review |
| Reviewed documents | `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md` (v1.1), `docs/10-engineering-challenges.md` |
| Reviewer stance | Senior staff engineer, adversarial feasibility review |
| Scope | Consistency, one-engineer implementability, overengineering, distributed-systems correctness, agent architecture, tool safety, RAG, prompt injection, API/deployment boundaries, testing, deployment provider assumptions, missing decisions, required spikes |
| Status | Review only — no source documents or implementation files were modified |

---

## Executive Verdict

**Feasible with required changes.**

Every individual technique in the reviewed documents is sound distributed-systems and AI-agent engineering — the transactional outbox, execution leases, citation validation, and tool permission model are all internally correct as isolated designs. The problem is not correctness in isolation, it is **scope density relative to a one-engineer portfolio timeline**. `docs/03-technical-design.md` (2,469 lines) specifies a fault-tolerant distributed job pipeline (outbox + relay + leases + dead-letter + reconciliation CLI + multi-replica-safe leasing), a four-framework test pyramid with chaos-style integration tests, and a four-provider deployment topology — for a system whose actual runtime workload is a handful of seeded tickets, five runbooks, and low public traffic. `docs/03-technical-design.md §28 Technical Risks and Mitigations` itself lists "Overengineering → Project not completed" as a top risk, but the rest of the document does not act on that risk.

There are also a small number of genuine correctness/design gaps (agent-loop resume semantics after a crash, how the structured final report is actually elicited from Claude, BullMQ job-ID reuse semantics) that would stall an implementer mid-build, not just slow them down. Those are P0s below.

Before writing code, the highest-leverage decision is whether to keep Redis/BullMQ plus the full transactional outbox, or replace it with a Postgres-only job mechanism (`docs/03-technical-design.md §16.1`, Alternative E, already named and deferred in the design itself). That single choice determines whether roughly a third of the technical design document's content needs to be built at all.

---

## P0 Blocking Issues

### P0-1 — Structured final-report elicitation method is unspecified

- **Finding:** `docs/03-technical-design.md §13.5 Structured Output` defines the target JSON shape and states it "must conform to a runtime-validated schema," and `§13.2 Agent Loop` step 6 says "Validate the final report against the shared schema" — but no section states *how* Claude is made to emit that shape (forced tool-choice on a `submit_resolution_report`-style tool vs. free-text JSON parsing vs. another structured-response mechanism). This is the single most implementation-relevant AI decision in the document and it is missing.
- **Why it matters:** The candidate approaches have materially different reliability, retry, and validation-failure characteristics. Guessing wrong burns real implementation time re-plumbing the agent loop.
- **Failure scenario:** An implementer free-text-parses JSON from Claude's response; Claude occasionally wraps JSON in prose or omits a field; `§20.1 Failure Categories` classifies "invalid model output" as "Reject without retry" — runs fail at a meaningfully higher rate than the `§27 Performance and Cost Targets` goal of "Run success rate on eval set: At least 90%," with no specified repair path.
- **Document section:** `docs/03-technical-design.md §13.5 Structured Output`, `§13.2 Agent Loop`, `§20.1 Failure Categories`.
- **Recommended correction:** Specify the mechanism explicitly — the strongest option is a forced tool-call (`tool_choice: {type: "tool", name: "submit_resolution_report"}`) so Claude's output is always the tool's structured input, avoiding prose-wrapping entirely. Add one bounded repair attempt (feed the Zod validation error back to Claude once) before failing the run, rather than applying the current blanket "reject without retry" policy to this specific failure type.

### P0-2 — Agent-loop resume semantics after a lease reclaim are undefined

- **Finding:** `docs/03-technical-design.md §16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery` and `docs/10-engineering-challenges.md §"Agent Run Claiming"` (under Challenge 1 → Implementation Notes) describe how a crashed run's lease is reclaimed by a new worker, but neither document states what the reclaiming worker does with the run: restart the agent loop from turn 1 (re-issuing already-completed tool calls and model turns), or resume from the last persisted `AgentStep`/`ToolExecution`.
- **Why it matters:** `§13.3 Bounded Execution` enforces hard caps ("Maximum total tool calls: 5," "Maximum calls to the same tool: 2"). If a reclaimed run restarts from scratch, either those counters silently reset (allowing more real tool executions and Claude calls than the limit implies, inflating cost) or they must be seeded from prior `ToolExecution` rows — logic that is not described anywhere.
- **Failure scenario:** A worker crashes after 2 tool calls and 1 model turn. Reclaim restarts the loop fresh. The run now performs up to 5 more tool calls and 6 more model turns — more than double the intended Claude spend against `AGENT_MAX_TOOL_CALLS=5` — while the trace UI shows two overlapping sets of steps for one run, undermining `§21.2 Agent Trace`'s framing of the trace as "a product feature and an engineering diagnostic surface."
- **Document section:** `docs/03-technical-design.md §16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery`, `§13.3 Bounded Execution`.
- **Recommended correction:** State explicitly that reclaim restarts the loop from scratch (consistent with the design's own admission in `§16.7` that "the model may be called again after an unexpected crash... acceptable for the MVP") **and** make the tool-call/turn counters run-lifetime (recomputed from existing `ToolExecution`/`AgentStep` rows on start) rather than in-memory, so limits are enforced correctly across a restart.

### P0-3 — Deterministic BullMQ `jobId` reuse interacts unclearly with retention and reconciliation

- **Finding:** `§16.5 Queue` mandates the outbox event's UUID as the BullMQ `jobId` and states "a duplicate add should be treated as successful publication when the same job already exists." `§16.9 Reconciliation` separately says repair may "republish an existing outbox event with the same deterministic jobId." `§16.6 Job Options` also specifies "Remove completed queue metadata after a retention period." BullMQ's actual behavior on `add()` differs depending on whether the matching `jobId` still exists in Redis (no-op) or has been removed by retention cleanup (creates a fresh job) — the design never states which case reconciliation is meant to trigger, nor how this interacts with BullMQ's own `attempts: 3` retry mechanism having already been exhausted.
- **Why it matters:** This is the mechanism that recovers stuck investigations. If reconciliation's "republish" silently no-ops because BullMQ still retains metadata for the old (already-failed) job, an operator or an automated test will believe recovery works when it does not.
- **Failure scenario:** A job exhausts its 3 BullMQ attempts and is marked failed but retained for debugging (per `§16.6`). Reconciliation later tries to "republish with the same jobId" to recover it — BullMQ sees an existing (failed) job with that ID and no-ops the add. The run stays stuck; the reconciliation command reports success.
- **Document section:** `docs/03-technical-design.md §16.5 Queue`, `§16.6 Job Options`, `§16.9 Reconciliation`.
- **Recommended correction:** Resolve with Required Technical Spike 2 before implementation, and add an explicit statement of the exact BullMQ API call reconciliation uses (e.g., remove-then-readd, or a distinct jobId suffix per republish attempt with the outbox event as the idempotency anchor rather than the literal BullMQ jobId).

### P0-4 — Execution lease duration vs. single Claude call latency is not validated

- **Finding:** `§16.6 Job Options` sets Execution lease = 30 seconds and heartbeat = every 10 seconds, but `docs/10-engineering-challenges.md §"Execution Lease"` states the lease is refreshed only "before a model call / after a model call / before a tool call / after a tool call" — i.e., only at call boundaries, not during a call. A single Claude call, especially one involving tool-use decision-making, is not bounded to under 30 seconds; provider latency spikes into the 20-40 second range are common and are the explicit reason `§13.3 Bounded Execution` sets a 90-second overall job timeout.
- **Why it matters:** If one in-flight model call exceeds the lease window because heartbeats only fire at call boundaries, a second worker can legitimately reclaim the "stale" lease and begin executing the same run concurrently — two workers now issue Claude calls and persist `AgentStep`/`ToolExecution` rows for one investigation.
- **Failure scenario:** Worker A calls Claude; the call takes 35 seconds. At second 30, Worker B observes an expired lease and reclaims. Both workers now believe they hold exclusive ownership. The unique index on `AgentStep(agentRunId, sequence)` (`§11.3 Important Indexes and Constraints`) will throw on the first colliding insert, but by then both workers may have already made billed Claude calls and/or tool executions — the claim in `§16.7` that "the design guarantees one active owner" does not hold in this window.
- **Document section:** `docs/03-technical-design.md §16.6 Job Options`, `§16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery`, `docs/10-engineering-challenges.md §"Execution Lease"`.
- **Recommended correction:** Either (a) heartbeat on a background timer independent of call boundaries, or (b) set lease duration meaningfully longer than the slowest expected single provider round trip (e.g., 60-75 seconds), sized to exceed p99 single-call latency, not average latency. Validate with Required Technical Spike 3.

### P0-5 — PRD tool taxonomy is internally inconsistent and doesn't match downstream documents

- **Finding:** See Cross-Document Inconsistencies #1. The PRD defines two different, non-overlapping state-changing tool sets in the same document, and neither matches the MVP scope's or technical design's list.
- **Why it matters:** This is exactly the kind of ambiguity `docs/02-mvp-scope.md §11 Implementation Boundary for Claude Code` warns against — a task scoped from "read the PRD and implement the tools" would get a different answer depending on which PRD section it read.
- **Failure scenario:** An implementation task references `docs/01-prd.md §9.2` for the state-changing tool list, builds `MARK_TICKET_RESOLVED` and `ASSIGN_TICKET_OWNER` as separate action types, then a later task references `docs/03-technical-design.md §14.4` and finds only three action types exist, requiring rework.
- **Document section:** `docs/01-prd.md §8.3 Tool Calling`, `§9.2 State-Changing Tools`; `docs/02-mvp-scope.md §4.6 Diagnostic Tools`; `docs/03-technical-design.md §14.4 Approval-Required Actions`.
- **Recommended correction:** Update `docs/01-prd.md §9.2` to exactly match the three action types canonical in the technical design (`UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, `DRAFT_CUSTOMER_REPLY`), removing "send customer reply," "assign ticket owner," and "mark ticket as resolved" as distinct items, or explicitly marking them post-MVP.

---

## P1 High-Risk Issues

### P1-1 — Render background-worker free-tier availability is unverified and load-bearing

`docs/03-technical-design.md §4.1 Assumptions` assumes "the initial deployment may use free or low-cost managed services," and `§25.2 Service Configuration` places the outbox relay and BullMQ consumer on a Render **Background Worker** (a distinct service type from a **Web Service**). Free tiers on managed-hosting platforms have historically applied to web services but not to continuously-running background workers. If that remains true, the entire queue subsystem requires an always-on paid instance, contradicting the "low-cost" assumption and independently reinforcing the case for removing Redis/BullMQ (see Overengineering Review #1). **Requires external verification** — do not assume current Render pricing or tier behavior.

### P1-2 — Upstash Redis free-tier request budget likely can't sustain the recommended poll interval

`§16.3 Outbox Relay` recommends a 500ms poll interval for the relay. At that cadence the relay alone issues on the order of 170,000+ operations per day, before counting BullMQ's own internal Redis command volume for job state, retries, and connection keep-alives. Managed Redis free tiers are commonly request-metered in the low tens-of-thousands/day range. This is a straightforward capacity calculation, but the exact current Upstash quota **requires external verification**. Recommend increasing the poll interval substantially (e.g., 2-5 seconds) regardless, since `§27 Performance and Cost Targets` only requires "Outbox dispatch lag p95: Under 2 seconds," not sub-second dispatch.

### P1-3 — Neon autosuspend cold-start could break the demo's "click Analyze Ticket" moment

Managed Postgres free tiers commonly auto-suspend idle compute with a multi-second wake-up on the next query. `§27`'s "Ticket list API p95: Under 300 ms **excluding cold start**" carve-out implicitly acknowledges this risk without resolving it for the actual first-load experience a reviewer will have. **Requires external verification** of current Neon free-tier suspend behavior, and a decision on whether a keep-warm mechanism is worth the added complexity.

### P1-4 — Mid-investigation approval gating is implied by the PRD but not built

`docs/01-prd.md §7 Flow 2` and `docs/02-mvp-scope.md §4.4 Agent Trace Panel`'s `approval_required` step type read naturally as: the agent can pause during an investigation, wait for a human decision, then continue. `docs/03-technical-design.md §13.1 Agent Responsibilities` and `§14.4 Approval-Required Actions` establish that approval-required actions are only ever proposed as part of the already-completed final report — there is no mid-loop pause-for-approval-then-resume path. This is a defensible simplification (it avoids suspending and resuming a multi-turn Claude conversation across an arbitrary human delay) but it silently narrows what Flow 2 describes. Reconcile the documents explicitly.

### P1-5 — Reject-without-retry policy for invalid model output has no repair loop

`§20.1 Failure Categories` classifies "Invalid API body or model output" uniformly as "Reject without retry." Applied literally to the final report schema, one malformed Claude response (a missed field, an out-of-range confidence value) fails the entire run and consumes the full token/latency cost with nothing to show for it. Given the `§27` target of ≥90% eval success rate, one bounded repair attempt (feed the validation error back to the model once) is cheap insurance the design as written doesn't allow for this specific failure type, as distinct from genuinely malformed API request bodies where reject-without-retry is correct.

### P1-6 — Test pyramid breadth exceeds MVP scope's own stated bar

`docs/03-technical-design.md §22 Testing Strategy` specifies four distinct test frameworks (Jest, Vitest + React Testing Library, Playwright, plus a fake-LLM contract-test harness) and integration tests that simulate Redis outages, relay-crash-before-publish, duplicate BullMQ delivery, and stale-lease recovery — effectively chaos/fault-injection testing. `docs/02-mvp-scope.md §4.10 Basic Evaluation Cases`, `§4.11 Basic CI`, and `§8 MVP Acceptance Criteria` describe the MVP bar as "basic automated tests" and "basic CI" (lint, typecheck, unit tests, build). Building the full fault-injection suite is valuable engineering content for interviews, but as a required MVP deliverable it's a significant, independent completion risk layered on top of the outbox/lease implementation itself.

### P1-7 — Rate limiting and demo-abuse controls are named but not specified

`§19.2 API Security` says "Rate limit on agent-run creation" without numbers, and `§25.4 Public Demo Protection` lists five possible demo-protection mechanisms as alternatives without committing to one. Since `docs/01-prd.md` goal #1 is "Be deployed publicly," and real Claude/Voyage API cost is directly exposed by the public demo, this is a concrete decision needed before the deployment is safe to share, not an implementation detail that can be deferred indefinitely.

---

## P2 Improvements

- **Cursor pagination for list endpoints** (`§12.1 API Conventions`) is unnecessary complexity against a seed dataset of a handful of tickets; offset/limit (or no pagination at all for MVP) is sufficient and can be upgraded later without an API contract break if the response envelope reserves the field.
- **OpenAPI generation** (`§12.1`) is nice-to-have; low priority against completion risk.
- **Four-way test-mode matrix** (`§22.4 Test Modes`: `test`/`local`/`eval-live`/`production-demo`) is more harness surface than needed up front; `test` and `eval-live` are the two that matter for MVP completion, `local` can mean "point at real or fake providers via env var" without a formally distinct mode.
- **Full accessibility requirements** (`§18.4 Accessibility`: live regions, focus indicators, keyboard navigation) are good practice but should be sequenced after the core flow works, not as a blocking MVP requirement.
- **Separate `agent-evals.yml` CI workflow with budget guardrails** (`§23.5 Eval Workflow`) is reasonable but can start as a manually-triggered script before it's a full second CI pipeline.
- **ADR backlog** (`§32 Architecture Decision Records to Add Later`) is already correctly scoped as deferred, post-hoc documentation — no action needed, confirming only.

---

## Cross-Document Inconsistencies

1. **Tool taxonomy mismatch (three-way).** `docs/01-prd.md §8.3 Tool Calling` lists 2 state-changing tools (`create_escalation`, `update_ticket_status`); the same document's `§9.2 State-Changing Tools` lists 5 differently-named items (adds "send customer reply," "assign ticket owner," "mark ticket as resolved" — none of which appear in `§8.3`). `docs/02-mvp-scope.md §4.6 Diagnostic Tools` lists 3 state-changing tools and introduces `draft_customer_reply`, a name that appears nowhere in the PRD. `docs/03-technical-design.md §14.4 Approval-Required Actions` matches the MVP scope's 3 (`DRAFT_CUSTOMER_REPLY`), not the PRD's terminology. The PRD is inconsistent with itself before it is inconsistent with the other two documents.

2. **Field-naming mismatch for the execution lease.** `docs/03-technical-design.md §11.1 Core Entities` (AgentRun domain model) defines `leaseOwner`, `leaseExpiresAt`, `lastHeartbeatAt`. `docs/10-engineering-challenges.md §"Agent Run Claiming"` SQL example uses `execution_owner` and `execution_lease_until` for the same concept. Cosmetic in isolation, but exactly the kind of drift that produces a schema mismatch if a task is scoped against one document and not the other, per `docs/02-mvp-scope.md §11`'s own warning about narrow, document-scoped tasks.

3. **Mid-run approval gating implied vs. not built.** `docs/01-prd.md §7 Flow 2: Approve a Suggested Action` and `docs/02-mvp-scope.md §4.4 Agent Trace Panel`'s `approval_required` trace-step type read as an in-line pause-and-resume mechanic. `docs/03-technical-design.md §13.1 Agent Responsibilities` / `§14.4 Approval-Required Actions` only support proposing approval-required actions as part of the already-finalized report. Not contradictory in a way that blocks implementation, but genuinely under-reconciled. See P1-4.

4. **Prompt injection scope.** `docs/01-prd.md §17 Future Enhancements` item 7 lists "Prompt injection detection" as explicitly out of MVP scope. `docs/03-technical-design.md §19.3 Prompt Injection Defense` specifies MVP-baseline structural defenses (data boundaries, tool restriction, approval-in-code) *and* "injection-focused eval cases" as required MVP work. These are not strictly the same thing (architectural defense vs. active detection), but as written they read as contradictory about whether injection-handling work belongs in the MVP at all. Needs one sentence of reconciliation: architectural defenses are MVP-in, active injection detection/classification is post-MVP.

5. **Test-depth mismatch.** `docs/02-mvp-scope.md §4.10`, `§4.11`, and `§8 MVP Acceptance Criteria` set the MVP bar at "basic automated tests" and "basic CI" (lint/typecheck/unit/build). `docs/03-technical-design.md §22 Testing Strategy` specifies fault-injection-grade integration tests (simulated Redis outage, relay crash mid-publish, duplicate delivery, stale-lease recovery) as required coverage — a significant escalation over the MVP scope document's own stated bar. See P1-6.

6. **Deployment-as-optional vs. deployment-as-required.** `docs/02-mvp-scope.md §5.7 Production Deployment Automation` states "Optional deployment is acceptable ... the MVP is considered complete if it runs locally." `docs/03-technical-design.md §30 Definition of Done` lists "The application is deployed and uses synthetic data" as a required completion item, and `docs/01-prd.md` goal #1 (`§4 Goals`) is "Be deployed publicly." Three documents, three different positions on whether public deployment gates MVP completion. The PRD's stated project goal should win here, but `§5.7`'s literal text currently contradicts it and should be corrected rather than left as a stale "optional" carve-out.

7. **Free/low-cost service assumption vs. the architecture actually specified.** `docs/03-technical-design.md §4.1 Assumptions` assumes low-cost managed services suffice, but the architecture it goes on to specify (always-on separate worker process, 500ms outbox polling against Upstash) is not validated against that assumption. See P1-1 and P1-2.

---

## Overengineering Review

Ranked by leverage (highest time/risk savings first):

1. **Redis + BullMQ + full transactional outbox** (`docs/03-technical-design.md §5.2 Transactional Outbox for Database-to-Queue Delivery`, all of `§16 Queue, Outbox, and Worker Design`, `docs/10-engineering-challenges.md §3 Challenge 1 — Database and Queue Dual-Write Consistency` in full). This is the single biggest simplification opportunity in the whole design. The system has one logical workspace, low traffic, and mock/deterministic tool outputs (`§4.1`). The design's own `§16.1 Consistency Model`, Alternative E ("Use PostgreSQL as the Job Queue," in `docs/10-engineering-challenges.md §"Alternatives Considered"`) names a Postgres-only job queue and states it "remains a valid future simplification if operating Redis becomes unnecessary" — for a solo-engineer MVP, "unnecessary" is now, not later. Replacing BullMQ with a Postgres-polling job table (`SELECT ... FOR UPDATE SKIP LOCKED` directly against a jobs table, no separate queue system) eliminates the outbox pattern entirely (single-database writes are already atomic), the relay process, deterministic-jobId reconciliation, dead-letter handling, multi-replica lease-safe relay logic, and the Upstash deployment component — roughly a third of `docs/03-technical-design.md`'s content and testing surface. The distributed-systems reasoning captured in `docs/10-engineering-challenges.md` remains valuable as a documented design discussion for interviews even if the simpler version ships — the document doesn't have to describe only what was built to be useful, but the implementation should not be gated on building the harder version first.

2. **Multi-replica-safe outbox leasing** (`§16.3 Outbox Relay`, `§16.10 Concurrency and Locking`) and multiple relay replicas. The actual deployment (`§25.2 Service Configuration`) runs one Render worker instance. `FOR UPDATE SKIP LOCKED` multi-consumer-safe leasing solves a problem (multiple concurrent relay instances) the deployment topology doesn't create. Keep a single conditional-update claim; drop the "multiple relay replicas" design goal.

3. **Execution-lease heartbeating at call boundaries** (`§16.6 Job Options`, `§16.7`). For jobs capped at a 90-second timeout (`§13.3 Bounded Execution`), a single lease claimed at job start with a duration comfortably longer than the timeout (e.g., 120 seconds) removes the need for heartbeat-refresh logic entirely, and resolves P0-4 by construction.

4. **Full reconciliation CLI + dead-letter alerting + the `§21.3 Metrics` list.** Reasonable content to design (and genuinely good interview material), but building operational tooling for a system nobody operates on-call is lower priority than finishing the product loop. Keep the concept; cut it to a single manual script, not a maintained subsystem with its own test coverage requirement.

5. **Four-framework test pyramid + fault-injection integration tests** (`§22 Testing Strategy`). See P1-6. Tier this: unit tests plus one integration test path (happy path through the real Postgres/queue mechanism) plus a handful of E2E flows are enough for MVP completion; the crash/duplicate/stale-lease integration tests are valuable but should be scoped as stretch goals, explicitly not gating "done."

6. **Cursor pagination, OpenAPI generation, four test modes** — see P2 above, same theme: reasonable production patterns, unnecessary against this dataset size and timeline.

---

## Missing Design Details

1. **How the final structured report is elicited from Claude** (forced tool-choice vs. free-text JSON) — `docs/03-technical-design.md §13.5 Structured Output`. See P0-1.
2. **Agent-loop resume behavior after a lease reclaim** (restart vs. resume-from-step, and how run-lifetime limits are recomputed) — `§16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery`. See P0-2.
3. **Exact BullMQ semantics for reconciliation's "republish with the same jobId"** given retention/removal settings — `§16.9 Reconciliation`. See P0-3.
4. **Repair/retry policy specifically for schema-invalid model output**, distinct from the blanket "reject without retry" default — `§20.1 Failure Categories`. See P1-5.
5. **Concrete rate-limit numbers and the chosen demo-protection mechanism** — `§25.4 Public Demo Protection` lists options, doesn't pick one. See P1-7.
6. **Whether prior-turn tool results remain in the Claude conversation context for every subsequent turn**, or are pruned/summarized — `§13.7 Context Assembly` states what's excluded from the *initial* context but not how context is managed turn-over-turn as tool results accumulate across up to 6 turns (`§13.3`).
7. **Concrete Claude model identifier and embedding dimension** — explicitly flagged as open questions in `§33 Open Questions` items 1-2, but the schema (`RunbookChunk.embedding`, a fixed-dimension vector column, `§11.1 Core Entities`) cannot be migrated cheaply once chosen (`§15.4 Embeddings`: "Changing embedding dimensions requires a migration or a new embedding column/table"), so this blocks the first stable schema, not just a config value.

---

## Required Technical Spikes

### Spike 1 — Structured-output elicitation reliability

- **Question being validated:** Does forced tool-choice (a `submit_resolution_report`-style tool) reliably produce schema-valid output across a range of ticket inputs, including edge cases (ambiguous ticket, no relevant runbook, tool error mid-investigation)?
- **Minimal implementation:** Single script calling the Claude Messages API with forced tool-choice matching the `ResolutionReport` Zod schema (`§13.5`), run against 15-20 varied mock tickets, including deliberately ambiguous/adversarial ones.
- **Pass criteria:** At least 95% of responses parse and validate against the schema without a repair step.
- **Fail criteria:** Meaningful rate of malformed/incomplete tool-call arguments, or the model refuses to call the tool.
- **Estimated relative effort:** S

### Spike 2 — BullMQ deterministic-jobId reconciliation behavior

- **Question being validated:** What actually happens when the relay `add()`s a job with a jobId matching a completed/failed/removed job of the same ID under the configured retention settings (`§16.5`, `§16.6`, `§16.9`)?
- **Minimal implementation:** Local BullMQ + Redis test: create a job, let it fail through all attempts, apply the configured `removeOnComplete`/`removeOnFail` settings, then attempt to re-add the same jobId and observe whether a new attempt cycle starts.
- **Pass criteria:** A clear, documented answer for each relevant retention configuration, with a resulting reconciliation implementation that provably re-triggers processing.
- **Fail criteria:** Re-add silently no-ops for at least one relevant retention configuration and no alternative mechanism is found.
- **Estimated relative effort:** S

### Spike 3 — Execution lease vs. real Claude call latency distribution

- **Question being validated:** What is the realistic p99 single-call latency for a tool-use-enabled Claude call representative of this workload, and does the proposed 30-second lease (`§16.6`) survive it?
- **Minimal implementation:** Fire 30-50 representative agent-turn calls (with tool definitions attached) against the real API, record the latency distribution.
- **Pass criteria:** Chosen lease duration exceeds observed p99 with margin.
- **Fail criteria:** p99 latency approaches or exceeds the lease window.
- **Estimated relative effort:** S

### Spike 4 — Render background-worker tier and cold-start behavior

- **Question being validated:** Does Render currently offer a free or low-cost tier for a continuously-running Background Worker service (not Web Service), and what is current Web Service cold-start latency?
- **Minimal implementation:** Deploy a trivial worker and web service to Render, inspect current plan/pricing pages and actual idle/wake behavior.
- **Pass criteria:** A free or low-single-digit-dollar tier exists that can run the worker continuously without unacceptable gaps, or a documented decision to pay for it.
- **Fail criteria:** No viable low-cost always-on worker tier exists — this should trigger reconsidering the Redis/BullMQ removal (Overengineering Review #1) as load-bearing, not optional.
- **Estimated relative effort:** S — **flagged for external verification; do not assume current Render pricing or tiers.**

### Spike 5 — Upstash Redis request-quota math against real polling load

- **Question being validated:** Does the current Upstash free/low-cost tier's request quota survive the recommended 500ms outbox poll interval (`§16.3`) plus BullMQ's own Redis command volume for a full day of idle-plus-demo traffic?
- **Minimal implementation:** Compute expected daily command volume from the configured poll interval and BullMQ concurrency/keep-alive settings; compare against Upstash's current published limits.
- **Pass criteria:** Projected volume stays comfortably under quota at the recommended settings, or a longer poll interval is adopted that does.
- **Fail criteria:** Projected volume exceeds quota at recommended settings.
- **Estimated relative effort:** S — **current Upstash pricing/limits require external verification.**

### Spike 6 — Neon autosuspend impact on demo latency

- **Question being validated:** What is the actual cold-start latency after Neon free-tier compute autosuspend, and is it acceptable for a portfolio demo's first interaction?
- **Minimal implementation:** Deploy to Neon free tier, let compute idle past the suspend threshold, measure first-query latency.
- **Pass criteria:** Cold-start latency is low enough (or maskable with a loading state) not to read as broken.
- **Fail criteria:** Multi-second-plus delay with no graceful UI handling.
- **Estimated relative effort:** S — **current Neon tier behavior requires external verification.**

### Spike 7 — SSE connection survival through the deployment proxy path

- **Question being validated:** Does a long-lived SSE connection (up to the ~90-second job timeout plus 15-second heartbeats per `§12.4 SSE Event Contract`) survive Render's front door / load balancer without being forcibly closed?
- **Minimal implementation:** Deploy the SSE endpoint, hold a connection open for several minutes with heartbeats, confirm no forced disconnect.
- **Pass criteria:** Connection survives at least 2-3x the expected run duration without intervention.
- **Fail criteria:** Proxy-level idle timeout closes the connection before a run completes, forcing reliance on the polling fallback (`§18.2 Feature Modules`, Agent Trace) more often than intended.
- **Estimated relative effort:** S

---

## Recommended Implementation Order

This follows `docs/02-mvp-scope.md §7 MVP Build Order`'s phase structure but inserts the decision points and spikes that the technical design currently defers or leaves implicit, and sequences the highest-uncertainty infrastructure choice (Spikes 4-5, Redis vs. Postgres-only queue) before any code is written against it — reworking that decision after the outbox/lease code exists would be the most expensive possible time to change it.

1. **Decide the job-queue architecture first** (Overengineering Review #1): run Spike 4 and Spike 5, then decide Redis+BullMQ+outbox vs. Postgres-only queue before writing any of `apps/worker`. This single decision reshapes `packages/database`, `apps/worker`, and the deployment topology — sequence it before Phase 2 of the MVP build order, not after.
2. **Phase 1-2 as scoped** (`docs/02-mvp-scope.md §7`, Phase 1: Planning; Phase 2: Project Scaffold; Phase 3: Ticket Vertical Slice): monorepo scaffold, ticket vertical slice, no agent/RAG/tools/queue yet. Low risk, builds confidence and the shared `packages/contracts`/`packages/database` foundation.
3. **Spike 1 (structured output) before Phase 4: Basic Agent.** Resolve P0-1 with a throwaway script against the real Claude API before wiring it into the agent loop — cheaper to fix the elicitation strategy in a small script than inside the full orchestrator.
4. **Phase 4: Basic Agent**, using whichever queue mechanism was chosen in step 1, with the resume/limit-counting fix from P0-2 built in from the start rather than retrofitted.
5. **Phase 5: Tools, then Phase 6: RAG** (`docs/02-mvp-scope.md §7` order is reasonable here — tools before RAG lets the bounded tool-calling loop get proven out on the simpler mock-data tools first).
6. **Phase 7: Approval Flow**, resolving P1-4 (documenting the "approval only at final report" narrowing) as part of this phase, not after.
7. **Spike 3 (lease vs. latency) once real Claude calls are flowing** from Phase 4 onward — use production-shaped latency data, not synthetic estimates, to finalize lease duration (P0-4).
8. **Phase 8: Evals and CI**, scoped to the tiered test plan from P1-6/Overengineering Review #5 — required unit tests plus one integration path plus minimal E2E first; fault-injection integration tests as a follow-up pass if time remains.
9. **Spikes 2, 6, 7 and deployment** (`docs/02-mvp-scope.md §7` Phase 9: Portfolio Polish; `docs/03-technical-design.md §25 Deployment Architecture`) — run these once the app is feature-complete locally, since they validate infrastructure assumptions that shouldn't gate feature development.
10. **Reconcile the documents** (all seven items in Cross-Document Inconsistencies) as a short pass before calling the project portfolio-ready — cheap to fix, embarrassing to leave contradictory in a repo meant to demonstrate rigor to reviewers.
