# Completion-Rate Re-measurement After #106/#107/#115 (Milestone 14 follow-up)

| Field | Value |
|---|---|
| Script | `apps/worker/src/demo/measure-completion-rate.ts` (`RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate`) |
| Date | 2026-09-18 |
| Model | `claude-sonnet-5` |
| Result | Pre-fix, on the deployed zero-retry policy: **2/4 then 4/5**, pooled **6/9 (67%)**. Baseline **2/8 (25%)**. Post-fix: one void round (`maxRetries: 2`) and one 2/4 whose attribution was lost — **no usable post-fix observation**. |
| Cost | 30 billed runs across six rounds, ≈ $4.8. Three voided for apparatus defects (wrong retrieval input, then `maxRetries: 2` twice), rounds A and B usable, round D usable but with its attribution truncated away. |
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
| `TICKET-4004` sign-in failures | `PROVIDER_UNAVAILABLE` — **excluded** | `completed` |
| `TICKET-4005` storage quota | `completed` | `REPORT_SCHEMA_INVALID` |
| **Completed** | **2/4** (one excluded) | **4/5** |

```
Round A: COMPLETED 2/4  (1 run excluded — never reached a report), healed 1
Round B: COMPLETED 4/5,                                            healed 1
Pooled:  COMPLETED 6/9   (rounds A+B only — same code)
```

`TICKET-4004` in round A failed with `PROVIDER_UNAVAILABLE` and is **excluded
from the denominator**, not counted as a failure. The orchestrator collapses
`AUTHENTICATION`, `BILLING` and `REQUEST_INVALID` into that same code alongside
genuine outages (`agent-orchestrator.ts`'s category switch), so a run carrying
it cannot be shown to have reached the model at all. Counting it would let a
configuration problem depress a rate that is supposed to measure report
quality.

**The spread between two identical five-run rounds is the primary result.**
The same tickets, the same configuration, and the same model produced 2/4 and
4/5 — and the per-ticket outcomes disagree in four of five slots. `TICKET-4001`
and `TICKET-4002` failed in A and passed in B; `TICKET-4005` did the reverse.

So the owner threshold (at most one failure in five) was **met in round B and
missed in round A** (2 failures in the 4 usable runs). A single round of five cannot distinguish these, which is
what the design's stated weakness looks like when it actually bites: at a true
rate of 60%, five runs yield ≥4 completions about 34% of the time and ≤2 about
32% of the time. Both rounds are consistent with one underlying rate.

**What is reasonably supported:** the pooled 6/9 (67%) is above the 2/8 (25%)
baseline, but at this sample size the intervals still overlap — suggestive, not
a demonstrated improvement.

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
being met. **Re-running under the deployed policy produced 2/4 — the opposite
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

## The root cause, and why this PR does not touch #115

Relaxing #115's eligibility would have been symptom repair. Reading the grammar
Claude actually receives shows why the omission happens at all:

```json
"evidence": {
  "type": "array",
  "items": { ... }
}
```

**No `description`, no `minItems`.** The rule — every `groundedBy` locator must
also appear in `evidence` — lived ONLY in the report tool's ~1700-character
prose description. The model fills the JSON Schema, and that schema never
stated the requirement. An empty `evidence` array is also deliberately legal (a
truthful zero-evidence INSUFFICIENT report must be submittable), so nothing
objects at authoring time; it fails later in cross-field validation, by which
point the model has no signal it erred.

This PR adds `.describe()` to the evidence array and to `groundedBy` on all
three write-action variants. **No invariant changes and no validation is
relaxed** — `applyReportEvidenceInvariants` remains the sole authority. The
constraint simply becomes visible where the report is written.

The shape of this defect matches the AndroidWorld T3A attribution reversal: a
missing observation channel in the harness, not a model-capability problem. The
tempting alternatives — widen the auto-completion rule, or swap models — both
target the symptom.

### One supporting observation, not a verified fix

| Round | Provider policy | Result | Empty-evidence shape |
|---|---|---|---|
| A | zero retries (deployed) | 2/4 | present |
| B | zero retries (deployed) | 4/5 | present |
| C (after `.describe()`) | **`maxRetries: 2` — NOT deployed** | 5/5 | absent |
| D (after `.describe()`) | zero retries (deployed) | 2/4 | attribution lost to output truncation |

**Round C is VOID.** It ran under `maxRetries: 2` while a deployed LIVE run is
pinned to zero — the apparatus defect described below. Re-running under the
deployed policy (round D) gave 2/4, and that round's per-failure attribution
was lost to output truncation, so it is not known whether the targeted shape
recurred.

**The `.describe()` change therefore has no supporting observation at all.** It
is well-motivated by source inspection — the rule genuinely was absent from the
schema the model fills — and unverified by measurement. Treating round C as
evidence would be selecting the round that ran under the most permissive
configuration, which is the error this document exists to record. Experiment 7-7 is the direct warning: three
context representations scored an identical 6/11 while failing in different
places — *changing a context representation does not automatically repair an
application policy*. This document already contains the same hazard: the two
VOIDED rounds both read 4/5 on the surface while differing underneath
(`healed=0` vs `healed=2`), and round B's 4/5 matches them on the surface too
despite running on corrected code. Identical headline figures here have
repeatedly concealed different mechanisms.

Confirming the effect needs a round on the corrected apparatus, with the
per-failure attribution persisted — which is what the artefact writing added in
this change enables, and what no round so far has produced.

## What this measurement does and does not support

**Supports:**

- #115 engages against a real model. `TICKET-4003` completed via
  auto-completion in both rounds, auto-completing three evidence entries each
  time — the only reproducible outcome observed.
- #106's attribution works: every failure here names the invariant that caused
  it, which #105 explicitly could not do for 4 of its 5 failures.
- A pooled 6/9 (67%) sits above the 2/8 (25%) baseline, though the intervals
  still overlap at this sample size.

**Does not support:**

- **That the owner threshold is met.** Round B met it, round A did not, and
  nothing distinguishes the two. On this evidence the threshold is *unresolved*,
  not passed.
- **Any point estimate of the rate.** Two rounds of the same configuration gave
  50% and 80%. Pooled 67% is the best available reading, and it is not precise
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

## Why the next measurement should not be another five-run round

Rounds A and B, identical in configuration, disagreed in four of five slots.
Five end-to-end runs cannot separate a real effect from sampling noise at any
plausible underlying rate, and each round bills five full investigations to
observe one report-submission step.

The failure being studied happens at the **last** turn: retrieval, tool calls
and the multi-turn loop are irrelevant to whether `evidence` gets populated,
yet they account for most of the tokens.

A trajectory-prefix regression set is the better instrument: freeze the
conversation at the point where the model must submit its report — retrieval
done, tool results present — and require only that next step. One billed call
per sample instead of five, so the same budget buys roughly 5x the sample size,
and the variable is isolated.

Two design constraints, if this is built:

- **The expected answer is a set of acceptable actions, not one action.** A
  report can be valid in more than one shape; pinning a single output would
  measure conformity to a fixture rather than correctness.
- **It measures the report-submission policy, not the end-to-end completion
  rate.** It cannot replace the public-trial gate, which is defined in
  end-to-end terms (#105).

This remains a proposal. No such set exists yet, and building one is an owner
decision.

## Reproducing

```bash
RUN_COUNT=5 pnpm --filter @opspilot/worker run measure:completion-rate
```

Requires `ANTHROPIC_API_KEY`. No Voyage credential, no demo token, no
deployment interaction.
