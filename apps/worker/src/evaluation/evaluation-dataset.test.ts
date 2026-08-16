import { describe, expect, it } from "vitest";

import type { ResolutionReport } from "@opspilot/contracts";
import { INJECTION_PROBE_CHUNK, loadDefaultRunbookCorpus } from "../rag";
import { validateEvaluationDataset } from "./dataset-validation";
import { EVALUATION_CASES } from "./evaluation-dataset";
import { runEvaluationSuite } from "./evaluation-runner";
import { LocalEvaluationScorer } from "./evaluation-scorer";
import { buildEvaluationSuiteInputV1, EVALUATION_DATASET_ID } from "./v1-types";

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
];

describe("EVALUATION_CASES", () => {
  it("contains exactly the 15 approved case ids, in the approved order", () => {
    expect(EVALUATION_CASES.map((evaluationCase) => evaluationCase.id)).toEqual(EXPECTED_CASE_IDS);
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

  it("passes every declared expectation for all 15 cases when run against the real corpus and real components", async () => {
    const corpusLoad = await loadDefaultRunbookCorpus();

    const caseInputs = await runEvaluationSuite({
      cases: EVALUATION_CASES,
      defaultCorpus: corpusLoad.chunks,
      injectionProbeChunk: INJECTION_PROBE_CHUNK,
    });
    const suiteInput = buildEvaluationSuiteInputV1(EVALUATION_DATASET_ID, caseInputs);
    const suiteResult = new LocalEvaluationScorer().score(suiteInput);

    const failures = suiteResult.cases.filter((result) => !result.passed);
    expect(failures).toEqual([]);

    const metrics = suiteResult.metrics;
    expect(metrics.totalCases).toBe(15);
    expect(metrics.passedCases).toBe(15);
    expect(metrics.failedCases).toBe(0);
    expect(metrics.retrievalTop1).toEqual({ numerator: 6, denominator: 6 });
    expect(metrics.retrievalHitAt3).toEqual({ numerator: 2, denominator: 2 });
    expect(metrics.schemaHandlingCorrectness).toEqual({ numerator: 10, denominator: 10 });
    expect(metrics.evidenceGroundingCorrectness).toEqual({ numerator: 9, denominator: 9 });
    expect(metrics.toolCorrectness).toEqual({ numerator: 11, denominator: 11 });
    expect(metrics.expectedStatusCorrectness).toEqual({ numerator: 15, denominator: 15 });
  });
});
