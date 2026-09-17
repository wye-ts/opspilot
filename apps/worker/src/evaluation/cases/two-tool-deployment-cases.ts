import type { FakeAgentScenario } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";

import type { EvaluationCase } from "../types";

// Issue #94 — evaluation coverage for a two-tool investigation chain
// (get_service_status + get_recent_deployments). Dataset positions 23-26,
// appended at the true end of the fixed order.
//
// THE CAUSAL CONSTRAINT THAT SHAPES ALL FOUR CASES
//
// runbook-deployment-rollback-001 requires BOTH an error-budget burn rate
// tripling within ten minutes of a rollout AND reproducibility on the new
// revision but not the previous one. `get_recent_deployments` reports
// NEITHER. Its two non-success outcomes are also ambiguous in the wrong
// direction: a FAILED deployment may never have reached production, and a
// ROLLED_BACK one may describe an already-remediated incident.
//
// So NO case here may assert a root cause grounded on deployment outcome. A
// fixture-scripted case that did would not test the inference — it would
// CI-bless an unsupported causal conclusion, which is exactly the
// over-promise this repo's semantic-honesty bar exists to stop. #93 wrote the
// same reasoning into the fixture comments (get-recent-deployments.ts:80-85,
// :106-108) so a later eval case would not undo it; this file is that later
// eval case, and it holds the line.
//
// What deployment data DOES legitimately support:
//   - NEGATIVE reasoning: "no recent deployments, so deployment is ruled out
//     as a contributing factor" — and only because `knownService: true`
//     distinguishes a genuine empty from a genuine unknown. That is an
//     argument from a positive fact, not from missing data.
//   - UNRESOLVED-LEAD reasoning: INSUFFICIENT + rootCause null, naming the
//     specific facts that are missing.
//
// Fixed per-turn usage, so expectedBounds stays deterministic:
// turns.length * 120.
const USAGE = { inputTokens: 100, outputTokens: 20 };

function scenario(id: string, turns: FakeAgentScenario["turns"]): FakeAgentScenario {
  return { id, turns };
}

// 23. deployment-ruled-out — the one case carrying a non-null conclusion, and
// it is a NEGATIVE one. billing-service is OUTAGE with `knownService: true`
// and zero deployments, so "deployment is not a contributing factor" is
// earned rather than assumed. This is also the acceptance-criterion-1 case:
// two distinct TOOL_EXECUTION locators from two DIFFERENT tools, plus a
// RAG_CHUNK.
const DEPLOYMENT_RULED_OUT_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary:
    "billing-service is in a confirmed outage, and no recent deployment exists that could have caused it.",
  // Deliberately null. Ruling a candidate OUT does not establish what the
  // cause IS, and the tools in this run cannot.
  rootCause: null,
  customerImpact: "Billing operations are unavailable while the outage persists.",
  recommendedResolution:
    "Escalate to the billing on-call team. Recent deployments are excluded as a contributing factor, so investigation should start from infrastructure and dependency health.",
  confidence: 0.6,
  evidence: [
    {
      evidenceId: "case23-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "billing-service status is OUTAGE.",
      supports: [],
    },
    {
      evidenceId: "case23-call-2",
      sourceType: "TOOL_EXECUTION",
      finding:
        "billing-service is a known service with zero recent deployments, so no rollout coincides with this outage.",
      supports: [],
    },
    {
      evidenceId: "runbook-storage-quota-exhaustion-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook guidance for storage-related service outages.",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Billing",
        reason:
          "billing-service is in a confirmed outage with no recent deployment to explain it; deployment is ruled out and the cause remains unidentified.",
        priority: "HIGH",
      },
      groundedBy: [
        { evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" },
      ],
    },
  ],
};

// 24. deployment-unresolved-lead — notification-service is DEGRADED with a
// recent ROLLED_BACK deployment. The tempting conclusion ("the rollback caused
// it") is exactly what the runbook forbids on this evidence. The report must
// name the missing facts instead of asserting the chain.
const DEPLOYMENT_UNRESOLVED_LEAD_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary:
    "notification-service is degraded and a recent deployment was rolled back, but the rollback cannot be confirmed as the cause.",
  rootCause: null,
  customerImpact: "Notification delivery is degraded for an unconfirmed subset of users.",
  recommendedResolution:
    "Treat the rolled-back deployment as an unresolved lead, not a cause. Confirming it requires the error-budget burn rate around the rollout window and whether the fault reproduces on the new revision but not the previous one; neither is available from the diagnostics run here.",
  confidence: 0.3,
  evidence: [
    {
      evidenceId: "case24-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service status is DEGRADED.",
      supports: [],
    },
    {
      evidenceId: "case24-call-2",
      sourceType: "TOOL_EXECUTION",
      finding:
        "The most recent notification-service deployment was ROLLED_BACK; the tool reports no burn-rate or revision-reproducibility data.",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// 25. deployment-unknown-service — `knownService: false` must NOT be read as
// "no deployments, therefore ruled out". An empty result for an unknown
// service is an absence of RECORDS, not evidence of an absence of deployments,
// and grounding a negative on it would be an argument from missing data.
const DEPLOYMENT_UNKNOWN_SERVICE_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "No deployment or status records exist for the reported service.",
  rootCause: null,
  customerImpact: "Impact could not be determined from available evidence.",
  recommendedResolution:
    "The service is unknown to both diagnostics, so nothing is ruled in or out. Confirm the correct service identifier before investigating further.",
  confidence: 0.1,
  evidence: [
    {
      evidenceId: "case25-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "Status for the reported service is UNKNOWN.",
      supports: [],
    },
    {
      evidenceId: "case25-call-2",
      sourceType: "TOOL_EXECUTION",
      finding:
        "The deployment tool reports knownService false: there are no records for this service, which is not the same as having no deployments.",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// 26. deployment-failed-behind-success — auth-service is OPERATIONAL, and its
// FAILED deployment sits BEHIND a later SUCCEEDED one. A FAILED deployment may
// never have reached production at all, so this supports nothing in either
// direction — not a cause, and not a clean bill of health either.
const DEPLOYMENT_FAILED_BEHIND_SUCCESS_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary:
    "auth-service is operational; an older failed deployment is superseded by a later successful one and explains nothing.",
  rootCause: null,
  customerImpact: "No customer impact is confirmed for auth-service.",
  recommendedResolution:
    "No action is warranted from these signals. The failed deployment predates a successful one and may never have reached production, so it is not evidence of a fault.",
  confidence: 0.25,
  evidence: [
    {
      evidenceId: "case26-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service status is OPERATIONAL.",
      supports: [],
    },
    {
      evidenceId: "case26-call-2",
      sourceType: "TOOL_EXECUTION",
      finding:
        "auth-service's most recent deployment SUCCEEDED; an earlier one FAILED, which the tool cannot distinguish from a rollout that never reached production.",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

export const TWO_TOOL_DEPLOYMENT_CASES: readonly EvaluationCase[] = [
  {
    id: "deployment-ruled-out",
    description:
      "Two-tool chain: a confirmed outage with zero recent deployments grounds a NEGATIVE conclusion (deployment excluded) on two distinct tools plus a runbook chunk.",
    ticketContext: {
      ticketId: "EVAL-23",
      summary: "Billing operations are failing and customers cannot be invoiced.",
    },
    retrievalQuery: "storage quota exhaustion",
    corpusProfile: "default",
    toolProfile: "with-deployments-tool",
    scenario: scenario("deployment-ruled-out", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case23-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "billing-service" },
            // Retrieval has already run, so the A3 guard forbids
            // NO_EVIDENCE_YET — cite the retrieved chunk.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "runbook-storage-quota-exhaustion-001", sourceType: "RAG_CHUNK" }],
            },
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case23-call-2",
            toolName: "get_recent_deployments",
            input: { serviceSlug: "billing-service" },
            // The outage is confirmed but its cause is not; checking whether a
            // rollout coincides is a scope the status tool does not cover.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [{ evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      {
        // Third and FINAL diagnostic call — this case deliberately sits at
        // MAX_DIAGNOSTIC_TOOL_CALLS (3) so the bound is exercised at its edge
        // rather than only below it (plan §2.3, acceptance criterion 4). A
        // regression in third-request sequencing would otherwise ship green.
        //
        // Checking auth-service is justified, not filler: billing is down and
        // an upstream dependency is a live hypothesis the first two calls do
        // not address.
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case23-call-3",
            toolName: "get_recent_deployments",
            input: { serviceSlug: "auth-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [{ evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: DEPLOYMENT_RULED_OUT_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-storage-quota-exhaustion-001" },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case23-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case23-call-2" },
          { toolName: "get_recent_deployments", toolCallId: "case23-call-3" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "billing-service" } },
          { toolName: "get_recent_deployments", input: { serviceSlug: "billing-service" } },
          { toolName: "get_recent_deployments", input: { serviceSlug: "auth-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case23-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case23-call-2" },
          { toolName: "get_recent_deployments", toolCallId: "case23-call-3" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
      // Ruling deployment OUT is not establishing a cause.
      expectedRootCause: "ABSENT",
      expectedEvidence: {
        state: "INSUFFICIENT",
        requiredLocators: [
          { evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" },
        ],
        minDistinctLocators: 3,
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
      ],
      // The billing results are probative: a confirmed OUTAGE and a confirmed
      // "known service, zero deployments" each carry real evidential weight,
      // and the second is what makes the negative conclusion legitimate. The
      // third call (auth-service deployments) is NOT probative for billing's
      // outage — it rules an upstream lead in or out for no service the report
      // concludes about, so it is declared non-probative rather than padded
      // into the grounding.
      expectedTelemetryEvidence: {
        probative: [
          { evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" },
        ],
        nonProbative: [{ evidenceId: "case23-call-3", sourceType: "TOOL_EXECUTION" }],
      },
      expectedConfidence: { min: 0.4, max: 0.75 },
      expectedActions: [
        {
          type: "CREATE_ESCALATION",
          requiredGrounding: [
            { evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" },
          ],
          allowedGrounding: [
            { evidenceId: "case23-call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "case23-call-2", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "runbook-storage-quota-exhaustion-001", sourceType: "RAG_CHUNK" },
          ],
        },
      ],
      // Four provider turns (3 diagnostics at the MAX_DIAGNOSTIC_TOOL_CALLS
      // bound + the report) * 120 = 480, versus 360 for the three-turn cases.
      expectedBounds: { maxTotalTokens: 480 },
    },
  },
  {
    id: "deployment-unresolved-lead",
    description:
      "A DEGRADED service with a recent ROLLED_BACK deployment stays an unresolved lead: INSUFFICIENT, no root cause, and the missing facts named.",
    ticketContext: {
      ticketId: "EVAL-24",
      summary: "Customers report delayed notification emails after a recent release.",
    },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "with-deployments-tool",
    scenario: scenario("deployment-unresolved-lead", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case24-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                { evidenceId: "runbook-notification-degradation-001", sourceType: "RAG_CHUNK" },
              ],
            },
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case24-call-2",
            toolName: "get_recent_deployments",
            input: { serviceSlug: "notification-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [{ evidenceId: "case24-call-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: DEPLOYMENT_UNRESOLVED_LEAD_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-notification-degradation-001" },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case24-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case24-call-2" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
          { toolName: "get_recent_deployments", input: { serviceSlug: "notification-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case24-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case24-call-2" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION"],
      },
      // The whole point of the case: a suggestive rollback does not become a
      // root cause on this evidence.
      expectedRootCause: "ABSENT",
      expectedEvidence: {
        state: "INSUFFICIENT",
        requiredLocators: [{ evidenceId: "case24-call-2", sourceType: "TOOL_EXECUTION" }],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
      ],
      // The DEGRADED status is probative. The ROLLED_BACK deployment is NOT:
      // it is a lead the runbook explicitly cannot promote to a cause without
      // burn-rate and revision-reproducibility data this tool never returns.
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case24-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [{ evidenceId: "case24-call-2", sourceType: "TOOL_EXECUTION" }],
      },
      expectedConfidence: { min: 0.15, max: 0.45 },
      expectedActions: [],
      expectedBounds: { maxTotalTokens: 360 },
    },
  },
  {
    id: "deployment-unknown-service",
    description:
      "knownService false is an absence of RECORDS, not evidence of no deployments: the run stays INSUFFICIENT and rules nothing out.",
    ticketContext: {
      ticketId: "EVAL-25",
      summary: "A reported service is failing but the name does not match any known system.",
    },
    // Zero-corpus-overlap query, so expectedNoResults holds and the
    // NO_EVIDENCE_YET assessment on the first turn stays A3-valid.
    retrievalQuery: "checkout payment gateway transaction",
    corpusProfile: "default",
    toolProfile: "with-deployments-tool",
    scenario: scenario("deployment-unknown-service", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case25-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "checkout-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "NO_EVIDENCE_YET",
              supportedBy: [],
            },
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case25-call-2",
            toolName: "get_recent_deployments",
            input: { serviceSlug: "checkout-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [{ evidenceId: "case25-call-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: DEPLOYMENT_UNKNOWN_SERVICE_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedNoResults: true },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case25-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case25-call-2" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "checkout-service" } },
          { toolName: "get_recent_deployments", input: { serviceSlug: "checkout-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case25-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case25-call-2" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: {
        state: "INSUFFICIENT",
        requiredLocators: [{ evidenceId: "case25-call-2", sourceType: "TOOL_EXECUTION" }],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
      ],
      // Neither result is probative: an UNKNOWN status and a
      // `knownService: false` deployment lookup are both non-answers. This is
      // the classification that stops "no records" being read as "no
      // deployments, therefore ruled out".
      expectedTelemetryEvidence: {
        probative: [],
        nonProbative: [
          { evidenceId: "case25-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "case25-call-2", sourceType: "TOOL_EXECUTION" },
        ],
      },
      expectedConfidence: { min: 0.05, max: 0.3 },
      expectedActions: [],
      expectedBounds: { maxTotalTokens: 360 },
    },
  },
  {
    id: "deployment-failed-behind-success",
    description:
      "An older FAILED deployment behind a later SUCCEEDED one supports nothing in either direction; the operational service yields no root cause and no action.",
    ticketContext: {
      ticketId: "EVAL-26",
      summary: "Login problems are reported and a recent deployment is suspected.",
    },
    retrievalQuery: "authentication failures",
    corpusProfile: "default",
    toolProfile: "with-deployments-tool",
    scenario: scenario("deployment-failed-behind-success", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case26-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [{ evidenceId: "runbook-auth-failures-001", sourceType: "RAG_CHUNK" }],
            },
          },
        ],
      },
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case26-call-2",
            toolName: "get_recent_deployments",
            input: { serviceSlug: "auth-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [{ evidenceId: "case26-call-1", sourceType: "TOOL_EXECUTION" }],
            },
          },
        ],
      },
      {
        kind: "report_submission",
        usage: USAGE,
        rawInput: DEPLOYMENT_FAILED_BEHIND_SUCCESS_REPORT,
      },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-auth-failures-001" },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case26-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case26-call-2" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
          { toolName: "get_recent_deployments", input: { serviceSlug: "auth-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case26-call-1" },
          { toolName: "get_recent_deployments", toolCallId: "case26-call-2" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: {
        state: "INSUFFICIENT",
        requiredLocators: [{ evidenceId: "case26-call-2", sourceType: "TOOL_EXECUTION" }],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
      ],
      // OPERATIONAL is a real observation. The FAILED-behind-SUCCEEDED
      // deployment history is not probative in either direction: a FAILED
      // rollout may never have reached production, so it is neither a fault
      // signal nor a clean bill of health.
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case26-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [{ evidenceId: "case26-call-2", sourceType: "TOOL_EXECUTION" }],
      },
      expectedConfidence: { min: 0.1, max: 0.4 },
      expectedActions: [],
      expectedBounds: { maxTotalTokens: 360 },
    },
  },
];
