import { describe, expect, it, vi } from "vitest";

import { logEventEmissionFailure } from "./event-emission-log";

describe("logEventEmissionFailure", () => {
  it("emits one line of JSON with only safe closed values", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logEventEmissionFailure({
      runId: "8f14e45f-1234-4abc-8def-000000000001",
      attemptedEventType: "TOOL_REQUESTED",
      persistenceErrorCode: "PERSISTENCE_UNAVAILABLE",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toEqual({
      event: "investigation_event_emission_failed",
      runId: "8f14e45f-1234-4abc-8def-000000000001",
      attemptedEventType: "TOOL_REQUESTED",
      persistenceErrorCode: "PERSISTENCE_UNAVAILABLE",
    });
    spy.mockRestore();
  });

  it("includes the reducer's contract error code when the write was refused as invalid", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logEventEmissionFailure({
      runId: "8f14e45f-1234-4abc-8def-000000000002",
      attemptedEventType: "REPORT_SUBMITTED",
      persistenceErrorCode: "PERSISTENCE_EVENT_STREAM_INVALID",
      contractErrorCode: "OPEN_TOOL_CALL",
    });

    expect(JSON.parse(spy.mock.calls[0]?.[0] as string)).toMatchObject({
      persistenceErrorCode: "PERSISTENCE_EVENT_STREAM_INVALID",
      contractErrorCode: "OPEN_TOOL_CALL",
    });
    spy.mockRestore();
  });

  it("never throws, so a logging failure cannot affect execution", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("stdout is gone");
    });

    expect(() =>
      logEventEmissionFailure({
        runId: "8f14e45f-1234-4abc-8def-000000000003",
        attemptedEventType: "AGENT_STARTED",
        persistenceErrorCode: "PERSISTENCE_UNAVAILABLE",
      }),
    ).not.toThrow();
    spy.mockRestore();
  });
});
