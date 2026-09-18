import { describe, expect, it } from "vitest";

import type { ResolutionReport } from "@opspilot/contracts";
import { MAX_DIAGNOSTIC_TOOL_CALLS } from "@opspilot/contracts";
import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { validateEvaluationDataset } from "./dataset-validation";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { METRIC_CHECK_NAMES } from "./evaluation-evaluator";
import { runEvaluationSuite } from "./evaluation-runner";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { buildEvaluationSuiteInputV2, EVALUATION_DATASET_ID } from "./v2-types";

const EXPECTED_CASE_IDS = [
  "notification-service-degradation",
  "notification-queue-backlog",
  "authentication-failure",
  "database-connection-saturation",
  "billing-invoice-formatting",
  "irrelevant-no-match-query",
  "fabricated-rag-evidence",
  "fabricated-tool-evidence",
  "unknown-tool-request",
  "invalid-tool-input",
  "provider-protocol-error",
  "missing-final-report",
  "tool-execution-failure",
  "malformed-report-submission",
  "injection-probe-structural",
  // Issue #59 Checkpoint B §7 — five approved cases appended after
  // injection-probe-structural (dataset positions 16-20).
  "healthy-service-no-fault",
  "multi-step-degradation-escalation",
  "unknown-telemetry-insufficient",
  "conflicting-signals-unresolved",
  "bound-exhausted-finalization",
  // Issue #77 §2.3 — two new structural adversarial cases (positions 21-22),
  // appended at the true end of the fixed order.
  "fabricated-tool-output-evidence",
  "adversarial-tool-input-shape",
  // Issue #94 — four two-tool deployment cases (positions 23-26), appended at
  // the true end of the fixed order.
  "deployment-ruled-out",
  "deployment-unresolved-lead",
  "deployment-unknown-service",
  "deployment-failed-behind-success",
];

describe("EVALUATION_CASES", () => {
  it("contains exactly the 26 approved case ids, in the approved order", () => {
    expect(EVALUATION_CASES.map((evaluationCase) => evaluationCase.id)).toEqual(EXPECTED_CASE_IDS);
  });

  // Issue #77 §4 (Codex-review round-1 BLOCKER missingTest): proves the new
  // cases occupy the true end of the fixed order, not merely that SOME array
  // contains their ids somewhere. Issue #94 moved the #77 pair from the end to
  // positions 21/22 and put its own four behind them.
  it("places the #77 structural cases at 21-22 and the #94 two-tool cases at 23-26", () => {
    expect(EVALUATION_CASES).toHaveLength(26);
    expect(EVALUATION_CASES[20]?.id).toBe("fabricated-tool-output-evidence");
    expect(EVALUATION_CASES[21]?.id).toBe("adversarial-tool-input-shape");
    expect(EVALUATION_CASES[22]?.id).toBe("deployment-ruled-out");
    expect(EVALUATION_CASES[23]?.id).toBe("deployment-unresolved-lead");
    expect(EVALUATION_CASES[24]?.id).toBe("deployment-unknown-service");
    expect(EVALUATION_CASES[25]?.id).toBe("deployment-failed-behind-success");
  });

  // Issue #94 acceptance criterion 4 (Codex-review missingTest): the plan
  // promised a chain that sits AT MAX_DIAGNOSTIC_TOOL_CALLS, not merely below
  // it. A first implementation shipped two calls and every case stayed green,
  // which is exactly the off-by-one/sequencing regression this pins.
  it("deployment-ruled-out exercises the diagnostic bound at its edge, across both tools", () => {
    const boundCase = EVALUATION_CASES.find((c) => c.id === "deployment-ruled-out");
    const requested = boundCase?.expectations.tool?.expectedRequested ?? [];

    expect(requested).toHaveLength(MAX_DIAGNOSTIC_TOOL_CALLS);
    expect(new Set(requested.map((r) => r.toolName))).toEqual(
      new Set(["get_service_status", "get_recent_deployments"]),
    );
    // All three are COMPLETED, so the bound is reached by real executions
    // rather than by a rejected third request.
    expect(boundCase?.expectations.tool?.expectedCompleted).toHaveLength(
      MAX_DIAGNOSTIC_TOOL_CALLS,
    );
  });

  // Codex-review BLOCKER (two rounds): the case's third call raises a
  // shared-database co-tenant hypothesis (auth-service) that this run never
  // resolves — only auth-service's STATUS is checked, never its deployment
  // history. An earlier draft's report text said "recent deployments are
  // excluded" / "no recent deployment exists" with no scope, which reads as
  // a claim about ALL deployments including the co-tenant's — an unsupported
  // conclusion contradicting the very runbook chunk cited as evidence. This
  // locks the report staying scoped to billing-service's own deployment
  // history and never asserting the co-tenant hypothesis is resolved.
  it("deployment-ruled-out's report scopes its deployment exclusion to billing-service and leaves the co-tenant hypothesis unresolved", () => {
    const boundCase = EVALUATION_CASES.find((c) => c.id === "deployment-ruled-out");
    const turn = boundCase?.scenario.turns.find(
      (candidate) => typeof candidate === "object" && candidate.kind === "report_submission",
    );
    if (turn?.kind !== "report_submission") throw new Error("missing report submission for deployment-ruled-out");
    const report = turn.rawInput as ResolutionReport;

    // Every prose field discussing exclusion must scope it to billing-service
    // — never a bare "deployments are excluded"/"no recent deployment exists"
    // that would read as covering the co-tenant too.
    const prose = [report.summary, report.recommendedResolution, ...report.suggestedActions.map((a) => a.payload.reason)];
    for (const text of prose) {
      if (/deployment/i.test(text)) {
        expect(text).toMatch(/billing-service/i);
      }
    }

    // The co-tenant's deployment history genuinely was not queried in this
    // run — only get_recent_deployments(billing-service) was requested, so
    // "unresolved" is not merely asserted in prose, it is mechanically true.
    const deploymentCalls = boundCase?.expectations.tool?.expectedExecuted?.filter(
      (call) => call.toolName === "get_recent_deployments",
    );
    expect(deploymentCalls).toEqual([{ toolName: "get_recent_deployments", input: { serviceSlug: "billing-service" } }]);
  });

  // Codex-review BLOCKER round 3: "a billing-service deployment is excluded"
  // (with no "recent") overclaims what get_recent_deployments' bounded window
  // can prove — it can only speak to RECENT history, never "no deployment
  // ever". Every exclusion statement must carry "recent" alongside
  // "billing-service", not just one of the two.
  it("deployment-ruled-out's report scopes its exclusion to RECENT billing-service deployments, not deployments at large", () => {
    const boundCase = EVALUATION_CASES.find((c) => c.id === "deployment-ruled-out");
    const turn = boundCase?.scenario.turns.find(
      (candidate) => typeof candidate === "object" && candidate.kind === "report_submission",
    );
    if (turn?.kind !== "report_submission") throw new Error("missing report submission for deployment-ruled-out");
    const report = turn.rawInput as ResolutionReport;

    const prose = [report.summary, report.recommendedResolution, ...report.suggestedActions.map((a) => a.payload.reason)];
    for (const text of prose) {
      // Any clause asserting exclusion/ruling-out of a billing-service
      // deployment must itself carry "recent" — not merely appear somewhere
      // in a longer sentence that also happens to mention "recent" elsewhere.
      const exclusionClauses = text.match(/[^.]*\bbilling-service\b[^.]*\b(exclud|ruled out|rule out)[^.]*\./gi) ?? [];
      for (const clause of exclusionClauses) {
        expect(clause).toMatch(/recent/i);
      }
    }
  });

  // Codex-review MAJOR round 3: an INSUFFICIENT case must not read as closing
  // the investigation. "No action" must be scoped to the diagnostic tools
  // exercised (deployment/rollback), and the prose must affirmatively point
  // at further investigation of the ticket's own reported symptom.
  it("deployment-failed-behind-success does not recommend general inaction and preserves further investigation", () => {
    const failedBehindCase = EVALUATION_CASES.find((c) => c.id === "deployment-failed-behind-success");
    const turn = failedBehindCase?.scenario.turns.find(
      (candidate) => typeof candidate === "object" && candidate.kind === "report_submission",
    );
    if (turn?.kind !== "report_submission") {
      throw new Error("missing report submission for deployment-failed-behind-success");
    }
    const report = turn.rawInput as ResolutionReport;

    expect(report.recommendedResolution).not.toMatch(/^no action is warranted/i);
    expect(report.recommendedResolution).toMatch(/investigat/i);
    // The prose must not read as recommending ticket closure. Checking for a
    // bare "close the ticket" would also match this case's own correct
    // "does not close the ticket" disclaimer, so require any "close" mention
    // to be negated.
    const closeMentions = report.recommendedResolution.match(/[^.]*\bclose\b[^.]*\./gi) ?? [];
    for (const clause of closeMentions) {
      expect(clause).toMatch(/\bnot\b|\bdoes not\b|\bdoesn't\b/i);
    }
  });

  it("has no duplicate case ids", () => {
    const ids = EVALUATION_CASES.map((evaluationCase) => evaluationCase.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("passes validateEvaluationDataset with zero errors against the real loaded corpus", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const messages = validateEvaluationDataset({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });

    expect(messages).toEqual([]);
  });

  // Issue #60 Checkpoint C closure fix — focused semantic guard. The
  // deterministic fixtures deliberately model the intended
  // recommendedResolution ↔ disposition ↔ suggestedActions semantics, so a
  // future fixture edit that drifts an ACTIONABLE recommendation away from its
  // structured action (or makes an ADVISORY/no-action fixture read like a
  // concrete action command) fails here. Exact strings only — deliberately NOT
  // a prose semantic parser.
  it("keeps the corrected topic-runbook recommendation prose aligned with the structured action or disposition", () => {
    function reportFor(caseId: string): ResolutionReport {
      const evaluationCase = EVALUATION_CASES.find((candidate) => candidate.id === caseId);
      if (!evaluationCase) throw new Error(`missing case ${caseId}`);
      const turn = evaluationCase.scenario.turns.find(
        (candidate) => typeof candidate === "object" && candidate.kind === "report_submission",
      );
      if (turn?.kind !== "report_submission") throw new Error(`missing report submission for ${caseId}`);
      return turn.rawInput as ResolutionReport;
    }

    const expectedResolutionByCaseId: Readonly<Record<string, string>> = {
      "notification-service-degradation":
        "Update the ticket to IN_PROGRESS while the notification-service degradation is investigated per the runbook.",
      "notification-queue-backlog":
        "Update the ticket to IN_PROGRESS while the notification queue backlog is investigated per the runbook.",
      "authentication-failure":
        "Create an escalation to the Identity team to investigate the elevated authentication failures per the runbook.",
      "billing-invoice-formatting":
        "Draft a customer-facing reply acknowledging the invoice formatting issue; the DRAFT_CUSTOMER_REPLY suggested action provides that draft for review.",
      "irrelevant-no-match-query":
        "Manual investigation is required before a structured next action can be recommended.",
    };

    for (const [caseId, expectedResolution] of Object.entries(expectedResolutionByCaseId)) {
      expect(reportFor(caseId).recommendedResolution).toBe(expectedResolution);
    }

    // The no-match case stays ADVISORY + []: its recommendation is manual
    // investigation, not a concrete escalation command.
    const noMatch = reportFor("irrelevant-no-match-query");
    expect(noMatch.recommendationDisposition).toBe("ADVISORY");
    expect(noMatch.suggestedActions).toEqual([]);

    // Final source-grounding closure: action grounding must support the
    // action's content (not merely pass the subset invariant), and no payload
    // may claim an unrepresented operation or unsupported remediation progress.
    const case2Action = reportFor("notification-queue-backlog").suggestedActions[0];
    if (!case2Action || case2Action.type !== "UPDATE_TICKET_STATUS") {
      throw new Error("notification-queue-backlog must carry an UPDATE_TICKET_STATUS action");
    }
    expect(case2Action.payload.reason).not.toMatch(/scal/i);
    expect(case2Action.groundedBy).toContainEqual({
      evidenceId: "runbook-notification-queue-backlog-001",
      sourceType: "RAG_CHUNK",
    });

    const case3Action = reportFor("authentication-failure").suggestedActions[0];
    if (!case3Action || case3Action.type !== "CREATE_ESCALATION") {
      throw new Error("authentication-failure must carry a CREATE_ESCALATION action");
    }
    expect(case3Action.groundedBy).toContainEqual({
      evidenceId: "runbook-auth-failures-001",
      sourceType: "RAG_CHUNK",
    });
    expect(case3Action.groundedBy).toContainEqual({
      evidenceId: "runbook-auth-failures-002",
      sourceType: "RAG_CHUNK",
    });

    const case5Action = reportFor("billing-invoice-formatting").suggestedActions[0];
    if (!case5Action || case5Action.type !== "DRAFT_CUSTOMER_REPLY") {
      throw new Error("billing-invoice-formatting must carry a DRAFT_CUSTOMER_REPLY action");
    }
    expect(case5Action.groundedBy).toContainEqual({
      evidenceId: "runbook-billing-invoice-formatting-001",
      sourceType: "RAG_CHUNK",
    });
    expect(case5Action.payload.body).not.toMatch(/working on a fix/i);
  });

  it("passes every declared expectation for all 26 cases when run against the real corpus and real components", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const caseInputs = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    const suiteInput = buildEvaluationSuiteInputV2(EVALUATION_DATASET_ID, caseInputs);
    const suiteResult = new LocalEvaluationScorer().score(suiteInput);

    const failures = suiteResult.cases.filter((result) => !result.passed);
    expect(failures).toEqual([]);

    const metrics = suiteResult.metrics;
    expect(metrics.totalCases).toBe(26);
    expect(metrics.passedCases).toBe(26);
    expect(metrics.failedCases).toBe(0);
    // The two new Issue #77 structural cases shift the six v1 ratio scopes
    // as follows (both declare tool + schema/grounding + expectedStatus
    // expectations; neither declares a retrieval expectation, so
    // retrievalTop1/retrievalHitAt3 are unchanged from the 20-case suite):
    //   retrievalTop1: unchanged -> 10/10
    //   retrievalHitAt3: unchanged -> 4/4
    //   schemaHandlingCorrectness: +2 -> 16/16
    //   evidenceGroundingCorrectness: +2 -> 15/15
    //   toolCorrectness: +2 (each declares tool expectations) -> 18/18
    //   expectedStatusCorrectness: +2 -> 22/22
    //
    // Issue #94's four two-tool deployment cases then shift them again. All
    // four declare tool + schema/grounding + expectedStatus expectations;
    // three declare expectedTop1 and one (deployment-unknown-service)
    // declares expectedNoResults, which is scored outside retrievalTop1:
    //   retrievalTop1: +3 -> 13/13
    //   retrievalHitAt3: unchanged -> 4/4
    //   schemaHandlingCorrectness: +4 -> 20/20
    //   evidenceGroundingCorrectness: +4 -> 19/19
    //   toolCorrectness: +4 -> 22/22
    //   expectedStatusCorrectness: +4 -> 26/26
    expect(metrics.retrievalTop1).toEqual({ numerator: 13, denominator: 13 });
    expect(metrics.retrievalHitAt3).toEqual({ numerator: 4, denominator: 4 });
    expect(metrics.schemaHandlingCorrectness).toEqual({ numerator: 20, denominator: 20 });
    expect(metrics.evidenceGroundingCorrectness).toEqual({ numerator: 19, denominator: 19 });
    expect(metrics.toolCorrectness).toEqual({ numerator: 22, denominator: 22 });
    expect(metrics.expectedStatusCorrectness).toEqual({ numerator: 26, denominator: 26 });
  });

  it("A: every scored case emits exactly one outcome per #59 metric check, in the fixed METRIC_CHECK_NAMES order", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const caseInputs = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    const suiteInput = buildEvaluationSuiteInputV2(EVALUATION_DATASET_ID, caseInputs);
    const suiteResult = new LocalEvaluationScorer().score(suiteInput);

    expect(suiteResult.cases).toHaveLength(26);
    for (const caseResult of suiteResult.cases) {
      // Exactly the nine metric names, once each, in the fixed order — no
      // missing outcome (which the exactly-nine guard would reject anyway),
      // no duplicate, and the fixed order proves stable ordering (§14-A/D).
      const metricChecks = caseResult.checks.filter((check) =>
        (METRIC_CHECK_NAMES as readonly string[]).includes(check.name),
      );
      expect(metricChecks.map((check) => check.name), `case "${caseResult.caseId}"`).toEqual([
        ...METRIC_CHECK_NAMES,
      ]);
    }
  });
});
