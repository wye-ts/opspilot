import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function jobResponse(overrides: Partial<AgentJobResponse> = {}): AgentJobResponse {
  return {
    id: "job-1",
    ticketId: `DEMO-${UUID_A}`,
    summary: "Elevated error rate",
    createdAt: "2026-07-23T10:00:00.000Z",
    ...overrides,
  };
}

function runDetail(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    trace: [
      { type: "TOOL_REQUESTED", toolCallId: "job-1-call-1", toolName: "get_service_status" },
      { type: "TOOL_COMPLETED", toolCallId: "job-1-call-1", toolName: "get_service_status" },
      { type: "REPORT_GENERATED" },
    ],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "A diagnostic check was performed.",
        rootCause: "No root cause could be established.",
        customerImpact: "No customer impact could be established.",
        recommendedResolution: "Further diagnostic action is required.",
        confidence: 0.5,
        evidence: [{ evidenceId: "job-1-call-1", sourceType: "TOOL_EXECUTION", finding: "get_service_status completed." }],
        suggestedActions: [],
      },
    },
    ...overrides,
  };
}

// PR 4B: every successful run triggers a chained approval GET (App.tsx's
// runInvestigation/retryRun/refreshRun). These PR 4A tests don't assert on
// approval state — approval.test.tsx owns that — but a successful run mock
// chain needs one more response, or the extra fetch call resolves to
// `undefined` and surfaces a spurious error banner.
function approvalView(overrides: Partial<ApprovalView> = {}): ApprovalView {
  return {
    runId: "run-1",
    status: "NOT_ELIGIBLE",
    reviewerName: null,
    note: null,
    decidedAt: null,
    ...overrides,
  };
}

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary: string, approvalDemo = false) {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  if (approvalDemo) {
    await user.click(screen.getByLabelText("Approval workflow demo"));
  }
  await user.click(screen.getByRole("button", { name: "Run Investigation" }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App investigation workflow", () => {
  it("one click calls POST job then POST run, in that order", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Investigation timeline");

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(3);
    expect(calls[0]?.[0]).toBe("/v1/agent-jobs");
    expect(calls[1]?.[0]).toBe("/v1/agent-jobs/job-1/runs");
    expect(calls[2]?.[0]).toBe("/v1/agent-runs/run-1/approval");
  });

  it("ordinary mode sends exactly DEMO-<stubbed UUID>", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Investigation timeline");

    const firstCallInit = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(firstCallInit?.body).toBe(JSON.stringify({ ticketId: `DEMO-${UUID_A}`, summary: "Elevated error rate" }));
  });

  it("two ordinary submissions use two distinct deterministic UUIDs", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");
    uuidSpy.mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ id: "job-1", ticketId: `DEMO-${UUID_A}` }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-1" }) }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "First issue");
    await screen.findByText("Investigation timeline");
    const firstTicketId = vi.mocked(fetch).mock.calls[0]?.[1]?.body as string;

    uuidSpy.mockReturnValueOnce(UUID_B);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ id: "job-2", ticketId: `DEMO-${UUID_B}` }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-2" }) }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    await user.clear(screen.getByLabelText("Issue Summary"));
    await submit(user, "Second issue");
    await waitFor(() => expect(vi.mocked(fetch).mock.calls).toHaveLength(6));
    const secondTicketId = vi.mocked(fetch).mock.calls[3]?.[1]?.body as string;

    expect(firstTicketId).toContain(UUID_A);
    expect(secondTicketId).toContain(UUID_B);
    expect(firstTicketId).not.toBe(secondTicketId);
  });

  it("approval-demo mode sends exactly TICKET-APPROVAL-DEMO", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submit(user, "Approval demo issue", true);
    await screen.findByText("Investigation timeline");

    const firstCallInit = vi.mocked(fetch).mock.calls[0]?.[1];
    expect(firstCallInit?.body).toBe(JSON.stringify({ ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval demo issue" }));
  });

  it("renders no editable Ticket ID field, and shows the ticket/job/run IDs as read-only metadata", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Investigation timeline");

    expect(screen.queryByRole("textbox", { name: /ticket/i })).toBeNull();
    expect(screen.getByText(`DEMO-${UUID_A}`).tagName).toBe("DD");
    expect(screen.getByText("job-1").tagName).toBe("DD");
    expect(screen.getByText("run-1").tagName).toBe("DD");
  });

  it("preserves trace response order in the rendered timeline", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Investigation timeline");

    const items = screen.getAllByRole("listitem").filter((item) => item.className.includes("trace-timeline-item"));
    expect(items[0]).toHaveTextContent("Tool requested");
    expect(items[1]).toHaveTextContent("Tool completed");
    expect(items[2]).toHaveTextContent("Report generated");
  });

  it("an ordinary run's report has zero suggested-action cards", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");
    await screen.findByText("Investigation timeline");

    expect(screen.getByText("This run produced no suggested actions.")).toBeInTheDocument();
    expect(screen.queryByText("Draft customer reply")).toBeNull();
  });

  it("an approval-demo run's report has exactly one DRAFT_CUSTOMER_REPLY card", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const demoRun = runDetail({
      outcome: {
        type: "COMPLETED",
        report: {
          category: "UNKNOWN",
          summary: "s",
          rootCause: "r",
          customerImpact: "c",
          recommendedResolution: "rr",
          confidence: 0.5,
          evidence: [{ evidenceId: "e1", sourceType: "TOOL_EXECUTION", finding: "f" }],
          suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." } }],
        },
      },
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRun }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    render(<App />);
    await submit(user, "Approval demo issue", true);
    await screen.findByText("Investigation timeline");

    expect(screen.getAllByText("Draft customer reply")).toHaveLength(1);
    expect(screen.getByText("Update")).toBeInTheDocument();
  });

  it("a job-creation failure shows the error and makes no run request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The request body failed validation.");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
    expect(screen.queryByText("Investigation")).toBeNull();
    expect(screen.queryByText("Investigation timeline")).toBeNull();
  });

  it("a run-creation failure retains job metadata and exposes Retry Run, which retries only POST /runs", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The database is temporarily unavailable.");
    expect(screen.getByText("job-1").tagName).toBe("DD");
    const retryButton = screen.getByRole("button", { name: "Retry Run" });
    expect(retryButton).toBeInTheDocument();

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    await user.click(retryButton);
    await screen.findByText("Investigation timeline");

    const calls = vi.mocked(fetch).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[2]?.[0]).toBe("/v1/agent-jobs/job-1/runs");
    expect(calls[3]?.[0]).toBe("/v1/agent-runs/run-1/approval");
    expect(calls.filter((call) => call[0] === "/v1/agent-jobs")).toHaveLength(1);
  });

  it("a new investigation clears the prior job, run, and error state before the new one resolves", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    const uuidSpy = vi.spyOn(globalThis.crypto, "randomUUID");
    uuidSpy.mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ id: "job-1" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-1" }) }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "First issue");
    await screen.findByText("Investigation timeline");
    expect(screen.getByText("job-1")).toBeInTheDocument();

    let resolveSecondJob!: (value: Response) => void;
    const pendingSecondJob = new Promise<Response>((resolve) => {
      resolveSecondJob = resolve;
    });
    uuidSpy.mockReturnValueOnce(UUID_B);
    vi.mocked(fetch).mockImplementationOnce(() => pendingSecondJob);

    await user.clear(screen.getByLabelText("Issue Summary"));
    await user.type(screen.getByLabelText("Issue Summary"), "Second issue");
    await user.click(screen.getByRole("button", { name: "Run Investigation" }));

    await waitFor(() => expect(screen.queryByText("Investigation timeline")).toBeNull());
    expect(screen.queryByText("job-1")).toBeNull();

    resolveSecondJob(jsonResponse(201, { data: jobResponse({ id: "job-2", ticketId: `DEMO-${UUID_B}` }) }));
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ job: jobResponse({ id: "job-2" }) }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    await screen.findByText("job-2");
  });

  it("a network failure renders an actionable, safe message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText(/Could not reach the OpsPilot API/);
    expect(document.body.textContent).not.toContain("TypeError");
    expect(document.body.textContent).not.toContain("Failed to fetch");
  });

  it("a malformed response body renders a safe UNEXPECTED_RESPONSE message", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("<html>not json</html>", { status: 500 }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("The server returned an unexpected response.");
    expect(document.body.textContent).not.toContain("<html>");
  });

  it("renders a FAILED outcome with its code and message, and no suggested-actions section", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(
        jsonResponse(201, {
          data: runDetail({ outcome: { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." } }),
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("RETRIEVAL_FAILED");
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    expect(screen.queryByText(/Suggested actions/)).toBeNull();
  });

  it("renders a RUNNING outcome with the not-yet-produced state and a working Refresh", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail({ outcome: { type: "RUNNING" } }) }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submit(user, "Elevated error rate");

    await screen.findByText("This run has not produced a report yet.");

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));
    const refreshButtons = screen.getAllByRole("button", { name: "Refresh" });
    await user.click(refreshButtons[0]!);

    await screen.findByText("This run produced no suggested actions.");
  });

  it("a rapid double-click produces exactly one workflow submission", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await user.type(screen.getByLabelText("Issue Summary"), "Elevated error rate");
    await user.dblClick(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Investigation timeline");
    expect(vi.mocked(fetch).mock.calls).toHaveLength(3);
    expect(vi.mocked(fetch).mock.calls.filter((call) => call[0] === "/v1/agent-jobs")).toHaveLength(1);
  });
});
