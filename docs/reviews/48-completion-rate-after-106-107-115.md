# Completion-Rate Re-measurement After #106/#107/#115 (Milestone 14 follow-up)

| Field | Value |
|---|---|
| Script | `apps/worker/src/demo/measure-completion-rate.ts` (`RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate`) |
| Date | 2026-09-18 |
| Model | `claude-sonnet-5` |
| Result | **4/5 `COMPLETED` (80%)**, against a **2/8 (25%)** deployed baseline |
| Cost | 5 runs, ≈ $0.8 |
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

Re-opening the public trial is gated on an end-to-end completion rate (#105
§"Re-opening the public trial"), and that number was unknown.

## Result

| Ticket | Outcome |
|---|---|
| `TICKET-4001` notification delay | `completed` |
| `TICKET-4002` billing 5xx | **`REPORT_SCHEMA_INVALID`** |
| `TICKET-4003` search staleness | `completed` |
| `TICKET-4004` sign-in failures | `completed` |
| `TICKET-4005` storage quota | `completed` |

```
COMPLETED:              4/5
REPORT_SCHEMA_INVALID:  1/5
provider-side failures: 0/5
runs where #115 healed an F5 omission: 0
```

## The failure, and why #115 did not heal it

`TICKET-4002` failed with three validation issues:

```
suggestedActions[].groundedBy entries must each appear in report.evidence.   (x2)
SUFFICIENT evidence requires at least one distinct grounded evidence entry.
```

That is F5 (`GROUNDED_BY_NOT_IN_EVIDENCE`) **co-occurring** with
`SUFFICIENT_REQUIRES_EVIDENCE`. #115 is eligible only when F5 is the *sole*
violated invariant (`agent-orchestrator.ts`, `tryAutoCompleteGroundedByOmission`
§2.2), so it declined — correctly, per its own design.

**But the two invariants are not independent, and that is the finding.**
`SUFFICIENT_REQUIRES_EVIDENCE` fires on
`countDistinctEvidenceLocators(report.evidence) < 1` — i.e. an effectively
empty `evidence` array. So a report that grounds an action while listing *no*
evidence at all necessarily trips **both**, from one underlying mistake.

The consequence, stated plainly:

> #115 heals a **partial** evidence omission, but not a **total** one — even
> though the total omission is the more complete expression of the same defect.

`evidence-auto-completion-eligibility.test.ts` pins this with four cases: the
empty-array case trips both invariants; the same omission under `INSUFFICIENT`
trips F5 alone (so #115 *would* apply); a partial omission under `SUFFICIENT`
trips F5 alone (the case #115 does heal); and listing the omitted entry clears
both, confirming the single root cause.

This is characterization, **not** a proposal to loosen the eligibility rule.
Widening it to a *set* of invariants would mean auto-completion reasoning about
invariants it was not built for, which #114's review rounds deliberately
rejected. Whether to revisit it is an owner decision.

## What this measurement does and does not support

**Supports:** the completion rate on this ticket set is materially better than
the 25% baseline. A 25% → 80% shift is large enough that it is unlikely to be
entirely sampling noise, even at n=5.

**Does not support:**

- **That the rate is 80%.** At n=5 the interval is very wide: a true rate of
  60% still yields ≥4/5 about 34% of the time, and a true rate of 80% yields
  ≤3/5 about 26% of the time. The threshold was met; "80% measured" is not a
  claim this design can make.
- **That #115 is responsible.** It did not fire once (`healed=0`). The
  improvement is more plausibly #107's wider turn budget or #101's corrective
  retry, but this measurement cannot separate them — that is an untested
  hypothesis, not a conclusion.
- **That visitor traffic behaves this way.** These are five hand-authored
  tickets run through the in-process orchestrator, not deployed traffic. The
  validation path is identical (`agent-run-service.ts` calls the same
  `runAgentOrchestrator` and only reads the failure code afterwards), but the
  ticket distribution is not.

## Why this ran locally rather than against the deployment

The deployed path consumes the public-trial visitor quota, which at the time of
this measurement showed `visitorRunsRemaining: 1`. Report validation and the
F5 auto-completion both live in `runAgentOrchestrator`, which both paths share,
so the same logic is exercised without spending the last visitor slot.

A deployed re-measurement is still the only way to compare like-for-like
against #105's 8 runs. That remains open and is an owner decision, since it
costs visitor quota.

## Reproducing

```bash
RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate
```

Requires `ANTHROPIC_API_KEY`. No Voyage credential, no demo token, no
deployment interaction.
