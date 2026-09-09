# Issue #78 — CI adversarial gate + stale-doc fixes

| | |
| --- | --- |
| Scope | #78 "CI adversarial gate + stale-doc fixes" — full scope as written, with two scope items corrected against source (see §0) |
| Basis | `main` @ `a64db1e` (PR #86 merge — closes #77), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/78-ci-adversarial-gate` (created, empty) |
| Committed location | `docs/reviews/34-issue-78-ci-adversarial-gate-plan.md` |

---

## 0. Scope corrections — what this issue actually is, verified against source

The issue text was written from `docs/reviews/27-milestone-13-...-plan.md` §2.2/§6.7 before the
harness reached its current state. Three of its four scope bullets need correcting before
implementation, and the correction changes what the "gate" honestly guarantees. Recording this
here rather than silently building to the issue's literal text.

### 0.1 "CI fails if any of the 3 structural adversarial cases fails" is ALREADY TRUE today

`run-eval.ts:177-180` — `getExitCode` returns `1` whenever `metrics.failedCases > 0`. Every one of
the 22 dataset cases is expected to pass, so **any** case failing (adversarial or not) already
exits non-zero and already fails the `Cross-service parity` CI job, which runs
`pnpm --filter @opspilot/worker run eval` three times (ci.yml:546, 583, and 595's
deliberately-inverted unreachable-service leg).

Removal of an adversarial case is likewise already caught — `evaluation-dataset.test.ts:42-53`
pins the exact 22 ids in order and asserts `toHaveLength(22)`, running in the `Verify` job.

**Therefore: a plain "adversarial pass rate ≥ 100%" gate adds no enforcement whatsoever.** Building
it as if it did, and describing the result as "CI now gates adversarial robustness," would be a
semantic upgrade the mechanism does not earn. Two things are genuinely missing, and they are what
this issue should deliver:

| Missing today | What closes it |
| --- | --- |
| **Legibility.** "22/22 passed" does not say the adversarial suite ran, or how many cases it has. A reader of CI output or the CLI report cannot tell the security cases from the topical ones. | A named `Adversarial (structural): 3/3` readout in the CLI report, plus a named CI step. |
| **Fail-closed on ABSENCE.** Every existing guard proves cases that *ran* passed. A run over a case subset (`runEvaluation({ cases })`'s injectable override, used by tests and available to any future caller) reports `Failed: 0` and exits `0` with zero adversarial cases present — vacuously "green". `100% of 0` is not a security guarantee. | The readout fails closed when a declared adversarial case id is **absent** from the run's results, not only when one fails. |

The presence half is the only genuinely new guarantee in this issue. The plan states it that way.

### 0.2 "Remove the empty `evals/cases/` directory" — that directory is not in the repository

`git ls-tree -r --name-only origin/main | grep evals` returns nothing; `git log --all -- evals` is
empty. `evals/` has **never been tracked**. It exists only in the local working copy, containing a
single `.DS_Store`, and is invisible to `git status` only because `.gitignore:60` ignores
`.DS_Store` — the directory itself is untracked-but-empty-of-tracked-content, so git ignores it.

There is nothing to remove in a PR. The real, in-repo residue of that never-built directory is
**`docs/03-technical-design.md`**, which still describes it as live structure in two places:
- §"Proposed repo layout" tree (line ~418): `├── evals/` with `cases/`, `results/`, `src/`.
- §22.3 (line ~2266): "Eval cases live in `evals/cases/*.json`." — followed by a per-case JSON field
  list and a scoring-dimension list that describe a design never implemented. The harness that
  actually shipped is `apps/worker/src/evaluation/**` with TypeScript case modules, documented in
  `docs/07-evaluation-plan.md`.

**Decision: correct the doc, delete the local directory outside the PR.** §22.3 is corrected to
point at what exists, not deleted wholesale — it is a numbered section referenced by the document's
own structure, and D19/§23.5's `pnpm eval` requirement in its last paragraph is still accurate.

### 0.3 "README's 15-case → 20-case (two occurrences)" — the correct number is 22

README.md:297 and :300 say "15-case". The issue says change to 20. Since #77 merged, the dataset is
**22** (`docs/07-evaluation-plan.md` §3 already says 22 throughout). Writing 20 would ship a
second, fresher stale claim. **Decision: 22.**

### 0.4 What is deliberately NOT changed

The three structural adversarial cases prove *validator* behavior — that evidence grounding and
`.strict()` tool-input schemas reject fabricated/smuggled input. They are `FakeAgentScenario`-driven
and no real model is in the loop, so they cannot and do not prove model resistance to injection
(the live-spike scenarios in `docs/reviews/33-...-spike-results.md` are that question, and D/E of
them remain BLOCKED on Issue #85). No readout, step name, or doc line added here may be worded so
as to imply otherwise.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Exit code | `apps/worker/src/evaluation/run-eval.ts:177-180` `getExitCode` | `configuration-error` → 1; otherwise `metrics.failedCases > 0 ? 1 : 0`. No case-identity awareness at all |
| Case results available at render time | `run-eval.ts:236-241` | `formatEvaluationReport(outcome.results, outcome.metrics)`; `outcome.results` is `readonly EvaluationCaseResultV2[]`, each carrying `caseId` and `passed` |
| CLI report | `apps/worker/src/evaluation/evaluation-formatter.ts:49-116` | Per-case PASS/FAIL lines, a `Summary` block, 15 metric ratios, and (only when `retrievalQualityProvenance !== null`) a retrieval-quality block. No adversarial grouping |
| Golden report | `apps/worker/src/evaluation/fixtures/cli-report-golden.txt` (154 lines) + `cli-report-golden.test.ts` | Byte-identical assertion over the whole rendered report. **Any new line regenerates this fixture** |
| Adversarial case inventory | `apps/worker/src/evaluation/cases/evidence-grounding-cases.ts` | `INJECTION_PROBE_STRUCTURAL_CASE` (15), `FABRICATED_TOOL_OUTPUT_EVIDENCE_CASE` (21), `ADVERSARIAL_TOOL_INPUT_SHAPE_CASE` (22) — the 3 in scope |
| Adjacent, deliberately excluded | same file | `FABRICATED_RAG_EVIDENCE_CASE` (7), `FABRICATED_TOOL_EVIDENCE_CASE` (8) — bare "scripted report cites a bad id" cases with **no adversarial content anywhere in the run**; per `docs/reviews/32-...-plan.md`'s scope decision, that narrative distinction is exactly what makes 15/21/22 the adversarial set. Including 7/8 would make the count 5 and contradict both the milestone plan and #78's own acceptance criterion |
| Dataset order/count pin | `evaluation-dataset.test.ts:12-53` | Exact 22 ids, exact order, exact length — the existing anti-removal guard |
| Metrics contract | `apps/worker/src/evaluation/types.ts:158-230`, `v2-types.ts` | 15 ratios + 4 Milestone-13 retrieval-quality fields + nullable provenance; mirrored in the Python service and the `evaluation_metrics` table |
| Persisted-metric read path | `services/evaluation/src/opspilot_evaluation/api.py` `_read_metrics` | Explicit allowlist of accepted persisted metric-name shapes, fails closed on anything else |
| CI eval steps | `.github/workflows/ci.yml:543, 580, 591` | Three `pnpm ... run eval` invocations named for the *scorer-cutover* property each proves ("Default-cutover proof — …"). None mentions the eval harness or its case suite |

---

## 2. Design

### 2.1 One declared adversarial set, in its own pure module

New file `apps/worker/src/evaluation/adversarial-gate.ts`:

- `export const ADVERSARIAL_CASE_IDS = ["injection-probe-structural",
  "fabricated-tool-output-evidence", "adversarial-tool-input-shape"] as const;` — the single source
  of truth, with a comment recording *why* cases 7/8 are excluded (§1's row above), so a future
  reader does not "fix" the count.
- `export function summarizeAdversarialCases(results: readonly EvaluationCaseResultV2[]):
  AdversarialSummary` returning `{ declared: number; present: number; passed: number; missingIds:
  readonly string[] }`.

Pure, dependency-light (types only). It deliberately does **not** import `EVALUATION_CASES` — the
runtime constant stays a declaration, and the link to the real dataset is asserted in tests (§2.4),
which is where a mismatch should surface loudly rather than being silently self-satisfying.

### 2.2 Readout — a named line, honestly worded

`evaluation-formatter.ts` appends one line to the `Summary` block, after `Pass rate`:

```
Adversarial (structural): 3/3
```

`passed/declared`, never `passed/present` — a missing case must not be able to hide behind a
shrunken denominator. When cases are missing, the same line renders the absence explicitly rather
than a bare ratio:

```
Adversarial (structural): 2/3 (1 missing)
```

Wording is deliberately `(structural)`, not "adversarial robustness"/"security gate" (§0.4).

### 2.3 Enforcement — fail closed on ABSENCE, which is the new part

`getExitCode` gains one condition: non-zero if `summary.passed !== summary.declared`. This covers
both a failed adversarial case (already covered by `failedCases > 0` — redundant on purpose, so the
guarantee is stated where it is read) and, newly, an adversarial case **absent** from the results.

The plan does not add a second gate mechanism, a new CI job, or a threshold constant: 100% is the
only defensible bar for a security-shaped suite, and hard-coding equality expresses that better
than a configurable rate.

### 2.4 Tests (test-first, per repo convention)

| Test | Proves |
| --- | --- |
| `adversarial-gate.test.ts` — every id in `ADVERSARIAL_CASE_IDS` exists in `EVALUATION_CASES` | The declared constant cannot drift away from the real dataset |
| same — the 3 ids are exactly the cases whose corpus/tool profile or narrative marks them adversarial | Guards a future 4th adversarial case being added and silently left out of the gate |
| same — `summarizeAdversarialCases` over: all-present-all-pass / one-failed / one-absent / empty results | Each branch, including the vacuous-empty case that motivated §0.1 |
| `run-eval.test.ts` — `getExitCode` returns 1 for an outcome with `failedCases: 0` but an adversarial case absent | The genuinely new guarantee, stated as its own test |
| `evaluation-formatter.test.ts` — the line renders `3/3` and the `(N missing)` form | Readout shape |
| `cli-report-golden.test.ts` + regenerated `cli-report-golden.txt` | Whole-report byte-identity, with the one new line |

### 2.5 CI step naming (issue scope bullet 4)

Rename the three eval steps so the Actions UI shows the harness ran, without losing what each leg
actually proves — the existing names encode the #61 Phase 4 cutover property and must not be
flattened to a generic "Run eval":

- `Evaluation harness (22 cases incl. 3 structural adversarial) — explicit local oracle, no service`
- `Evaluation harness (22 cases incl. 3 structural adversarial) — default scorer against the real service`
- `Evaluation harness — default scorer fails closed when the service is unreachable`

No workflow logic changes. The gate rides the existing exit code.

---

## 3. Compatibility

- **No contract change.** `EvaluationMetrics`, `EvaluationSuiteInputV2`, the Python service's
  request/response models, and the `evaluation_metrics` table are all untouched. The adversarial
  ratio is derived at render/exit time from `EvaluationCaseResultV2.caseId`/`passed`, which both
  scorers already return. This deliberately avoids the third-metric-generation read-compatibility
  work (`_read_metrics`'s shape allowlist) that a persisted 16th metric would require — a real cost
  with no corresponding benefit, since nothing needs to query historical adversarial rates.
- **Cross-service parity fixtures** (`ts-parity-v1.json`, `ts-parity-v2.json`,
  `negative-vectors-v2.json`) are contract-level and unaffected; only `cli-report-golden.txt`
  regenerates.
- Persisted runs from before this change stay readable and comparable — nothing about them changes.

---

## 4. Verification plan — and its explicit limit

| Case | Expected |
| --- | --- |
| `EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval` | exit 0; `Adversarial (structural): 3/3` present |
| Same, with one adversarial case's expectations locally broken | exit 1 |
| `runEvaluation({ cases: <subset omitting an adversarial case> })` | exit 1, `(1 missing)` rendered — the new guarantee |
| `pnpm test` (Verify job equivalent) | green, incl. regenerated golden |
| `pnpm agent:verify --final` | green |

**What this cannot prove:** nothing here demonstrates model robustness against injection. All three
cases run against `FakeLlmProvider`, whose turns are pre-authored and never read the adversarial
payload — they prove the orchestrator's validators reject fabricated evidence and malformed tool
input, which is a code guarantee, not a behavioral one. The behavioral question is the live-spike's,
and it is currently **blocked on Issue #85** for the RAG-channel scenarios. That gap is not closed
by this issue and must not be described as if it were.

---

## 5. Out of scope (explicit)

- Any change to Issue #85's `NO_EVIDENCE_YET` run-state guard, the live-spike scenarios, or their
  blocked D/E verdicts.
- A persisted 16th metric / metric-generation read-compatibility work (§3).
- A metrics-baseline drift gate — already flagged out of scope by #78 itself.
- Adding, removing, or re-narrating any evaluation case.
- Re-litigating whether cases 7/8 belong in the adversarial set (§1).
- Removing `evals/` from git — it is not in git (§0.2).

---

## 6. Sequencing

1. `adversarial-gate.ts` + its tests (RED first: the dataset-membership test and the absent-case
   summary branch).
2. Wire `getExitCode`; add its new test.
3. Formatter line + formatter test.
4. Regenerate `cli-report-golden.txt` from a real `EVALUATION_SCORER=local` run; confirm the diff is
   exactly one added line.
5. Docs: README 15→22 (two occurrences); `docs/03-technical-design.md` §22.3 + repo-layout tree
   corrected to the shipped `apps/worker/src/evaluation/**` harness; `docs/07-evaluation-plan.md`
   gains the adversarial readout to its CLI-report description.
6. CI step renames.
7. `pnpm agent:verify --final` → `agent:review-bundle` → `agent:codex-review` → adjudicate → fix →
   final verify → owner-controlled commit/push/PR.

---

## 7. Acceptance criteria

1. `ADVERSARIAL_CASE_IDS` exists as one exported constant; a test proves every id is a real member
   of `EVALUATION_CASES`.
2. The CLI report carries a named structural-adversarial readout showing `passed/declared`, and
   renders missing cases explicitly.
3. `getExitCode` returns non-zero when a declared adversarial case is **absent** from the results,
   even with `failedCases === 0` — proven by its own test.
4. `cli-report-golden.txt` regenerated; the golden test passes byte-identically.
5. README's two "15-case" occurrences read 22; `docs/03-technical-design.md` no longer describes
   `evals/cases/*.json` as the harness's location.
6. The three CI eval steps name the evaluation harness and its case count.
7. `pnpm agent:verify --final` green; nothing in the contract, Python service, or persisted metric
   shape changed.
8. No document, step name, or readout added by this issue claims model-behavioral adversarial
   robustness.
