# OpsPilot — Deterministic Evaluation Harness — Design

| Field | Value |
|---|---|
| Document | Deterministic Evaluation Harness |
| Version | 1.0 |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Describe the fully offline, deterministic evaluation harness that regression-tests the RAG + agent vertical slice: the fixed 15-case dataset, the stage-aware evaluator, the aggregate metrics, and the CLI report |
| Related Documents | `docs/04-agent-design.md`, `docs/05-rag-design.md` §10, `docs/10-engineering-challenges.md` §4 (Challenge 2), `services/evaluation/README.md` (Python evaluation service, §10 below) |

---

## 1. Scope

`docs/05-rag-design.md` §10 named a gap: "a retrieval evaluation dataset —
a fixed set of queries with known expected top-ranked chunks, run
repeatedly to detect retrieval-quality regressions — is not yet built."
This harness closes that gap, and extends it to the whole pipeline: it
proves retrieval correctness, tool correctness (requested / executed /
completed), run-status and failure-code correctness, report schema
validity, and evidence-grounding correctness (including rejection of
fabricated evidence) — in one repeatable, offline command.

It reuses every existing production component exactly as-is:
the file-backed Markdown runbook corpus, `InMemoryKeywordRunbookRetriever`,
`FakeLlmProvider`, `InMemoryToolRegistry`, `getServiceStatusTool`, and
`runAgentOrchestrator`. It adds no new orchestrator behavior, no new
production tool, no live provider, and no persistence.

Out of scope: live-provider evaluation, LLM-as-a-judge/semantic grading,
statistical benchmarking, and a large corpus. See §9.

## 2. Architecture

```
runbooks/*.md (7 chunks, 5 files)
  → loadDefaultRunbookCorpus()                 [existing, called once]
  → InMemoryKeywordRunbookRetriever(corpus)     [existing, fresh per case]
  → FakeLlmProvider(scenario)                   [existing, fresh per case]
  → recording-wrapped InMemoryToolRegistry       [existing tools + a thin recorder]
  → runAgentOrchestrator({...})                  [existing, unmodified]
  → evaluation-evaluator (stage-aware checks vs. declared expectations)
  → evaluation-metrics (aggregate, scoped denominators)
  → evaluation-formatter (terminal report)
  → run-eval.ts (CLI composition root, exit code)
```

Modules, under `apps/worker/src/evaluation/`:

| File | Responsibility |
|---|---|
| `types.ts` | `EvaluationCase`, `EvaluationExpectations`, `CorpusProfile`, `ToolProfile`, `EvaluationCaseResult`, `EvaluationCheckResult`, `EvaluationMetrics`, and the harness-wide constant `EVALUATION_TOP_K = 3`. |
| `fixtures/always-fails-tool.ts` | `alwaysFailsTool` — an evaluation-only `DiagnosticToolDefinition` whose `execute()` always throws. Never registered in production/demo/live-spike wiring. |
| `cases/topic-runbook-cases.ts` | Cases 1–6: per-topic retrieval + tool + report, plus the irrelevant-query case. |
| `cases/evidence-grounding-cases.ts` | Cases 7, 8, 15: fabricated RAG evidence, fabricated tool evidence, and the injection-probe case. |
| `cases/protocol-and-failure-cases.ts` | Cases 9–14: unknown tool, invalid input, protocol error, missing final report, tool execution failure, malformed report. |
| `evaluation-dataset.ts` | Assembles the 15 cases into `EVALUATION_CASES`, in the fixed approved order. |
| `dataset-validation.ts` | `validateEvaluationDataset(...)` — every structural rule in §5, including bounded case-id slug validation, using only fixed messages; also exports `resolveCorpus`, shared with the runner. |
| `recording-tool-registry.ts` | `createRecordingToolRegistry(...)` — wraps each tool's `execute()` to record `{toolName, input}` before delegating, without altering lookup/execute behavior. |
| `evaluation-evaluator.ts` | Pure, stage-aware check functions (`evaluateRetrieval`, `evaluateTool`, `evaluateReport`, `evaluateFailure`, `evaluateStatus`) plus `evaluateCase`, which combines them into an `EvaluationCaseResult`. Every failing check's `reason` is one of a small, fixed set of templates — never an interpolated raw identifier. |
| `evaluation-runner.ts` | `runEvaluationSuite(...)` — for each case, constructs every collaborator fresh and calls `runAgentOrchestrator`, in supplied order. |
| `evaluation-metrics.ts` | `aggregateMetrics(...)` — aggregates the evaluator's named checks; never re-derives looser logic. |
| `evaluation-formatter.ts` | `formatEvaluationReport(...)` — sanitized terminal report; never reads `EvaluationCheckResult.expected`/`.observed`. |
| `run-eval.ts` | CLI composition root: `runEvaluation` (load corpus, validate, run), `resolveEvaluationRun` (the sole catch boundary, producing one of three fatal-resolution kinds), `renderEvaluationOutput` (the final top-level rendering guard), `main()`. See §7. |

## 3. Case Inventory (15 cases, fixed order)

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
schema-invalid report body.

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
overlap; and that `corpusProfile`/`toolProfile` are valid literals. All 15
approved case ids satisfy the slug pattern.

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

`expectedNoResults` is never counted toward `retrievalHitAt3`. A
zero-denominator metric formats as `N/0` and a `0.0%` pass rate, never
`NaN`.

## 7. CLI, Output, and Exit Behavior

```bash
pnpm --filter @opspilot/worker run eval
```

On a normal run, prints one `PASS`/`FAIL` line per case (with each failed
check's fixed reason indented beneath a `FAIL` line), then a summary and the
metrics table above; exit code is `0` only when every case passes, `1`
otherwise.

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
per §5), the literal words `PASS`/`FAIL`, a fixed check name from the closed
set in §4/§6, one of a small number of fixed, application-authored reason
templates (e.g. `"The expected top-ranked chunk was not observed."`), the
three fixed category labels above, and a `RunbookLoadErrorCategory` enum
value. `EvaluationCheckResult.expected`/`.observed` are never read by the
formatter. This is a closed, enumerable set of fixed strings plus bounded
slugs and enum values — not a claim that "no string can ever reach output"
in the abstract, but a specific guarantee that no evaluator/dataset raw
identifier, chunk id, tool name, evidence id, or thrown error's own message
is ever interpolated into anything the CLI prints.

## 8. Safety and Isolation

The case-execution harness described in §1–§7 (corpus load through
`runEvaluationSuite`) makes no network call and reads no `.env` file — every
component it exercises is either already-deterministic production code or a
thin observer/wrapper around it (`docs/10-engineering-challenges.md` §4
documents the underlying evidence-grounding mechanism this harness
exercises). The runner constructs a fresh retriever, tool registry,
recorder, and provider for every case, sharing only the read-only loaded
corpus array; cases never leak state into one another regardless of run
order, and the runner never reorders the supplied case list.

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
- This is a fixed, ~15-case regression harness, not a statistical quality
  benchmark, an LLM-as-a-judge system, or a large-scale evaluation corpus.
- No live Claude or Voyage evaluation and no dashboard are part of this
  slice. Persistence is no longer deferred — see §10: the default `SERVICE`
  scorer persists every run through the Python/FastAPI evaluation service.

## 10. Scorer Selection and the Python Evaluation Service (OpsPilot #61, Phases 1–4)

`run-eval.ts` (§7) normalizes each case's expectations and observed facts
into `EvaluationSuiteInputV1` (see `apps/worker/src/evaluation/v1-types.ts`)
and hands the whole suite to exactly one `EvaluationScorer`. Scoring and
persistence are deliberately outside the case-execution harness in §1–§8 —
this section is the authoritative description of that boundary and its
Phase 4 default cutover.

```text
TypeScript (this harness, §1–§8)
  deterministic case setup, agent execution, observed-fact normalization
        ↓
EvaluationSuiteInputV1
        ↓
DEFAULT: Python/FastAPI evaluation service (services/evaluation/)
  deterministic scoring + persistence
        ↓
validated persisted resource
        ↓
existing CLI rendering (§7)

EXPLICIT MIGRATION ORACLE: EVALUATION_SCORER=local
        ↓
frozen TypeScript v1 scorer (LocalEvaluationScorer)
```

**Default (as of Phase 4):** the Python/FastAPI evaluation service is the
default, authoritative scorer. `EVALUATION_SCORER` unset/empty resolves to
`service`, exactly like an explicit `EVALUATION_SCORER=service` — including
the same fail-closed requirement that `EVALUATION_SERVICE_URL` be an
absolute `http(s)` URL (see `apps/worker/src/evaluation/evaluation-scorer-config.ts`).

**Explicit local oracle:** `EVALUATION_SCORER=local` runs
`LocalEvaluationScorer` in-process — the frozen v1 migration/parity/
regression oracle. It is explicit-only, never the default, and is not
deleted by #61; when the evaluation contract advances beyond v1 it must be
explicitly revisited/removed/upgraded rather than silently continuing to
stand in as a second authoritative scorer.

**No fallback:** neither mode ever falls back to the other. An unreachable,
timed-out, or malformed-response service under `service` mode fails the
evaluation (non-zero exit, a fixed `Evaluation scoring error:` category, zero
cases rendered as passing) — it never silently scores locally instead. See
`apps/worker/src/evaluation/service-unavailable.test.ts` and
`cross-service-parity.test.ts`.

**Ownership:**

```text
TypeScript:
- executes cases
- normalizes observations

Python (services/evaluation/):
- authoritative deterministic scoring
- persistence
```

The Python service owns its own tables via SQLAlchemy/Alembic
(`services/evaluation/alembic/`), entirely separate from the Prisma-owned
schema at the repo root; Prisma does not read or migrate them. Dev/test
database separation (`opspilot_evaluation` / `opspilot_evaluation_test`) is
described in `services/evaluation/README.md`.

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

# explicit frozen v1 oracle, no service required
EVALUATION_SCORER=local pnpm run eval
```
