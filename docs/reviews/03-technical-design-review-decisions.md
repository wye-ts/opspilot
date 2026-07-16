# OpsPilot — Technical Design Review: Approved Decisions

| Field | Value |
|---|---|
| Document | Review Decisions Record |
| Source review | `docs/reviews/03-technical-design-feasibility-review.md` |
| Source documents | `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md` (v1.1), `docs/10-engineering-challenges.md` |
| Status | Decisions approved; document and implementation changes not yet applied |
| Scope | Maps every finding in the feasibility review to an approved architecture decision. Updated with D11–D19, then corrected/extended with D12 (ownership-fenced transaction), strengthened D13, and new D20. |

This document records the disposition of every finding in `docs/reviews/03-technical-design-feasibility-review.md` against twenty approved architecture decisions (D1–D20). It does not modify `docs/01-prd.md`, `docs/02-mvp-scope.md`, `docs/03-technical-design.md`, or `docs/10-engineering-challenges.md` — required changes to those documents are recorded here as pending work, not applied.

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
| **D12** | Every claimed job receives a unique execution fencing token, enforced through an ownership-fenced repository transaction. Every worker persistence operation must: begin a database transaction; lock and verify the related `agent_jobs` row (`SELECT ... FOR UPDATE`); confirm `status = RUNNING` and that `executionToken` matches; only then insert `AgentStep`, `ToolExecution`, or `PendingAction` records, or update `AgentRun`, within that same transaction; and roll back and stop without persisting if ownership verification fails. The maintenance sweep updates the same `agent_jobs` row, so it participates in the same locking boundary. |
| **D13** | The public demo uses a deterministic fake provider by default. Live Claude runs require a demo access token. Default configurable limits are 20 live runs globally per day and 5 live runs per access token per hour, with usage persisted in PostgreSQL. Demo access tokens are never stored in plaintext — PostgreSQL stores a cryptographic token hash and safe identifying metadata. Rate-limit usage updates are atomic. Expired or disabled tokens cannot start live-provider runs. Fake-provider mode remains available without a live token. |
| **D14** | Structural prompt-injection defenses are required for the MVP. A dedicated prompt-injection detection model or classifier is post-MVP. |
| **D15** | Distinguish Feature Complete from Portfolio Ready. Feature Complete means the project works locally and passes required tests. Portfolio Ready additionally requires a protected public deployment, documentation, screenshots, a demo, and measured eval results. |
| **D16** | The MVP uses a lightweight PostgreSQL job maintenance sweep. Every 60 seconds it marks expired `RUNNING` jobs and their `AgentRun`s `FAILED`, invalidates the execution token, and records a stable timeout error. No automatic resume, dead-letter queue, or dedicated reconciliation CLI is required. |
| **D17** | The bounded Claude conversation is retained across agent turns. Tool outputs are validated, sanitized, and truncated before insertion. The system persists observable trace summaries, not hidden reasoning or the full private model conversation. |
| **D18** | The embedding model and vector dimension will be selected in a small RAG spike before the `RunbookChunk` migration is finalized. The MVP then locks one canonical model and dimension; changing it requires re-ingestion and a schema migration. |
| **D19** | For MVP scope: no ticket pagination is required; OpenAPI generation is post-MVP; only fake-provider and live-provider modes are required; baseline accessibility is required, but a formal audit is post-MVP; agent evals run through a required local/manual script; a dedicated eval CI workflow is a stretch goal. |
| **D20** | The exact Claude model identifier is selected during the structured-output spike before the live-provider implementation is finalized. The model remains environment-configurable. Every `AgentRun` persists the exact provider and model identifier used. The baseline model must be evaluated for tool-selection quality, structured-report validity, latency, token usage, and estimated cost. Changing the production-demo default model requires rerunning and recording the agent eval suite, but does not require a schema migration. |

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
- **Reason:** D5's original policy (no resume, mark failed) is necessary but, on its own, only prevents a *second* worker from concurrently claiming the same run — it does not stop the *original* worker, if it is merely slow rather than actually dead, from continuing to execute and later persisting steps/results against a run the system has already moved to a terminal state. D11 makes this precise: only `PENDING` jobs may be claimed, a `RUNNING` job is never reclaimed by another worker, and a maintenance sweep (D16, every 60 seconds) is the sole mechanism that marks an expired `RUNNING` job `FAILED`. The corrected D12 closes the remaining gap with an **ownership-fenced repository transaction**, not a bare conditional `WHERE` clause on an `INSERT`: every worker persistence operation opens a transaction, locks and re-reads the owning `agent_jobs` row (`SELECT ... FOR UPDATE`), confirms `status = RUNNING` and that `executionToken` still matches the token issued at claim time, and only then performs its `AgentStep`/`ToolExecution`/`PendingAction` insert or `AgentRun` update inside that same transaction — rolling back and discarding the result if ownership verification fails. When the sweep (D16) marks a job `FAILED`, it updates the same `agent_jobs` row under the same locking boundary, so any later transaction attempted by the original (stale) worker will find the row already changed, fail its ownership check, and roll back. This is what actually guarantees single-writer safety — fail-on-expiry alone only changes what a human sees; the ownership-fenced transaction is what prevents the stale worker from persisting anything after losing ownership.
- **Required document changes:** `docs/03-technical-design.md §16.7 Consumer Idempotency, Execution Leases, and Duplicate Delivery` — rewrite entirely around the `agent_jobs` claim/fencing-token model: only `PENDING` jobs are claimable (D11); every persistence operation runs inside a transaction that locks the `agent_jobs` row, verifies `status = RUNNING` and `executionToken`, and only then writes `AgentStep`/`ToolExecution`/`PendingAction`/`AgentRun` records; a failed ownership check rolls back and stops the worker without persisting anything (D12). `§17.1 Agent Run State` — replace the `RUNNING → QUEUED: retriable failure` transition with `RUNNING → FAILED` via the maintenance sweep only, and note the sweep writes to `agent_jobs` under the same transactional locking boundary as worker writes. `docs/10-engineering-challenges.md §"Agent Run Claiming"` and `§"Execution Lease"` — replace the reclaim-oriented SQL and prose with the ownership-fenced transaction pattern.
- **Required implementation changes:** Add an `executionToken` (e.g., UUID) column to the `agent_jobs`/`AgentRun` row, generated on each successful claim. Implement a repository method used by every worker write that: begins a transaction, executes `SELECT ... FROM agent_jobs WHERE id = $1 FOR UPDATE`, verifies `status = 'RUNNING' AND execution_token = $token` in application code, performs the requested insert/update only if verification passes, commits, and otherwise rolls back and returns an ownership-lost signal that aborts the worker's current run processing. Implement the 60-second maintenance sweep (D16) as a transaction against the same `agent_jobs` row shape (lock, check expiry, update to `FAILED`, invalidate `executionToken`, commit).
- **Technical spike still necessary:** No — the correctness question is resolved by policy and by the ownership-fenced transaction pattern, not by measurement.

### P0-3 — Deterministic BullMQ `jobId` reuse interacts unclearly with retention and reconciliation
- **Decision:** D1
- **Reason:** D1 removes BullMQ (and therefore the `jobId`/retention/reconciliation ambiguity) entirely by replacing it with a PostgreSQL-backed `agent_jobs` table. The finding is moot under the approved architecture — there is no external queue with its own retention semantics to reconcile against.
- **Required document changes:** `docs/03-technical-design.md §16.5 Queue` — remove BullMQ job-payload and `jobId` content; replace with the `agent_jobs` claim/lease design. `§16.9 Reconciliation` — rewrite to describe reconciliation over `agent_jobs` rows only (no outbox/queue cross-system reconciliation).
- **Required implementation changes:** No BullMQ job-ID or retention logic to build. Implement `agent_jobs` claim via `UPDATE ... WHERE status = 'PENDING' ... RETURNING *` (or `FOR UPDATE SKIP LOCKED` for a polling worker loop).
- **Technical spike still necessary:** No — Spike 2 (BullMQ jobId reconciliation behavior) is no longer applicable.

### P0-4 — Execution lease duration vs. single Claude call latency is not validated
- **Decision:** D1, D5, D11, D12, D16
- **Reason:** The original review flagged that a too-short lease could let a second worker prematurely reclaim a still-active run, causing two workers to execute concurrently. D11 already prevents the "second worker" half of that scenario by construction (only `PENDING` jobs are claimable; a `RUNNING` job is never reclaimed). The remaining half — the *original* worker continuing to write after the maintenance sweep has already marked its job `FAILED` because the lease looked expired — is **not** solved by fail-on-expiry alone. The corrected D12 closes it with an ownership-fenced repository transaction, not a bare conditional write: once the sweep (D16) locks the `agent_jobs` row, marks it `FAILED`, and invalidates `executionToken` within its own transaction, any transaction the original worker later attempts will lock the same row, find `status != RUNNING` or a mismatched token, and roll back without persisting. Under this design, an undersized lease duration becomes a pure UX/cost concern (a live investigation gets prematurely marked `FAILED` and must be retried as a new `AgentRun`, per D11), never a data-corruption or duplicate-billing concern — correctness comes from the transaction boundary, not from the lease value being well-tuned.
- **Required document changes:** `docs/03-technical-design.md §16.6 Job Options` and `§16.7` — restate lease duration guidance as a UX-tuning parameter only ("set comfortably above expected p99 single-call latency to avoid spurious failures"), and state explicitly that correctness does not depend on this value because of the D12 ownership-fenced transaction, not merely a conditional `WHERE` clause. `docs/10-engineering-challenges.md §"Execution Lease"` — update to reflect the transactional lock-verify-write pattern, not reclaim-on-expiry and not a bare conditional update.
- **Required implementation changes:** Size the lease duration using real latency data (Spike 3, downgraded to non-blocking, below); implement the D12 lock-and-verify repository transaction on every persistence call in the worker so lease sizing is a tuning knob, not a safety mechanism.
- **Technical spike still necessary:** Downgraded, recommended not blocking. Spike 3 (lease vs. real Claude call latency) remains useful purely to avoid an unnecessarily high spurious-failure rate in the demo; it is not a correctness-blocking spike, because D12's ownership-fenced transaction guarantees correctness regardless of the chosen lease duration.

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
- **Decision:** D13 (strengthened)
- **Reason:** D13 supplies the previously missing mechanism and numbers: fake provider by default, a demo access token required for any live Claude run, and default configurable caps of 20 live runs/day globally and 5 live runs/hour per access token, with usage tracked in PostgreSQL. The strengthened D13 additionally closes the credential-handling and race-condition gaps a naive implementation of the original D13 would have left open: tokens are never stored in plaintext, rate-limit counters are updated atomically (preventing a burst of concurrent requests from all reading a stale count and all passing the check), and expired/disabled tokens are rejected even if a client retains a previously valid one.
- **Required document changes:** `docs/03-technical-design.md §19.2 API Security` — state the access-token requirement for live-provider runs, that tokens are hashed at rest, and that fake-provider mode requires no token. `§25.4 Public Demo Protection` — replace the five-option list with D13's committed mechanism: fake-provider default; access-token-gated live runs; the two named rate limits; token hash storage (no plaintext); atomic usage-counter updates; expired/disabled token rejection.
- **Required implementation changes:** Add a `demo_access_tokens` table storing a cryptographic hash (e.g., salted SHA-256 or bcrypt) of each token plus safe identifying metadata (label, created date, expiry, enabled flag) — never the raw token. Enforce the per-token hourly cap and the global daily cap via an atomic increment-and-check (e.g., a single `UPDATE ... SET count = count + 1 WHERE ... RETURNING count`, or an equivalent transaction) before allowing a live-provider `AgentRun`, so concurrent requests cannot race past the limit. Reject any token that is expired or disabled before checking rate limits. Default to the fake provider when no valid token is presented.
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
- **Reason:** D1 replaces the `AgentRun` lease fields and the `OutboxEvent` model entirely with a new `agent_jobs` design, so this specific naming drift is superseded rather than reconciled — the new schema needs its own consistent naming from the start. The corrected D12 adds a new field (`executionToken`) that must be named consistently across both documents from the outset, along with the repository-transaction pattern (lock, verify, write) that reads and writes it, rather than repeating the original drift.
- **Required document changes:** `docs/03-technical-design.md §11.1 Core Entities` — define the `agent_jobs`/`AgentRun` schema with one canonical set of field names (e.g., `leaseOwner`, `leaseExpiresAt`, `executionToken`) and use it consistently everywhere, including `docs/10-engineering-challenges.md`. Document the ownership-fenced transaction as a shared repository method, not inline SQL repeated per call site.
- **Required implementation changes:** Implement the new schema once, matching the doc, including the `executionToken` column and the transactional lock-verify-write repository method required by the corrected D12, rather than porting the old inconsistent naming forward.
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
- **Reason:** D5's fail-on-expiry policy removes the need for reclaim-and-continue logic, and therefore the need for heartbeat-driven lease renewal to prevent false reclaim. The corrected D12 reinforces this independently: because every write goes through an ownership-fenced transaction that locks and re-verifies the `agent_jobs` row at write time, rather than relying on lease freshness at read time, there is no correctness reason to refresh the lease mid-job at all — a single lease set at claim time, checked only by the maintenance sweep (D16), is sufficient.
- **Required document changes:** Same as P0-2/P0-4.
- **Required implementation changes:** No heartbeat-refresh code path; set lease duration once at claim time; rely on the ownership-fenced transaction, not lease freshness, for write safety.
- **Technical spike still necessary:** No (see P0-4 for the related, non-blocking tuning spike).

### OE-4 — Full reconciliation CLI + dead-letter alerting + the `§21.3` metrics list
- **Decision:** D1, D12, D16
- **Reason:** D1 removes the outbox-specific dead-letter and relay-reconciliation surface entirely. D16 settles the remaining question the original review left open ("how much reconciliation tooling is required"): a single lightweight maintenance sweep running every 60 seconds that marks expired `RUNNING` jobs and their `AgentRun`s `FAILED`, invalidates the execution token, and records a stable timeout error code — explicitly, no automatic resume, no dead-letter queue, and no dedicated reconciliation CLI. The corrected D12 requires the sweep's own update to be a transaction against the same `agent_jobs` row (lock, check expiry, update, invalidate token, commit), so it participates in the same ownership-fencing boundary as ordinary worker writes rather than being a separate, unsynchronized update path.
- **Required document changes:** `docs/03-technical-design.md §16.9 Reconciliation` — replace with the D16 sweep design (60-second interval, `agent_jobs`/`AgentRun` scope only, no dead-letter state, no CLI), specifying that the sweep uses the same lock-and-update transaction shape as D12. `§21.3 Metrics` — remove outbox-specific dead-letter metrics; retain only stuck/expired-job counts relevant to the sweep.
- **Required implementation changes:** Implement the sweep as a simple scheduled function (e.g., a `setInterval` in the worker process or a lightweight cron-style job) whose row update runs inside the same locking transaction pattern used by D12's worker writes, not a separate operational tool.
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
- **Decision:** D5, D11, D12, D16. Same as P0-2. Resolved — including the write-safety mechanism (the corrected D12 ownership-fenced repository transaction), not only the "no resume" policy.

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
- **Decision:** D18 (embedding dimension), D20 (Claude model identifier)
- **Reason:** D18 resolves the embedding-dimension half of this finding by defining a process — a small RAG spike selects the embedding model and dimension before the `RunbookChunk` migration is finalized, then the MVP locks that choice, with any future change requiring re-ingestion and a schema migration (consistent with `docs/03-technical-design.md §15.4`'s existing warning). D20 now resolves the previously open Claude-model half the same way: the exact model identifier is selected during the structured-output spike (Spike 1) before the live-provider implementation is finalized, remains environment-configurable (not hardcoded), and every `AgentRun` persists the exact provider and model identifier actually used for that run. D20 also defines the evaluation bar for the baseline model choice (tool-selection quality, structured-report validity, latency, token usage, estimated cost) and states that changing the production-demo default later requires rerunning and recording the agent eval suite, but not a schema migration — unlike the embedding dimension, which does require one. `docs/03-technical-design.md §33 Open Questions` items 1 and 2 are both now resolved via defined spike-then-lock/select processes rather than left open.
- **Required document changes:** `docs/03-technical-design.md §33 Open Questions` — mark item 1 (Claude model) as resolved via the D20 structured-output-spike selection process, and item 2 (embedding dimension) as resolved via the D18 RAG-spike process. `§13.8 Model Configuration` — state that `ANTHROPIC_MODEL` is selected via the D20 spike, remains environment-configurable, and that `AgentRun.model` persists the exact identifier used. `§15.4 Embeddings` — reference the D18 spike as the mechanism for selecting `EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS` before the first migration. Add an "MVP baseline model evaluation" note listing D20's five required evaluation dimensions.
- **Required implementation changes:** Run the D18 RAG spike before writing the `RunbookChunk` migration. Run the Spike 1 structured-output spike against candidate Claude models, select the baseline using D20's five evaluation dimensions, and persist the choice as the default `ANTHROPIC_MODEL`. Ensure `AgentRun.model` is populated from the actual provider response, not just the configured default, so a later default change is auditable per run.
- **Technical spike still necessary:** Yes — Spike 8 (embedding model/dimension, per D18) and Spike 1 (structured-output reliability, now also the vehicle for the D20 model selection) both remain necessary. Both are validation/selection spikes with an already-defined decision process, not open architecture questions.

---

## Required Technical Spikes — Final Disposition

| Spike (from the original review) | Disposition under approved decisions | Still necessary? |
|---|---|---|
| Spike 1 — Structured-output elicitation reliability | Design question resolved by D3; spike downgraded to a lightweight, non-blocking validation of forced-tool-choice reliability. Per D20, this spike is also where the baseline Claude model identifier is selected (evaluated for tool-selection quality, structured-report validity, latency, token usage, and estimated cost) before the live-provider implementation is finalized. | Recommended, not blocking |
| Spike 2 — BullMQ deterministic-jobId reconciliation behavior | Moot — BullMQ removed by D1 | No |
| Spike 3 — Execution lease vs. real Claude call latency | Correctness risk resolved by D5 + D11 (fail-on-expiry, no reclaim) and, decisively, by the corrected D12 (the ownership-fenced repository transaction guarantees write safety independent of lease duration, not a bare conditional `WHERE` clause); remaining value is pure UX tuning (avoiding spurious failures) | Recommended, not blocking |
| Spike 4 — Render background-worker tier and cold-start behavior | Retained explicitly by D10 | **Yes** |
| Spike 5 — Upstash Redis request-quota math | Moot — Redis/Upstash removed by D1 | No |
| Spike 6 — Neon autosuspend impact on demo latency | Retained explicitly by D10 | **Yes** |
| Spike 7 — SSE connection survival through the deployment proxy path | Retained explicitly by D10 | **Yes** |
| Spike 8 — Embedding model and vector dimension selection (introduced by D18) | New spike required before the `RunbookChunk` migration is finalized; not part of the original seven | **Yes** |

---

## Summary — Decision Coverage Complete

**No unresolved architecture decisions remain.** Every finding from `docs/reviews/03-technical-design-feasibility-review.md` is now covered by an approved decision (D1–D20). What remains are validation tasks — spikes with an already-defined decision process, not open architecture questions:

- **Deployment behavior** (Render worker-tier pricing/availability, Neon cold-start latency, SSE proxy survival) — governed by **D10**: these are external-platform facts to be measured, not decisions to be made. The corresponding spikes (4, 6, 7) remain necessary as verification, not design work.
- **Model and embedding selection** (the exact Claude model identifier and the embedding model/vector dimension) — governed by **D20** and **D18** respectively: both now have a defined selection process (evaluate during a spike against named criteria, then lock the choice and persist it per run/per schema) rather than being open-ended. Spike 1 (structured-output reliability) is also the vehicle for the D20 model selection; Spike 8 is the vehicle for the D18 embedding selection.

Previously open findings and their resolving decisions:

| Previously open finding | Resolved by |
|---|---|
| P1-7 / MDD-5 — Rate limiting and demo-abuse controls | **D13** (strengthened: token hashing, atomic rate-limit updates, expired/disabled token rejection) |
| P2-1 / OE-6 — Cursor pagination | **D19** (removed as an MVP requirement) |
| P2-2 / OE-6 — OpenAPI generation | **D19** (post-MVP) |
| P2-3 / OE-6 — Four-way test-mode matrix | **D19** (collapsed to fake-provider/live-provider) |
| P2-4 — Full accessibility requirements | **D19** (baseline required, formal audit post-MVP) |
| P2-5 — Separate eval CI workflow | **D19** (local/manual script required; CI workflow is a stretch goal) |
| XDOC-4 — Prompt injection scope | **D14** (structural defenses required; detection model post-MVP) |
| XDOC-6 — Deployment-as-optional vs. required | **D15** (Feature Complete vs. Portfolio Ready) |
| OE-4 (remaining scope) — Reconciliation tooling depth | **D16** (60-second sweep, transactionally consistent with D12, no CLI, no dead-letter queue) |
| MDD-6 — Turn-over-turn context management | **D17** |
| MDD-7 — Claude model identifier (previously the one open item) | **D20** (selected during Spike 1, locked, persisted per `AgentRun`) |

P0-2 and P0-4 were strengthened in the prior round and are **corrected again** in this round:

- The prior round added **D11** (only `PENDING` jobs claimable; `RUNNING` jobs never reclaimed) and an earlier, insufficiently specified version of **D12** (a bare conditional `WHERE status = 'RUNNING' AND execution_token = $token` on each write).
- This round replaces that D12 with an **ownership-fenced repository transaction**: every worker persistence operation begins a transaction, locks and re-reads the owning `agent_jobs` row, verifies `status = RUNNING` and a matching `executionToken`, and only then writes `AgentStep`, `ToolExecution`, `PendingAction`, or `AgentRun` records within that same transaction — rolling back and discarding the result if verification fails. The D16 maintenance sweep now explicitly updates the same `agent_jobs` row under the same locking boundary, so a sweep-driven `FAILED` transition and a stale worker's write transaction cannot race past each other.
- This is a materially stronger guarantee than the earlier "conditional write affects zero rows" framing, which described the right intent but not a mechanism precise enough to implement correctly against PostgreSQL's actual concurrency model.

No files other than this one were modified in producing this update.
