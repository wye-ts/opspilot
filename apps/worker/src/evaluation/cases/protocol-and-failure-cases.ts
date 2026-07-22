import type { EvaluationCase } from "../types";

const USAGE = { inputTokens: 100, outputTokens: 20 };

// Missing every field but `category` — ResolutionReportSchema.safeParse fails
// before any evidence check runs.
const MALFORMED_REPORT_RAW_INPUT: unknown = {
  category: "SERVICE_DEGRADATION",
};

export const PROTOCOL_AND_FAILURE_CASES: readonly EvaluationCase[] = [
  {
    id: "unknown-tool-request",
    description: "A request for a never-registered tool must fail TOOL_NOT_FOUND without ever executing anything.",
    ticketContext: { ticketId: "EVAL-9", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: {
      id: "unknown-tool-request",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [{ toolCallId: "case9-call-1", toolName: "search_logs", input: {} }],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["search_logs"] },
      failure: { expectedCode: "TOOL_NOT_FOUND" },
    },
  },
  {
    id: "invalid-tool-input",
    description: "Input failing the registered tool's own input schema must fail TOOL_INPUT_INVALID before execution.",
    ticketContext: { ticketId: "EVAL-10", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: {
      id: "invalid-tool-input",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [
            { toolCallId: "case10-call-1", toolName: "get_service_status", input: { serviceSlug: "" } },
          ],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["get_service_status"] },
      failure: { expectedCode: "TOOL_INPUT_INVALID" },
    },
  },
  {
    id: "provider-protocol-error",
    description: "Two diagnostic tool requests in a single turn must normalize to PROVIDER_PROTOCOL_INVALID before any tool logic runs.",
    ticketContext: { ticketId: "EVAL-11", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: {
      id: "provider-protocol-error",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [
            {
              toolCallId: "case11-call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
            },
            {
              toolCallId: "case11-call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
            },
          ],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["get_service_status"] },
      failure: { expectedCode: "PROVIDER_PROTOCOL_INVALID" },
    },
  },
  {
    id: "missing-final-report",
    description: "A diagnostic tool request on the finalization turn, instead of a report submission, must fail PROVIDER_PROTOCOL_INVALID.",
    ticketContext: { ticketId: "EVAL-12", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: {
      id: "missing-final-report",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [
            {
              toolCallId: "case12-call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
            },
          ],
        },
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [
            {
              toolCallId: "case12-call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
            },
          ],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: {
        expectedRequested: [{ toolName: "get_service_status", toolCallId: "case12-call-1" }],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
        ],
        expectedCompleted: [{ toolName: "get_service_status", toolCallId: "case12-call-1" }],
      },
      failure: { expectedCode: "PROVIDER_PROTOCOL_INVALID" },
    },
  },
  {
    id: "tool-execution-failure",
    description: "A tool whose execute() always throws must fail TOOL_EXECUTION_FAILED after being requested but never completed.",
    ticketContext: { ticketId: "EVAL-13", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "with-always-fails-tool",
    scenario: {
      id: "tool-execution-failure",
      turns: [
        {
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [{ toolCallId: "case13-call-1", toolName: "always_fails", input: {} }],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: {
        expectedRequested: [{ toolName: "always_fails", toolCallId: "case13-call-1" }],
        expectedExecuted: [{ toolName: "always_fails", input: {} }],
        forbiddenCompletedToolCallIds: ["case13-call-1"],
      },
      failure: { expectedCode: "TOOL_EXECUTION_FAILED" },
    },
  },
  {
    id: "malformed-report-submission",
    description: "A report submission missing required fields must fail REPORT_SCHEMA_INVALID before any evidence check runs.",
    ticketContext: { ticketId: "EVAL-14", summary: "Customers report delayed notification emails." },
    retrievalQuery: "notification service degradation",
    corpusProfile: "default",
    toolProfile: "default",
    scenario: {
      id: "malformed-report-submission",
      turns: [{ kind: "report_submission", usage: USAGE, rawInput: MALFORMED_REPORT_RAW_INPUT }],
    },
    expectations: {
      runStatus: "failed",
      report: { schemaExpectation: "INVALID" },
      failure: { expectedCode: "REPORT_SCHEMA_INVALID" },
    },
  },
];
