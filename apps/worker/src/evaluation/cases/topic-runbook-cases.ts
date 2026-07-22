import type { ResolutionReport } from "@opspilot/contracts";

import type { FakeAgentScenario } from "../../providers/fake-llm-provider";
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
    "Monitor notification-service and follow the degradation runbook until status recovers.",
  confidence: 0.85,
  evidence: [
    {
      evidenceId: "case1-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
    },
    {
      evidenceId: "runbook-notification-degradation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook confirms this is a known notification-service degradation pattern.",
    },
  ],
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Investigating notification-service degradation." },
    },
  ],
};

const CASE_2_REPORT: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "A backlog has formed in the notification queue.",
  rootCause: "notification-service reported DEGRADED while a queue backlog builds up.",
  customerImpact: "Customers are experiencing delayed emails and push notifications.",
  recommendedResolution:
    "Scale the notification worker pool and monitor downstream provider status per the queue-backlog runbook.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "case2-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "notification-service reported status DEGRADED.",
    },
    {
      evidenceId: "runbook-notification-queue-backlog-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes a growing notification queue backlog.",
    },
    {
      evidenceId: "runbook-notification-queue-backlog-002",
      sourceType: "RAG_CHUNK",
      finding: "Runbook remediation steps for a notification queue backlog.",
    },
  ],
  suggestedActions: [
    {
      type: "UPDATE_TICKET_STATUS",
      payload: { status: "IN_PROGRESS", reason: "Scaling notification workers to clear the backlog." },
    },
  ],
};

const CASE_3_REPORT: ResolutionReport = {
  category: "AUTHENTICATION",
  summary: "Customers are experiencing authentication failures.",
  rootCause: "Elevated 401 responses correlated with a recent auth-service deploy.",
  customerImpact: "Customers are unable to log in.",
  recommendedResolution:
    "Correlate the failures with the most recent auth-service deploy and check for signing-key or clock-drift issues per the runbook.",
  confidence: 0.75,
  evidence: [
    {
      evidenceId: "case3-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "auth-service reported status OPERATIONAL.",
    },
    {
      evidenceId: "runbook-auth-failures-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes authentication failure symptoms.",
    },
    {
      evidenceId: "runbook-auth-failures-002",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes authentication failure root causes.",
    },
  ],
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Identity",
        reason: "Investigate elevated authentication failures.",
        priority: "HIGH",
      },
    },
  ],
};

const CASE_4_REPORT: ResolutionReport = {
  category: "CONFIGURATION",
  summary: "Database connection pool saturation is causing intermittent timeouts.",
  rootCause: "Connection pool saturation across services sharing the database.",
  customerImpact: "Customers may experience intermittent timeouts.",
  recommendedResolution:
    "Check active connection count against pool size and investigate long-running queries per the runbook.",
  confidence: 0.7,
  evidence: [
    {
      evidenceId: "case4-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "database status could not be confirmed (UNKNOWN).",
    },
    {
      evidenceId: "runbook-database-connection-saturation-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes database connection pool saturation.",
    },
  ],
  suggestedActions: [],
};

const CASE_5_REPORT: ResolutionReport = {
  category: "DATA_QUALITY",
  summary: "Billing invoice PDFs are misformatted.",
  rootCause: "A template version mismatch after a billing-service deploy.",
  customerImpact: "Customers are receiving invoices with misaligned totals or missing line items.",
  recommendedResolution: "Roll back or fix the invoice template version per the runbook.",
  confidence: 0.8,
  evidence: [
    {
      evidenceId: "case5-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "billing-service reported status OUTAGE.",
    },
    {
      evidenceId: "runbook-billing-invoice-formatting-001",
      sourceType: "RAG_CHUNK",
      finding: "Runbook describes billing invoice PDF formatting issues.",
    },
  ],
  suggestedActions: [
    {
      type: "DRAFT_CUSTOMER_REPLY",
      payload: {
        subject: "Invoice formatting issue",
        body: "We are aware of an issue affecting invoice PDF formatting and are working on a fix.",
      },
    },
  ],
};

const CASE_6_REPORT: ResolutionReport = {
  category: "UNKNOWN",
  summary: "No known runbook matches this query; status could not be determined from available evidence.",
  rootCause: "Unable to determine a root cause from available evidence.",
  customerImpact: "Impact could not be determined from available evidence.",
  recommendedResolution: "Escalate for manual investigation.",
  confidence: 0.2,
  evidence: [
    {
      evidenceId: "case6-call-1",
      sourceType: "TOOL_EXECUTION",
      finding: "unclassified-service status could not be confirmed (UNKNOWN).",
    },
  ],
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
          { toolCallId: "case3-call-1", toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
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
          { toolCallId: "case4-call-1", toolName: "get_service_status", input: { serviceSlug: "database" } },
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
    },
  },
];
