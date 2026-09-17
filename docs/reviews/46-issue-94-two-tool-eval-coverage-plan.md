# Issue #94 — Evaluation coverage for a two-tool investigation chain

| | |
| --- | --- |
| Scope | #94 "Evaluation coverage for a two-tool investigation chain" — eval cases only, no production source change |
| Basis | `main` @ `ed8f415` (#117, retry attribution), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/94-two-tool-eval-coverage` (created, empty) |
| Committed location | `docs/reviews/46-issue-94-two-tool-eval-coverage-plan.md` |

---

## 0. Scope corrections — verified against source

Every scope bullet in #94 was re-derived against current `main` before planning. Three are stale
or wrong, and one of them would have produced a fixture asserting a fact the tools do not report.

**0.1 `resolveTools("default")` does NOT return both catalog tools.** The issue states it
"returns both catalog tools" and cites `evaluation-runner.ts:17-26`. Current source
(`evaluation-runner.ts:17-26`) reads `case "default": return [getServiceStatusTool];` — a
single-element list. `DIAGNOSTIC_TOOL_CATALOG` (`diagnostic-tool-catalog.ts:53-56`) does contain
both entries, but the evaluation runner never consumes it. **Decision:** this is the one
production-adjacent change the issue actually needs. See §Scope decision for which of the two
available shapes is taken.

**0.2 The "deployment ruled out" case cannot use `DEGRADED`.** The issue specifies
"`get_service_status` returns `DEGRADED`; `get_recent_deployments` returns
`knownService: true, deployments: []`". No such service exists. The empty-deployments fixture is
`billing-service`, which `get-service-status.ts:38` seeds as **`OUTAGE`**. **Decision:** the case
uses `billing-service` and asserts `OUTAGE`. Writing `DEGRADED` would have required inventing a
fixture, and #93 deliberately seeded exactly three slugs so "the two tools describe one world a
run can corroborate across" (`get-recent-deployments.ts:64-66`).

**0.3 "Old `FAILED` deployment" and "completed `ROLLED_BACK` deployment" are not two more
services.** The issue lists them as separate cases. In the fixtures they are the *same three
slugs* re-read: `auth-service` carries the `FAILED`-behind-`SUCCEEDED` pair
(`get-recent-deployments.ts:107-122`) and `notification-service` carries the `ROLLED_BACK`
(`:86-99`). **Decision:** four cases over three slugs, not five over five. Each case is named for
the evidential shape it locks, not for a service.

**0.4 The issue's `toolProfile` bullet is conditional and the condition holds.** It says "if a new
`toolProfile` literal is needed, `dataset-validation.ts`'s exhaustive literal check (`:70-75`) is
updated in the same change." Confirmed the check exists at `dataset-validation.ts:68-77` and
rejects any literal outside the current three. Whether a new literal is needed is settled in
§Scope decision.

**0.5 The issue does not mention the derived-fixture blast radius, and it is the largest part of
the work.** Adding cases to `EVALUATION_CASES` invalidates a committed parity fixture, a golden
CLI report, and a case count pinned in ~8 assertions across three files plus the cross-language
parity suite. Enumerated in §3; this is scope the issue text silently omits.

---

## Scope decision

**How should the two-tool cases get a registry containing both tools?**

1. **Widen `"default"` to return both tools.** Rejected. 20 of the 22 existing cases run under
   `"default"`; widening it changes the registry every one of them resolves against. Their
   scripted turns never request `get_recent_deployments`, so nothing should change — but "should"
   is doing real work in a sentence about a 22-case regression surface, and the blast radius is
   unbounded for a benefit the next option gets for free.
2. **Add a `"with-deployments-tool"` profile returning both tools.** **Chosen.** New cases opt in;
   the existing 20 are untouched by construction rather than by argument. Costs one literal in
   `dataset-validation.ts:68-77` and one `switch` arm — exactly the conditional the issue's own
   bullet anticipated.
3. **Per-case explicit tool arrays.** Rejected: replaces a closed, validated vocabulary with
   free-form per-case wiring, and `dataset-validation.ts`'s exhaustive check exists specifically
   to keep that vocabulary closed.

**Decision: option 2.**

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Tool profiles | `evaluation-runner.ts:17-26` | 3 profiles; `"default"` returns `[getServiceStatusTool]` only |
| Profile validation | `dataset-validation.ts:68-77` | Exhaustive literal check over the 3 profiles |
| Catalog | `diagnostic-tool-catalog.ts:53-56` | Both entries; NOT consumed by the evaluation runner |
| Deployment fixtures | `get-recent-deployments.ts:79-123` | `notification-service` → `ROLLED_BACK` + `SUCCEEDED`; `billing-service` → `[]`; `auth-service` → `SUCCEEDED` + `FAILED` |
| Status fixtures | `get-service-status.ts:36-40` | `notification-service` DEGRADED, `billing-service` OUTAGE, `auth-service` OPERATIONAL |
| Unknown service | `get-recent-deployments.ts:133-136` | `knownService: seeded !== undefined`, Map-based so unknown is unknown for every string |
| Dataset order | `evaluation-dataset.ts:15-35` | Fixed array order; new cases append at the true end |
| Case-shape precedent | `checkpoint-b-cases.ts:275-380` | `multi-step-degradation-escalation` — the closest existing two-call case |
| Diagnostic bound | `agent-run-bounds.ts` | `MAX_DIAGNOSTIC_TOOL_CALLS = 3`, `MAX_PROVIDER_TURNS = 5` |

**The causal constraint (verified, not inherited from the issue text).** `runbook-deployment-rollback-001`
requires an error-budget burn rate tripling within ten minutes of a rollout **and** reproducibility
on the new revision but not the previous one. `get_recent_deployments` reports neither. Both enum
values are ambiguous in the wrong direction — a `FAILED` deployment may never have reached
production; a `ROLLED_BACK` one may already be remediated. #93 wrote this reasoning into the
fixture comments (`get-recent-deployments.ts:80-85`, `:106-108`) precisely so a later eval case
would not undo it.

## 2. Design

### 2.1 New tool profile

`ToolProfile` gains `"with-deployments-tool"`; `resolveTools` returns
`[getServiceStatusTool, getRecentDeploymentsTool]`; `dataset-validation.ts:68-77` gains the
literal. No existing profile changes.

### 2.2 Four new cases, one per evidential shape

Each is named for what it locks, appended at the end of `EVALUATION_CASES` in this order.

| id | Slugs | Shape | Report must be |
| --- | --- | --- | --- |
| `deployment-ruled-out` | `billing-service` | `OUTAGE` + `knownService: true`, `deployments: []` | Grounded on 2 distinct `TOOL_EXECUTION` locators + 1 `RAG_CHUNK`; deployment excluded as a contributing factor |
| `deployment-unresolved-lead` | `notification-service` | `DEGRADED` + recent `ROLLED_BACK` | `INSUFFICIENT`, `rootCause: null`, prose naming the missing burn-rate / revision-regression facts |
| `deployment-unknown-service` | unseeded slug | `UNKNOWN` + `knownService: false` | `INSUFFICIENT`, `rootCause: null`; NOT read as "no deployments, therefore ruled out" |
| `deployment-failed-behind-success` | `auth-service` | `OPERATIONAL` + `FAILED` behind a later `SUCCEEDED` | `INSUFFICIENT`, `rootCause: null` |

`deployment-ruled-out` is the case satisfying acceptance criterion 1 (two tools, two distinct
`TOOL_EXECUTION` locators, plus a `RAG_CHUNK`). The other three are negative/ambiguity locks.

**Only `deployment-ruled-out` may carry a non-null conclusion, and that conclusion is negative**
("deployment is ruled out as a contributing factor"). It is legitimate *because*
`knownService: true` distinguishes a genuine empty from a genuine unknown — an argument from a
positive fact, not from missing data.

### 2.3 Budget

Each case scripts 2 diagnostic calls + 1 report submission = 3 provider turns, within
`MAX_DIAGNOSTIC_TOOL_CALLS = 3` and `MAX_PROVIDER_TURNS = 5`. Acceptance criterion 4 asks for a
3-call chain; `deployment-ruled-out` additionally scripts a third diagnostic call to prove the
bound holds at its edge, giving 4 provider turns — still within 5.

### 2.4 What is NOT added

No production behavior change beyond the profile arm. No new tool, no fixture data, no prompt
change, no metric. `toolCorrectness` (`evaluation-metrics.ts:82-94`) continues to score whether
the orchestrator honored a *case-declared* call — these cases do not and cannot measure tool
*selection*, because `evaluation-runner.ts:60` constructs `FakeLlmProvider` per case and every
turn is fixture-scripted.

## 3. Compatibility — the derived-fixture blast radius

Appending 4 cases takes the dataset from 22 to 26 and invalidates every artifact derived from it.
All of these must be updated in the same change, and the regenerated ones by script, never by hand:

| Artifact | How |
| --- | --- |
| `fixtures/ts-parity-v2.json` | Regenerate via `export-parity-vectors.ts` (writes the file directly) |
| `fixtures/ts-parity-v1.json` | **Do NOT touch.** Frozen by design and never regenerated — it survives only as the offline oracle input for `legacy-v1/` (`parity-vectors.ts:26-29`). An earlier draft of this plan listed it for regeneration; that would have destroyed a deliberate historical artifact. |
| `fixtures/cli-report-golden.txt` | Regenerate; `cli-report-golden.test.ts:9` pins it byte-for-byte |
| `evaluation-dataset.test.ts:35-56` | `EXPECTED_CASE_IDS` + `toHaveLength(22)` → 26 |
| `evaluation-dataset.test.ts:50-52` | **Terminal-position pins**: `[20]`/`[21]` assert `fabricated-tool-output-evidence` / `adversarial-tool-input-shape` are the last two. Appending moves them off the end. |
| `evaluation-dataset.test.ts:165-183` | **Aggregate metrics** — every numerator/denominator shifts: `totalCases`/`passedCases` 22→26, `expectedStatusCorrectness` 22/22→26/26, and `retrievalTop1`, `retrievalHitAt3`, `schemaHandlingCorrectness`, `evidenceGroundingCorrectness`, `toolCorrectness` each grow by however many of the four new cases are applicable to that metric. These must be **derived from the final case expectations, not guessed** — write the cases first, run the suite, read the real numbers. |
| `evaluation-dataset.test.ts:197` | `suiteResult.cases` length |
| `parity-vectors.test.ts:62` | **Terminal-case pin**: `fixture.cases.at(-1)?.caseId === "adversarial-tool-input-shape"`. Breaks on append; retarget to the new last case. |
| `parity-vectors.test.ts:37,55-57,72,81-82,94,244,363` | Counts, pass counts, and the N/A-coverage comment |
| `cross-service-parity.test.ts:85-87` | Count + description |
| `cli-report-golden.test.ts:23` | Description |
| `adversarial-gate.ts:6` | Comment citing "22 case ids" |
| `docs/07-evaluation-plan.md` | The dataset's design doc carries the count and inventory in ~9 places: the purpose line (`:9`), the component table (`:66`, `:69`), the **§3 Case Inventory heading and table** (`:83`, rows through `:108`), the Checkpoint-B/`#77` narrative (`:124-127`), the adversarial-gate note (`:366`, `:378`), the fixed-harness statement (`:455`), and `:722`. Cases 23-26 must be added to the inventory table and the `ToolProfile` column's vocabulary updated. |
| `README.md:297,300` | Describes "the 22-case evaluation" and "the 22-case suite" as current behavior. **Count correction only** — see the §5 narrowing. |
| `docs/01-prd.md:531` | "The 22-case harness measures…" — a live claim about the current suite. Count correction only; its surrounding argument (that tool *selection* quality is NOT measured) stays exactly as written and is reinforced, not weakened, by this issue. |
| `docs/04-agent-design.md:1203` | **Do NOT touch.** "`false` in every one of these 22 cases" is a historical record of a past regression run, not a claim about the current dataset size. Rewriting it would falsify a completed verification record. |

Caught by review: an earlier draft of this table omitted `docs/07-evaluation-plan.md` entirely,
which would have left the repo's own evaluation design document stating a dataset size the code
contradicts. A later round caught the same omission for `README.md` / `docs/01-prd.md`. The
`04-agent-design.md` exclusion above was found by grepping for every `22-case`/`22 cases` string
in the repo rather than by a further review round — historical run records and live claims about
the current suite look identical to a text search and must be classified before editing.

The cross-language parity suite must then re-run: a fixture regenerated on the TS side is only
proven compatible once the Python service's suite actually consumes it.

## 4. Verification plan — and its limits

| # | Case | Expect |
| --- | --- | --- |
| 1 | `deployment-ruled-out` runs | 2 tools execute, 2 distinct `TOOL_EXECUTION` locators + 1 `RAG_CHUNK` in grounding |
| 2 | `deployment-unresolved-lead` | `INSUFFICIENT`, `rootCause: null` |
| 3 | `deployment-unknown-service` | `INSUFFICIENT`, `rootCause: null`, `knownService: false` observed |
| 4 | `deployment-failed-behind-success` | `INSUFFICIENT`, `rootCause: null` |
| 5 | Every new case | Stays within `MAX_DIAGNOSTIC_TOOL_CALLS` |
| 6 | Full dataset | 26 cases, fixed order, all green |
| 7 | Parity fixture | Regenerates byte-identically from the dataset |
| 8 | Cross-service parity | TS and Python agree on all 26 |
| 9 | Grep guard | No new case/fixture/doc asserts a root cause grounded on deployment outcome |

**What this cannot prove.** Nothing here measures whether a real model *chooses* the second tool,
or chooses it for a good reason. Every turn is fixture-scripted, so a green suite proves the
orchestrator honors a declared two-tool chain and that the report contract holds over it — not
that model behavior improved. That question is #95's LIVE spike and must not be claimed here.
Criterion 9 exists because this is exactly where a CI-blessed causal overclaim would enter.

## 5. Out of scope

- Any production source change other than the new `resolveTools` arm and its validation literal.
- Web UI, README **narrative/Roadmap content**, LIVE spike — all #95. The one exception is the
  mechanical case-count correction in `README.md:297,300` and `docs/01-prd.md:531`, which is in
  scope here: leaving them stale would ship documentation contradicting the code this issue
  changes. No new README section, no Roadmap entry, no prose beyond the number.
- Any claim that tool-selection quality became measurable.
- Tool input/output enrichment in Agent Activity.

## 6. Sequencing

1. Add the `"with-deployments-tool"` profile + validation literal. Assert the existing 22 cases
   are unaffected (they never name the new profile).
2. Add `deployment-ruled-out`. Confirm it fails for the right reason before the profile exists —
   a case that passes without the new registry is not testing what it claims.
3. Add the three negative cases.
4. Wire all four into `evaluation-dataset.ts` at the end of the fixed order.
5. Update the pinned ids/counts in §3's table, **including `docs/07-evaluation-plan.md`** — its
   §3 Case Inventory is the human-readable mirror of the fixed order and goes stale silently.
   Derive the aggregate-metric numbers by running the suite and reading the real values; do not
   hand-compute them from the case table.
6. Regenerate the derived fixtures **by script**. Diff them to confirm only the new cases appear.
7. Run the cross-language parity suite.
8. `pnpm agent:verify --final`. (Integration is reported `notRun` by that command and this change
   touches no persistence path, so no separate integration run is owed.)

## 7. Acceptance criteria

1. At least one eval case grounds a report on two distinct `TOOL_EXECUTION` locators from two
   different tools plus a `RAG_CHUNK`.
2. No eval case, fixture, or document asserts a root cause grounded on deployment outcome.
3. The `knownService: false`, old-`FAILED`, and completed-`ROLLED_BACK` cases each keep
   `rootCause: null` / `INSUFFICIENT`.
4. A 3-call chain across two tools stays within `MAX_DIAGNOSTIC_TOOL_CALLS`.
5. `pnpm agent:verify --final` returns PASS on `.nvmrc`'s Node `22.21.0`.
6. The existing 22 cases' **`cases[]` entries** are byte-identical in the regenerated parity
   fixture — the only additions are the four appended cases. The fixture's derived
   `expectedMetrics` block necessarily changes and is excluded from this criterion: an earlier
   draft demanded the whole fixture be unchanged, which is unsatisfiable by construction.
7. No readout, test name, or doc line added here claims this change measures tool *selection* or
   improved model behavior.
8. The four new cases use only the three seeded slugs plus one deliberately-unseeded slug; no new
   fixture data is invented.
9. No document in the repo makes a **live** claim about the current dataset size that the code
   contradicts. Verify with:

   ```
   git grep -n -e '22-case' -e '22 cases' -- '*.md' ':!docs/reviews/'
   ```

   It must return only `docs/04-agent-design.md:1203` (a historical run record, deliberately
   unchanged). `git grep` is required rather than plain `grep`: a pathspec keeps generated,
   git-ignored artifacts such as `.agent/codex/review-summary.md` out of the result, and the
   quoted glob is safe under zsh, where a bare `--include=*.md` with no matching path fails
   outright. `docs/reviews/` is excluded because plan documents are point-in-time records and are
   never retroactively edited.

---

See #94 for the filed issue, #93 for the tool and its fixtures, #95 for the reader-visible surface
and the LIVE spike, and `docs/reviews/37-milestone-14-second-diagnostic-tool-plan.md` §3.3.
