import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createAgentJob, getAgentRun, startAgentRun } from "./endpoints";
import { ApiRequestError, request } from "./http-client";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function rawResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe("request", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns data and numeric status for a 2xx envelope", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: { id: "abc" } }));
    const result = await request<{ id: string }>("/v1/agent-jobs/abc");
    expect(result.data).toEqual({ id: "abc" });
    expect(result.status).toBe(200);
  });

  it("surfaces 201 and 200 distinctly", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { data: { id: "a" } }));
    const created = await request<{ id: string }>("/v1/agent-jobs");
    expect(created.status).toBe(201);

    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: { id: "a" } }));
    const replayed = await request<{ id: string }>("/v1/agent-jobs");
    expect(replayed.status).toBe(200);
  });

  it("throws ApiRequestError with status/code/message/requestId for a valid error envelope", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "AGENT_JOB_NOT_FOUND", message: "The requested agent job was not found.", requestId: "req-1" } }),
    );

    await expect(request("/v1/agent-jobs/missing")).rejects.toMatchObject({
      status: 404,
      code: "AGENT_JOB_NOT_FOUND",
      message: "The requested agent job was not found.",
      requestId: "req-1",
    });
  });

  it("throws UNEXPECTED_RESPONSE for an error body missing requestId, rather than an undefined requestId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, { error: { code: "BROKEN", message: "Malformed envelope" } }));
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE", requestId: null });
  });

  it("throws UNEXPECTED_RESPONSE for an error body with a non-string requestId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, { error: { code: "BROKEN", message: "Malformed envelope", requestId: 12345 } }),
    );
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("throws UNEXPECTED_RESPONSE for an error body with a non-string optional runId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(500, { error: { code: "AGENT_EXECUTION_CRASHED", message: "Crashed.", requestId: "req-1", runId: 42 } }),
    );
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("still preserves requestId for a valid envelope with a string requestId", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(404, { error: { code: "AGENT_RUN_NOT_FOUND", message: "The requested agent run was not found.", requestId: "req-2" } }),
    );
    await expect(request("/v1/agent-runs/missing")).rejects.toMatchObject({
      code: "AGENT_RUN_NOT_FOUND",
      requestId: "req-2",
    });
  });

  it("throws a synthetic UNEXPECTED_RESPONSE for a malformed error body, never a raw SyntaxError", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(rawResponse(500, "<html>not json</html>"));

    let caught: unknown;
    try {
      await request("/v1/agent-jobs");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiRequestError);
    expect((caught as ApiRequestError).code).toBe("UNEXPECTED_RESPONSE");
    expect((caught as ApiRequestError).requestId).toBeNull();
  });

  it("throws UNEXPECTED_RESPONSE for an empty error body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(rawResponse(503, ""));
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("throws UNEXPECTED_RESPONSE for a success body with no data field", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ code: "UNEXPECTED_RESPONSE" });
  });

  it("throws NETWORK_UNAVAILABLE when fetch rejects for a non-abort reason", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(request("/v1/agent-jobs")).rejects.toMatchObject({ status: 0, code: "NETWORK_UNAVAILABLE" });
  });

  it("preserves AbortError rather than converting it to a network error", async () => {
    const abortError = new DOMException("aborted", "AbortError");
    vi.mocked(fetch).mockRejectedValueOnce(abortError);
    await expect(request("/v1/agent-jobs")).rejects.toBe(abortError);
  });

  it("never exposes the raw Response object on the success path", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: { id: "abc" } }));
    const result = await request<{ id: string }>("/v1/agent-jobs");
    expect(Object.keys(result)).toEqual(["data", "status"]);
  });
});

describe("endpoint functions", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createAgentJob calls a relative /v1/agent-jobs path with a JSON body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { data: { id: "job-1" } }));
    await createAgentJob({ ticketId: "DEMO-1", summary: "test" });

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/v1/agent-jobs");
    expect(String(url).startsWith("/v1/")).toBe(true);
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ ticketId: "DEMO-1", summary: "test" }));
  });

  it("startAgentRun sends no body at all", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(201, { data: {} }));
    await startAgentRun("job-1");

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/v1/agent-jobs/job-1/runs");
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toBeUndefined();
  });

  it("getAgentRun calls a relative /v1/agent-runs/:id path with no body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { data: {} }));
    await getAgentRun("run-1");

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("/v1/agent-runs/run-1");
    expect(init?.body).toBeUndefined();
  });
});
