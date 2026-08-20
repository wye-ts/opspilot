import type { FakeAgentScenario } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";

import type { EvaluationCase } from "../types";

// Issue #59 Checkpoint B §7 — the five approved cases appended after
// injection-probe-structural (dataset positions 16-20). Every case uses the
// fixed per-turn usage {inputTokens: 100, outputTokens: 20}, so the total
// token expectation in expectedBounds is deterministic: turns.length * 120.
const USAGE = { inputTokens: 100, outputTokens: 20 };

function scenario(id: string, turns: FakeAgentScenario["turns"]): FakeAgentScenario {
  return { id, turns };
}

// 7.1 healthy-service-no-fault — a grounded "no fault observed" conclusion:
// the auth runbook describes failures, but the seeded status check reports
// auth-service OPERATIONAL, so no root cause is established (rootCause null is
// valid under SUFFICIENT evidence — a non-causal conclusion, per P1-1).
const CASE_16_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "No fault observed; auth-service is operational.",
  rootCause: null,
  customerImpact: "Impact could not be confirmed from available evidence.",
  recommendedResolution:
    "Monitor the service; no structured action is warranted while no fault is established.",
  confidence: 0.75,
  evidence: [
    {
      evidenceId: "case16-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL.",
    },
    {
      evidenceId: "runbook-auth-failures-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes authentication failure symptoms; none currently observed.",
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: no structured action — the truthful disposition
  // for a no-fault conclusion is ADVISORY with zero suggested actions.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// 7.2 multi-step-degradation-escalation — the flagship: two diagnostics
// (notification-service DEGRADED, then auth-service OPERATIONAL ruling out the
// ticket's upstream-auth suspicion), a grounded ACTIONABLE escalation, and
// approval eligibility.
const CASE_17_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is degraded; the upstream authentication suspicion is ruled out.",
  rootCause: "notification-service is reporting a DEGRADED status.",
  customerImpact: "Customers experience delayed notification emails.",
  recommendedResolution:
    "Escalate to the Messaging Platform team to remediate the notification-service degradation.",
  confidence: 0.85,
  evidence: [
    {
      evidenceId: "case17-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
    },
    {
      evidenceId: "case17-call-2",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL; upstream auth cause ruled out.",
    },
    {
      evidenceId: "runbook-notification-degradation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook confirms a known notification-service degradation pattern.",
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: grounded ACTIONABLE — the escalation is grounded
  // in the notification-service DEGRADED tool result.
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Messaging Platform",
        reason: "Investigate the notification-service degradation.",
        priority: "HIGH",
      },
      groundedBy: [{ evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" }],
    },
  ],
};

// 7.3 unknown-telemetry-insufficient — checkout-service returns UNKNOWN (not
// in the seeded status table) and the run correctly treats it as a
// non-answer: INSUFFICIENT evidence, no root cause, no action.
const CASE_18_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "checkout-service status could not be determined.",
  rootCause: null,
  customerImpact: "Impact could not be determined from available evidence.",
  recommendedResolution:
    "Manual investigation is required before a structured next action can be recommended.",
  confidence: 0.2,
  evidence: [
    {
      evidenceId: "case18-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "checkout-service status could not be confirmed (UNKNOWN).",
    },
  ],
  evidenceState: "INSUFFICIENT",
  // Issue #60 Checkpoint C: ADVISORY with zero actions — the UNKNOWN tool
  // result does not justify a structured action.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// 7.4 conflicting-signals-unresolved — two OPERATIONAL auth-service checks
// conflict with the RAG incident description; the run stops voluntarily with
// CONFLICTING evidence and no root cause.
const CASE_19_REPORT: ResolutionReport = {
  category: "AUTHENTICATION",
  summary: "Authentication incident signals conflict; status could not be resolved.",
  rootCause: null,
  customerImpact: "Impact could not be conclusively determined.",
  recommendedResolution:
    "Manual investigation is required before a structured next action can be recommended.",
  confidence: 0.35,
  evidence: [
    {
      evidenceId: "case19-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL.",
    },
    {
      evidenceId: "case19-call-2",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL on a second check.",
    },
    {
      evidenceId: "runbook-auth-failures-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes an authentication incident; conflicts with the operational status checks.",
    },
  ],
  evidenceState: "CONFLICTING",
  // Issue #60 Checkpoint C: ADVISORY with zero actions — the conflict is not
  // resolved, so no structured action is justified.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

// 7.5 bound-exhausted-finalization — three diagnostics exhaust the diagnostic
// bound, then the reserved finalization turn submits a report, so the run is
// forced-finalized with BOUND_EXHAUSTED.
const CASE_20_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "Investigation reached the diagnostic bound without establishing a root cause.",
  rootCause: null,
  customerImpact: "Impact could not be conclusively determined.",
  recommendedResolution:
    "Manual investigation is required; the automated investigation exhausted its diagnostic bound.",
  confidence: 0.25,
  evidence: [
    {
      evidenceId: "case20-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
    },
    {
      evidenceId: "case20-call-2",
      sourceType: "TOOL_EXECUTION",
      finding: "payments-service status could not be confirmed (UNKNOWN).",
    },
    {
      evidenceId: "case20-call-3",
      sourceType: "TOOL_EXECUTION",
      finding: "search-service status could not be confirmed (UNKNOWN).",
    },
    {
      evidenceId: "runbook-notification-degradation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes a notification-service degradation pattern.",
    },
  ],
  evidenceState: "INSUFFICIENT",
  // Issue #60 Checkpoint C: ADVISORY with zero actions — no root cause was
  // established, so no structured action is justified.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

export const CHECKPOINT_B_CASES: readonly EvaluationCase[] = [
  {
    id: "healthy-service-no-fault",
    description: "A grounded no-fault conclusion: the auth check reports OPERATIONAL, so no root cause is established.",
    ticketContext: { ticketId: "EVAL-16", summary: "Customers report intermittent login errors." },
    retrievalQuery: "authentication failures",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("healthy-service-no-fault", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case16-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Issue #58 Checkpoint B: retrieval has run, so the A3 guard
            // forbids NO_EVIDENCE_YET — cite the auth runbook chunk.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-auth-failures-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_16_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: {
        expectedTop1: "runbook-auth-failures-001",
        expectedInTopK: ["runbook-auth-failures-001", "runbook-auth-failures-002"],
      },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case16-call-1" }],
        expectedExecuted: [{ toolName: "get_service_status", input: { serviceSlug: "auth-service" } }],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case16-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: {
        state: "SUFFICIENT",
        requiredLocators: [{ evidenceId: "case16-call-1", sourceType: "TOOL_EXECUTION" }],
        requiresTelemetry: true,
        minDistinctLocators: 2,
      },
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case16-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [],
      },
      expectedDiagnostics: [{ evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" }],
      expectedStopReason: "SUFFICIENT_EVIDENCE",
      expectedConfidence: { min: 0.6, max: 0.9 },
      expectedApproval: "NOT_ELIGIBLE",
      expectedBounds: { maxTotalTokens: 240 },
    },
  },
  {
    id: "multi-step-degradation-escalation",
    description: "Flagship: a successful multi-step investigation (notification degraded, auth ruled out) producing an escalation and approval eligibility.",
    ticketContext: {
      ticketId: "EVAL-17",
      summary: "Customers report delayed notification emails. Authentication is suspected as an upstream cause.",
    },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("multi-step-degradation-escalation", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case17-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Issue #58 Checkpoint B: retrieval has run, so the A3 guard
            // forbids NO_EVIDENCE_YET — cite the notification runbook chunk.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-notification-degradation-001",
                  sourceType: "RAG_CHUNK",
                },
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
            toolCallId: "case17-call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Issue #58 Checkpoint B: notification-service is confirmed
            // DEGRADED, but the ticket's auth-suspicion scope is not yet
            // covered — a further diagnostic is justified (SCOPE_NOT_COVERED).
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "SCOPE_NOT_COVERED",
              supportedBy: [
                { evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" },
                {
                  evidenceId: "runbook-notification-degradation-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_17_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-notification-degradation-001" },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case17-call-1" },
          { toolName: "get_service_status", toolCallId: "case17-call-2" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case17-call-1" },
          { toolName: "get_service_status", toolCallId: "case17-call-2" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
      expectedRootCause: "PRESENT",
      expectedEvidence: {
        state: "SUFFICIENT",
        requiredLocators: [
          { evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "runbook-notification-degradation-001", sourceType: "RAG_CHUNK" },
        ],
        requiresTelemetry: true,
        minDistinctLocators: 2,
      },
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "SCOPE_NOT_COVERED" },
      ],
      expectedStopReason: "SUFFICIENT_EVIDENCE",
      expectedConfidence: { min: 0.75, max: 0.95 },
      expectedActions: [
        {
          type: "CREATE_ESCALATION",
          requiredGrounding: [{ evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" }],
          allowedGrounding: [
            { evidenceId: "case17-call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "runbook-notification-degradation-001", sourceType: "RAG_CHUNK" },
          ],
        },
      ],
      expectedApproval: "ELIGIBLE",
      expectedBounds: { maxTotalTokens: 360 },
    },
  },
  {
    id: "unknown-telemetry-insufficient",
    description: "An UNKNOWN status check is correctly treated as a non-answer: INSUFFICIENT evidence, no root cause, no action.",
    ticketContext: { ticketId: "EVAL-18", summary: "Customers report errors during checkout." },
    // A deliberate zero-corpus-overlap query (the corpus has no checkout /
    // payment runbook), so expectedNoResults holds and the NO_EVIDENCE_YET
    // assessment stays A3-valid: "checkout service errors" WOULD match the
    // notification/auth runbooks via the "service"/"errors" tokens, which
    // would make NO_EVIDENCE_YET a false claim.
    retrievalQuery: "checkout payment gateway transaction",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("unknown-telemetry-insufficient", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case18-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "checkout-service" },
            // Issue #58 Checkpoint B: this query returns zero retrieval
            // results (expectedNoResults) and no tool has executed yet, so
            // both evidence sets are empty — NO_EVIDENCE_YET is the
            // run-state-consistent claim the A3 guard requires here.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "NO_EVIDENCE_YET",
              supportedBy: [],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_18_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedNoResults: true },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case18-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "checkout-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case18-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: { state: "INSUFFICIENT", requiredLocators: [] },
      expectedTelemetryEvidence: {
        probative: [],
        nonProbative: [{ evidenceId: "case18-call-1", sourceType: "TOOL_EXECUTION" }],
      },
      expectedDiagnostics: [{ evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET" }],
      expectedStopReason: "NO_JUSTIFIED_DIAGNOSTIC",
      expectedConfidence: { min: 0.05, max: 0.35 },
      expectedApproval: "NOT_ELIGIBLE",
      expectedBounds: { maxTotalTokens: 240 },
    },
  },
  {
    id: "conflicting-signals-unresolved",
    description: "OPERATIONAL status checks conflict with the RAG incident description; the run stops voluntarily without a root cause.",
    ticketContext: { ticketId: "EVAL-19", summary: "Customers report login issues consistent with a known authentication incident." },
    retrievalQuery: "authentication failures",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("conflicting-signals-unresolved", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case19-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Issue #58 Checkpoint B: retrieval has run, so the A3 guard
            // forbids NO_EVIDENCE_YET — cite the auth runbook chunk.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-auth-failures-001",
                  sourceType: "RAG_CHUNK",
                },
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
            toolCallId: "case19-call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Issue #58 Checkpoint B: the first OPERATIONAL check conflicts
            // with the RAG incident description — a second check is justified
            // to adjudicate the conflict (CONFLICTING + CONFLICT_UNRESOLVED).
            rawAssessment: {
              evidenceState: "CONFLICTING",
              continuationReason: "CONFLICT_UNRESOLVED",
              supportedBy: [
                { evidenceId: "case19-call-1", sourceType: "TOOL_EXECUTION" },
                {
                  evidenceId: "runbook-auth-failures-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_19_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: {
        expectedTop1: "runbook-auth-failures-001",
        expectedInTopK: ["runbook-auth-failures-001", "runbook-auth-failures-002"],
      },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case19-call-1" },
          { toolName: "get_service_status", toolCallId: "case19-call-2" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case19-call-1" },
          { toolName: "get_service_status", toolCallId: "case19-call-2" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: { state: "CONFLICTING", requiredLocators: [] },
      expectedTelemetryEvidence: {
        probative: [
          { evidenceId: "case19-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "case19-call-2", sourceType: "TOOL_EXECUTION" },
        ],
        nonProbative: [],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "CONFLICTING", continuationReason: "CONFLICT_UNRESOLVED" },
      ],
      expectedStopReason: "NO_JUSTIFIED_DIAGNOSTIC",
      expectedConfidence: { min: 0.2, max: 0.5 },
      expectedApproval: "NOT_ELIGIBLE",
      expectedBounds: { maxTotalTokens: 360 },
    },
  },
  {
    id: "bound-exhausted-finalization",
    description: "Three diagnostics exhaust the diagnostic bound; the reserved finalization turn submits a report, forced-finalizing the run.",
    ticketContext: { ticketId: "EVAL-20", summary: "Customers report delayed notifications and checkout failures." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("bound-exhausted-finalization", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case20-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Issue #58 Checkpoint B: retrieval has run, so the A3 guard
            // forbids NO_EVIDENCE_YET — cite the notification runbook chunk.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-notification-degradation-001",
                  sourceType: "RAG_CHUNK",
                },
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
            toolCallId: "case20-call-2",
            toolName: "get_service_status",
            input: { serviceSlug: "payments-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                { evidenceId: "case20-call-1", sourceType: "TOOL_EXECUTION" },
                {
                  evidenceId: "runbook-notification-degradation-001",
                  sourceType: "RAG_CHUNK",
                },
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
            toolCallId: "case20-call-3",
            toolName: "get_service_status",
            input: { serviceSlug: "search-service" },
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                { evidenceId: "case20-call-1", sourceType: "TOOL_EXECUTION" },
                { evidenceId: "case20-call-2", sourceType: "TOOL_EXECUTION" },
                {
                  evidenceId: "runbook-notification-degradation-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      // The reserved finalization turn: a report submission here forces
      // finalization (REPORT_GENERATION_STARTED -> BOUND_EXHAUSTED).
      { kind: "report_submission", usage: USAGE, rawInput: CASE_20_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-notification-degradation-001" },
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case20-call-1" },
          { toolName: "get_service_status", toolCallId: "case20-call-2" },
          { toolName: "get_service_status", toolCallId: "case20-call-3" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "payments-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "search-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case20-call-1" },
          { toolName: "get_service_status", toolCallId: "case20-call-2" },
          { toolName: "get_service_status", toolCallId: "case20-call-3" },
        ],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
      expectedRootCause: "ABSENT",
      expectedEvidence: { state: "INSUFFICIENT", requiredLocators: [] },
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case20-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [
          { evidenceId: "case20-call-2", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "case20-call-3", sourceType: "TOOL_EXECUTION" },
        ],
      },
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
      ],
      expectedStopReason: "BOUND_EXHAUSTED",
      expectedConfidence: { min: 0.15, max: 0.35 },
      expectedApproval: "NOT_ELIGIBLE",
      expectedBounds: { maxTotalTokens: 480 },
    },
  },
];
