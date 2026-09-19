# Completion-Rate Re-measurement After #106/#107/#115 (Milestone 14 follow-up)

| Field | Value |
|---|---|
| Script | `apps/worker/src/demo/measure-completion-rate.ts` (`RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate`) |
| Date | 2026-09-18 |
| Model | `claude-sonnet-5` |
| Result | **4/5 `COMPLETED` (80%)**, against a **2/8 (25%)** deployed baseline |
| Cost | 10 billed runs across two measurement rounds, ≈ $1.6 (the first round was void — see "A voided first round") |
| Owner threshold | 5 runs, at most 1 failure — **met** |

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

| Ticket | Outcome | Evidence entries auto-completed by #115 |
|---|---|---|
| `TICKET-4001` notification delay | `completed` | 0 |
| `TICKET-4002` billing 5xx | **`REPORT_SCHEMA_INVALID`** | — |
| `TICKET-4003` search staleness | `completed` | **3** |
| `TICKET-4004` sign-in failures | `completed` | 0 |
| `TICKET-4005` storage quota | `completed` | **2** |

```
COMPLETED:              4/5
REPORT_SCHEMA_INVALID:  1/5
provider-side failures: 0/5
runs where #115 healed an F5 omission: 2
```

**#115 is doing real work.** Two of the four completions required it: without
auto-completion those runs would have hit the F5 retry path, and the measured
rate would have been at best 2/5. This is the first evidence that the mechanism
fires against a real model at all.

## A voided first round, and what it hid

The first five runs used **hand-authored keyword retrieval queries** (e.g.
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

The headline number happened to be 4/5 both times, which is exactly why this
matters: the difference was invisible in the summary statistic and showed up
only in the mechanism underneath. The void round recorded `healed=0` and
concluded "#115 never fires" — **that conclusion was an artifact of the wrong
retrieval path**. With the deployed query the same mechanism fires twice in
five runs. A better-retrieved run apparently gives the model enough material to
ground actions on evidence it then forgets to list, which is precisely #115's
target shape.

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

- The completion rate on this ticket set is materially better than the 25%
  baseline. A 25% → 80% shift is large enough to be unlikely to be entirely
  sampling noise, even at n=5.
- #115 fires against a real model and carried two of the four completions.

**Does not support:**

- **That the rate is 80%.** At n=5 the interval is very wide: a true rate of
  60% still yields ≥4/5 about 34% of the time, and a true rate of 80% yields
  ≤3/5 about 26% of the time. The threshold was met; "80% measured" is not a
  claim this design can make.
- **That the improvement is attributable to any one fix.** #115 demonstrably
  helped twice, but #107's wider budget and #101's corrective retry are also in
  play and this measurement cannot separate them.
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
