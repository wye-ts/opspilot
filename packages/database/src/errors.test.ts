import { describe, expect, it } from "vitest";

import { normalizeDatabaseError, PersistenceError } from "./errors";

describe("normalizeDatabaseError", () => {
  it("passes an existing PersistenceError through unchanged", () => {
    const original = new PersistenceError("PERSISTENCE_NOT_FOUND", "not found");
    expect(normalizeDatabaseError(original, "context")).toBe(original);
  });

  it("maps a unique-violation driver code to PERSISTENCE_CONFLICT", () => {
    const result = normalizeDatabaseError({ code: "P2002" }, "createJob");
    expect(result.code).toBe("PERSISTENCE_CONFLICT");
  });

  it("maps a raw Postgres unique_violation SQLSTATE to PERSISTENCE_CONFLICT", () => {
    const result = normalizeDatabaseError({ meta: { code: "23505" } }, "createJob");
    expect(result.code).toBe("PERSISTENCE_CONFLICT");
  });

  it("maps a check_violation SQLSTATE to PERSISTENCE_CONFLICT", () => {
    const result = normalizeDatabaseError({ meta: { code: "23514" } }, "finalizeCompleted");
    expect(result.code).toBe("PERSISTENCE_CONFLICT");
  });

  it("maps a not-found driver code to PERSISTENCE_NOT_FOUND", () => {
    const result = normalizeDatabaseError({ code: "P2025" }, "getAgentRun");
    expect(result.code).toBe("PERSISTENCE_NOT_FOUND");
  });

  it("maps a connection-refused code to PERSISTENCE_UNAVAILABLE", () => {
    const result = normalizeDatabaseError({ code: "ECONNREFUSED" }, "startRun");
    expect(result.code).toBe("PERSISTENCE_UNAVAILABLE");
  });

  it("defaults an unrecognized error to PERSISTENCE_UNAVAILABLE", () => {
    const result = normalizeDatabaseError(new Error("something odd"), "startRun");
    expect(result.code).toBe("PERSISTENCE_UNAVAILABLE");
  });

  it("never includes the raw driver message, connection string, or SQL text in .message", () => {
    const rawError = new Error(
      "connection to server at postgres://opspilot:hunter2@localhost:55432/opspilot failed: SELECT * FROM agent_runs",
    );
    const result = normalizeDatabaseError(rawError, "startRun");
    expect(result.message).not.toContain("hunter2");
    expect(result.message).not.toContain("postgres://");
    expect(result.message).not.toContain("SELECT");
    expect(result.cause).toBe(rawError);
  });
});
