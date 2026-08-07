import { AgentRunServiceError } from "@opspilot/agent-runtime";
import { AgentRunApprovalError, PersistenceError } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { mapDomainError } from "./map-domain-error";

describe("mapDomainError", () => {
  it("maps PERSISTENCE_CONFLICT to 409 PERSISTENCE_CONFLICT in a client-resolvable context", () => {
    const error = new PersistenceError("PERSISTENCE_CONFLICT", "conflict");
    const apiError = mapDomainError(error, "createAgentJob");
    expect(apiError.code).toBe("PERSISTENCE_CONFLICT");
    expect(apiError.status).toBe(409);
  });

  it("maps PERSISTENCE_UNAVAILABLE to 503 PERSISTENCE_UNAVAILABLE", () => {
    const error = new PersistenceError("PERSISTENCE_UNAVAILABLE", "down");
    const apiError = mapDomainError(error, "getAgentJob");
    expect(apiError.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(apiError.status).toBe(503);
  });

  it("maps PERSISTENCE_VALIDATION_FAILED to 500 INTERNAL_DATA_INVALID", () => {
    const error = new PersistenceError("PERSISTENCE_VALIDATION_FAILED", "bad stored data");
    const apiError = mapDomainError(error, "getAgentRun");
    expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
    expect(apiError.status).toBe(500);
  });

  it("maps PERSISTENCE_NOT_FOUND in getAgentJob context to 404 AGENT_JOB_NOT_FOUND", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no job");
    const apiError = mapDomainError(error, "getAgentJob");
    expect(apiError.code).toBe("AGENT_JOB_NOT_FOUND");
    expect(apiError.status).toBe(404);
  });

  it("maps PERSISTENCE_NOT_FOUND in getAgentRun context to 404 AGENT_RUN_NOT_FOUND", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no run");
    const apiError = mapDomainError(error, "getAgentRun");
    expect(apiError.code).toBe("AGENT_RUN_NOT_FOUND");
    expect(apiError.status).toBe(404);
  });

  it("maps PERSISTENCE_NOT_FOUND in run-creation context to 404 AGENT_JOB_NOT_FOUND", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no job for run-creation");
    const apiError = mapDomainError(error, "run-creation");
    expect(apiError.code).toBe("AGENT_JOB_NOT_FOUND");
    expect(apiError.status).toBe(404);
  });

  it("maps PERSISTENCE_NOT_FOUND in finalization context to 500 INTERNAL_DATA_INVALID", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "run vanished during finalization");
    const apiError = mapDomainError(error, "finalization");
    expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
    expect(apiError.status).toBe(500);
  });

  it("maps AgentRunServiceError to 500 AGENT_EXECUTION_CRASHED with the stable runId", () => {
    const error = new AgentRunServiceError("AGENT_EXECUTION_CRASHED", "run-123", { cause: new Error("boom") });
    const apiError = mapDomainError(error, "run-creation");
    expect(apiError.code).toBe("AGENT_EXECUTION_CRASHED");
    expect(apiError.status).toBe(500);
    expect(apiError.runId).toBe("run-123");
  });

  it("maps an unknown Error throw to a fixed INTERNAL_ERROR", () => {
    const apiError = mapDomainError(new Error("some raw internal detail"), "getAgentJob");
    expect(apiError.code).toBe("INTERNAL_ERROR");
    expect(apiError.status).toBe(500);
    expect(apiError.message).not.toContain("some raw internal detail");
  });

  it("maps a non-Error throw (string) to a fixed INTERNAL_ERROR", () => {
    const apiError = mapDomainError("raw string throw", "getAgentRun");
    expect(apiError.code).toBe("INTERNAL_ERROR");
    expect(apiError.status).toBe(500);
  });

  it("never leaks the underlying error's message onto the mapped ApiError message", () => {
    const error = new PersistenceError("PERSISTENCE_UNAVAILABLE", "raw db connection string leak attempt");
    const apiError = mapDomainError(error, "getAgentJob");
    expect(apiError.message).toBe("The database is temporarily unavailable.");
  });

  it("maps AgentRunApprovalError(RUN_NOT_APPROVAL_ELIGIBLE) to 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE regardless of context", () => {
    const error = new AgentRunApprovalError("RUN_NOT_APPROVAL_ELIGIBLE", "run-1");
    const apiError = mapDomainError(error, "recordApprovalDecision");
    expect(apiError.code).toBe("AGENT_RUN_NOT_APPROVAL_ELIGIBLE");
    expect(apiError.status).toBe(409);
  });

  it("maps AgentRunApprovalError(APPROVAL_ALREADY_DECIDED) to 409 AGENT_RUN_APPROVAL_ALREADY_DECIDED, preserving runId", () => {
    const error = new AgentRunApprovalError("APPROVAL_ALREADY_DECIDED", "run-1");
    const apiError = mapDomainError(error, "recordApprovalDecision");
    expect(apiError.code).toBe("AGENT_RUN_APPROVAL_ALREADY_DECIDED");
    expect(apiError.status).toBe(409);
    expect(apiError.runId).toBe("run-1");
  });

  it("maps PERSISTENCE_NOT_FOUND with context recordApprovalDecision to 404 AGENT_RUN_NOT_FOUND", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no run");
    const apiError = mapDomainError(error, "recordApprovalDecision");
    expect(apiError.code).toBe("AGENT_RUN_NOT_FOUND");
    expect(apiError.status).toBe(404);
  });

  it("maps PERSISTENCE_NOT_FOUND with context getApprovalDecision to 404 AGENT_RUN_NOT_FOUND", () => {
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "no run");
    const apiError = mapDomainError(error, "getApprovalDecision");
    expect(apiError.code).toBe("AGENT_RUN_NOT_FOUND");
    expect(apiError.status).toBe(404);
  });

  it.each(["recordApprovalDecision", "getApprovalDecision"] as const)(
    "maps PERSISTENCE_VALIDATION_FAILED with context %s to 500 INTERNAL_DATA_INVALID (existing context-independent case)",
    (context) => {
      const error = new PersistenceError("PERSISTENCE_VALIDATION_FAILED", "bad stored data");
      const apiError = mapDomainError(error, context);
      expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
      expect(apiError.status).toBe(500);
    },
  );

  it.each(["recordApprovalDecision", "getApprovalDecision"] as const)(
    "maps PERSISTENCE_UNAVAILABLE with context %s to 503 PERSISTENCE_UNAVAILABLE (existing context-independent case)",
    (context) => {
      const error = new PersistenceError("PERSISTENCE_UNAVAILABLE", "down");
      const apiError = mapDomainError(error, context);
      expect(apiError.code).toBe("PERSISTENCE_UNAVAILABLE");
      expect(apiError.status).toBe(503);
    },
  );

  it.each(["recordApprovalDecision", "getApprovalDecision"] as const)(
    "maps PERSISTENCE_CONFLICT with context %s to 409 PERSISTENCE_CONFLICT (existing context-independent case, defense-in-depth backstop)",
    (context) => {
      const error = new PersistenceError("PERSISTENCE_CONFLICT", "conflict");
      const apiError = mapDomainError(error, context);
      expect(apiError.code).toBe("PERSISTENCE_CONFLICT");
      expect(apiError.status).toBe(409);
    },
  );

  // Issue #37 Phase B — canonical lifecycle persistence failures.
  it("maps PERSISTENCE_UNAVAILABLE during event emission to 503, the existing public behavior", () => {
    const error = new PersistenceError("PERSISTENCE_UNAVAILABLE", "ledger down");
    const apiError = mapDomainError(error, "event-emission");
    expect(apiError.code).toBe("PERSISTENCE_UNAVAILABLE");
    expect(apiError.status).toBe(503);
  });

  it.each(["event-emission", "finalization", "getAgentRun"] as const)(
    "maps PERSISTENCE_EVENT_STREAM_INVALID to 500 INTERNAL_DATA_INVALID in context %s",
    (context) => {
      // An emitter/repository contract defect or stored corruption — never a
      // client mistake and never transient, so it is a 500 in every context.
      // Deliberately reuses an existing public code: no new public error code
      // is added merely for lifecycle persistence.
      const error = new PersistenceError("PERSISTENCE_EVENT_STREAM_INVALID", "stream invalid");
      const apiError = mapDomainError(error, context);
      expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
      expect(apiError.status).toBe(500);
    },
  );

  it("maps PERSISTENCE_NOT_FOUND during event emission to 500 INTERNAL_DATA_INVALID, not a 404", () => {
    // The run demonstrably existed — it was created and was executing — so a
    // missing row here is stored-data corruption, not a client naming
    // something that never existed.
    const error = new PersistenceError("PERSISTENCE_NOT_FOUND", "run vanished");
    const apiError = mapDomainError(error, "event-emission");
    expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
    expect(apiError.status).toBe(500);
  });

  // Codex Phase B review, finding M3: a canonical append conflict discovered
  // during event emission is an internal ledger/emitter inconsistency the
  // client cannot resolve — it must map to 500 INTERNAL_DATA_INVALID, never
  // the general client-facing 409.
  describe("PERSISTENCE_CONFLICT context override (finding M3)", () => {
    it("maps PERSISTENCE_CONFLICT in event-emission context to 500 INTERNAL_DATA_INVALID", () => {
      const error = new PersistenceError("PERSISTENCE_CONFLICT", "conflict");
      const apiError = mapDomainError(error, "event-emission");
      expect(apiError.code).toBe("INTERNAL_DATA_INVALID");
      expect(apiError.status).toBe(500);
    });

    it.each(["createAgentJob", "finalization", "recordApprovalDecision", "getApprovalDecision"] as const)(
      "leaves PERSISTENCE_CONFLICT at 409 in the genuinely client-resolvable context %s (regression)",
      (context) => {
        const error = new PersistenceError("PERSISTENCE_CONFLICT", "conflict");
        const apiError = mapDomainError(error, context);
        expect(apiError.code).toBe("PERSISTENCE_CONFLICT");
        expect(apiError.status).toBe(409);
      },
    );

    it("does not leak the underlying PersistenceError message into the public response", () => {
      const error = new PersistenceError(
        "PERSISTENCE_CONFLICT",
        "AgentRun 8f14e45f-... already carries a different TOOL_REQUESTED payload",
      );
      const apiError = mapDomainError(error, "event-emission");

      // The response is the fixed public message for INTERNAL_DATA_INVALID —
      // internal event/ledger detail (run ids, event types, payload content)
      // is retained only as `.cause` for internal logging, never surfaced to
      // the client.
      expect(apiError.message).not.toContain("TOOL_REQUESTED");
      expect(apiError.message).not.toContain("8f14e45f");
      expect(JSON.stringify(apiError)).not.toContain("TOOL_REQUESTED");
    });
  });
});
