import { AgentRunServiceError } from "@opspilot/agent-runtime";
import { PersistenceError } from "@opspilot/database";
import { describe, expect, it } from "vitest";

import { mapDomainError } from "./map-domain-error";

describe("mapDomainError", () => {
  it("maps PERSISTENCE_CONFLICT to 409 PERSISTENCE_CONFLICT regardless of context", () => {
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
});
