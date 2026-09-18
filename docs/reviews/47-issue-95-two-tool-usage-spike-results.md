# Two-Tool Usage Live Spike — Results (Issue #95, Milestone 14)

| Field | Value |
|---|---|
| Spike | `apps/worker/src/demo/run-rag-live-spike.ts` (`RAG_SPIKE_SCENARIO=two-tool-usage pnpm --filter @opspilot/worker run spike:rag`) |
| Scenario logic | `apps/worker/src/demo/run-rag-live-spike-scenarios.ts`, unit-tested in `run-rag-live-spike-scenarios.test.ts` without executing the live composition root |
| Related design | `docs/06-tool-design.md` ("Implementation state"), `docs/03-technical-design.md` §14.3. The Milestone 14 plan (`docs/reviews/37-milestone-14-second-diagnostic-tool-plan.md`) is **not on `main`** — it exists only on the unmerged `docs/milestone-14-second-diagnostic-tool` branch, so it is deliberately not cited as a resolvable path. `docs/reviews/46-issue-94-two-tool-eval-coverage-plan.md` (line 254) carries the same dangling reference; plan documents are point-in-time records and are not retroactively edited. |
| Date | 2026-09-18 |
| Status | **Descriptive record obtained from 4 recorded runs** (of 5 that completed — run 1 completed but is discarded, see the run ledger). Both catalog tools were offered to a live model for the first time; the model called both. **No catalog-sizing conclusion follows.** |
| Model | `claude-sonnet-5`. No Voyage/embedding client — this scenario uses the shipped `InMemoryKeywordRunbookRetriever`. |
| Cost | 3 billed Claude calls per run that reaches the model, ≈ $0.13 each. Six of seven invocations were billed (run 4 died at the first call), so ≈ $0.78 total. |

## What this scenario is for

Before it existed, the spike's composition root pinned `diagnosticTools` to a
**one-entry list**. No live run had ever placed both catalog tools in front of
a real model, so nothing was known about what a live model does when it can
choose. Closing that gap is the whole contribution.

The question is deliberately **descriptive**:

> Offered both catalog tools on a realistic ticket, which tools does a live
> model actually reach for, and what evidence is it holding when it does?

## Setup

| Element | Value |
|---|---|
| Ticket | `TICKET-3006` — "Customers on one tenant report outbound notification emails arriving late or not at all. The notification worker pool is healthy and no release has been announced." |
| Retrieval query | `notification provider rate limit 429 rejections throttled tenant` |
| Retriever | `InMemoryKeywordRunbookRetriever` over the real `runbooks/` corpus, `topK: 3` |
| Tools offered | `get_service_status`, `get_recent_deployments` (both real catalog entries) |

## Observed result

The four recorded runs, across two separate API-credit periods, produced identical tool usage:

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

**What this records:** offered a choice, the model used both tools, and it did
so while holding retrieved evidence whose top-ranked chunk attributes the
symptom to provider-side throttling.

## A claim this document previously made, and retracts

An earlier version of this write-up asserted that the `get_recent_deployments`
call was **unmotivated budget waste**, and offered it as *evidence against*
adding a third tool (`get_error_rate_metrics`, milestone-14 candidate B).

**That inference does not hold, and is withdrawn.** The reasoning rested on the
ticket's "no release has been announced" — but an unannounced release is not an
absent one. Consulting the deployment record rather than trusting an
announcement is precisely what a differential diagnosis looks like; it is a
reasonable investigative step, not waste. Nor does top-ranked retrieval
constitute authoritative exclusion: the retriever returns the best keyword
matches, not a ruling that other causes are eliminated.

Establishing that a deployments call is genuinely unmotivated would require a
context that **authoritatively rules deployments out** — which this scenario
does not construct. The scenario was also renamed from `tool-discipline` to
`two-tool-usage`, because it never measured discipline and a name implying it
is a claim the mechanism cannot support.

The retraction is enforced mechanically, not just editorially: unit tests
assert the finding text contains no affirmative "unmotivated" / "budget waste"
/ "evidence against adding" phrasing. Those assertions were verified to fail
when the retracted wording is reintroduced.

## What follows, and what does not

**Follows:** both catalog tools are genuinely reachable by a live model through
the real provider wire, and a model offered the choice exercised it. That is a
plumbing and behavior observation the one-entry list could not produce.

**Does not follow:**

- That the model selects tools well, or badly. The scenario does not construct
  a situation with a known-correct tool choice, so neither verdict is available.
- **That the four identical runs establish stability.** Samples that agree do
  not rule out sampling variability — they merely failed to exhibit it. With
  n=4 against a non-deterministic model the observable variation is bounded
  only very loosely; this is consistent with anything from fully deterministic
  behavior to a meaningful minority of runs behaving differently.
- That tool-*selection* quality is measured anywhere. The CI evaluation harness
  drives `FakeLlmProvider` from typed fixtures, so every tool request in all 26
  cases is scripted. This spike is manual, not CI-gated, and must never be
  cited as a measured property (issue #95 acceptance criterion 5).
- **Anything about whether to add a third tool.** That decision needs an
  authoritative-exclusion context and enough runs to separate a tendency from
  noise. Neither exists here.

## Why `acceptance: PASSED` does not mean "the model behaved well"

`passed` drives the process exit code. Had it tracked the model's tool choice,
this paid, non-deterministic probe would have become a model-behavior gate —
exactly the semantic upgrade this repository's bar exists to prevent.

`passed` means only: **a readable observation was obtained.** It is identical
whether or not the deployments tool was called — a unit test asserts precisely
that. `evaluateTwoToolUsageScenario` fails closed when the observation is not
usable:

| Failure code | Meaning |
|---|---|
| `DEPLOYMENTS_TOOL_NOT_OFFERED` / `SERVICE_STATUS_TOOL_NOT_OFFERED` | The premise did not hold — a "no call" result would be an artifact of the wiring. |
| `RUN_NOT_COMPLETED_*` | The agent did not finish; nothing to read. |
| `NO_DIAGNOSTIC_CALL_OBSERVED` | Nothing was investigated at all. |
| `PREMISE_CHUNK_NOT_RETRIEVED` | The expected runbook was never shown to the model. |
| `PREMISE_CHUNK_NOT_RANK_ONE` | It was retrieved but did not rank first, so describing it as the top-ranked evidence would overstate what the model saw. |

## Run ledger

Seven invocations total: five completed, one failed after billing, one failed
before it. Only runs 3, 5, 6 and 7 are recorded as observations; the ledger
lists every invocation so the cost total and the discarded outcomes reconcile.

Run 1 performed **no retrieval at all** — that is exactly why it is discarded.
Every invocation from run 2 onward retrieved the identical ranking
(`runbook-notification-rate-limit-001` at rank 1, score 12), retrieval being
deterministic here: keyword retriever, fixed corpus, fixed query.

| # | Outcome | Billed calls | Disposition |
|---|---|---|---|
| 1 | Completed | 3 | **Discarded.** No retriever was wired, so the model never saw the rate-limit runbook, yet the printed finding asserted it had. |
| 2 | `status=failed` | ~3 | **Discarded.** The guard correctly refused to emit a finding, but no failure code was printed, making it undiagnosable. |
| 3 | Completed | 3 | **Recorded.** Premise verified from the run's own trace. |
| 4 | `status=failed` (`PROVIDER_UNAVAILABLE`) | 0 (failed at the first call) | Provider outage — exhausted API credit, unrelated to the change. |
| 5 | Completed | 3 | **Recorded.** Verifies the tightened rank-1 guard end-to-end; same tool usage as run 3. |
| 6 | Completed | 3 | **Recorded.** Confirms the `tool-discipline` → `two-tool-usage` rename did not break the live path; same tool usage again. |
| 7 | Completed | 3 | **Recorded.** Confirms the corrected `.env` loading and the call list rendered from recorded data; same tool usage again. |

Runs 1 and 2 are documented rather than quietly dropped, because each exposed a
real defect that is fixed in this change:

**Run 1** — the scenario was wired with no retriever at all. Fixed by wiring
the real keyword retriever *and* by making the premise a **verified fact**: the
observation now carries `retrievedChunkIds` and `rankOneChunkId` read from the
run's own `RETRIEVAL_COMPLETED` trace event (using its `rank` field, not array
position), and fails closed when the expected chunk is absent or not first.

**Run 2** — fixed by printing `code`/`message`/`reportValidationIssues` on a
non-completed run, mirroring the existing scenarios.

## A pre-existing defect this work exposed

`spike:rag` was the only live script in `apps/worker/package.json` that never
loaded `.env`:

```
"spike:rag": "pnpm run build:deps && tsx src/demo/run-rag-live-spike.ts"
```

Every sibling (`demo:persisted`, `test:claude:live`,
`generate:embedding-fixture`) passes `--env-file-if-exists`. The first
invocation therefore failed at `requireEnv("ANTHROPIC_API_KEY")` and, because
the script's top-level catch is deliberately opaque to avoid leaking
credentials, reported only "The spike failed to run."

The fix loads **both** env files, and the order matters. This repository keeps
`ANTHROPIC_API_KEY` and the database URLs in the root `.env`, but
`VOYAGE_API_KEY` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` exist **only** in
`apps/worker/.env` — and the spike's other scenarios need Voyage. Loading just
the root file would have left every embedding-backed scenario without a
credential; this scenario only escaped that because it deliberately uses the
keyword retriever.

Node applies `--env-file-if-exists` so that **later files override earlier
ones** (verified directly, not assumed — it is the opposite of the intuitive
reading). The worker-local file is therefore passed last, so its values win:

```
--env-file-if-exists=../../.env --env-file-if-exists=.env
```

Verified after the change: `VOYAGE_API_KEY`, `ANTHROPIC_API_KEY`,
`DATABASE_URL` and `EMBEDDING_MODEL` are all visible to the process.

## Reproducing

```bash
RAG_SPIKE_SCENARIO=two-tool-usage pnpm --filter @opspilot/worker run spike:rag
```

`two-tool-usage` is deliberately **excluded from `RAG_SPIKE_SCENARIO=all`** —
it answers a catalog question, not an adversarial-robustness one, and folding
it in would silently add a billed call to every historical full-suite
invocation. A unit test pins that exclusion.
