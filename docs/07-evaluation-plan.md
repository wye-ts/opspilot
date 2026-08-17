# OpsPilot — Deterministic Evaluation Harness — Design

| Field | Value |
|---|---|
| Document | Deterministic Evaluation Harness |
| Version | 2.0 |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Describe the fully offline, deterministic evaluation harness that regression-tests the RAG + agent vertical slice: the fixed 20-case dataset, the stage-aware evaluator, the fifteen aggregate metrics (six legacy + nine Milestone-11), the three-state check outcome model, and the CLI report |
| Related Documents | `docs/04-agent-design.md`, `docs/05-rag-design.md` §10, `docs/10-engineering-challenges.md` §4 (Challenge 2), `services/evaluation/README.md` (Python evaluation service, §10 below) |

---

## 1. Scope

`docs/05-rag-design.md` §10 named a gap: "a retrieval evaluation dataset —
a fixed set of queries with known expected top-ranked chunks, run
repeatedly to detect retrieval-quality regressions — is not yet built."
This harness closes that gap, and extends it to the whole pipeline: it
proves retrieval correctness, tool correctness (requested / executed /
completed), run-status and failure-code correctness, report schema
validity, evidence-grounding correctness (including rejection of
fabricated evidence), and — since OpsPilot #59 — nine deterministic
Milestone-11 metric areas (root-cause discipline, evidence support, UNKNOWN
handling, diagnostic justification, confidence calibration, action
grounding, approval gates, bounds respect, and deterministic recovery) —
in one repeatable, offline command.

It reuses every existing production component exactly as-is:
the file-backed Markdown runbook corpus, `InMemoryKeywordRunbookRetriever`,
`FakeLlmProvider`, `InMemoryToolRegistry`, `getServiceStatusTool`, and
`runAgentOrchestrator`. It adds no new orchestrator behavior, no new
production tool, no live provider, and no persistence (persistence belongs
to the scoring boundary in §10).

Out of scope: live-provider evaluation, LLM-as-a-judge/semantic grading,
statistical benchmarking, and a large corpus. See §9.

## 2. Architecture

```
runbooks/*.md (7 chunks, 5 files)
  → loadDefaultRunbookCorpus()                 [existing, called once]
  → InMemoryKeywordRunbookRetriever(corpus)     [existing, fresh per case]
  → FakeLlmProvider(scenario)                   [existing, fresh per case]
  → recording-wrapped InMemoryToolRegistry       [existing tools + a thin recorder]
  → recording provider decorator                 [runAgentTurn attempt + usage recorder]
  → lifecycle-event collector                    [ordered TOOL_REQUESTED/REPORT_* events]
  → runAgentOrchestrator({...})                  [existing, unmodified]
  → observed-facts (v2 normalization)            [investigation facts + report facts]
  → evaluation-evaluator (stage-aware checks + nine #59 metric checks)
  → evaluation-metrics (aggregate, scoped denominators, N/A excluded)
  → evaluation-formatter (terminal report)
  → run-eval.ts (CLI composition root, exit code)
```

Modules, under `apps/worker/src/evaluation/`:

| File | Responsibility |
|---|---|
| `types.ts` | `EvaluationCase`, `EvaluationExpectations`, `CorpusProfile`, `ToolProfile`, `EvaluationCaseResult`, `EvaluationCheckResult`, `EvaluationMetrics` (six original + nine #59 ratio fields), and the harness-wide constant `EVALUATION_TOP_K = 3`. |
| `v2-types.ts` | The active v2 cross-language contract: `EVALUATION_CONTRACT_VERSION = 2`, `EVALUATION_DATASET_ID = "opspilot-deterministic-v2"`, `EvaluationCheckV2` (three-state discriminated union), `EvaluationSuiteInputV2`/`ResultV2`. |
| `fixtures/always-fails-tool.ts` | `alwaysFailsTool` — an evaluation-only `DiagnosticToolDefinition` whose `execute()` always throws. Never registered in production/demo/live-spike wiring. |
| `cases/topic-runbook-cases.ts` | Cases 1–6: per-topic retrieval + tool + report, plus the irrelevant-query case (extended by #59). |
| `cases/evidence-grounding-cases.ts` | Cases 7, 8, 15: fabricated RAG evidence, fabricated tool evidence, and the injection-probe case. |
| `cases/protocol-and-failure-cases.ts` | Cases 9–14: unknown tool, invalid input, protocol error, missing final report, tool execution failure, malformed report. |
| `cases/checkpoint-b-cases.ts` | Cases 16–20: the five #59 Milestone-11 cases. |
| `evaluation-dataset.ts` | Assembles the 20 cases into `EVALUATION_CASES`, in the fixed approved order. |
| `dataset-validation.ts` | `validateEvaluationDataset(...)` — every structural rule in §5, including bounded case-id slug validation, using only fixed messages; also exports `resolveCorpus`, shared with the runner. |
| `recording-tool-registry.ts` | `createRecordingToolRegistry(...)` — wraps each tool's `execute()` to record `{toolName, input}` (and, on success, `output`) before delegating, without altering lookup/execute behavior. |
| `recording-provider.ts` | `createRecordingProvider(...)` — records a `runAgentTurn` attempt **before** delegating (so a thrown provider call is still counted) and stamps the returned `usage` on success. |
| `observed-facts.ts` | `buildObservedFacts(...)` — normalizes `AgentOrchestratorResult` + recorder + lifecycle events into the v2 `ObservedFacts` (investigation, tools, report, failure facts). |
| `evaluation-evaluator.ts` | Pure, stage-aware check functions plus the nine #59 metric check functions; `evaluateCase` combines them into an `EvaluationCaseResult`. Every failing check's `reason` is one of a small, fixed set of templates — never an interpolated raw identifier. |
| `evaluation-runner.ts` | `runEvaluationSuite(...)` — for each case, constructs every collaborator fresh and calls `runAgentOrchestrator`, in supplied order. |
| `evaluation-metrics.ts` | `aggregateMetrics(...)` — aggregates the evaluator's named checks; never re-derives looser logic. |
| `evaluation-formatter.ts` | `formatEvaluationReport(...)` — sanitized terminal report; never reads `EvaluationCheckResult.expected`/`.observed`. |
| `evaluation-service-client.ts` | POSTs `EvaluationSuiteInputV2` to the Python service, re-runs `aggregateMetrics` locally, and enforces the exactly-nine-per-case completeness invariant (`MALFORMED_RESPONSE` otherwise). |
| `legacy-v1/` | The frozen v1 offline oracle: `v1-types.ts`, `evaluator-v1.ts`, `metrics-v1.ts`, `local-scorer-v1.ts`, `parity-v1.test.ts`. Unwired from the active runtime. |
| `run-eval.ts` | CLI composition root: `runEvaluation` (load corpus, validate, run), `resolveEvaluationRun` (the sole catch boundary), `renderEvaluationOutput`, `main()`. See §7. |

## 3. Case Inventory (20 cases, fixed order)

| # | Case ID | Corpus | Tool profile | Status / code |
|---|---|---|---|---|
| 1 | `notification-service-degradation` | default | default | completed |
| 2 | `notification-queue-backlog` | default | default | completed |
| 3 | `authentication-failure` | default | default | completed |
| 4 | `database-connection-saturation` | default | default | completed |
| 5 | `billing-invoice-formatting` | default | default | completed |
| 6 | `irrelevant-no-match-query` | default | default | completed |
| 7 | `fabricated-rag-evidence` | default | default | failed / `REPORT_EVIDENCE_INVALID` |
| 8 | `fabricated-tool-evidence` | default | default | failed / `REPORT_EVIDENCE_INVALID` |
| 9 | `unknown-tool-request` | default | default | failed / `TOOL_NOT_FOUND` |
| 10 | `invalid-tool-input` | default | default | failed / `TOOL_INPUT_INVALID` |
| 11 | `provider-protocol-error` | default | default | failed / `PROVIDER_PROTOCOL_INVALID` |
| 12 | `missing-final-report` | default | default | failed / `PROVIDER_PROTOCOL_INVALID` |
| 13 | `tool-execution-failure` | default | with-always-fails-tool | failed / `TOOL_EXECUTION_FAILED` |
| 14 | `malformed-report-submission` | default | default | failed / `REPORT_SCHEMA_INVALID` |
| 15 | `injection-probe-structural` | injection-probe | default | failed / `REPORT_EVIDENCE_INVALID` |
| 16 | `healthy-service-no-fault` | default | default | completed |
| 17 | `multi-step-degradation-escalation` | default | default | completed |
| 18 | `unknown-telemetry-insufficient` | default | default | completed |
| 19 | `conflicting-signals-unresolved` | default | default | completed |
| 20 | `bound-exhausted-finalization` | default | default | completed |

Cases 1–6 exercise retrieval + tool + report end to end, using queries built
from a target chunk's exact title tokens (the deterministic keyword
retriever scores a title-token match at `+2`, a content-token match at `+1`)
so the expected top-ranked chunk is provably dominant. Cases 7, 8, and 15
each submit a schema-valid report citing evidence that was never actually
produced in that run — a real-but-unretrieved chunk id, another case's
tool-execution id, and a fabricated id planted inside adversarial retrieved
content, respectively — proving evidence grounding rejects all three the
same way. Cases 9–14 exercise the orchestrator's failure paths: unknown
tool, invalid tool input, a malformed multi-request turn, a tool request on
the required-report turn, a tool whose execution throws, and a
schema-invalid report body. Cases 16–20 are the #59 Milestone-11 cases
added at Checkpoint B (§11).

### 3.1 The eight required scenario classes

The #59 planning milestone required eight deterministic scenario classes to
be covered by the dataset. The mapping below shows which case owns each
class; several cases close more than one.

| # | Scenario class | Case(s) |
|---|---|---|
| 1 | Healthy service — grounded `SUFFICIENT`, `rootCause: null`, `ADVISORY` | 16 `healthy-service-no-fault` |
| 2 | Known degradation | 1 `notification-service-degradation`, 2 `notification-queue-backlog`, 5 `billing-invoice-formatting`, 17 `multi-step-degradation-escalation` |
| 3 | UNKNOWN telemetry handled correctly | 4 `database-connection-saturation` (corrected fixture), 6 `irrelevant-no-match-query`, 18 `unknown-telemetry-insufficient`, 20 `bound-exhausted-finalization` |
| 4 | Insufficient evidence — voluntary stop with capacity remaining | 6 `irrelevant-no-match-query`, 18 `unknown-telemetry-insufficient` |
| 5 | Conflicting signals | 19 `conflicting-signals-unresolved` |
| 6 | Tool failure — deterministic failed-stage / no side effects / no report | 13 `tool-execution-failure` (and every other failure case, via the mandatory `expectedRecovery`) |
| 7 | Multiple diagnostic steps | 17 `multi-step-degradation-escalation` (successful), 20 `bound-exhausted-finalization` (bound edge) |
| 8 | Approval-producing investigation | 17 `multi-step-degradation-escalation` (flagship), 1 `notification-service-degradation`; the `NOT_ELIGIBLE` terminal side is exercised by cases 4, 6, 16, 18, 19, 20 and every failure case |

The five new cases close the previously missing classes directly: 16 closes
scenario 1; 17 closes scenarios 2, 7, and 8 (the suite's only run that is
multi-step, voluntary, grounded, actionable, approval-eligible, and stops
with capacity remaining); 18 closes scenarios 3 and 4; 19 closes scenario 5;
20 closes scenario 7's bound edge (and re-exercises scenario 3). Case 4's
authored fixture was corrected at Checkpoint B (an untruthful `SUFFICIENT`
+ definitive `rootCause` on `UNKNOWN` telemetry became the truthful
`INSUFFICIENT` / `rootCause: null` shape) so it serves scenario 3 truthfully
instead of encoding a bad judgment.

Every case in this inventory is expected to **PASS** (the dataset is green
by construction). The proof that the metrics reject bad shapes lives in the
negative evaluator vectors (§11.6).

## 4. Expectation Model

Each case declares a `CorpusProfile` (`"default"` → the real loaded
Markdown corpus; `"injection-probe"` → exactly `[INJECTION_PROBE_CHUNK]`), a
`ToolProfile` (`"default"` → `get_service_status`; `"with-always-fails-tool"`
→ that plus the evaluation-only `always_fails` fixture), a `FakeAgentScenario`
(the exact turns fed to the real orchestrator), and `EvaluationExpectations`.

Expectations split into two categories:

- **Stage expectations** (`report.schemaExpectation`,
  `report.groundingExpectation`) are pure functions of
  `AgentOrchestratorResult.status`/`.code`. They are always evaluable and
  never "missing" — they may be declared on either a completed or a failed
  case.
- **Payload expectations** (`report.requiredEvidenceTypes`,
  `requiredEvidenceIds`, `forbiddenEvidenceIds`, `requiredActionTypes`)
  require an actual `result.report`, so dataset validation rejects
  declaring any of them on a case whose declared `runStatus` is `"failed"`.

Retrieval, tool-requested/executed/completed, and failure-code expectations
are each checked against a specific observation source (the
`RETRIEVAL_COMPLETED`/`TOOL_REQUESTED`/`TOOL_COMPLETED` trace events, the
per-case tool-execution recorder, and `result.code`, respectively). A
declared expectation whose observation source never fired in the actual run
fails explicitly, with a fixed reason — it is never silently skipped or
counted as passing.

### 4.1 Check outcome model (three-state)

Since #59 Checkpoint A, every check resolves to exactly one of three
outcomes (`EvaluationCheckV2`, `v2-types.ts`):

| Status | `reasonCode` |
|---|---|
| `PASS` | `null` |
| `FAIL` | a `CheckReasonCode` |
| `NOT_APPLICABLE` | a `NotApplicableCode` |

A case passes iff **no** check has `status: "FAIL"`; `NOT_APPLICABLE` never
fails a case and is excluded from both a metric ratio's numerator and its
denominator (the formatter reports the N/A count separately).

The three N/A reason codes are a closed, application-authored vocabulary
(`not-applicable-codes.ts`):

| Code | Meaning | Fixed display |
|---|---|---|
| `NA_RUN_DID_NOT_COMPLETE` | The metric needs a report payload and the run failed. | "The run did not complete, so this check cannot be evaluated." |
| `NA_EXPECTATION_NOT_DECLARED` | The run produced the facts, but this case declares no expectation for this metric. | "No expectation was declared for this check." |
| `NA_NO_RECOVERY_PATH_EXERCISED` | The run completed successfully, so no failure/recovery behavior exists to evaluate. | "No recovery path was exercised in this run." |

### 4.2 Two check populations, two emission rules

| Population | Emission rule |
|---|---|
| Legacy / low-level checks (status, retrieval-*, tool-*, schema-handling, evidence-grounding, evidence-types, evidence-ids, action-types, failure-code) | **Expectation-scoped** — emitted iff the matching expectation is declared. Absence carries no meaning and is not an outcome. |
| The nine #59 metric checks | **Exactly nine emitted per case**, one per metric, each exactly `PASS \| FAIL \| NOT_APPLICABLE`. A missing #59 metric outcome is a scorer/Harness bug, never equivalent to N/A. |

The exactly-nine invariant is enforced in three layers: the scorer in both
languages (assembling a case's checks raises if the nine names do not each
appear exactly once, in fixed order), the TS service client's
`validateSemanticConsistency` (a response missing a metric outcome is
`MALFORMED_RESPONSE`), and tests in both languages (including a negative
test proving the scorer raises on a synthetic partial result). See §11.5.

## 5. Dataset Validation

`validateEvaluationDataset({ cases, defaultCorpus, injectionProbeChunk })`
runs before any case executes and collects every violated rule across every
case (not just the first). It checks: case ids are bounded, lowercase-hyphen
slugs (`CASE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/`, capped at
`MAX_CASE_ID_LENGTH = 128`) with no duplicates; at least one behavioral
expectation beyond `runStatus`; status/failure-code consistency (including
the four-way stage-expectation/failure-code consistency guard); that payload
expectations only appear on completed cases; that `expectedNoResults` never
coexists with `expectedTop1`/`expectedInTopK`; that `expectedInTopK` is
non-empty when present; that retrieval-expectation chunk ids belong to the
case's *effective* corpus (resolved via the case's `corpusProfile`); that
expected/forbidden retrieval ids, executed-tool names, and completed-call
ids never conflict within a case; that required/forbidden evidence ids never
overlap; and that `corpusProfile`/`toolProfile` are valid literals.

The #59 Checkpoint B rules extend this validator with the Milestone-11
semantic expectations:

1. `0 <= expectedConfidence.min <= expectedConfidence.max <= 1`. *(No
   cross-case ordering rule.)*
2. `expectedRootCause: "PRESENT"` requires `expectedEvidence.state: "SUFFICIENT"`.
3. For every expected action, `requiredGrounding` is non-empty and
   `requiredGrounding ⊆ allowedGrounding`.
4. `expectedApproval: "ELIGIBLE"` requires `runStatus: "completed"` and a
   non-empty `expectedActions`; a failed run may declare only
   `"NOT_ELIGIBLE"`.
5. `expectedTelemetryEvidence.probative` and `.nonProbative` are disjoint
   and internally distinct by `(sourceType, evidenceId)`, and every entry is
   a `TOOL_EXECUTION` locator.
6. Probative classification is **complete**: every `TOOL_EXECUTION` locator
   named in the case's expectations must appear in exactly one of
   `probative`/`nonProbative`. An unlisted locator is a validation error,
   never a silently-probative one.
7. No locator in `expectedTelemetryEvidence.nonProbative` may appear in any
   action's `requiredGrounding`.
8. Report-requiring metric expectations (`expectedRootCause`,
   `expectedEvidence`, `expectedTelemetryEvidence`, `expectedConfidence`,
   `expectedActions`) require `runStatus: "completed"`. `expectedApproval` is
   **not** report-only: it may be declared on `"completed"` or `"failed"`.
9. **(a)** `expectedRecovery` requires `runStatus: "failed"`.
   **(b)** `runStatus: "failed"` **requires** `expectedRecovery` — missing
   recovery coverage is a dataset-authoring error, caught before any case
   executes.
10. `expectedDiagnostics.length <= MAX_DIAGNOSTIC_TOOL_CALLS`, and the
    scenario's turn count `<= MAX_PROVIDER_TURNS`.
11. `expectedStopReason` requires `expectedDiagnostics`. An orphaned stop
    reason (declared with no diagnostic sequence to attach it to) is a
    dataset-authoring error — it can never silently become N/A.
12. Count/token/cardinality fields (`minDistinctLocators`,
    `expectedBounds.maxTotalTokens`, and the observed
    `investigation.*`/`usage.*` counts) are strict non-negative integers in
    both languages — no floats, booleans, or non-finite values.
13. `expectedConfidence.min`/`.max` are strict finite numbers in `[0,1]`,
    accepting valid integer/fractional JSON numbers (`0`, `1`, `0.25`,
    `0.75`) but rejecting bool, string, `NaN`, `±Infinity`, negative values,
    and `min > max`.

By design, `requiredEvidenceIds`/`forbiddenEvidenceIds` are never checked
against corpus or tool-execution-id membership — cases 7, 8, and 15
deliberately cite ids that were never produced in their own run, and that is
exactly the behavior evidence grounding must reject.

**Every validation message is a fixed, application-authored template.** None
ever interpolates a raw case id, chunk id, tool name, toolCallId, evidence
id, or profile value from the case data itself — a message identifies which
case it concerns only by a safe 1-based ordinal (e.g. `"Case 4: ..."`), never
by echoing the value that caused the failure. This holds even for a
deliberately invalid case id itself: the id-format message never echoes the
invalid string.

A validation failure means zero cases execute; the CLI prints a single line
of the form `Dataset configuration error: <first fixed message>` followed by
`Cases executed: 0`, and exits non-zero (see §7).

## 6. Metrics

`aggregateMetrics` aggregates the evaluator's fixed, named per-case checks
— it never re-derives a separate, looser notion of correctness from raw
status/code comparisons.

| Metric | Numerator | Denominator |
|---|---|---|
| `retrievalTop1` | passing `retrieval-top1` checks | cases declaring `expectedTop1` |
| `retrievalHitAt3` | passing `retrieval-hit3` checks | cases declaring a non-empty `expectedInTopK` |
| `schemaHandlingCorrectness` | passing `schema-handling` checks | cases declaring `schemaExpectation` |
| `evidenceGroundingCorrectness` | passing `evidence-grounding` checks | cases declaring `groundingExpectation` |
| `toolCorrectness` | cases where every declared tool sub-check passes | cases declaring any of the five tool sub-fields |
| `expectedStatusCorrectness` | passing `status` checks | all cases |
| `rootCauseDiscipline` | passing `root-cause-discipline` checks | cases with a PASS/FAIL `root-cause-discipline` outcome |
| `evidenceSupport` | passing `evidence-support` checks | cases with a PASS/FAIL `evidence-support` outcome |
| `unknownHandling` | passing `unknown-telemetry-handling` checks | cases with a PASS/FAIL `unknown-telemetry-handling` outcome |
| `diagnosticJustification` | passing `diagnostic-justification` checks | cases with a PASS/FAIL `diagnostic-justification` outcome |
| `confidenceCalibration` | passing `confidence-calibration` checks | cases with a PASS/FAIL `confidence-calibration` outcome |
| `actionGrounding` | passing `action-grounding` checks | cases with a PASS/FAIL `action-grounding` outcome |
| `approvalGate` | passing `approval-gate` checks | cases with a PASS/FAIL `approval-gate` outcome |
| `boundsRespected` | passing `bounds-respected` checks | all cases (never N/A) |
| `deterministicRecovery` | passing `deterministic-recovery` checks | cases with a PASS/FAIL `deterministic-recovery` outcome |

For the six original ratios, `NOT_APPLICABLE` never occurs (the N/A codes are
used only by the nine #59 metrics), so the original semantics are unchanged.
For the nine #59 ratios, an N/A outcome is excluded from **both** numerator
and denominator — a case where a metric was inapplicable cannot lower the
ratio — and the formatter reports the N/A count separately. A
zero-denominator metric formats as `N/0` and a `0.0%` pass rate, never
`NaN`.

The nine #59 metric semantics are described in full in §11.

## 7. CLI, Output, and Exit Behavior

```bash
pnpm --filter @opspilot/worker run eval
```

On a normal run, prints one `PASS`/`FAIL` line per case (with each failed
check's fixed reason indented beneath a `FAIL` line), one `~` line per
`NOT_APPLICABLE` metric outcome (so all nine metric outcomes are visible for
every case), then a summary and the metrics table above; exit code is `0`
only when every case passes, `1` otherwise.

Three distinct, never-conflated fatal-output categories exist, each with its
own fixed label and exit code `1`:

| Category | Output label | Cause | Cases executed |
|---|---|---|---|
| Dataset configuration failure | `Dataset configuration error: <fixed message>` | `validateEvaluationDataset` rejected the dataset | 0 |
| Evaluation setup failure | `Evaluation setup error: could not load the runbook corpus (<category>).` | `loadDefaultRunbookCorpus()` threw a `RunbookLoadError` | 0 |
| Unexpected failure | `Evaluation failed unexpectedly.` | any other thrown error, at any point in the entry-point path — including one from rendering itself, after cases may have already executed | not claimed either way |

`run-eval.ts`'s `resolveEvaluationRun` is the only function that catches
`runEvaluation`'s rejections, producing exactly one of `{ kind: "outcome" }`,
`{ kind: "setup-error", category }`, or `{ kind: "unexpected-error" }` — the
`category` on `setup-error` is `RunbookLoadErrorCategory`, a fixed enum
value, never the underlying error's own message. `renderEvaluationOutput`
wraps the pure `renderEvaluationResolution` renderer in its own final
try/catch, so a bug in rendering itself (e.g. in `formatEvaluationReport`)
also falls back to the "unexpected failure" message rather than throwing —
this is the genuinely top-level guard around the whole entry-point path;
`main()` never invokes itself as a bare, unguarded `void main()` promise.

**Output boundary, precisely.** The formatter and every fatal-output path
print only: case ids (validated as bounded slugs before any case executes,
per §5), the literal words `PASS`/`FAIL`, the `~` marker and fixed N/A
message for a `NOT_APPLICABLE` metric outcome, a fixed check name from the
closed set in §4/§6, one of a small number of fixed, application-authored
reason templates (e.g. `"The expected top-ranked chunk was not observed."`),
the three fixed category labels above, and a `RunbookLoadErrorCategory` enum
value. `EvaluationCheckResult.expected`/`.observed` are never read by the
formatter. This is a closed, enumerable set of fixed strings plus bounded
slugs and enum values — not a claim that "no string can ever reach output"
in the abstract, but a specific guarantee that no evaluator/dataset raw
identifier, chunk id, tool name, evidence id, or thrown error's own message
is ever interpolated into anything the CLI prints.

The exact layout is frozen by `fixtures/cli-report-golden.txt` (byte-identical
regeneration asserted by `cli-report-golden.test.ts`).

## 8. Safety and Isolation

The case-execution harness described in §1–§7 (corpus load through
`runEvaluationSuite`) makes no network call and reads no `.env` file — every
component it exercises is either already-deterministic production code or a
thin observer/wrapper around it (`docs/10-engineering-challenges.md` §4
documents the underlying evidence-grounding mechanism this harness
exercises). The runner constructs a fresh retriever, tool registry,
recorder, and provider for every case, sharing only the read-only loaded
corpus array; cases never leak state into one another regardless of run
order, and the runner never reorders the supplied case list. The provider is
always `FakeLlmProvider`; the recording provider decorator adds the
attempted-turn/usage observations without changing provider behavior, and a
thrown provider call is still counted as an attempted turn (§11.8).

This guarantee is about case execution, not scoring — §10 describes the
scorer boundary, where the default `SERVICE` mode does make one bounded HTTP
call per run to the configured evaluation service (never to a live
LLM/embedding provider).

## 9. Explicitly Deferred

- `RETRIEVAL_PARAMS_INVALID`, `RETRIEVAL_FAILED`, `RETRIEVAL_RESPONSE_INVALID`,
  and the "absent `RETRIEVAL_COMPLETED`" observation branch are not exercised
  — every case in this dataset uses a valid, in-bounds query/topK.
- `TOOL_OUTPUT_INVALID` is not exercised — `get_service_status`'s output is
  always schema-valid.
- This is a fixed, 20-case regression harness, not a statistical quality
  benchmark, an LLM-as-a-judge system, or a large-scale evaluation corpus.
- No live Claude or Voyage evaluation and no dashboard are part of this
  slice. Persistence is no longer deferred — see §10: the default `SERVICE`
  scorer persists every run through the Python/FastAPI evaluation service.
- Deliberately **not** used anywhere: wall-clock timing, monetary cost, or
  LLM-as-a-judge. Metric 8's "time/cost" dimension is proven by
  deterministic provider-call, tool-call, and recorded-token facts only,
  because the orchestrator owns no wall-clock deadline.
- The proof that the #59 metrics catch bad judgment lives in the negative
  evaluator vectors (§11.6), not in deliberately red dataset cases — the
  acceptance dataset is green by construction.

## 10. Scorer Selection and the Python Evaluation Service

`run-eval.ts` (§7) normalizes each case's expectations and observed facts
into `EvaluationSuiteInputV2` (see `apps/worker/src/evaluation/v2-types.ts`)
and hands the whole suite to exactly one `EvaluationScorer`. Scoring and
persistence are deliberately outside the case-execution harness in §1–§8 —
this section is the authoritative description of that boundary.

### 10.1 The active v2 boundary

```text
TypeScript (this harness, §1–§8)
  deterministic case setup, agent execution, observed-fact normalization
        ↓
EvaluationSuiteInputV2   (contractVersion = 2, datasetId = opspilot-deterministic-v2)
        ↓
DEFAULT: Python/FastAPI evaluation service (services/evaluation/)
  authoritative deterministic scoring + persistence
        ↓
persisted HTTP resource (EvaluationRunResultV2 — the POST/GET /evaluations
  body; the TS client's PersistedEvaluationRunV2, a superset of the scorer
  result that adds the persisted `id`)
        ↓
scorer result (EvaluationSuiteResultV2 — HttpEvaluationScorer.score()
  strips the persisted `id`; what the CLI consumes)
        ↓
existing CLI rendering (§7)

EXPLICIT PARITY ORACLE: EVALUATION_SCORER=local
        ↓
in-process TypeScript LocalEvaluationScorer (mirrors the Python scorer
function-for-function for explicit deterministic parity)

FROZEN OFFLINE HISTORICAL ORACLE: legacy-v1/
        ↓
v1 scorer reproduces historical v1 output byte-for-byte, unwired from runtime
```

**Contract version:** `contractVersion = 2` is the only live contract.
`POST /evaluations` accepts v2 only; a v1 body returns 422. The frozen v1
contract is **not** a runtime compatibility path — it survives solely as the
offline historical oracle (`legacy-v1/` in TS, `legacy_v1/` in Python),
scoring the untouched `fixtures/ts-parity-v1.json` and asserting byte-identical
historical output. Per the approved plan, v2 is an internal transitional
branch state and is not considered externally frozen until the #59 branch
merges.

**Default (as of Phase 4, extended by #59):** the Python/FastAPI evaluation
service is the default, authoritative scorer. `EVALUATION_SCORER` unset/empty
resolves to `service`, exactly like an explicit `EVALUATION_SCORER=service` —
including the same fail-closed requirement that `EVALUATION_SERVICE_URL` be an
absolute `http(s)` URL (see `apps/worker/src/evaluation/evaluation-scorer-config.ts`).

**Explicit local oracle:** `EVALUATION_SCORER=local` runs
`LocalEvaluationScorer` in-process — the v2 parity/regression oracle that
mirrors the Python scorer function-for-function for offline use. It is
explicit-only, never the default, and never falls back.

**No fallback:** neither mode ever falls back to the other. An unreachable,
timed-out, or malformed-response service under `service` mode fails the
evaluation (non-zero exit, a fixed `Evaluation scoring error:` category, zero
cases rendered as passing) — it never silently scores locally instead. See
`apps/worker/src/evaluation/service-unavailable.test.ts` and
`cross-service-parity.test.ts`.

### 10.2 Persistence and GET read-back compatibility

The Python service owns its own tables via SQLAlchemy/Alembic
(`services/evaluation/alembic/`), entirely separate from the Prisma-owned
schema at the repo root; Prisma does not read or migrate them. Dev/test
database separation (`opspilot_evaluation` / `opspilot_evaluation_test`) is
described in `services/evaluation/README.md`.

- `evaluation_checks.status` (`'PASS' | 'FAIL' | 'NOT_APPLICABLE'`) is the
  single persisted source of truth; the v1 `passed` boolean was dropped by
  migration `04098efaef34` (§10.3). Three-state persistence is enforced by
  the `ck_checks_status_domain` and `ck_checks_status_reason_code`
  constraints (a PASS check carries no `reason_code`; a FAIL/N/A check must).
- `POST /evaluations` persists the run, per-case results, three-state checks,
  and all fifteen metric rows in one transaction, and requires exactly nine
  #59 metric outcomes per case (§11.5). `evaluation_case_results.passed`
  (the case-level verdict) is a separate, genuinely distinct fact and stays.
- `GET /evaluations/{id}` serves persisted v2 runs. It retains **pre-B v2
  GET compatibility**: a v2 row persisted during Checkpoint A (all six
  original metric rows, none of the nine new rows) is served successfully,
  with the nine new ratios synthesized as `0/0` (zero-evaluated) — never
  inventing PASS/FAIL/N-A check rows and never mutating the stored row.
  Partial new-metric persistence (a subset of the nine) fails closed with the
  service's internal-data error policy rather than being silently defaulted
  one metric at a time. A `contract_version` other than 2 is refused with a
  stable `CONTRACT_VERSION_UNSUPPORTED` error instead of a blind cast.

### 10.3 The Alembic migration and its lossy downgrade

`services/evaluation/alembic/versions/04098efaef34_three_state_check_status.py`
migrates `evaluation_checks` from the v1 two-state boolean to the v2
three-state `status` domain. The **upgrade is non-lossy** for v1 data:
historical `passed` booleans map to `PASS`/`FAIL`, and `NOT_APPLICABLE` did
not exist in v1 rows. The **downgrade is intentionally lossy**: a v2
`NOT_APPLICABLE` check row has no v1 boolean counterpart, so it is **deleted**
when downgrading to the old binary representation, and every remaining
non-FAIL status maps back to `passed = TRUE`. This is documented in the
revision docstring as lossy rather than pretending to be a clean inverse.

**Ownership:**

```text
TypeScript:
- executes cases
- normalizes observations

Python (services/evaluation/):
- authoritative deterministic scoring
- persistence
```

**Local workflow** — see `services/evaluation/README.md` for the full setup;
smallest reliable flow, two terminals:

```sh
# terminal 1 — provision/migrate and run the service (dev DB, :8001)
cd services/evaluation
make migrate
make run

# terminal 2 — run the evaluation CLI (default: service scorer)
cd apps/worker
EVALUATION_SERVICE_URL=http://127.0.0.1:8001 pnpm run eval

# explicit local parity oracle, no service required
EVALUATION_SCORER=local pnpm run eval
```

## 11. The Nine Issue-#59 Metric Checks

This section is the authoritative statement of the nine #59 metric checks
implemented at Checkpoint B. Emission order is appended after the existing
groups: `status → retrieval → tool → report → failure → [the nine metric
checks, in the order below]`. The **report-payload metrics — 1, 2, 3, 5, and
6 — follow one shared ordering**: **(a)** report-dependency check → a failed
run gives `NA_RUN_DID_NOT_COMPLETE`; **(b)** applicability check → a missing
declaration gives `NA_EXPECTATION_NOT_DECLARED`; **(c)** otherwise PASS/FAIL.
The remaining four metrics do **not** follow that ordering:

- **Metric 4** `diagnosticJustification` — **no** report-dependency gate; it
  may score failed runs. Missing `expectedDiagnostics` →
  `NA_EXPECTATION_NOT_DECLARED`; otherwise PASS/FAIL.
- **Metric 7** `approvalGate` — **no** report-dependency N/A. Scores any
  terminal run — completed **or** failed — that declares `expectedApproval` (a
  failed run has no report, so its suggested-action count is deterministically
  0 and matches only `NOT_ELIGIBLE`). Missing `expectedApproval` →
  `NA_EXPECTATION_NOT_DECLARED`; otherwise PASS/FAIL.
- **Metric 8** `boundsRespected` — **always** applies, never N/A; always
  PASS/FAIL.
- **Metric 9** `deterministicRecovery` — a completed run →
  `NA_NO_RECOVERY_PATH_EXERCISED`; a failed run is PASS/FAIL because
  `expectedRecovery` is required by dataset validation for every failed case.

| # | Metric key | Check name | Applicability | PASS | FAIL (reason codes) |
|---|---|---|---|---|---|
| 1 | `rootCauseDiscipline` | `root-cause-discipline` | completed run **and** `expectedRootCause` declared | `rootCausePresent === (expectedRootCause === "PRESENT")` and (`!rootCausePresent` or `evidenceState === "SUFFICIENT"`) | `ROOT_CAUSE_PRESENCE_MISMATCH`, `ROOT_CAUSE_WITHOUT_SUFFICIENT_EVIDENCE` |
| 2 | `evidenceSupport` | `evidence-support` | completed run **and** `expectedEvidence` declared | all `requiredLocators` appear in `report.evidence` (matched by `(sourceType, evidenceId)`); `evidenceState === expectedEvidence.state`; if `requiresTelemetry`, ≥1 `TOOL_EXECUTION` locator; distinct count ≥ `minDistinctLocators ?? 0` | `EVIDENCE_REQUIRED_LOCATOR_MISSING`, `EVIDENCE_STATE_MISMATCH`, `EVIDENCE_TELEMETRY_MISSING`, `EVIDENCE_CARDINALITY_INSUFFICIENT` |
| 3 | `unknownHandling` | `unknown-telemetry-handling` | completed run **and** `expectedTelemetryEvidence.nonProbative.length > 0` (§11.3) | A. every declared non-probative locator observed as a completed tool call; B. the case-declared UNKNOWN response is honored (§11.3); C. no observed action with non-empty `groundedBy` is grounded solely on declared non-probative locators | `TELEMETRY_CLASSIFICATION_NOT_OBSERVED`, `UNKNOWN_TELEMETRY_TREATED_AS_ANSWER`, `UNKNOWN_TELEMETRY_GROUNDS_ACTION` |
| 4 | `diagnosticJustification` | `diagnostic-justification` | `expectedDiagnostics` declared (no report dependency — failed runs may declare it) | observed `(evidenceState, continuationReason)` sequence equals declared, in order; `diagnosticRequestCount === declared.length`; when `expectedStopReason === "NO_JUSTIFIED_DIAGNOSTIC"`, `diagnosticRequestCount < bounds.maxDiagnosticToolCalls`; observed `stopReason === expectedStopReason` when declared | `DIAGNOSTIC_SEQUENCE_MISMATCH`, `DIAGNOSTIC_COUNT_MISMATCH`, `DIAGNOSTIC_STOP_NOT_VOLUNTARY`, `STOP_REASON_MISMATCH` |
| 5 | `confidenceCalibration` | `confidence-calibration` | completed run **and** `expectedConfidence` declared | `min <= confidence <= max` (inclusive) | `CONFIDENCE_OUT_OF_BAND` |
| 6 | `actionGrounding` | `action-grounding` | completed run **and** `expectedActions` declared | observed action types equal the expected multiset; per matched action: `requiredGrounding ⊆ groundedBy`, `groundedBy ⊆ allowedGrounding`, no duplicate locator | `ACTION_TYPE_SET_MISMATCH`, `ACTION_REQUIRED_GROUNDING_MISSING`, `ACTION_GROUNDING_NOT_ALLOWED`, `ACTION_GROUNDING_DUPLICATED` |
| 7 | `approvalGate` | `approval-gate` | `expectedApproval` declared on a terminal run — completed or failed | `(runStatus === "completed" && suggestedActions.length >= 1) === (expectedApproval === "ELIGIBLE")` — a failed run has no report, so `suggestedActionCount` is deterministically 0 and matches only `NOT_ELIGIBLE` | `APPROVAL_ELIGIBILITY_MISMATCH` |
| 8 | `boundsRespected` | `bounds-respected` | **always** — never N/A | `providerTurnsUsed <= bounds.maxProviderTurns`; `diagnosticRequestCount <= bounds.maxDiagnosticToolCalls`; when `expectedBounds.maxTotalTokens` declared, `inputTokens + outputTokens <= maxTotalTokens` | `TURN_BOUND_EXCEEDED`, `TOOL_BOUND_EXCEEDED`, `TOKEN_BUDGET_EXCEEDED` |
| 9 | `deterministicRecovery` | `deterministic-recovery` | failed run (validation guarantees `expectedRecovery` exists); completed run → `NA_NO_RECOVERY_PATH_EXERCISED` | `failedStage === expectedRecovery.failedStage`; none of `forbiddenCompletedToolCallIds` in `tools.completed`; `report === null` iff `reportProduced === false` | `RECOVERY_STAGE_MISMATCH`, `RECOVERY_SIDE_EFFECT_OBSERVED`, `RECOVERY_REPORT_PRESENCE_MISMATCH` |

### 11.1 Final semantics that must be preserved

- **Evidence support (metric 2)** uses case-declared required locators only.
  There is no general natural-language entailment over `rootCause` prose:
  #59 deterministically checks that the case-declared evidence needed to
  support the expected conclusion is present and that the evidence-state
  judgment matches. No report prose crosses the evaluation boundary; no LLM
  judge is introduced.
- **UNKNOWN handling (metric 3)** is case-declared and does **not** globally
  privilege `TOOL_EXECUTION` over `RAG_CHUNK`. It carries no global "a
  `TOOL_EXECUTION` is the only positive support" rule.
- **Action grounding (metric 6)** is case-declared via non-empty
  `requiredGrounding` + `allowedGrounding`. No source type — `RAG_CHUNK`
  included — is globally probative; an action grounded only on UNKNOWN
  telemetry fails `ACTION_REQUIRED_GROUNDING_MISSING`.
- **Approval eligibility (metric 7)** mirrors production and is proven
  against reachable repository lifecycle states (§11.7).
- **Confidence (metric 5)** uses per-case inclusive bands, no global
  threshold and no cross-case ordering rule.
- **Bounds (metric 8)** use deterministic turn/tool/token observations, not
  wall-clock or monetary estimates. The attempted-turn semantics from
  Checkpoint A are authoritative: a thrown provider call still counts as a
  turn.
- **Deterministic recovery (metric 9)** means fail-closed/predictable
  failure behavior, not retry/repair. Production has no retry or repair path
  (`agent-orchestrator.ts:612` swallows the tool error and fails terminally),
  so "recovery" can only mean "failed cleanly and predictably."

### 11.2 `expectedTelemetryEvidence` serves two separable purposes

Its `probative` list feeds metric 6's grounding rule and is useful on every
case with tool evidence; its `nonProbative` list is what makes metric 3
applicable. A case with clean, probative telemetry (`healthy-service-no-fault`,
`multi-step-degradation-escalation`, `conflicting-signals-unresolved`)
declares `nonProbative: []` and correctly reports metric 3 as N/A — it
contains no UNKNOWN handling to evaluate, so a PASS there would be a false
claim.

### 11.3 Metric 3 — case-declared, not a global source-type policy

Metric 3 is PASS/FAIL **only** when the case explicitly declares
non-probative telemetry to evaluate (`expectedTelemetryEvidence.nonProbative.length > 0`);
otherwise it is `NOT_APPLICABLE / NA_EXPECTATION_NOT_DECLARED`. When
applicable, it (A) verifies the declared non-probative locators were observed
as completed tool calls, (B) cross-checks only what the case itself declares —
`evidenceState` against `expectedEvidence.state`, root-cause presence against
`expectedRootCause` — deliberately overlapping metrics 1/2 (the negative-vector
fixture asserts the exact multi-metric failure sets), and (C) fails an action
**only** when the action's `groundedBy` is non-empty and *every* locator in it
is declared non-probative. An action that also cites case-declared required
grounding does not fail metric 3; metric 6's non-empty `requiredGrounding` is
the authoritative, case-declared semantic action-grounding check. No unlisted
or `RAG_CHUNK` locator is globally classified as probative.

### 11.4 Metric 4 — "allowed ≠ justified"

`diagnosticRequestCount < maxDiagnosticToolCalls` fires only for runs claiming
`NO_JUSTIFIED_DIAGNOSTIC`. A run that stops at the bound is `BOUND_EXHAUSTED`
and is scored on sequence/count/stop-reason only. `bound-exhausted-finalization`
is the dedicated **successful** forced-finalization / `BOUND_EXHAUSTED`
acceptance case: it reaches the provider/tool limits exactly (4 of 4 provider
turns, 3 of 3 diagnostic tool calls) and still produces the expected terminal
report. `missing-final-report` reaches the same provider/tool limits at the
same exact bound but fails report completion — it requests a tool on the
required-report turn and is forced-finalized with no report — so the failed
side of the exact-bound state is exercised there instead.

### 11.5 Completeness and fail-closed rules

- A current `POST /evaluations` response must contain **exactly nine** #59
  metric outcomes per case — zero, eight, a duplicate, an unexpected
  replacement, or out-of-fixed-order all fail closed (`MALFORMED_RESPONSE`).
- A missing/duplicated/out-of-order current metric outcome is a scorer or
  client-compatibility bug, never equivalent to N/A.
- `expectedStopReason` requires `expectedDiagnostics`; the orphaned shape is
  a dataset-authoring error, never silently N/A.
- Count/token/cardinality fields are strict non-negative integers in both
  languages (no bool/float/string/non-finite coercion).
- Confidence bounds are strict finite numeric values in `[0,1]`, accepting
  valid integer/fractional numbers but rejecting bool/string/non-finite
  coercion.

### 11.6 Negative evaluator vectors

The 20-case acceptance dataset is green by construction. Proof that the
metrics reject bad shapes lives in a dedicated, shared negative-vector
fixture — `apps/worker/src/evaluation/fixtures/negative-vectors-v2.json` — a
list of synthetic `{ id, expectations, observed, expectedFailures }` scorer
inputs. They need not be producible by the orchestrator; they are scorer
inputs. Both consumers
(`apps/worker/src/evaluation/negative-vectors.test.ts` and
`services/evaluation/tests/test_negative_vectors.py`, reading the same
TS-owned fixture by path) assert: every `(checkName, reasonCode)` in
`expectedFailures` is present with `status: "FAIL"`; no **unexpected** #59
metric failure appears (the observed failure subset equals the declared one
exactly); and cross-language results agree. Every retained new #59 FAIL
reason code is exercised by at least one vector (25 vectors), including the
two co-firing shapes the acceptance dataset deliberately no longer carries:
`UNKNOWN_TELEMETRY_TREATED_AS_ANSWER` + `EVIDENCE_STATE_MISMATCH` +
`ROOT_CAUSE_PRESENCE_MISMATCH` (the corrected case 4's old shape), and
`UNKNOWN_TELEMETRY_GROUNDS_ACTION` + `ACTION_REQUIRED_GROUNDING_MISSING` (a
bad action grounded only on UNKNOWN telemetry).

### 11.7 Approval parity — reachable repository states only

Metric 7 is the evaluator-side **mirror** of production eligibility
(`packages/database/src/repositories/agent-run-approval-repository.ts`
computes `eligible = status === "COMPLETED" && suggestedActionCount >= 1`
inside a real SQL transaction). The parity proof executes the real repository
behavior against PostgreSQL via a shared vector fixture
(`packages/database/src/test/approval-eligibility-vectors.json`), covering
**reachable production lifecycle shapes only**:

```text
RUNNING   + 0 actions  → NOT_ELIGIBLE  → evaluationObservable: false
COMPLETED + 0 actions  → NOT_ELIGIBLE  → evaluationObservable: true
COMPLETED + ≥1 action  → ELIGIBLE      → evaluationObservable: true
FAILED    + 0 actions  → NOT_ELIGIBLE  → evaluationObservable: true
```

Impossible shapes (`FAILED + ≥1 action`, `RUNNING + ≥1 action`) are not
claimed as repository parity — a FAILED run is never given a finalized
report, and an in-flight RUNNING row is never given a finalized report.
Evaluator-side parity (`approval-parity.test.ts`) covers the shared fixture's
**terminal, evaluator-observable** vectors only — `COMPLETED + 0`,
`COMPLETED + ≥1`, and `FAILED + 0` — feeding each through the `approval-gate`
rule as normalized terminal facts; the `RUNNING` row is repository-only and
deliberately not evaluable offline. No exhaustive `3 × 2` truth table of the
pure boolean mirror exists or is claimed: the evaluator mirror is proven
against exactly the reachable matrix, no more. The repository integration
test
(`packages/database/src/repositories/agent-run-approval-repository.integration.test.ts`)
seeds each reachable vector through the real lifecycle helpers and asserts
`view.status !== "NOT_ELIGIBLE"` ⟺ `vector.expectedEligible`; the evaluator
mirror (`apps/worker/src/evaluation/approval-parity.test.ts`) feeds the
equivalent normalized terminal facts (never RUNNING) through the
`approval-gate` rule.

### 11.8 Determinism

- The provider is always `FakeLlmProvider`; there is no LIVE/paid-provider
  dependency anywhere in the suite.
- The CLI executes each case exactly once; repeatability is proven by a
  dedicated suite self-check (`evaluation-determinism.test.ts`, which runs
  `runEvaluationSuite` twice and asserts deep-equal `EvaluationCaseInputV2[]`)
  and by byte-identity assertions over the regenerated fixtures.
- The frozen v2 parity fixture (`ts-parity-v2.json`) regenerates byte-identically;
  the frozen v1 historical fixture (`ts-parity-v1.json`) is never regenerated.
- Routine evaluation runs are fully offline.

## 12. Failure Classification and Ratchet Adjudication (Issue #59)

The plan's Harness-ratchet policy classifies every evaluation failure that
genuinely arises during implementation/verification into exactly one of three
buckets:

| Bucket | Definition | Disposition |
|---|---|---|
| **Fixture / evaluator bug** | The scripted scenario, declared expectation, authored fake report, or the evaluator itself is wrong; production behaved correctly. An authored `FakeLlmProvider` report is authored input, so it can never be evidence about model judgment. | Fix inside the evaluation system. Not a Harness change. |
| **Captured model-quality issue** | A **real model execution** produced a poor judgment inside the space the Harness legitimately permits. Requires actual model evidence — not a fixture. | Record as an evaluation finding. Do not patch a prompt as the resolution of a failing evaluation. |
| **Systemic Harness invariant gap** | The Harness permits an output that a **written deterministic product invariant** says must be impossible, and a Harness-appropriate invariant can reject it. | Ratchet: add or tighten a deterministic invariant in `packages/contracts` / the orchestrator, in a separate HQ-approved commit. |

### 12.1 Genuine findings from Checkpoints A/B

The following findings were actually discovered during Checkpoint A/B
implementation and independent review. All are classified in bucket 1 —
defects in the evaluation system, its compatibility layer, or its test
contract — none came from a real model execution, and none demonstrated a
production agent Harness invariant gap.

| Finding | When | Classification | Why bucket 1 |
|---|---|---|---|
| Provider-attempt observation undercount on a thrown provider call | A | Evaluator observation-layer bug | The recording provider recorded a turn only after a successful delegate, so `providerTurnsUsed`/`providerCalls` undercounted by 1 on a thrown provider call. Fixed inside the evaluation observation plumbing (attempt recorded before delegating). Not a model or production-Harness issue. |
| Pre-B v2 GET compatibility regression | B | Persistence/read-model compatibility bug | Checkpoint B expanded active v2 to fifteen metrics, so reading a valid pre-B v2 row (six originals only) failed. Fixed by the all-or-none compatibility rule (§10.2). Not a production-Harness issue. |
| Frozen v1 schema leakage from active metrics | B | Legacy-oracle isolation/test bug | The v1 oracle structurally re-emitted the nine new #59 metric fields from an active schema. Fixed by isolating a genuinely frozen six-metric v1 structure in `legacy_v1/`. Not a production-Harness issue. |
| POST exactly-nine completeness hole | B | Active v2 client fail-closed/completeness bug | A POST response could omit #59 metric outcomes and still be accepted. Fixed by the exactly-nine invariant in the scorer, the client parser, and tests (§11.5). Not a production-Harness issue. |
| TS/Python count-token numeric-domain mismatch | B | Cross-language contract-validation bug | Count/token/cardinality fields had incompatible numeric domains across TS and Python. Fixed by strict non-negative-integer validation in both languages. Not a production-Harness issue. |
| Orphaned `expectedStopReason` silently becoming N/A | B | Dataset-authoring / metric-applicability invariant bug | `expectedStopReason` could be declared without `expectedDiagnostics` and be silently skipped. Fixed by the validation rule `expectedStopReason requires expectedDiagnostics`. Not a production-Harness issue. |
| Confidence-bound coercion of malformed values | B | Cross-language input-validation bug | `expectedConfidence` bounds could coerce booleans/strings/non-finite values instead of rejecting them. Fixed by strict finite `[0,1]` numeric validation in both languages. Not a production-Harness issue. |

In addition, the authored fake-fixture corrections from planning and
implementation are recorded as **fixture bugs**, not model failures:
`database-connection-saturation`'s untruthful authored report (`SUFFICIENT`
+ definitive `rootCause` on `UNKNOWN` telemetry) was corrected to its
truthful shape (bucket 1), and `authentication-failure`'s weaker judgment
shape was handled as a fixture/scope decision (the dedicated
`conflicting-signals-unresolved` case owns the conflict class; the old shape
is pinned as a negative vector rather than carried as a red case). Both are
authored fixture content, never captured model behavior.

### 12.2 Ratchet adjudication

Applying the approved three-condition ratchet gate to the above findings:

```text
1. a written invariant exists?
2. the proposed fix is Harness-shaped (validates structure, grounding, or
   run-state consistency)?
3. it rejects the bad shape while preserving all valid cases?
```

**No finding clears the gate.** Every finding above was a defect in the
evaluation system, its compatibility layer, or its test contract — none
demonstrated a production agent Harness invariant gap, and none came from a
real model execution. Consequently:

```text
NO systemic production Harness ratchet is warranted.
```

No ratchet was manufactured to satisfy the issue, and no entry was added to
`docs/10-engineering-challenges.md` merely to create one. No change to
`packages/contracts/**` or production orchestration was made. If a genuine
systemic gap is discovered by future review, it will be adjudicated through
the same gate before any `packages/contracts` change is proposed.
