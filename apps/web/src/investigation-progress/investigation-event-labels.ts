import type { InvestigationEventRecordPayload } from "@opspilot/contracts";

// The frozen friendly-name allowlist for known diagnostic tools. An unknown
// tool identifier must never be interpolated into a label — it degrades to
// the generic wording below instead.
const KNOWN_TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  get_service_status: "Get service status",
};

/**
 * Formats an investigation event (canonical or legacy) into the label shown
 * nested under its execution-stage row. Presentation copy only — never raw
 * payload fields, provider content, or failure codes.
 */
export function formatInvestigationEventLabel(
  payload: InvestigationEventRecordPayload,
): string {
  switch (payload.type) {
    case "RUN_CREATED":
      return "Run created";
    case "AGENT_STARTED":
      return "Agent started";
    case "RETRIEVAL_COMPLETED":
      return "Runbook retrieval completed";
    case "TOOL_REQUESTED": {
      const display = KNOWN_TOOL_DISPLAY_NAMES[payload.toolName];
      return display !== undefined
        ? `Tool requested: ${display}`
        : "Tool requested";
    }
    case "TOOL_COMPLETED": {
      const display = KNOWN_TOOL_DISPLAY_NAMES[payload.toolName];
      return display !== undefined
        ? `Tool completed: ${display}`
        : "Tool completed";
    }
    case "TOOL_FAILED": {
      const display = KNOWN_TOOL_DISPLAY_NAMES[payload.toolName];
      return display !== undefined
        ? `Tool failed: ${display}`
        : "Tool failed";
    }
    case "REPORT_GENERATION_STARTED":
      return "Report generation started";
    case "REPORT_SUBMITTED":
      return "Report submitted";
    case "REPORT_VALIDATED":
      return "Report validated";
    case "REPORT_VALIDATION_FAILED":
      return "Report validation failed";
    case "RUN_COMPLETED":
      return "Run completed";
    case "RUN_FAILED":
      return "Run failed";
    case "REPORT_GENERATED":
      return "Report generated";
  }
}
