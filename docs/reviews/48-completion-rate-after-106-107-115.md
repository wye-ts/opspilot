# Completion-Rate Re-measurement After #106/#107/#115 (Milestone 14 follow-up)

| Field | Value |
|---|---|
| Script | `apps/worker/src/demo/measure-completion-rate.ts` (`RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate`) |
| Date | 2026-09-18 |
| Model | `claude-sonnet-5` |
| Result | **2/5 then 4/5** across two rounds on the corrected provider policy. Pooled: **6/10 (60%)**. Baseline **2/8 (25%)**. |
| Cost | 20 billed runs across four rounds, ≈ $3.2 (two rounds voided — see "Two voided rounds") |
| Owner threshold | 5 runs, at most 1 failure — **met in one round, missed in the other**. Not established. |

## Why this was measured

`docs/reviews/40-issue-105-report-failure-attribution-plan.md` recorded 8
deployed LIVE runs on 2026-09-14/15, *after* #101 merged:

> 2 `COMPLETED`, 5 `REPORT_SCHEMA_INVALID`, 1 `PROVIDER_UNAVAILABLE`

Three fixes landed afterwards and **none had been measured against a real
model**:

| Issue | Change |
|---|---|
| #106 | attributes `REPORT_SCHEMA_INVALID` to the invariant that caused it |
| #107 | widened the turn budget from 4/3 to 5/3 |
| #115 | auto-completes evidence for real `groundedBy` omissions (F5) — the shape #105 called dominant |

Re-opening the public trial is gated on an end-to-end completion rate (#105),
and that number was unknown.

## Result

Two rounds of five, same corrected configuration, run back to back:

| Ticket | Round A | Round B |
|---|---|---|
| `TICKET-4001` notification delay | `REPORT_SCHEMA_INVALID` | `completed` |
| `TICKET-4002` billing 5xx | `REPORT_SCHEMA_INVALID` | `completed` |
| `TICKET-4003` search staleness | `completed` (auto-completed 3) | `completed` (auto-completed 3) |
| `TICKET-4004` sign-in failures | `PROVIDER_UNAVAILABLE` | `completed` |
| `TICKET-4005` storage quota | `completed` | `REPORT_SCHEMA_INVALID` |
| **Completed** | **2/5** | **4/5** |

```
Round A: COMPLETED 2/5, REPORT_SCHEMA_INVALID 2/5, provider-side 1/5, healed 1
Round B: COMPLETED 4/5, REPORT_SCHEMA_INVALID 1/5, provider-side 0/5, healed 1
Pooled:  COMPLETED 6/10
```

**The spread between two identical five-run rounds is the primary result.**
The same tickets, the same configuration, and the same model produced 2/5 and
4/5 — and the per-ticket outcomes disagree in four of five slots. `TICKET-4001`
and `TICKET-4002` failed in A and passed in B; `TICKET-4005` did the reverse.

So the owner threshold (at most one failure in five) was **met in round B and
missed in round A**. A single round of five cannot distinguish these, which is
what the design's stated weakness looks like when it actually bites: at a true
rate of 60%, five runs yield ≥4 completions about 34% of the time and ≤2 about
32% of the time. Both rounds are consistent with one underlying rate.

**What is reasonably supported:** the pooled 6/10 (60%) is above the 2/8 (25%)
baseline, but with n=10 the two intervals still overlap — this is suggestive,
not a demonstrated improvement.

**What is not supported:** any single-round headline. Reporting round B's 4/5
alone would have been a selection artifact, and this document originally did
exactly that before the provider policy was corrected.

## Failure attribution

`#106`'s attribution made every failure legible, which is the capability #105
lacked:

| Ticket | Invariant |
|---|---|
| `TICKET-4001` (A) | `GROUNDED_BY_NOT_IN_EVIDENCE` + `SUFFICIENT_REQUIRES_EVIDENCE` |
| `TICKET-4002` (A) | `GROUNDED_BY_NOT_IN_EVIDENCE` ×2 + `SUFFICIENT_REQUIRES_EVIDENCE` |
| `TICKET-4005` (B) | `ACTIONABLE_REQUIRES_ACTION` |

Every F5 failure observed here carries `SUFFICIENT_REQUIRES_EVIDENCE` alongside
it — the co-occurrence analysed below. `ACTIONABLE_REQUIRES_ACTION` is a
different shape entirely (#105 classified it as locally fixable by the
corrective retry) and is the one failure #115 was never meant to address.

#115 engaged once per round, auto-completing three evidence entries on
`TICKET-4003` both times. That run is the only fully reproducible outcome in
the table.

## Two voided rounds, and what they hid

**Round 1 — wrong retrieval input.** It used **hand-authored keyword retrieval queries** (e.g.
`"billing service elevated error rate deployment rollback"`). Review caught
that the deployed path does something different —
`apps/api/src/execution/retrieval-input.ts`:

```ts
export function buildRetrievalInput(job: AgentJobRecord): RetrievalInput {
  return { query: job.ticketContext.summary, topK: RETRIEVAL_TOP_K };
}
```

The ticket summary **verbatim**. A tuned keyword query hands the model better
evidence than any visitor can supply, so that round was not an end-to-end rate
and not comparable to the 2/8 baseline. It was **voided and re-run**, not
patched up.

That round recorded `healed=0` and I concluded "#115 never fires" — **an
artifact of the wrong retrieval path**. With the deployed query the mechanism
engages in every subsequent round. A better-retrieved run gives the model
enough material to ground actions on evidence it then forgets to list, which is
exactly #115's target shape.

**Round 2 — provider policy more permissive than deployment.** It hardcoded
`maxRetries: 2` with no timeout, while deployment applies
`DEFAULT_MAX_RETRIES = 1` and `DEFAULT_TIMEOUT_MS = 45_000`
(`packages/provider-claude/src/claude-config.ts`). A completion obtained under
a more forgiving retry budget is not one the deployed path would necessarily
reach, so that round was voided too.

It had produced 4/5, and this document briefly recorded that as the threshold
being met. **Re-running under the deployed policy produced 2/5 — the opposite
verdict.** The number that survived review was not the number the corrected
configuration produces, which is the strongest argument in this document for
not treating a single five-run round as a result.

## The remaining failure, and why #115 did not heal it

`TICKET-4002` failed with three validation issues:

```
suggestedActions[].groundedBy entries must each appear in report.evidence.   (x2)
SUFFICIENT evidence requires at least one distinct grounded evidence entry.
```

That is F5 (`GROUNDED_BY_NOT_IN_EVIDENCE`) **co-occurring** with
`SUFFICIENT_REQUIRES_EVIDENCE`. #115 is eligible only when F5 is the *sole*
violated invariant (`tryAutoCompleteGroundedByOmission` §2.2), so it declined —
correctly, per its own design.

**The two invariants are not independent, and that is the finding.**
`SUFFICIENT_REQUIRES_EVIDENCE` fires on
`countDistinctEvidenceLocators(report.evidence) < 1` — an effectively empty
`evidence` array. So a report that grounds an action while listing *no*
evidence necessarily trips **both**, from one underlying mistake:

> #115 heals a **partial** evidence omission but not a **total** one — even
> though the total omission is the more complete expression of the same defect.

`evidence-auto-completion-eligibility.test.ts` pins this with four cases: the
empty-array case trips both invariants; the same omission under `INSUFFICIENT`
trips F5 alone (so #115 *would* apply); a partial omission under `SUFFICIENT`
trips F5 alone (the healed case); and listing the omitted entry clears both,
confirming the single root cause. Written against the production classifier
(`classifyReportInvariants`), not a reimplementation.

This is characterization, **not** a proposal to loosen the eligibility rule.
Widening it to a *set* of invariants would mean auto-completion reasoning about
invariants it was not built for, which #114's review rounds deliberately
rejected. Whether to revisit it is an owner decision.

## What this measurement does and does not support

**Supports:**

- #115 engages against a real model. `TICKET-4003` completed via
  auto-completion in both rounds, auto-completing three evidence entries each
  time — the only reproducible outcome observed.
- #106's attribution works: every failure here names the invariant that caused
  it, which #105 explicitly could not do for 4 of its 5 failures.
- A pooled 6/10 (60%) sits above the 2/8 (25%) baseline, though the intervals
  still overlap at this sample size.

**Does not support:**

- **That the owner threshold is met.** Round B met it, round A did not, and
  nothing distinguishes the two. On this evidence the threshold is *unresolved*,
  not passed.
- **Any point estimate of the rate.** Two rounds of the same configuration gave
  40% and 80%. Pooled 60% is the best available reading, and it is not precise
  enough to gate a public trial on.
- **That the improvement is attributable to any one fix.** #115 engaged twice,
  but #107's wider budget and #101's corrective retry are also in play, and
  nothing here isolates them. Establishing that #115 *caused* a completion
  needs a paired run — same rejected report, auto-completion on vs. off — which
  this measurement does not perform.
- **That visitor traffic behaves this way.** These are five hand-authored
  tickets through the in-process orchestrator. The validation path and the
  retrieval input rule are now identical to deployed, but the ticket
  distribution is not.

## Why this ran locally rather than against the deployment

The deployed path consumes the public-trial visitor quota, which showed
`visitorRunsRemaining: 1` (checked twice during this work). Report validation
and the F5 auto-completion both live in `runAgentOrchestrator`, which both
paths share — `agent-run-service.ts` calls the same function and only reads the
failure code afterwards — so the same logic is exercised without spending the
last visitor slot.

A deployed re-measurement is still the only like-for-like comparison against
#105's 8 runs. That remains open and is an owner decision, since it costs
visitor quota.

## Measurement integrity

Two defects in the script itself were caught in review; both would have
corrupted the number rather than failing loudly, which is the worst outcome for
an artifact whose only job is to report a trustworthy rate:

- **A catch-all swallowed code defects.** Any throw was recorded as a
  provider-side failure, so a four-completion/one-crash run would still have
  read as meeting the threshold. Now only a genuine `LlmProviderError` is a
  ledger row; anything else rethrows and voids the run.
- **`RUN_COUNT` was unvalidated.** `RUN_COUNT=0` or `abc` would have skipped
  the loop and printed `0/0 COMPLETED` as a clean success. Now validated to an
  integer in `1..25`.

`measure-completion-rate.test.ts` covers both.

## Reproducing

```bash
RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate
```

Requires `ANTHROPIC_API_KEY`. No Voyage credential, no demo token, no
deployment interaction.
