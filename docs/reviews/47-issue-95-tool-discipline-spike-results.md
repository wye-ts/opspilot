# Tool-Discipline Live Spike — Results (Issue #95, Milestone 14)

| Field | Value |
|---|---|
| Spike | `apps/worker/src/demo/run-rag-live-spike.ts` (`RAG_SPIKE_SCENARIO=tool-discipline pnpm --filter @opspilot/worker run spike:rag`) |
| Scenario logic | `apps/worker/src/demo/run-rag-live-spike-scenarios.ts` (unit-tested directly in `run-rag-live-spike-scenarios.test.ts`, without importing or executing the live composition root) |
| Related design | `docs/06-tool-design.md` ("Implementation state"), `docs/03-technical-design.md` §14.3. The Milestone 14 plan (`docs/reviews/37-milestone-14-second-diagnostic-tool-plan.md`) is **not on `main`** — it lives only on the unmerged `docs/milestone-14-second-diagnostic-tool` branch, so it is deliberately not cited as a resolvable path here. `docs/reviews/46-issue-94-two-tool-eval-coverage-plan.md` (line 254) carries the same dangling reference; plan documents are point-in-time records and are not retroactively edited, so that one stands. Whether to merge the planning branch is an owner decision. |
| Date | 2026-09-18 |
| Status | **Two usable observations obtained (n=2), same outcome both times.** The model called `get_recent_deployments` on a ticket whose retrieved evidence points at provider-side rate limiting. |
| Model | `claude-sonnet-5`. No Voyage/embedding client — this scenario uses the shipped `InMemoryKeywordRunbookRetriever`. |
| Cost | 3 billed Claude calls per completed run, ≈ $0.13 each; ≈ $0.46 total across five invocations (two completed, two discarded, one provider outage). |

## The question this run was designed to answer

Not "does the model choose the right tool" — that is not answerable at n=1
against a non-deterministic model, and no amount of spike work makes it a
measured property (see "What this does not establish").

The question is narrower and decision-shaped:

> Offered **both** catalog tools on a ticket whose retrieved runbook attributes
> the symptom to provider-side rate limiting and never mentions deployments,
> does the model spend diagnostic budget on `get_recent_deployments`?

This was chosen over the more obvious "will it call the second tool when it
*should*" because of what each answer unlocks. A "yes, it wastes budget"
result is **evidence against** adding a third tool (`get_error_rate_metrics`,
milestone-14 candidate B) — it closes a decision. A clean run merely fails to
find that evidence and closes nothing.

## Setup

| Element | Value |
|---|---|
| Ticket | `TICKET-3006` — "Customers on one tenant report outbound notification emails arriving late or not at all. The notification worker pool is healthy and no release has been announced." |
| Retrieval query | `notification provider rate limit 429 rejections throttled tenant` |
| Retriever | `InMemoryKeywordRunbookRetriever` over the real `runbooks/` corpus, `topK: 3` |
| Tools offered | `get_service_status`, `get_recent_deployments` (both real catalog entries) |

The ticket deliberately contains **"no release has been announced"** and the
top-ranked runbook (`runbook-notification-rate-limit-001`, score 12, clear of
the runner-up at 9) attributes the symptom to a provider throttling the tenant
and mentions neither deployments nor releases. That is what makes a
deployments call *unmotivated by the run's own evidence*, rather than merely
unusual.

## Observed result

```
status=completed
tools offered to the model: ["get_service_status","get_recent_deployments"]
tools actually called (in order): ["get_service_status","get_recent_deployments"]
serviceSlug value(s): ["notification-service","notification-service"]
retrieval: 3 chunk(s) — [
  {"chunkId":"runbook-notification-rate-limit-001","rank":1,"score":12},
  {"chunkId":"runbook-notification-rate-limit-002","rank":2,"score":9},
  {"chunkId":"runbook-public-api-rate-limit-001","rank":3,"score":7}
]
acceptance: PASSED (a readable observation was obtained — this says nothing
about whether the model chose well)
```

**OBSERVATION (this run):** the model spent diagnostic budget on
`get_recent_deployments` even though the top-ranked runbook it was shown
attributes the symptom to provider-side rate limiting and never mentions
deployments.

## What follows from this, and what does not

**Follows:** one sample of evidence **against** expanding the catalog to a
third tool. If two tools already draw a call unmotivated by the run's evidence,
a third widens the surface for the same behavior while consuming the same fixed
`MAX_DIAGNOSTIC_TOOL_CALLS = 3` budget.

**Does not follow:**

- That the model is generally undisciplined. n=2, non-deterministic model,
  single prompt, single ticket. Two identical outcomes rule out a pure
  sampling fluke and nothing more.
- That tool-*selection* quality is now measured. It is not, and cannot be by
  this route — the CI evaluation harness drives `FakeLlmProvider` from typed
  fixtures, so every tool request in every one of the 26 cases is scripted.
  This spike is a manual observation, is not CI-gated, and must never be cited
  as a measured property (issue #95 acceptance criterion 5).
- That the `get_error_rate_metrics` decision is settled. This is one input to
  it, not the verdict.

## Why `acceptance: PASSED` does **not** mean "the model behaved well"

`passed` drives the process exit code. Had it tracked the model's tool choice,
this paid, single-sample, non-deterministic probe would have become a
model-behavior gate — precisely the semantic upgrade this repository's bar
exists to prevent.

`passed` therefore means only: **a readable observation was obtained.** It is
`true` whether or not the deployments tool was called. `evaluateToolDisciplineScenario`
fails closed when the observation is *not* usable:

| Failure code | Meaning |
|---|---|
| `DEPLOYMENTS_TOOL_NOT_OFFERED` / `SERVICE_STATUS_TOOL_NOT_OFFERED` | The premise did not hold — a "no call" result would be an artifact of the wiring. |
| `RUN_NOT_COMPLETED_*` | The agent did not finish; nothing to read. |
| `NO_DIAGNOSTIC_CALL_OBSERVED` | Nothing was investigated at all. |
| `PREMISE_CHUNK_NOT_RETRIEVED` | The rate-limit runbook was never shown to the model, so "unmotivated" cannot be claimed. |
| `PREMISE_CHUNK_NOT_RANK_ONE` | It was retrieved but did not rank first, so the finding's "top-ranked runbook" wording would overstate what the model was shown. |

`run-rag-live-spike-scenarios.test.ts` pins this directly: a test asserts the
verdict is **identical** whether or not the deployments tool was called.

## Runs discarded, and why

Three live runs were made; only the third is recorded above. The first two are
documented because each exposed a real defect, and discarding them silently
would misrepresent how the finding was obtained.

**Run 1 — finding was unsupported; discarded.** The scenario was wired with no
retriever at all, so the model never saw the rate-limit runbook. The run still
printed a finding asserting that it had. The printed claim was not false about
the model's *action* (it did call the deployments tool) but the reason given
for calling it "unmotivated" rested on evidence the model was never shown.

Fixed by wiring the real keyword retriever **and** by making the premise a
verified fact rather than prose: the observation now carries
`retrievedChunkIds` read from the run's own `RETRIEVAL_COMPLETED` trace event,
`PREMISE_CHUNK_NOT_RETRIEVED` fails the scenario closed when the expected chunk
is absent, and the finding text prints exactly which chunks were shown.

This is the same defect class as the four Codex-review rounds on #94 — a report
claiming more than its cited evidence supports — reproduced here in the spike's
own write-up logic.

**Run 2 — `status=failed`; no observation emitted.** The guard worked: it
refused to print a finding. But the scenario printed no failure code, making
the failure undiagnosable. Fixed by printing `code`/`message` (and
`reportValidationIssues`) on a non-completed run, mirroring the existing
scenarios.

**Run 3 — recorded above.** Premise verified, run completed, finding supported.

## A pre-existing defect this work exposed

`spike:rag` was the only live script in `apps/worker/package.json` that never
loaded `.env`:

```
"spike:rag": "pnpm run build:deps && tsx src/demo/run-rag-live-spike.ts"
```

Every sibling (`demo:persisted`, `test:claude:live`, `generate:embedding-fixture`)
passes `--env-file-if-exists`. The first invocation therefore failed at
`requireEnv("ANTHROPIC_API_KEY")` and, because the script's top-level catch is
deliberately opaque to avoid leaking credentials, reported only "The spike
failed to run." Fixed in the same change. Anyone who ran this script previously
would have had to export the variables by hand.

## The rank-1 guard, and an independent reproduction

The `PREMISE_CHUNK_NOT_RANK_ONE` guard was added *after* the first recorded
run, in response to review: the original check only asserted the rate-limit
runbook was retrieved *somewhere*, while the finding called it "the top-ranked
runbook". Rank is now read from the `RETRIEVAL_COMPLETED` event's own `rank`
field rather than inferred from array position.

A full run was then completed against the tightened guard, and it reproduced
the finding independently:

```
status=completed
tools offered to the model: ["get_service_status","get_recent_deployments"]
tools actually called (in order): ["get_service_status","get_recent_deployments"]
retrieval: 3 chunk(s) — [
  {"chunkId":"runbook-notification-rate-limit-001","rank":1,"score":12},
  {"chunkId":"runbook-notification-rate-limit-002","rank":2,"score":9},
  {"chunkId":"runbook-public-api-rate-limit-001","rank":3,"score":7}
]
acceptance: PASSED
```

Billed calls: 3 (`diagnostic_tool_request`, `diagnostic_tool_request`,
`report_submission`), ≈ $0.12.

**This makes the observation n=2, not n=1** — two independent live runs, on
separate days' API credit, both ending with the model calling
`get_recent_deployments` against top-ranked evidence that names provider-side
throttling and never mentions deployments.

Two samples is still not a measured property and still not a general tendency.
It does mean the behavior was not a one-off sampling artifact, which is the
only thing the second run adds. Everything under "What follows from this, and
what does not" stands unchanged.

Retrieval is deterministic here (keyword retriever, fixed corpus, fixed query),
and the identical ranking appeared in all five invocations including the failed
ones — so the premise itself was never in question; only the model's response
to it varies.

## Reproducing

```bash
RAG_SPIKE_SCENARIO=tool-discipline pnpm --filter @opspilot/worker run spike:rag
```

`tool-discipline` is deliberately **excluded from `RAG_SPIKE_SCENARIO=all`** —
it answers a catalog-sizing question, not an adversarial-robustness one, and
folding it into `all` would silently add a billed call to every historical
full-suite invocation. A unit test pins that exclusion.
