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
          requests: [
            {
              toolCallId: "case9-call-1",
              toolName: "search_logs",
              input: {},
              // Issue #58 Checkpoint B: retrieval runs before this request, so
              // the run holds RAG evidence — the A2/A3 guards (which run before
              // the TOOL_NOT_FOUND failure) require a grounded, non-
              // NO_EVIDENCE_YET assessment.
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
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["search_logs"] },
      failure: { expectedCode: "TOOL_NOT_FOUND" },
      // Issue #59 Checkpoint B §8.6: the requested tool is never executed nor
      // completed, and no report is produced.
      expectedRecovery: {
        failedStage: "DIAGNOSTIC_EXECUTION",
        forbiddenCompletedToolCallIds: ["case9-call-1"],
        reportProduced: false,
      },
      expectedApproval: "NOT_ELIGIBLE",
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
            {
              toolCallId: "case10-call-1",
              toolName: "get_service_status",
              input: { serviceSlug: "" },
              // Issue #58 Checkpoint B: retrieval runs before this request, so
              // the run holds RAG evidence — the A2/A3 guards (which run before
              // the TOOL_INPUT_INVALID failure) require a grounded, non-
              // NO_EVIDENCE_YET assessment.
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
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["get_service_status"] },
      failure: { expectedCode: "TOOL_INPUT_INVALID" },
      // Issue #59 Checkpoint B §8.6: input validation fails before execution,
      // so the tool is never executed nor completed, and no report is produced.
      expectedRecovery: {
        failedStage: "DIAGNOSTIC_EXECUTION",
        forbiddenCompletedToolCallIds: ["case10-call-1"],
        reportProduced: false,
      },
      expectedApproval: "NOT_ELIGIBLE",
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
              // Issue #58 Checkpoint B: the two-request turn collapses to
              // PROVIDER_PROTOCOL_INVALID during normalization, before any
              // orchestrator guard reads the assessment — the rawAssessment is
              // present to satisfy the contract type, and kept run-state-
              // plausible (retrieval has run, so RAG evidence exists).
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
            {
              toolCallId: "case11-call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
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
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: { forbiddenExecutedToolNames: ["get_service_status"] },
      failure: { expectedCode: "PROVIDER_PROTOCOL_INVALID" },
      // Issue #59 Checkpoint B §8.6: the two-request turn normalizes to a
      // protocol error before any tool logic runs (turn 0, INVESTIGATION,
      // zero tool calls -> AGENT_ANALYSIS), so neither request is completed
      // and no report is produced.
      expectedRecovery: {
        failedStage: "AGENT_ANALYSIS",
        forbiddenCompletedToolCallIds: ["case11-call-1", "case11-call-2"],
        reportProduced: false,
      },
      expectedApproval: "NOT_ELIGIBLE",
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
              // Issue #58 Checkpoint B: first request; retrieval has run, so
              // the A3 guard forbids NO_EVIDENCE_YET — cite the available
              // RAG chunk.
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
              toolCallId: "case12-call-2",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // Issue #58 Checkpoint B: case12-call-1 completed, so its id is
              // now grounded evidence to cite.
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "case12-call-1", sourceType: "TOOL_EXECUTION" },
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
              toolCallId: "case12-call-3",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              // Issue #58 Checkpoint B: case12-call-1 and case12-call-2 both
              // completed, so both ids are grounded evidence to cite.
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "case12-call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "case12-call-2", sourceType: "TOOL_EXECUTION" },
                ],
              },
            },
          ],
        },
        {
          // The approved #57 bound is 3 diagnostic tool calls across the
          // investigation turns, then a reserved finalization turn. A fourth
          // tool request on that finalization turn is exactly the "missing
          // final report" protocol violation — the call is rejected before a
          // TOOL_REQUESTED is ever emitted. The rawAssessment is never read
          // (the finalization-turn guard fires first) but the contract type
          // still requires it.
          kind: "diagnostic_tool_requests",
          usage: USAGE,
          requests: [
            {
              toolCallId: "case12-call-4",
              toolName: "get_service_status",
              input: { serviceSlug: "notification-service" },
              rawAssessment: {
                evidenceState: "INSUFFICIENT",
                continuationReason: "STATUS_UNRESOLVED",
                supportedBy: [
                  { evidenceId: "case12-call-1", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "case12-call-2", sourceType: "TOOL_EXECUTION" },
                  { evidenceId: "case12-call-3", sourceType: "TOOL_EXECUTION" },
                ],
              },
            },
          ],
        },
      ],
    },
    expectations: {
      runStatus: "failed",
      tool: {
        expectedRequested: [
          { toolName: "get_service_status", toolCallId: "case12-call-1" },
          { toolName: "get_service_status", toolCallId: "case12-call-2" },
          { toolName: "get_service_status", toolCallId: "case12-call-3" },
        ],
        expectedExecuted: [
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
          { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
        ],
        expectedCompleted: [
          { toolName: "get_service_status", toolCallId: "case12-call-1" },
          { toolName: "get_service_status", toolCallId: "case12-call-2" },
          { toolName: "get_service_status", toolCallId: "case12-call-3" },
        ],
        forbiddenCompletedToolCallIds: ["case12-call-4"],
      },
      failure: { expectedCode: "PROVIDER_PROTOCOL_INVALID" },
      // Issue #59 Checkpoint B §8.5: the 3 successful diagnostics are declared
      // as the sequence, the 4 consumed provider turns cap the token budget at
      // 4 x 120 = 480, and — §8.6 — the rejected 4th call never completes and
      // no report is produced.
      expectedDiagnostics: [
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
        { evidenceState: "INSUFFICIENT", continuationReason: "STATUS_UNRESOLVED" },
      ],
      expectedBounds: { maxTotalTokens: 480 },
      expectedRecovery: {
        failedStage: "REPORT_GENERATION",
        forbiddenCompletedToolCallIds: ["case12-call-4"],
        reportProduced: false,
      },
      expectedApproval: "NOT_ELIGIBLE",
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
          requests: [
            {
              toolCallId: "case13-call-1",
              toolName: "always_fails",
              input: {},
              // Issue #58 Checkpoint B: retrieval runs before this request, so
              // the run holds RAG evidence — the A2/A3 guards (which run before
              // the TOOL_EXECUTION_FAILED failure) require a grounded, non-
              // NO_EVIDENCE_YET assessment.
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
      // Issue #59 Checkpoint B §8.6: the failing tool never completes and no
      // report is produced.
      expectedRecovery: {
        failedStage: "DIAGNOSTIC_EXECUTION",
        forbiddenCompletedToolCallIds: ["case13-call-1"],
        reportProduced: false,
      },
      expectedApproval: "NOT_ELIGIBLE",
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
      // Issue #59 Checkpoint B §8.6: the malformed report fails schema
      // validation, so no report object is produced and no tool ever ran.
      expectedRecovery: { failedStage: "REPORT_GENERATION", reportProduced: false },
      expectedApproval: "NOT_ELIGIBLE",
    },
  },
];
