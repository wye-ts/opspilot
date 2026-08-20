import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluateCase } from "./evaluation-evaluator";
import type { ObservedFacts } from "./observed-facts";
import type { EvaluationCaseInputV2 } from "./v2-types";

// Issue #59 Checkpoint B §10.2 — evaluator side of the approval-eligibility
// parity. Consumes the SAME shared fixture as the repository parity test
// (packages/database/src/test/approval-eligibility-vectors.json, §10.1).
// For every vector whose state is observable by offline evaluation
// (evaluationObservable == true — terminal COMPLETED/FAILED states only;
// RUNNING is repository-only because offline evaluation scores terminal
// runs), feed equivalent normalized terminal facts through the real evaluator
// approval rule (evaluateMetricApprovalGate, exercised via evaluateCase) and
// require the check to PASS. A PASS means the evaluator's pure eligibility
// rule agrees with the fixture's declared eligibility — and because the
// repository integration test asserts the same fixture against the real
// PostgreSQL repository, both layers must agree on every reachable matrix row.

const APPROVAL_ELIGIBILITY_FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "src",
  "test",
  "approval-eligibility-vectors.json",
);

interface ApprovalEligibilityVector {
  readonly id: string;
  readonly runStatus: "RUNNING" | "COMPLETED" | "FAILED";
  readonly suggestedActionCount: number;
  readonly expectedRepositoryEligibility: "ELIGIBLE" | "NOT_ELIGIBLE";
  readonly evaluationObservable: boolean;
}

function loadApprovalEligibilityFixture(): { readonly vectors: readonly ApprovalEligibilityVector[] } {
  return JSON.parse(readFileSync(APPROVAL_ELIGIBILITY_FIXTURE_PATH, "utf8")) as unknown as {
    readonly vectors: readonly ApprovalEligibilityVector[];
  };
}

// Equivalent normalized terminal facts for a COMPLETED vector: a report whose
// suggestedActions cardinality mirrors the vector's suggestedActionCount.
function completedObserved(suggestedActionCount: number): ObservedFacts {
  const suggestedActions = Array.from({ length: suggestedActionCount }, () => ({
    type: "UPDATE_TICKET_STATUS" as const,
    groundedBy: [] as const,
  }));
  return {
    runStatus: "completed",
    errorCode: null,
    retrieval: { completed: true, chunkIds: [] },
    tools: { requested: [], executed: [], completed: [] },
    report: {
      evidence: [],
      suggestedActionTypes: suggestedActions.map((action) => action.type),
      category: "SERVICE_DEGRADATION",
      rootCausePresent: false,
      confidence: 0.5,
      evidenceState: "SUFFICIENT",
      recommendationDisposition: suggestedActions.length > 0 ? "ACTIONABLE" : "ADVISORY",
      suggestedActions,
    },
    investigation: {
      providerTurnsUsed: 1,
      diagnosticRequestCount: 0,
      forcedFinalization: false,
      stopReason: "SUFFICIENT_EVIDENCE",
      assessments: [],
      toolFailures: [],
      bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
      usage: { inputTokens: 100, outputTokens: 20, providerCalls: 1 },
    },
    failedStage: null,
  };
}

// Equivalent normalized terminal facts for a FAILED vector: failed runs always
// normalize to zero suggested actions (report is null), so the fixture's
// FAILED row is necessarily 0 actions.
function failedObserved(): ObservedFacts {
  return {
    runStatus: "failed",
    errorCode: "REPORT_SCHEMA_INVALID",
    retrieval: { completed: true, chunkIds: [] },
    tools: { requested: [], executed: [], completed: [] },
    report: null,
    investigation: {
      providerTurnsUsed: 0,
      diagnosticRequestCount: 0,
      forcedFinalization: false,
      stopReason: null,
      assessments: [],
      toolFailures: [],
      bounds: { maxProviderTurns: 4, maxDiagnosticToolCalls: 3 },
      usage: { inputTokens: 0, outputTokens: 0, providerCalls: 0 },
    },
    failedStage: "REPORT_GENERATION",
  };
}

describe("Issue #59 Checkpoint B §10.2 — evaluator approval-eligibility parity with the shared fixture", () => {
  const fixture = loadApprovalEligibilityFixture();

  it("every observably-evaluable vector is terminal (COMPLETED or FAILED) — RUNNING is repository-only", () => {
    expect(fixture.vectors).toHaveLength(4);
    for (const vector of fixture.vectors) {
      if (vector.evaluationObservable) {
        expect(vector.runStatus === "COMPLETED" || vector.runStatus === "FAILED").toBe(true);
      } else {
        expect(vector.runStatus).toBe("RUNNING");
      }
    }
  });

  it("the evaluator approval rule agrees with the fixture for every observably-evaluable vector", () => {
    for (const vector of fixture.vectors) {
      if (!vector.evaluationObservable) continue;

      const observed =
        vector.runStatus === "COMPLETED" ? completedObserved(vector.suggestedActionCount) : failedObserved();
      const caseInput: EvaluationCaseInputV2 = {
        caseId: vector.id,
        expectations: {
          runStatus: vector.runStatus === "COMPLETED" ? "completed" : "failed",
          expectedApproval: vector.expectedRepositoryEligibility,
        },
        observed,
      };

      const result = evaluateCase(caseInput);

      const approvalCheck = result.checks.find((check) => check.name === "approval-gate");
      expect(approvalCheck, `approval-gate check present (${vector.id})`).toBeDefined();
      expect(approvalCheck!.status, `approval-gate (${vector.id})`).toBe("PASS");
      expect(result.passed, `case verdict (${vector.id})`).toBe(true);
    }
  });

  it("the same expectedApproval fed the repository would FAIL for the RUNNING row's NOT_ELIGIBLE only if offline — RUNNING must not be evaluable", () => {
    // Guard rail for the §10 invariant "RUNNING is repository-only": offline
    // evaluation never constructs normalized facts for a RUNNING run, so the
    // RUNNING row is deliberately skipped by the parity loop above. If
    // evaluationObservable ever flips to true for RUNNING, the loop must
    // reject it — proved by the terminal-state assertion in the first test.
    const running = fixture.vectors.find((vector) => vector.runStatus === "RUNNING");
    expect(running?.evaluationObservable).toBe(false);
  });
});
