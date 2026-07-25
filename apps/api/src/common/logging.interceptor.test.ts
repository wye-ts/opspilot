import { EventEmitter } from "node:events";

import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { describe, expect, it, vi } from "vitest";

import { LoggingInterceptor } from "./logging.interceptor";

class FakeResponse extends EventEmitter {
  statusCode = 200;
}

interface FakeRequest {
  method: string;
  path: string;
  originalUrl?: string;
  route?: { path: string };
  requestId?: string;
  body?: unknown;
}

function buildContext(request: FakeRequest, response: FakeResponse): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function buildCallHandler(): CallHandler {
  return { handle: () => of({ data: "ok" }) };
}

describe("LoggingInterceptor", () => {
  it("logs exactly once, after the response finishes, with the final status code", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const request: FakeRequest = { method: "GET", path: "/v1/agent-jobs/abc", requestId: "req-1" };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();

    expect(logSpy).not.toHaveBeenCalled();

    response.statusCode = 404;
    response.emit("finish");

    expect(logSpy).toHaveBeenCalledTimes(1);
    const [line] = logSpy.mock.calls[0] as [string];
    const parsed = JSON.parse(line);
    expect(parsed).toMatchObject({
      method: "GET",
      route: "/v1/agent-jobs/abc",
      status: 404,
      requestId: "req-1",
    });
    expect(typeof parsed.durationMs).toBe("number");

    logSpy.mockRestore();
  });

  it("logs only once even if 'finish' fires more than once", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const request: FakeRequest = { method: "POST", path: "/v1/agent-jobs", requestId: "req-2" };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();
    response.emit("finish");
    response.emit("finish");

    expect(logSpy).toHaveBeenCalledTimes(1);
    logSpy.mockRestore();
  });

  it("never logs a sentinel secret embedded in the request body", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const sentinelSecret = "sk-super-secret-do-not-leak";
    const request: FakeRequest = {
      method: "POST",
      path: "/v1/agent-jobs",
      requestId: "req-3",
      body: { ticketId: sentinelSecret, summary: sentinelSecret },
    };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();
    response.emit("finish");

    const [line] = logSpy.mock.calls[0] as [string];
    expect(line).not.toContain(sentinelSecret);
    logSpy.mockRestore();
  });

  // Query-safety regression: the logged "route" field must be the route
  // template/path (request.route?.path ?? request.path), never
  // request.originalUrl — originalUrl would include a raw query string,
  // which could carry a sentinel-shaped value appended by a caller.
  it("never logs a sentinel secret embedded in the query string", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const sentinelSecret = "sk-super-secret-query-do-not-leak";
    const request: FakeRequest = {
      method: "GET",
      path: "/v1/agent-jobs/abc",
      // originalUrl mirrors what Express would actually set on a real
      // request with a query string attached — present here specifically
      // to prove the interceptor does not read it.
      originalUrl: `/v1/agent-jobs/abc?token=${sentinelSecret}`,
      requestId: "req-4",
    };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();
    response.emit("finish");

    const [line] = logSpy.mock.calls[0] as [string];
    expect(line).not.toContain(sentinelSecret);
    expect(JSON.parse(line).route).toBe("/v1/agent-jobs/abc");
    logSpy.mockRestore();
  });

  it("prefers request.route.path (the matched route template) over request.path when both are present", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const request: FakeRequest = {
      method: "GET",
      path: "/v1/agent-jobs/0313ac34-6394-4f6d-9be1-ec277daa69dd",
      route: { path: "/agent-jobs/:jobId" },
      requestId: "req-5",
    };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();
    response.emit("finish");

    const [line] = logSpy.mock.calls[0] as [string];
    expect(JSON.parse(line).route).toBe("/agent-jobs/:jobId");
    logSpy.mockRestore();
  });

  it("falls back to 'unknown' when the request has no requestId", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const interceptor = new LoggingInterceptor();
    const response = new FakeResponse();
    const request: FakeRequest = { method: "GET", path: "/v1/agent-jobs/x" };

    interceptor.intercept(buildContext(request, response), buildCallHandler()).subscribe();
    response.emit("finish");

    const [line] = logSpy.mock.calls[0] as [string];
    expect(JSON.parse(line).requestId).toBe("unknown");
    logSpy.mockRestore();
  });
});
