import type { ArgumentsHost } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../errors/api-error";
import { AllExceptionsFilter } from "./all-exceptions.filter";

function buildHost(requestId: string | undefined): {
  host: ArgumentsHost;
  statusMock: ReturnType<typeof vi.fn>;
  jsonMock: ReturnType<typeof vi.fn>;
} {
  const jsonMock = vi.fn();
  const statusMock = vi.fn().mockReturnValue({ json: jsonMock });
  const request = { requestId };
  const response = { status: statusMock };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, statusMock, jsonMock };
}

describe("AllExceptionsFilter", () => {
  it("serializes an ApiError with the exact envelope shape and its own status/code/message", () => {
    const filter = new AllExceptionsFilter();
    const { host, statusMock, jsonMock } = buildHost("req-1");

    filter.catch(new ApiError("AGENT_JOB_NOT_FOUND"), host);

    expect(statusMock).toHaveBeenCalledWith(404);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: "AGENT_JOB_NOT_FOUND",
        message: "The requested agent job was not found.",
        requestId: "req-1",
      },
    });
  });

  it("includes runId only for AGENT_EXECUTION_CRASHED", () => {
    const filter = new AllExceptionsFilter();
    const { host, jsonMock } = buildHost("req-2");

    filter.catch(new ApiError("AGENT_EXECUTION_CRASHED", { runId: "run-9" }), host);

    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: "AGENT_EXECUTION_CRASHED",
        message: "The agent execution terminated unexpectedly.",
        requestId: "req-2",
        runId: "run-9",
      },
    });
  });

  it("normalizes an unrecognized exception to a fixed INTERNAL_ERROR envelope", () => {
    const filter = new AllExceptionsFilter();
    const { host, statusMock, jsonMock } = buildHost("req-3");
    const sentinelSecret = "sk-super-secret-do-not-leak";

    filter.catch(new Error(`raw failure containing ${sentinelSecret}`), host);

    expect(statusMock).toHaveBeenCalledWith(500);
    const payload = jsonMock.mock.calls[0]?.[0];
    expect(payload).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
        requestId: "req-3",
      },
    });
    expect(JSON.stringify(payload)).not.toContain(sentinelSecret);
  });

  it("normalizes a non-Error throw (e.g. a raw string) to a fixed INTERNAL_ERROR envelope", () => {
    const filter = new AllExceptionsFilter();
    const { host, statusMock, jsonMock } = buildHost("req-4");

    filter.catch("raw string throw", host);

    expect(statusMock).toHaveBeenCalledWith(500);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
        requestId: "req-4",
      },
    });
  });

  it("falls back to 'unknown' when no requestId was attached to the request", () => {
    const filter = new AllExceptionsFilter();
    const { host, jsonMock } = buildHost(undefined);

    filter.catch(new ApiError("INTERNAL_ERROR"), host);

    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected internal error occurred.",
        requestId: "unknown",
      },
    });
  });
});
