import { AgentRunServiceError } from "@opspilot/agent-runtime";
import { AgentRunApprovalError, PersistenceError } from "@opspilot/database";

import { ApiError } from "./api-error";

// Identifies which repository/service operation produced a PersistenceError
// so PERSISTENCE_NOT_FOUND (which is context-free at the database layer) can
// be mapped to the correct public 404 — see docs/12-agent-run-api.md and
// Agent Run API plan §9.
export type DomainErrorContext =
  | "createAgentJob"
  | "getAgentJob"
  | "getAgentRun"
  | "run-creation"
  | "finalization"
  | "recordApprovalDecision"
  | "getApprovalDecision";

// Maps a PersistenceError based on operation context:
//   create/write conflict            -> 409 PERSISTENCE_CONFLICT
//   database unavailable             -> 503 PERSISTENCE_UNAVAILABLE
//   stored-data validation failure   -> 500 INTERNAL_DATA_INVALID
//   job read not found               -> 404 AGENT_JOB_NOT_FOUND
//   run read not found               -> 404 AGENT_RUN_NOT_FOUND
//   run-creation stage not found     -> 404 AGENT_JOB_NOT_FOUND
//   finalization-stage not found     -> 500 INTERNAL_DATA_INVALID
//   approval read/write not found    -> 404 AGENT_RUN_NOT_FOUND
// AgentRunApprovalError is a separate, closed error type for domain-level
// approval facts discovered from valid data (not eligible / already
// decided) — never a PersistenceError code (docs/13-approval-workflow.md
// §9). AgentRunServiceError always maps to 500 AGENT_EXECUTION_CRASHED with
// its stable runId attached. Every other thrown value maps to a fixed
// INTERNAL_ERROR — never a raw exception is allowed to reach a response.
export function mapDomainError(error: unknown, context: DomainErrorContext): ApiError {
  if (error instanceof AgentRunApprovalError) {
    switch (error.code) {
      case "RUN_NOT_APPROVAL_ELIGIBLE":
        return new ApiError("AGENT_RUN_NOT_APPROVAL_ELIGIBLE", { runId: error.runId, cause: error });
      case "APPROVAL_ALREADY_DECIDED":
        return new ApiError("AGENT_RUN_APPROVAL_ALREADY_DECIDED", { runId: error.runId, cause: error });
    }
  }

  if (error instanceof PersistenceError) {
    switch (error.code) {
      case "PERSISTENCE_CONFLICT":
        return new ApiError("PERSISTENCE_CONFLICT", { cause: error });
      case "PERSISTENCE_UNAVAILABLE":
        return new ApiError("PERSISTENCE_UNAVAILABLE", { cause: error });
      case "PERSISTENCE_VALIDATION_FAILED":
        return new ApiError("INTERNAL_DATA_INVALID", { cause: error });
      case "PERSISTENCE_NOT_FOUND":
        if (context === "getAgentJob" || context === "run-creation") {
          return new ApiError("AGENT_JOB_NOT_FOUND", { cause: error });
        }
        if (context === "getAgentRun" || context === "recordApprovalDecision" || context === "getApprovalDecision") {
          return new ApiError("AGENT_RUN_NOT_FOUND", { cause: error });
        }
        if (context === "finalization") {
          return new ApiError("INTERNAL_DATA_INVALID", { cause: error });
        }
        return new ApiError("INTERNAL_ERROR", { cause: error });
    }
  }

  if (error instanceof AgentRunServiceError) {
    return new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
  }

  return new ApiError("INTERNAL_ERROR", { cause: error });
}
