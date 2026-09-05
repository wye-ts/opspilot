import type { FakeAgentScenario } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";

import type { EvaluationCase } from "../types";

const USAGE = { inputTokens: 100, outputTokens: 20 };

function scenario(id: string, turns: FakeAgentScenario["turns"]): FakeAgentScenario {
  return { id, turns };
}

const CASE_1_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is degraded due to a known notification-service issue.",
  rootCause: "notification-service is reporting a DEGRADED status.",
  customerImpact: "Customers may experience delayed notification emails and push notifications.",
  recommendedResolution:
    "Update the ticket to IN_PROGRESS while the notification-service degradation is investigated per the runbook.",
  confidence: 0.85,
  evidence: [
    {
      evidenceId: "case1-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
      supports: ["ROOT_CAUSE"],
    },
    {
      evidenceId: "runbook-notification-degradation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook confirms this is a known notification-service degradation pattern.",
      supports: [],
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: new-write fixtures declare the disposition and
  // ground each action on a locator already present in this report's evidence
  // (the completed get_service_status call for the degraded service).
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Investigating notification-service degradation." },
      groundedBy: [{ evidenceId: "case1-call-1", sourceType: "TOOL_EXECUTION" }],
    },
  ],
};

const CASE_2_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "A backlog has formed in the notification queue.",
  rootCause: "notification-service reported DEGRADED while a queue backlog builds up.",
  customerImpact: "Customers are experiencing delayed emails and push notifications.",
  recommendedResolution:
    "Update the ticket to IN_PROGRESS while the notification queue backlog is investigated per the runbook.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "case2-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
      supports: ["ROOT_CAUSE"],
    },
    {
      evidenceId: "runbook-notification-queue-backlog-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes a growing notification queue backlog.",
      supports: [],
    },
    {
      evidenceId: "runbook-notification-queue-backlog-002",
      sourceType: "RAG_CHUNK",
      finding: "Runbook remediation steps for a notification queue backlog.",
      supports: [],
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: grounded ACTIONABLE — see CASE_1 comment.
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      // Final source-grounding closure: the reason describes the ticket-status
      // action / observed investigation state — it must not claim an
      // unrepresented scaling operation.
      payload: { status: "IN_PROGRESS", reason: "Notification queue backlog and service degradation are under investigation." },
      // Grounded in evidence that supports the backlog/degradation context.
      groundedBy: [
        { evidenceId: "case2-call-1", sourceType: "TOOL_EXECUTION" },
        { evidenceId: "runbook-notification-queue-backlog-001", sourceType: "RAG_CHUNK" },
      ],
    },
  ],
};

const CASE_3_REPORT: ResolutionReport = {
  category: "AUTHENTICATION",
  summary: "Customers are experiencing authentication failures.",
  rootCause: "Elevated 401 responses correlated with a recent auth-service deploy.",
  customerImpact: "Customers are unable to log in.",
  recommendedResolution:
    "Create an escalation to the Identity team to investigate the elevated authentication failures per the runbook.",
  confidence: 0.75,
  evidence: [
    {
      evidenceId: "case3-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL.",
      supports: [],
    },
    {
      evidenceId: "runbook-auth-failures-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes authentication failure symptoms.",
      supports: [],
    },
    {
      evidenceId: "runbook-auth-failures-002",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes authentication failure root causes.",
      supports: ["ROOT_CAUSE"],
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: grounded ACTIONABLE — see CASE_1 comment.
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Identity",
        reason: "Investigate elevated authentication failures.",
        priority: "HIGH",
      },
      // Final source-grounding closure: the tool result reports auth-service
      // OPERATIONAL, which alone does not substantiate an escalation for
      // authentication failures — ground the escalation in the runbook
      // evidence that describes the incident/investigation context.
      groundedBy: [
        { evidenceId: "runbook-auth-failures-001", sourceType: "RAG_CHUNK" },
        { evidenceId: "runbook-auth-failures-002", sourceType: "RAG_CHUNK" },
      ],
    },
  ],
};

// Issue #59 Checkpoint B §8.1: the old fixture claimed "connection pool
// saturation" as an established root cause despite the diagnostic tool
// returning UNKNOWN (database-service is unseeded) — an untruthful fixture.
// Corrected to a truthful non-answer: UNKNOWN / INSUFFICIENT / rootCause null /
// ADVISORY / [] / ~0.3. The old bad shape belongs in the negative vectors.
const CASE_4_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "Database connection pool saturation could not be confirmed.",
  rootCause: null,
  customerImpact: "The cause of the intermittent timeouts remains unexplained.",
  recommendedResolution:
    "Manual investigation is required before a structured next action can be recommended.",
  confidence: 0.3,
  evidence: [
    {
      evidenceId: "case4-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "database status could not be confirmed (UNKNOWN).",
      supports: [],
    },
    {
      evidenceId: "runbook-database-connection-saturation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes connection pool saturation as a candidate pattern, but no confirmation was obtained.",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  // Issue #60 Checkpoint C: no structured action — the truthful disposition
  // for an unconfirmed conclusion is ADVISORY with zero suggested actions.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

const CASE_5_REPORT: ResolutionReport = {
  category: "DATA_QUALITY",
  summary: "Billing invoice PDFs are misformatted.",
  rootCause: "A template version mismatch after a billing-service deploy.",
  customerImpact: "Customers are receiving invoices with misaligned totals or missing line items.",
  recommendedResolution:
    "Draft a customer-facing reply acknowledging the invoice formatting issue; the DRAFT_CUSTOMER_REPLY suggested action provides that draft for review.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "case5-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "billing-service reported status OUTAGE.",
      supports: ["ROOT_CAUSE"],
    },
    {
      evidenceId: "runbook-billing-invoice-formatting-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes billing invoice PDF formatting issues.",
      supports: [],
    },
  ],
  evidenceState: "SUFFICIENT",
  // Issue #60 Checkpoint C: grounded ACTIONABLE — see CASE_1 comment.
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "DRAFT_CUSTOMER_REPLY",
      payload: {
        subject: "Invoice formatting issue",
        // Final source-grounding closure: status-neutral wording — the fixture
        // evidence does not support claiming remediation progress ("working on
        // a fix"), so the reply only acknowledges the incident and sets the
        // expectation of human follow-up.
        body: "We are aware of an issue affecting invoice PDF formatting. A human will follow up after reviewing the incident.",
      },
      // Grounded in the evidence that actually describes the invoice-formatting
      // issue (the runbook), not the OUTAGE tool result about billing-service
      // availability.
      groundedBy: [{ evidenceId: "runbook-billing-invoice-formatting-001", sourceType: "RAG_CHUNK" }],
    },
  ],
};

const CASE_6_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "No known runbook matches this query; status could not be determined from available evidence.",
  // Issue #58 (P1-1): non-sufficient evidence carries no root cause. The old
  // sentinel sentence only stated what could not be established — the schema
  // now conveys that structurally via INSUFFICIENT + rootCause null.
  rootCause: null,
  customerImpact: "Impact could not be determined from available evidence.",
  recommendedResolution:
    "Manual investigation is required before a structured next action can be recommended.",
  confidence: 0.2,
  evidence: [
    {
      evidenceId: "case6-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "unclassified-service status could not be confirmed (UNKNOWN).",
      supports: [],
    },
  ],
  evidenceState: "INSUFFICIENT",
  // Issue #60 Checkpoint C closure fix: this no-match case deliberately
  // carries no structured action. CREATE_ESCALATION is a supported action
  // type, but this run's evidence does not yet justify one — the
  // recommendation is manual investigation before any structured next action,
  // so the truthful disposition is ADVISORY with zero suggested actions.
  recommendationDisposition: "ADVISORY",
  suggestedActions: [],
};

export const TOPIC_RUNBOOK_CASES: readonly EvaluationCase[] = [
  {
    id: "notification-service-degradation",
    description: "Retrieval, tool execution, and a valid grounded report for a notification-service degradation.",
    ticketContext: { ticketId: "EVAL-1", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("notification-service-degradation", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case1-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Issue #58 Checkpoint B: retrieval runs before this request, so
            // the run already holds RAG evidence (expectedTop1) — the A3 guard
            // forbids NO_EVIDENCE_YET here.
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
      { kind: "report_submission", usage: USAGE, rawInput: CASE_1_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-notification-degradation-001" },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case1-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case1-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
        requiredActionTypes: ["UPDATE_TICKET_STATUS"],
      },
      // Issue #59 Checkpoint B §8.3: the flagship accepted expectations —
      // PRESENT root cause, SUFFICIENT evidence grounded in the notification
      // tool result + runbook, an ACTIONABLE grounded action, approval
      // eligibility, the diagnostic sequence, and a voluntary SUFFICIENT stop.
      // Metric 3 is N/A (nonProbative is empty).
      expectedRootCause: "PRESENT",
      expectedEvidence: {
        state: "SUFFICIENT",
        requiredLocators: [
          { evidenceId: "case1-call-1", sourceType: "TOOL_EXECUTION" },
          { evidenceId: "runbook-notification-degradation-001", sourceType: "RAG_CHUNK" },
        ],
        requiresTelemetry: true,
        minDistinctLocators: 2,
      },
      expectedTelemetryEvidence: {
        probative: [{ evidenceId: "case1-call-1", sourceType: "TOOL_EXECUTION" }],
        nonProbative: [],
      },
      expectedDiagnostics: [{ evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" }],
      expectedStopReason: "SUFFICIENT_EVIDENCE",
      expectedConfidence: { min: 0.7, max: 0.95 },
      expectedActions: [
        {
          type: "UPDATE_TICKET_STATUS",
          requiredGrounding: [{ evidenceId: "case1-call-1", sourceType: "TOOL_EXECUTION" }],
          allowedGrounding: [
            { evidenceId: "case1-call-1", sourceType: "TOOL_EXECUTION" },
            { evidenceId: "runbook-notification-degradation-001", sourceType: "RAG_CHUNK" },
          ],
        },
      ],
      expectedApproval: "ELIGIBLE",
    },
  },
  {
    id: "notification-queue-backlog",
    description: "Retrieval hit@3 across two queue-backlog chunks, tool execution, and a valid grounded report.",
    ticketContext: { ticketId: "EVAL-2", summary: "Customers report a growing notification backlog." },
    retrievalQuery: "notification queue backlog",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("notification-queue-backlog", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case2-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "notification-service" },
            // Issue #58 Checkpoint B: retrieval runs before this request, so
            // the run already holds RAG evidence (expectedTop1) — the A3 guard
            // forbids NO_EVIDENCE_YET here.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-notification-queue-backlog-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_2_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: {
        expectedTop1: "runbook-notification-queue-backlog-001",
        expectedInTopK: [
          "runbook-notification-queue-backlog-001",
          "runbook-notification-queue-backlog-002",
        ],
      },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case2-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case2-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
    },
  },
  {
    id: "authentication-failure",
    description: "Retrieval hit@3 across two auth-failure chunks, tool execution, and a valid grounded report.",
    ticketContext: { ticketId: "EVAL-3", summary: "Customers cannot log in." },
    retrievalQuery: "authentication failures",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("authentication-failure", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case3-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "auth-service" },
            // Issue #58 Checkpoint B: retrieval runs before this request, so
            // the run already holds RAG evidence (expectedTop1) — the A3 guard
            // forbids NO_EVIDENCE_YET here.
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
      { kind: "report_submission", usage: USAGE, rawInput: CASE_3_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: {
        expectedTop1: "runbook-auth-failures-001",
        expectedInTopK: ["runbook-auth-failures-001", "runbook-auth-failures-002"],
      },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case3-call-1" }],
        expectedExecuted: [{ toolName: "get_service_status", input: { serviceSlug: "auth-service" } }],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case3-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION", "RAG_CHUNK"],
      },
    },
  },
  {
    id: "database-connection-saturation",
    description: "Single dominant retrieval hit, an unseeded tool status, and a valid grounded report.",
    ticketContext: { ticketId: "EVAL-4", summary: "Multiple services report intermittent timeouts." },
    retrievalQuery: "database connection pool saturation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("database-connection-saturation", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case4-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "database" },
            // Issue #58 Checkpoint B: retrieval runs before this request, so
            // the run already holds RAG evidence (expectedTop1) — the A3 guard
            // forbids NO_EVIDENCE_YET here.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-database-connection-saturation-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_4_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedTop1: "runbook-database-connection-saturation-001" },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case4-call-1" }],
        expectedExecuted: [{ toolName: "get_service_status", input: { serviceSlug: "database" } }],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case4-call-1" }],
      },
      report: { schemaExpectation: "VALID", groundingExpectation: "VALID" },
      // Issue #59 Checkpoint B §8.1: the UNKNOWN status result is treated as a
      // non-answer — no root cause, INSUFFICIENT evidence, low confidence.
      expectedRootCause: "ABSENT",
      expectedEvidence: { state: "INSUFFICIENT", requiredLocators: [] },
      expectedTelemetryEvidence: {
        probative: [],
        nonProbative: [{ evidenceId: "case4-call-1", sourceType: "TOOL_EXECUTION" }],
      },
      expectedConfidence: { min: 0.15, max: 0.45 },
      expectedApproval: "NOT_ELIGIBLE",
    },
  },
  {
    id: "billing-invoice-formatting",
    description: "Single dominant retrieval hit, a seeded outage tool status, and a valid grounded report.",
    ticketContext: { ticketId: "EVAL-5", summary: "Customers report misformatted invoice PDFs." },
    retrievalQuery: "billing invoice pdf formatting",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("billing-invoice-formatting", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case5-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "billing-service" },
            // Issue #58 Checkpoint B: retrieval runs before this request, so
            // the run already holds RAG evidence (expectedTop1) — the A3 guard
            // forbids NO_EVIDENCE_YET here.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "STATUS_UNRESOLVED",
              supportedBy: [
                {
                  evidenceId: "runbook-billing-invoice-formatting-001",
                  sourceType: "RAG_CHUNK",
                },
              ],
            },
          },
        ],
      },
      { kind: "report_submission", usage: USAGE, rawInput: CASE_5_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: {
        expectedTop1: "runbook-billing-invoice-formatting-001",
        forbiddenChunkIds: ["runbook-auth-failures-001"],
      },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case5-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "billing-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case5-call-1" }],
      },
      report: { schemaExpectation: "VALID", groundingExpectation: "VALID" },
    },
  },
  {
    id: "irrelevant-no-match-query",
    description: "A query with zero corpus overlap, tool-only evidence, and a valid grounded report.",
    ticketContext: { ticketId: "EVAL-6", summary: "An unrelated, unclassified issue is reported." },
    retrievalQuery: "spacecraft thermal calibration firmware",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: scenario("irrelevant-no-match-query", [
      {
        kind: "diagnostic_tool_requests",
        usage: USAGE,
        requests: [
          {
            toolCallId: "case6-call-1",
            toolName: "get_service_status",
            input: { serviceSlug: "unclassified-service" },
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
      { kind: "report_submission", usage: USAGE, rawInput: CASE_6_REPORT },
    ]),
    expectations: {
      runStatus: "completed",
      retrieval: { expectedNoResults: true },
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case6-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "unclassified-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case6-call-1" }],
      },
      report: {
        schemaExpectation: "VALID",
        groundingExpectation: "VALID",
        requiredEvidenceTypes: ["TOOL_EXECUTION"],
      },
      // Issue #59 Checkpoint B §8.4: the UNKNOWN unclassified-service result
      // is nonProbative and treated as a non-answer — no root cause,
      // INSUFFICIENT evidence, low confidence, and a voluntary stop. Metric 3
      // PASSes (the nonProbative locator was a completed tool call).
      expectedRootCause: "ABSENT",
      expectedEvidence: { state: "INSUFFICIENT", requiredLocators: [] },
      expectedTelemetryEvidence: {
        probative: [],
        nonProbative: [{ evidenceId: "case6-call-1", sourceType: "TOOL_EXECUTION" }],
      },
      expectedDiagnostics: [{ evidenceState: "INSUFFICIENT", continuationReason: "NO_EVIDENCE_YET" }],
      expectedStopReason: "NO_JUSTIFIED_DIAGNOSTIC",
      expectedConfidence: { min: 0.05, max: 0.35 },
      expectedApproval: "NOT_ELIGIBLE",
    },
  },
];
