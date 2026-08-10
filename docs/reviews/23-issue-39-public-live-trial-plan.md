# Issue #39 — Public LIVE Trial for Portfolio Visitors

| | |
| --- | --- |
| Document | Issue #39 "Add a rate-limited public LIVE trial for portfolio visitors" (planning artifact) |
| Status | Design in progress. Rounds 1–3 of the design-review session are confirmed and frozen (this document). Round 4 (frontend UX detail, capabilities-response shape, test matrix, PR split) is not yet resolved. **No code, branch, migration, or GitHub state has changed.** |
| Milestone | Milestone 9 — Live Investigation Timeline & Progress UX |
| Depends on | #34 (immediate Timeline feedback) — merged. #19's LIVE budget/admission infrastructure — merged, extended (not replaced) here. |
| Repository inspection basis | `main`: `apps/api/src/execution/*`, `apps/api/src/capabilities/*`, `packages/database/src/repositories/agent-run-repository.ts`, `packages/database/prisma/migrations/20260729224500_add_live_run_budget_and_usage/`, `docs/reviews/19-protected-live-claude-api-plan.md` |

## Context

The private LIVE path (#19, merged) requires `LIVE_RUN_ACCESS_TOKEN` for any real
Claude-backed investigation and is deliberately opaque: `LiveAccessRequirement` is
typed as `"TOKEN_REQUIRED" | "NOT_APPLICABLE"` with `PUBLIC` explicitly excluded from
the union — startup fails rather than serve a tokenless LIVE mode
(`apps/api/src/capabilities/capabilities.controller.ts:7-16`). #39 is the issue every
prior plan (#36, #37, #38, docs/16, docs/20) has flagged as the place that decision
gets reopened: recruiters/engineers evaluating the deployment should be able to run
one real, bounded, Claude-backed investigation per day without ever touching the
private token.

This document is the frozen result of a three-round design-review session
(grilling + domain-modeling). It extends, and does not replace, #19's admission
transaction, budget table, rate limiter, and opacity contract.

## Confirmed public-trial policy

The following numbers were confirmed during the Issue #39 design review (this
session) and **supersede the ranges proposed in the GitHub issue body**, which were
explicitly marked "proposed... to be confirmed in this issue." These are the
authoritative figures for implementation:

- **1 LIVE run / visitor / UTC day**
- **5 PUBLIC LIVE runs / UTC day** (global, all visitors combined)
- **$0.50 PUBLIC estimated-cost ceiling / UTC day** (global)
- The existing **2 requests / 60 s per-IP burst limiter** (`apps/api/src/execution/live-run-rate-limiter.ts`) remains unchanged and applies to the public path
- **No separate daily per-IP quota** — the burst limiter above is casual-abuse protection only, not a second daily counter; the visitor and global-public counters are the only daily gates
- **PUBLIC input length: 15–300 trimmed characters**, free text (preset examples are UI suggestions, not an allowlist)
- **PUBLIC attempt limit: exactly 1, no retry** — not configurable
- **UTC daily reset boundary** — reused as-is from #19's existing `budget_date` convention; no visitor-local timezone handling

The pre-existing #19 overall LIVE budget/cost ceilings remain in force **above**
these PUBLIC-specific limits — a PUBLIC run must pass both gates, not one or the
other (see §7).

## 1. Access flags

Two independent boolean flags, not a single tri-state enum:

```
LIVE_AGENT_RUNS_ENABLED        // existing master kill switch — unchanged meaning
LIVE_PUBLIC_TRIAL_ENABLED      // new — anonymous PUBLIC path flag
```

| master | valid private token | public flag | Result |
| --- | --- | --- | --- |
| OFF | — | — | No LIVE at all |
| ON | yes | — | Existing private LIVE path, unchanged |
| ON | no | ON | PUBLIC trial path |
| ON | no | OFF | LIVE unavailable |

`LIVE_AGENT_RUNS_ENABLED` is never reinterpreted as private-only — it remains
authoritative over **both** paths, so flipping it off ends the public trial
immediately with no separate expiry mechanism (Round 2, Q6).

`LiveAccessRequirement` gains `PUBLIC_TRIAL` as a third enum value (the frozen
implementation types it as `"TOKEN_REQUIRED" | "PUBLIC_TRIAL" | "NOT_APPLICABLE").
`/v1/capabilities` reports access per-caller on dual-mode deployments (token
present → `TOKEN_REQUIRED`; no token + public flag on → `PUBLIC_TRIAL` with the
visitor-specific and Turnstile fields from §11; an invalid presented token is
never downgraded to `PUBLIC_TRIAL`).

## 2. Bot-challenge (Turnstile) flow

Applies to the PUBLIC path only. Order of checks in the run-creation handler:

```
1. cheap request/schema validation
2. 15–300 trimmed-character validation
3. existing per-IP burst limiter (2/60s)
4. determine private vs public access path
5. PUBLIC only: server-side Turnstile verification (siteverify call)
6. resolve/issue visitor identity
7. authoritative durable PUBLIC admission (§7)
8. orchestration/provider invocation
```

A missing/failed Turnstile check is a generic client-visible rejection that
consumes no visitor quota, no public global quota, and creates no run
reservation — it is checked before any database access. A valid private access
token bypasses Turnstile entirely (private path never reaches step 4 as PUBLIC).

## 3. Input constraints

Free text, validated server-side to 15–300 trimmed characters. Preset examples
shown in the UI are pre-filled suggestions only, not an enforced allowlist —
any free text within bounds is accepted.

## 4. Attempt policy

`maxLiveAttempts` becomes a function of access mode rather than one global
constant: PUBLIC always checks against a fixed `1` (not env-configurable, per
the confirmed policy above); PRIVATE continues to use the existing
`LIVE_RUN_MAX_ATTEMPTS_PER_JOB` (default `2`), unchanged.

## 5. Visitor identity

A signed, opaque, long-lived cookie: a random UUID plus an HMAC-SHA256
signature over a server-side secret, `httpOnly`, `Secure`, `SameSite=Lax`. The
raw UUID (never the signature) is the `visitor_id` used as a database key —
no PII, no counters stored in the cookie itself.

- Issued **lazily**: only as part of a real PUBLIC trial attempt, and only
  **after** Turnstile has been successfully verified — never merely because a
  page loaded or `/v1/capabilities` was called.
- Issued **unconditionally** once Turnstile passes, regardless of whether the
  subsequent admission transaction (§7) succeeds or is rejected — otherwise a
  quota-exhausted visitor never converges on a stable identity and could keep
  re-solving Turnstile for nothing. This is a deliberate refinement beyond
  "issue on success" to close that gap.
- Long-lived (no forced rotation); the UTC-day counters, not the cookie's own
  lifetime, are what reset daily.
- A caller with no cookie is treated as a new visitor with the default
  allowance. Clearing cookies resets visitor identity — an accepted residual
  gap consistent with the existing per-IP limiter's documented "not identity"
  limitation, not a gap this design tries to close.

## 6. Durable schema

Extends `live_run_budget` (one row per UTC day, unchanged identity) with three
columns for the global PUBLIC counters, and adds one narrowly scoped new table,
`live_run_visitor_usage`, for the per-visitor dimension — a cardinality that
does not fit a single daily row.

```sql
ALTER TABLE "live_run_budget"
  ADD COLUMN "public_runs_reserved" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "public_estimated_cost_nano_usd" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_runs_reserved_chk"
  CHECK ("public_runs_reserved" >= 0);
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_cost_nano_usd_chk"
  CHECK ("public_estimated_cost_nano_usd" >= 0);
ALTER TABLE "live_run_budget" ADD CONSTRAINT "live_run_budget_public_within_overall_chk"
  CHECK ("public_runs_reserved" <= "runs_reserved");

CREATE TABLE "live_run_visitor_usage" (
    "visitor_id"  UUID NOT NULL,
    "usage_date"  DATE NOT NULL,
    "created_at"  TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "live_run_visitor_usage_pkey" PRIMARY KEY ("visitor_id", "usage_date")
);
```

`live_run_visitor_usage` is insert-only: one row per `(visitor_id, usage_date)`,
written once via `ON CONFLICT DO NOTHING` at reservation time (§7) and never
updated afterward. There is no `runs_reserved` counter and no
completed/reconciled counterpart — a visitor either has today's row or does
not, so presence alone is the entire fact this table records.

## 7. Atomic admission transaction

Extends `startLiveRunWithAttemptLimit`
(`packages/database/src/repositories/agent-run-repository.ts:233-408`) with one
optional parameter block. When absent, the transaction is byte-identical to
today's private path — token holders are unaffected by construction, not by a
parallel code path kept in sync by hand.

```
BEGIN
  1. SELECT agent_jobs FOR UPDATE                        -> 404 NOT_FOUND
  2. replay lookup (job_id, client_request_id)           -> return existing run, done
  3. stored context vs. bounds                           -> 422 CONTEXT_INVALID
  4. count LIVE runs for job < maxLiveAttempts            -> 429 ATTEMPT_LIMIT
                                                              (1 public / existing config private)
  5. [PUBLIC ONLY] reserve the visitor-day row            -> 429 VISITOR_QUOTA_EXHAUSTED
  6. reserve the UTC-day budget row, extended WHERE       -> 429 BUDGET_EXHAUSTED
  7. allocate attempt_number; INSERT the run
COMMIT
```

Fixed lock order across every call, public or private:
`agent_jobs` → `live_run_visitor_usage` → `live_run_budget` → `agent_runs`
insert. Each transaction touches at most one row per table, so ordering by
table is sufficient to make deadlock impossible between concurrent callers.

Step 5:

```sql
INSERT INTO live_run_visitor_usage (visitor_id, usage_date, created_at)
VALUES (${visitorId}::uuid, ${budget.budgetDate}::date, now())
ON CONFLICT (visitor_id, usage_date) DO NOTHING
RETURNING visitor_id
```

A returned row means reserved; zero rows means this visitor already has
today's row, so admission is refused with `LIVE_RUN_VISITOR_QUOTA_EXHAUSTED`
— there is no `visitorDailyLimit` to compare against, since the primary key
itself is the one-per-day gate.

Step 6 (extended; the private WHERE clause is a strict subset):

```sql
INSERT INTO live_run_budget
  (budget_date, runs_reserved, public_runs_reserved, updated_at)
VALUES
  (${budget.budgetDate}::date, 1, ${isPublic ? 1 : 0}, now())
ON CONFLICT (budget_date) DO UPDATE
  SET runs_reserved = live_run_budget.runs_reserved + 1,
      public_runs_reserved = live_run_budget.public_runs_reserved + ${isPublic ? 1 : 0},
      updated_at = now()
  WHERE live_run_budget.runs_reserved < ${budget.dailyLimit}
    AND live_run_budget.estimated_cost_nano_usd < ${budget.costCeilingNanoUsd}
    AND live_run_budget.pricing_unknown_runs = 0
    AND live_run_budget.runs_completed = live_run_budget.runs_reserved
    AND ( NOT ${isPublic} OR (
         live_run_budget.public_runs_reserved < ${publicDailyLimit}
     AND live_run_budget.public_estimated_cost_nano_usd < ${publicCostCeilingNanoUsd}
    ))
RETURNING budget_date AS "budgetDate", runs_reserved AS "runsReserved"
```

`reconcileLiveRunBudget` gets a matching extra increment on the same UPDATE —
no public-completion increment, since `public_runs_completed` no longer
exists; the shared `runs_completed = runs_reserved` latch above remains the
sole staleness guard for both paths:

```sql
UPDATE live_run_budget
   SET runs_completed = runs_completed + 1,
       estimated_cost_nano_usd = estimated_cost_nano_usd + ${observedNanoUsd},
       public_estimated_cost_nano_usd = public_estimated_cost_nano_usd + ${isPublic ? observedNanoUsd : 0n},
       pricing_unknown_runs = pricing_unknown_runs + ${unknownIncrement},
       updated_at = now()
 WHERE budget_date = ${reservation.budgetDate}::date
```

**Open point for HQ, not silently decided:** `pricing_unknown_runs` stays a
single *shared* latch across both paths — one run of unknown pricing, private
or public, closes the cost gate for the whole day. A separate
`public_pricing_unknown_runs` would isolate the failure mode but is a second
latch the issue does not ask for. Recommend accepting; flag if not.

No refund after successful admission: if provider execution later fails,
times out, or errors, the PUBLIC attempt (and its visitor/public/overall
reservations) remains consumed — same "commit before orchestration" boundary
and no-refund pattern the existing attempt-limit already uses.

## 8. Idempotency

Unchanged mechanism, reused as-is: the replay lookup (step 2) runs before
steps 5–6, so a retried `clientRequestId` for the same job returns the
existing run without ever reaching the visitor-quota or budget statements —
no new logic for "same request retried."

A **new** job created specifically to sidestep the per-job attempt limit is
caught by step 5 regardless of which job it's attached to, because
`live_run_visitor_usage` is keyed on `(visitor_id, day)`, not `(job_id, day)`.

## 9. Sequencing

| Event | When |
| --- | --- |
| Job row becomes durable | Earlier, unchanged — the existing job-creation call, its own committed transaction, before any run-creation request exists |
| Turnstile verified | First step of the run-creation handler, public path only, before any database access |
| Visitor identity resolved | Immediately after Turnstile succeeds; read+verify existing cookie, else generate a fresh UUID in memory |
| Visitor cookie set on response | Same point, unconditionally, regardless of the admission transaction's eventual outcome (§5) |
| Public quota reserved/consumed | Inside the single transaction (§7, steps 5–6), commits before any provider call |
| Orchestration begins | Only after that transaction has committed — identical boundary to the existing private path |

## 10. Observability without leaking through the public API

New internal-only `ApiError` catalog codes, logged through the existing
one-line-per-decision recorder (`live-run-budget-log.ts`, code only, never a
message or figures — no new logging mechanism):

- `LIVE_RUN_TURNSTILE_FAILED`
- `LIVE_RUN_VISITOR_QUOTA_EXHAUSTED`
- `LIVE_RUN_BUDGET_EXHAUSTED` — reused for both the public sub-ceiling and the
  overall ceiling; distinguishing which ANDed condition failed would need an
  extra read purely for dashboards, deferred unless requested

Client-visible collapse (two buckets, matching the two different frontend
actions):
- **Turnstile failed** — distinct, retryable code; frontend re-presents the challenge
- **Everything else** (visitor quota, public global quota, public cost, overall
  LIVE budget, kill switch) — the existing single opaque "unavailable" shape,
  offering FAKE. An anonymous caller cannot distinguish which of these closed
  the gate.

## 11. Quota UX / no automatic fallback

`/v1/capabilities` may expose, in PUBLIC mode only, the current visitor's own
`visitorRunsRemaining`. It continues to hide public/global remaining, overall
global remaining, IP state, cost headroom, kill-switch reason, and internal
budget reason — the #19 opacity contract is preserved, not reopened, for
everything except the visitor's own count. The response carries
`Cache-Control: private, no-store` whenever it is visitor-specific, so it is
never shared or cached across visitors.

**LIVE is never silently converted to FAKE.** If `visitorRunsRemaining` is 0,
the UI disables the public-LIVE action, explains today's trial is used, and
explicitly offers the FAKE demo as a separate, user-initiated action. If an
admission race returns 429 despite the pre-check, the UI surfaces the same
public-safe quota-exhausted state and offers FAKE — it does not execute FAKE
automatically. LIVE vs. FAKE provenance stays explicit in both cases.

## 12. Token-holder precedence (unaffected)

Valid private-token requests: skip Turnstile entirely, consume no visitor
quota, consume no PUBLIC 5/day or $0.50/day ceiling. They remain subject to
every pre-existing #19 control unchanged: master kill switch, overall daily
budget/cost ceiling, concurrency, idempotency, attempt policy, reconciliation.

## 13. Non-goals of this document / remaining open items

Not yet resolved by this design-review session (later rounds):

- Exact frontend component/UX changes (trial banner, remaining-count display,
  disabled-state messaging, Turnstile widget placement)
- Exact `/v1/capabilities` response shape and versioning
- Focused abuse/limit test matrix (issue's "Testing expectations" section)
- PR split
- Whether `pricing_unknown_runs` stays a shared latch (§7 open point)
- Whether `LIVE_RUN_BUDGET_EXHAUSTED` needs to be split into public/overall
  variants for dashboard purposes (§10 open point)

No environment is enabling `LIVE_PUBLIC_TRIAL_ENABLED` as part of this design
work. Per the issue's safety notes, production enablement requires explicit
owner sign-off after abuse tests pass, independent of this document's approval.
