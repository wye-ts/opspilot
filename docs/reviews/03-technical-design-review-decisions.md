# OpsPilot — Technical Design Review: Approved Decisions

| Field | Value |
|---|---|
| Document | Review Decisions Record |
| Source review | `docs/reviews/03-technical-design-feasibility-review.md` |
| Source documents | `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md` (v1.1), `docs/10-engineering-challenges.md` |
| Status | Decisions approved; document and implementation changes not yet applied |
| Scope | Maps every finding in the feasibility review to an approved architecture decision (or records that none was made). Updated with D11–D19. |

This document records the disposition of every finding in `docs/reviews/03-technical-design-feasibility-review.md` against nineteen approved architecture decisions (D1–D19). It does not modify `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md`, or `docs/10-engineering-challenges.md` — required changes to those documents are recorded here as pending work, not applied.

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
| **D11** | Workers may claim only `PENDING` PostgreSQL agent jobs. A `RUNNING` job is never reclaimed or resumed after lease expiration. A maintenance sweep marks it `FAILED`, and retry creates a new `AgentRun`. |
| **D12** | Every claimed job receives a unique execution fencing token. All worker writes, including `AgentStep`, `ToolExecution`, `PendingAction`, and final `AgentRun` updates, must verify that the run is `RUNNING` and the execution token still matches. If a conditional write affects zero rows, the worker has lost ownership and must stop without persisting the result. |
| **D13** | The public demo uses a deterministic fake provider by default. Live Claude runs require a demo access token. Default configurable limits are 20 live runs globally per day and 5 live runs per access token per hour, with usage persisted in PostgreSQL. |
| **D14** | Structural prompt-injection defenses are required for the MVP. A dedicated prompt-injection detection model or classifier is post-MVP. |
| **D15** | Distinguish Feature Complete from Portfolio Ready. Feature Complete means the project works locally and passes required tests. Portfolio Ready additionally requires a protected public deployment, documentation, screenshots, a demo, and measured eval results. |
| **D16** | The MVP uses a lightweight PostgreSQL job maintenance sweep. Every 60 seconds it marks expired `RUNNING` jobs and their `AgentRun`s `FAILED`, invalidates the execution token, and records a stable timeout error. No automatic resume, dead-letter queue, or dedicated reconciliation CLI is required. |
| **D17** | The bounded Claude conversation is retained across agent turns. Tool outputs are validated, sanitized, and truncated before insertion. The system persists observable trace summaries, not hidden reasoning or the full private model conversation. |
| **D18** | The embedding model and vector dimension will be selected in a small RAG spike before the `RunbookChunk` migration is finalized. The MVP then locks one canonical model and dimension; changing it requires re-ingestion and a schema migration. |
| **D19** | For MVP scope: no ticket pagination is required; OpenAPI generation is post-MVP; only fake-provider and live-provider modes are required; baseline accessibility is required, but a formal audit is post-MVP; agent evals run through a required local/manual script; a dedicated eval CI workflow is a stretch goal. |

---

## P0 Blocking Issues

### P0-1 — Structured final-report elicitation method is unspecified
- **Decision:** D3, D4
- **Reason:** D3 answers the "how" question the review flagged as missing — Claude is forced to call `submit_resolution_report`, eliminating prose-wrapped/free-text parsing risk. D4 supplies the repair path the review recommended in place of the blanket "reject without retry" policy.
- **Required document changes:** `docs/03-technical-design.md §13.5 Structured Output` — state the forced tool-call mechanism explicitly and name the tool. `§13.2 Agent Loop` step 6 — describe the one-attempt repair loop (feed Zod validation error back to Claude, retry once, then fail) instead of implying a single validation pass. `§20.1 Failure Categories` — carve out "final-report schema validation failure" as a distinct row with one retry, separate from the general "invalid model output → reject without retry" row.
- **Required implementation changes:** Define `submit_resolution_report` as a tool with `tool_choice` forcing its use on the final turn; implement a single repair round-trip on Zod validation failure before marking the run `FAILED`.
- **Technical spike still necessary:** Downgraded, not blocking. Spike 1 (structured-output reliability) is still worth running as a lightweight validation of the forced-tool-choice approach across varied tickets, but the design question itself is resolved by D3 — it no longer blocks implementation start.

### P0-2 — Agent-loop resume semantics after a lease reclaim are undefined
- **Decision:** D5, D11, D12, D16
- **Reason:** D5's original policy (no resume, mark failed) is necessary but, on its own, only prevents a *second* worker from concurrently claiming the same run — it does not stop the *original* worker, if it is merely slow rather than actually dead, from continuing to execute and later persisting steps/results against a run the system has already moved to a terminal state. D11 makes this precise: only `PENDING` jobs may be claimed, a `RUNNING` job is never reclaimed by another worker, and a maintenance sweep (D16, every 60 seconds) is the sole mechanism that marks an expired `RUNNING` job `FAILED`. D12 closes the remaining gap: every claim is issued a unique execution fencing token, and every worker write (`AgentStep`, `ToolExecution`, `PendingAction`, `AgentRun` updates) is a conditional write that must match both `status = 'RUNNING'` and the current token. When the sweep marks a job `FAILED`, it invalidates the token, so any further write attempt by the original (stale) worker affects zero rows and must be discarded rather than persisted. This is what actually guarantees single-writer safety — fail-on-expiry alone only changes what a human sees; the fencing token is what prevents the stale worker from corrupting state in the meantime.
- **Required document changes:** `docs/03-technical-design.md §16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery` — rewrite entirely around the `agent_jobs` claim/fencing-token model: only `PENDING` jobs are claimable (D11); every write from a worker is a conditional `UPDATE ... WHERE status = 'RUNNING' AND execution_token = $token`; a write affecting zero rows means the worker must stop immediately and discard its in-memory result (D12). `§17.1 Agent Run State` — replace the `RUNNING → QUEUED: retriable failure` transition with `RUNNING → FAILED` via the maintenance sweep only. `docs/10-engineering-challenges.md §"Agent Run Claiming"` and `§"Execution Lease"` — replace the reclaim-oriented SQL and prose with the fencing-token claim/write pattern.
- **Required implementation changes:** Add an `execution_token` (e.g., UUID) column to the run/job row, generated on each successful claim. Every downstream write from the worker for that run must include `AND execution_token = $token` in its `WHERE` clause and check the affected row count; a zero-row result aborts the worker's current run processing without persisting anything further. Implement the 60-second maintenance sweep (D16) as the only path that transitions an expired `RUNNING` job to `FAILED` and invalidates its token.
- **Technical spike still necessary:** No — the correctness question is resolved by policy and by the fencing-token write pattern, not by measurement.

### P0-3 — Deterministic BullMQ `jobId` reuse interacts unclearly with retention and reconciliation
- **Decision:** D1
- **Reason:** D1 removes BullMQ (and therefore the `jobId`/retention/reconciliation ambiguity) entirely by replacing it with a PostgreSQL-backed `agent_jobs` table. The finding is moot under the approved architecture — there is no external queue with its own retention semantics to reconcile against.
- **Required document changes:** `docs/03-technical-design.md §16.5 Queue` — remove BullMQ job-payload and `jobId` content; replace with the `agent_jobs` claim/lease design. `§16.9 Reconciliation` — rewrite to describe reconciliation over `agent_jobs` rows only (no outbox/queue cross-system reconciliation).
- **Required implementation changes:** No BullMQ job-ID or retention logic to build. Implement `agent_jobs` claim via `UPDATE ... WHERE status = 'PENDING' ... RETURNING *` (or `FOR UPDATE SKIP LOCKED` for a polling worker loop).
- **Technical spike still necessary:** No — Spike 2 (BullMQ jobId reconciliation behavior) is no longer applicable.

### P0-4 — Execution lease duration vs. single Claude call latency is not validated
- **Decision:** D1, D5, D11, D12, D16
- **Reason:** The original review flagged that a too-short lease could let a second worker prematurely reclaim a still-active run, causing two workers to execute concurrently. D11 already prevents the "second worker" half of that scenario by construction (only `PENDING` jobs are claimable; a `RUNNING` job is never reclaimed). The remaining half — the *original* worker continuing to write after the maintenance sweep has already marked its job `FAILED` because the lease looked expired — is **not** solved by fail-on-expiry alone, and D12's fencing token is what actually closes it: once the sweep (D16) invalidates the token, every subsequent conditional write from the original worker affects zero rows and is discarded. Under this design, an undersized lease duration becomes a pure UX/cost concern (a live investigation gets prematurely marked `FAILED` and must be retried as a new `AgentRun`, per D11), never a data-corruption or duplicate-billing concern.
- **Required document changes:** `docs/03-technical-design.md §16.6 Job Options` and `§16.7` — restate lease duration guidance as a UX-tuning parameter only ("set comfortably above expected p99 single-call latency to avoid spurious failures"), and state explicitly that correctness does not depend on this value because of the D12 fencing token. `docs/10-engineering-challenges.md §"Execution Lease"` — update to reflect the fencing-token write pattern, not reclaim-on-expiry.
- **Required implementation changes:** Size the lease duration using real latency data (Spike 3, downgraded to non-blocking, below); implement the D12 conditional-write pattern on every persistence call in the worker so lease sizing is a tuning knob, not a safety mechanism.
- **Technical spike still necessary:** Downgraded, recommended not blocking. Spike 3 (lease vs. real Claude call latency) remains useful purely to avoid an unnecessarily high spurious-failure rate in the demo; it is not a correctness-blocking spike, because D12's fencing token guarantees correctness regardless of the chosen lease duration.

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
- **Decision:** D13
- **Reason:** D13 directly supplies the previously missing mechanism and numbers: fake provider by default, a demo access token required for any live Claude run, and default configurable caps of 20 live runs/day globally and 5 live runs/hour per access token, with usage tracked in PostgreSQL.
- **Required document changes:** `docs/03-technical-design.md §19.2 API Security` — state the access-token requirement for live-provider runs. `§25.4 Public Demo Protection` — replace the five-option list with D13's committed mechanism (fake-provider default, access-token-gated live runs, the two named rate limits) and note the limits are environment-configurable, not hardcoded.
- **Required implementation changes:** Add a `demo_access_tokens` (or equivalent) usage-tracking table in PostgreSQL; enforce the per-token hourly cap and the global daily cap before allowing a live-provider `AgentRun`; default to the fake provider when no valid token is presented.
- **Technical spike still necessary:** No.

---

## P2 Improvements

### P2-1 — Cursor pagination for list endpoints
- **Decision:** D19
- **Reason:** D19 states no ticket pagination is required for MVP scope, resolving this by removing the requirement rather than choosing a lighter pagination scheme.
- **Required document changes:** `docs/03-technical-design.md §12.1 API Conventions` — remove "Cursor pagination for list endpoints that can grow" as an MVP requirement; note it as a post-MVP addition if the seed dataset grows.
- **Required implementation changes:** Ticket list endpoint returns the full seeded set without pagination parameters for MVP.
- **Technical spike still necessary:** No.

### P2-2 — OpenAPI documentation generation
- **Decision:** D19
- **Reason:** D19 explicitly marks OpenAPI generation as post-MVP.
- **Required document changes:** `docs/03-technical-design.md §12.1 API Conventions` — mark "OpenAPI documentation generated from the NestJS API" as post-MVP, not required for Feature Complete (see D15).
- **Required implementation changes:** None for MVP.
- **Technical spike still necessary:** No.

### P2-3 — Four-way test-mode matrix (`test`/`local`/`eval-live`/`production-demo`)
- **Decision:** D19
- **Reason:** D19 collapses the required set to exactly two modes: fake-provider and live-provider.
- **Required document changes:** `docs/03-technical-design.md §22.4 Test Modes` — replace the four-row table with two modes (fake-provider, live-provider), each usable across CI, local development, and eval runs via configuration rather than a named, distinct mode per environment.
- **Required implementation changes:** Ensure the `LlmProvider`/`EmbeddingProvider` abstractions (`§5.6 Provider Isolation`) support switching between fake and live implementations via a single environment flag.
- **Technical spike still necessary:** No.

### P2-4 — Full accessibility requirements
- **Decision:** D19
- **Reason:** D19 requires a baseline accessibility bar for MVP but explicitly defers a formal accessibility audit to post-MVP.
- **Required document changes:** `docs/03-technical-design.md §18.4 Accessibility` — split into "MVP baseline" (keyboard-accessible controls, visible focus indicators, semantic headings — required) and "post-MVP" (formal audit, full live-region coverage verification — deferred).
- **Required implementation changes:** Build baseline keyboard/focus/semantic support as part of normal frontend work; do not schedule a dedicated accessibility audit pass for MVP completion.
- **Technical spike still necessary:** No.

### P2-5 — Separate `agent-evals.yml` CI workflow with budget guardrails
- **Decision:** D19
- **Reason:** D19 requires agent evals to run through a local/manual script for MVP and explicitly demotes a dedicated eval CI workflow to a stretch goal.
- **Required document changes:** `docs/03-technical-design.md §23.5 Eval Workflow` — mark the dedicated `agent-evals.yml` GitHub Actions workflow as a stretch goal; state that `pnpm eval` (already listed in `§24.3 Developer Commands`) run manually/locally satisfies the MVP requirement.
- **Required implementation changes:** Ensure `pnpm eval` works end-to-end locally with the initial agent eval cases; no CI workflow required for MVP completion.
- **Technical spike still necessary:** No.

### P2-6 — ADR backlog (`§32`)
- **Decision:** No change needed — already correctly scoped as deferred, post-hoc documentation in the original review. No action required.

---

## Cross-Document Inconsistencies

### XDOC-1 — Tool taxonomy mismatch (three-way)
- **Decision:** D6
- **Reason / required changes:** Same as P0-5.
- **Technical spike still necessary:** No.

### XDOC-2 — Field-naming mismatch for the execution lease (`leaseOwner`/`leaseExpiresAt` vs. `execution_owner`/`execution_lease_until`)
- **Decision:** D1, D12 (supersedes the underlying schema)
- **Reason:** D1 replaces the `AgentRun` lease fields and the `OutboxEvent` model entirely with a new `agent_jobs` design, so this specific naming drift is superseded rather than reconciled — the new schema needs its own consistent naming from the start. D12 adds a new field (the execution fencing token) that must be named consistently across both documents from the outset, rather than repeating the original drift.
- **Required document changes:** `docs/03-technical-design.md §11.1 Core Entities` — define the `agent_jobs`/`AgentRun` schema with one canonical set of field names (e.g., `leaseOwner`, `leaseExpiresAt`, `executionToken`) and use it consistently everywhere, including `docs/10-engineering-challenges.md`.
- **Required implementation changes:** Implement the new schema once, matching the doc, including the `executionToken` column required by D12, rather than porting the old inconsistent naming forward.
- **Technical spike still necessary:** No.

### XDOC-3 — Mid-run approval gating implied vs. not built
- **Decision:** D7
- **Reason / required changes:** Same as P1-4.
- **Technical spike still necessary:** No.

### XDOC-4 — Prompt injection scope (PRD excludes "detection," tech design requires MVP-baseline defenses and injection eval cases)
- **Decision:** D14
- **Reason:** D14 reconciles the apparent contradiction directly: structural defenses (data boundaries, tool restriction, approval-in-code, injection-focused eval cases) are required for MVP; a dedicated prompt-injection detection model or classifier is explicitly post-MVP. This matches the PRD's actual language in `§17 Future Enhancements` ("prompt injection detection") while preserving the tech design's structural controls as MVP-required.
- **Required document changes:** `docs/01-prd.md §17 Future Enhancements` item 7 — clarify that "prompt injection detection" refers specifically to a dedicated detection/classification model, not the structural defenses already required by the MVP. `docs/03-technical-design.md §19.3 Prompt Injection Defense` — add a sentence distinguishing "structural defenses (MVP-required)" from "active detection/classification (post-MVP)."
- **Required implementation changes:** Build the structural defenses already listed in `§19.3` (data boundaries, tool restriction, approval-in-code, injection-focused eval cases) for MVP; do not build a dedicated injection-detection model or classifier.
- **Technical spike still necessary:** No.

### XDOC-5 — Test-depth mismatch (MVP scope "basic tests" vs. tech design fault-injection suite)
- **Decision:** D8, D9
- **Reason / required changes:** Same as P1-6.
- **Technical spike still necessary:** No.

### XDOC-6 — Deployment-as-optional (MVP scope `§5.7`) vs. deployment-as-required (tech design `§30` Definition of Done, PRD goal #1)
- **Decision:** D15
- **Reason:** D15 resolves the three-way conflict by introducing a two-tier completion model: Feature Complete (works locally, passes required tests) matches `docs/02-mvp-scope.md §5.7`'s literal bar; Portfolio Ready (protected public deployment, documentation, screenshots, demo, measured eval results) matches `docs/03-technical-design.md §30 Definition of Done` and `docs/01-prd.md §4` goal #1. Both bars now coexist explicitly rather than contradicting each other.
- **Required document changes:** `docs/02-mvp-scope.md §5.7 Production Deployment Automation` — reframe as "satisfies Feature Complete; Portfolio Ready requires public deployment" instead of an unqualified "optional." `docs/03-technical-design.md §30 Definition of Done` — split into two labeled subsections, "Feature Complete" and "Portfolio Ready," per D15. `docs/01-prd.md §4 Goals` — note that goal #1 ("Be deployed publicly") is a Portfolio Ready criterion, not a Feature Complete one.
- **Required implementation changes:** None directly — this is a sequencing/labeling decision. It does mean deployment work (Render/Vercel/Neon setup, demo protection per D13) can be explicitly scheduled after Feature Complete rather than in parallel with core feature work.
- **Technical spike still necessary:** No.

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
- **Decision:** D5, D12
- **Reason:** D5's fail-on-expiry policy removes the need for reclaim-and-continue logic, and therefore the need for heartbeat-driven lease renewal to prevent false reclaim. D12 reinforces this independently: because every write is fenced by the execution token rather than relying on lease freshness at read time, there is no correctness reason to refresh the lease mid-job at all — a single lease set at claim time, checked only by the maintenance sweep (D16), is sufficient.
- **Required document changes:** Same as P0-2/P0-4.
- **Required implementation changes:** No heartbeat-refresh code path; set lease duration once at claim time; rely on the fencing token, not lease freshness, for write safety.
- **Technical spike still necessary:** No (see P0-4 for the related, non-blocking tuning spike).

### OE-4 — Full reconciliation CLI + dead-letter alerting + the `§21.3` metrics list
- **Decision:** D1, D16
- **Reason:** D1 removes the outbox-specific dead-letter and relay-reconciliation surface entirely. D16 settles the remaining question the original review left open ("how much reconciliation tooling is required"): a single lightweight maintenance sweep running every 60 seconds that marks expired `RUNNING` jobs and their `AgentRun`s `FAILED`, invalidates the execution token, and records a stable timeout error code — explicitly, no automatic resume, no dead-letter queue, and no dedicated reconciliation CLI.
- **Required document changes:** `docs/03-technical-design.md §16.9 Reconciliation` — replace with the D16 sweep design (60-second interval, `agent_jobs`/`AgentRun` scope only, no dead-letter state, no CLI). `§21.3 Metrics` — remove outbox-specific dead-letter metrics; retain only stuck/expired-job counts relevant to the sweep.
- **Required implementation changes:** Implement the sweep as a simple scheduled function (e.g., a `setInterval` in the worker process or a lightweight cron-style job), not a separate operational tool.
- **Technical spike still necessary:** No — fully resolved.

### OE-5 — Four-framework test pyramid + fault-injection integration tests
- **Decision:** D8, D9
- **Reason / required changes:** Same as P1-6. Note that several of the specific fault-injection tests named in the original review (Redis outage, relay crash-before-publish, duplicate BullMQ delivery) are additionally moot under D1, since there is no Redis or relay to inject faults into; the surviving stretch-goal fault-injection tests (per D9) should focus on `agent_jobs` claim races and lease-expiry behavior instead.
- **Technical spike still necessary:** No.

### OE-6 — Cursor pagination, OpenAPI generation, four test modes
- **Decision:** D19
- **Reason / required changes:** Same as P2-1, P2-2, and P2-3 respectively.
- **Technical spike still necessary:** No.

---

## Missing Design Details

### MDD-1 — How the final structured report is elicited from Claude
- **Decision:** D3. Same as P0-1. Resolved.

### MDD-2 — Agent-loop resume behavior after a lease reclaim
- **Decision:** D5, D11, D12, D16. Same as P0-2. Resolved — including the write-safety mechanism (fencing token), not only the "no resume" policy.

### MDD-3 — Exact BullMQ semantics for reconciliation's "republish with the same jobId"
- **Decision:** D1. Same as P0-3. Moot — no BullMQ.

### MDD-4 — Repair/retry policy for schema-invalid model output
- **Decision:** D4. Same as P1-5. Resolved.

### MDD-5 — Concrete rate-limit numbers and the chosen demo-protection mechanism
- **Decision:** D13. Same as P1-7. Resolved.

### MDD-6 — Whether prior-turn tool results remain in context across all subsequent turns
- **Decision:** D17
- **Reason:** D17 states the bounded Claude conversation (including tool outputs) is retained across turns rather than pruned or summarized; each tool output is validated, sanitized, and truncated before being inserted into that conversation; and what's persisted to the database/UI is a separate, observable trace summary, not the live conversation itself or hidden model reasoning.
- **Required document changes:** `docs/03-technical-design.md §13.7 Context Assembly` — add a subsection stating that tool results accumulate in the live Claude conversation for the duration of the bounded run (up to `AGENT_MAX_TURNS`), each subject to the existing sanitize/truncate rules, and that this is distinct from what `AgentStep`/`ToolExecution` persist to PostgreSQL for the trace UI.
- **Required implementation changes:** Ensure the sanitize/truncate step happens before appending a tool result to the conversation array, not only before persisting it to the database.
- **Technical spike still necessary:** No.

### MDD-7 — Concrete Claude model identifier and embedding dimension
- **Decision:** D18 (embedding dimension only)
- **Reason:** D18 resolves the embedding-dimension half of this finding by defining a process — a small RAG spike selects the embedding model and dimension before the `RunbookChunk` migration is finalized, then the MVP locks that choice, with any future change requiring re-ingestion and a schema migration (consistent with `docs/03-technical-design.md §15.4`'s existing warning). **The Claude reasoning-model identifier itself is not addressed by any of D1–D19 and remains open** — `docs/03-technical-design.md §33 Open Questions` item 1 is still unresolved.
- **Required document changes:** `docs/03-technical-design.md §33 Open Questions` — mark item 2 (embedding dimension) as resolved via the D18 spike-then-lock process; leave item 1 (Claude model) open pending a future decision. `§15.4 Embeddings` — reference the D18 spike as the mechanism for selecting `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` before the first migration.
- **Required implementation changes:** Run the D18 RAG spike before writing the `RunbookChunk` migration; no implementation change yet for the Claude model identifier.
- **Technical spike still necessary:** Yes — a new spike is required for D18 (embedding model/dimension selection); the Claude model identifier choice remains a separate, still-open decision with no spike or decision assigned yet.

---

## Required Technical Spikes — Final Disposition

| Spike (from the original review) | Disposition under approved decisions | Still necessary? |
|---|---|---|
| Spike 1 — Structured-output elicitation reliability | Design question resolved by D3; spike downgraded to a lightweight, non-blocking validation of forced-tool-choice reliability | Recommended, not blocking |
| Spike 2 — BullMQ deterministic-jobId reconciliation behavior | Moot — BullMQ removed by D1 | No |
| Spike 3 — Execution lease vs. real Claude call latency | Correctness risk resolved by D5 + D11 (fail-on-expiry, no reclaim) and, decisively, by D12 (the execution fencing token guarantees write safety independent of lease duration); remaining value is pure UX tuning (avoiding spurious failures) | Recommended, not blocking |
| Spike 4 — Render background-worker tier and cold-start behavior | Retained explicitly by D10 | **Yes** |
| Spike 5 — Upstash Redis request-quota math | Moot — Redis/Upstash removed by D1 | No |
| Spike 6 — Neon autosuspend impact on demo latency | Retained explicitly by D10 | **Yes** |
| Spike 7 — SSE connection survival through the deployment proxy path | Retained explicitly by D10 | **Yes** |
| Spike 8 — Embedding model and vector dimension selection (introduced by D18) | New spike required before the `RunbookChunk` migration is finalized; not part of the original seven | **Yes** |

---

## Summary — Findings With No Decision This Round

After D11–D19, only one substantive item from `docs/reviews/03-technical-design-feasibility-review.md` remains without an assigned decision:

- **MDD-7 (partial)** — The concrete Claude reasoning-model identifier. The embedding-dimension half of this finding is resolved by D18's spike-then-lock process (see Spike 8); the model-identifier half is not addressed by any of D1–D19 and still needs a future decision (`docs/03-technical-design.md §33 Open Questions` item 1).

Every other previously open finding is now resolved:

| Previously open finding | Resolved by |
|---|---|
| P1-7 / MDD-5 — Rate limiting and demo-abuse controls | **D13** |
| P2-1 / OE-6 — Cursor pagination | **D19** (removed as an MVP requirement) |
| P2-2 / OE-6 — OpenAPI generation | **D19** (post-MVP) |
| P2-3 / OE-6 — Four-way test-mode matrix | **D19** (collapsed to fake-provider/live-provider) |
| P2-4 — Full accessibility requirements | **D19** (baseline required, formal audit post-MVP) |
| P2-5 — Separate eval CI workflow | **D19** (local/manual script required; CI workflow is a stretch goal) |
| XDOC-4 — Prompt injection scope | **D14** (structural defenses required; detection model post-MVP) |
| XDOC-6 — Deployment-as-optional vs. required | **D15** (Feature Complete vs. Portfolio Ready) |
| OE-4 (remaining scope) — Reconciliation tooling depth | **D16** (60-second sweep, no CLI, no dead-letter queue) |
| MDD-6 — Turn-over-turn context management | **D17** |

Two P0 findings previously marked resolved by D5 alone have been **strengthened** this round, per explicit review guidance that fail-on-expiry alone is not sufficient:

- **P0-2** and **P0-4** now additionally rely on **D11** (only `PENDING` jobs are claimable; a `RUNNING` job is never reclaimed), **D12** (every worker write is a conditional write fenced by a unique execution token), and **D16** (the 60-second maintenance sweep that invalidates the token on expiry). D12's conditional-write pattern — not fail-on-expiry by itself — is what actually prevents a stale or slow worker from persisting results after losing ownership of a run.

A new spike not present in the original review is introduced by this round:

- **Spike 8** — Embedding model and vector dimension selection, required by **D18** before the `RunbookChunk` migration is finalized.

No files other than this one were modified in producing this update.
