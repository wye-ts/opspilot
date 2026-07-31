import { describe, expect, it, vi } from "vitest";

import { logReportValidationFailure } from "./report-validation-log";

describe("logReportValidationFailure", () => {
  it("emits exactly one JSON line containing only the sanitized fields, never a secret or raw value", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    logReportValidationFailure({
      runId: "run-1",
      providerMode: "LIVE",
      modelIdentifier: "claude-sonnet-5",
      issues: [{ path: ["confidence"], code: "too_big", origin: "number", bound: 1 }],
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0]?.[0];
    expect(() => JSON.parse(line as string)).not.toThrow();
    expect(JSON.parse(line as string)).toEqual({
      event: "report_schema_invalid",
      runId: "run-1",
      providerMode: "LIVE",
      model: "claude-sonnet-5",
      issues: [{ path: ["confidence"], code: "too_big", origin: "number", bound: 1 }],
    });

    logSpy.mockRestore();
  });
});
