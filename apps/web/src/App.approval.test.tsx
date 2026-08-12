import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

const UUID_A = "11111111-1111-1111-1111-111111111111";

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
      // A FAKE run made no provider call, so there is no measured cost.
      estimatedCostUsd: null,
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "s",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.5,
        evidence: [],
        suggestedActions: [],
      },
    },
    ...overrides,
  };
}

function demoRunDetail(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return runDetail({
    job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }),
    outcome: {
      type: "COMPLETED",
      report: {
        category: "UNKNOWN",
        summary: "s",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.5,
        evidence: [],
        suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." } }],
      },
    },
    ...overrides,
  });
}

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

function errorEnvelope(code: string, message: string, requestId = "req-1", runId?: string) {
  return { error: { code, message, requestId, ...(runId !== undefined ? { runId } : {}) } };
}

async function submitOrdinary(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

/**
 * Milestone-10: the "Approval workflow demo" checkbox is gone. Approval-demo
 * mode is now activated by the `?approval-demo=1` URL query param, read once
 * at App mount — so the caller must install the param via
 * `window.history.replaceState({}, "", "/?approval-demo=1")` BEFORE
 * `render(<App />)`. This helper only fills the summary and submits.
 */
async function submitDemo(user: ReturnType<typeof userEvent.setup>, summary = "Approval demo issue") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

/**
 * The app reads GET /v1/capabilities once on mount, before any user interaction,
 * so it is always the first fetch of a test. Each test's mock chain therefore
 * begins with this response, and `apiCalls()` filters it back out — every
 * assertion below is about the investigation workflow, not the capability probe.
 *
 * UNAVAILABLE keeps the LIVE option disabled, which is the posture these
 * deterministic workflow tests exercise.
 */
function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

/**
 * Investigation polling (#38) starts concurrently with every submit/retry
 * this file exercises and issues its own GET the tests below never queue a
 * response for. A default (not `mockResolvedValueOnce`) fallback answers any
 * such call with 404 — polling stops immediately (`not-found`), which is
 * invisible to every assertion in this file (none inspect polling state).
 */
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

function apiCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities" && !String(call[0]).endsWith("/investigation"));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("App approval workflow", () => {
  it("an ordinary investigation renders NOT_ELIGIBLE with no controls", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Not eligible");

    expect(screen.queryByLabelText("Reviewer name")).toBeNull();
  });

  it("an approval-demo investigation renders the PENDING decision form", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    expect(screen.getByLabelText("Reviewer name")).toBeInTheDocument();
  });

  it("run/timeline/report render before, or independently of, approval state", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView() }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Agent activity");
    expect(screen.getByText("Resolution report")).toBeInTheDocument();
  });

  it("a 201 approve response shows the recorded notice and a terminal, form-free APPROVED panel", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, {
        data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("Decision recorded.");
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(screen.queryByLabelText("Reviewer name")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /approve|reject/i })).toHaveLength(0);
  });

  it("a 201 reject response shows the terminal REJECTED panel", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, {
        data: approvalView({ status: "REJECTED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Reject" }));

    await screen.findByText("Rejected");
  });

  it("a 200 idempotent replay is treated as success, shows the replay notice, and preserves decidedAt", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(200, {
        data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }),
      }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("This decision was already recorded — nothing changed.");
    expect(screen.getByText("Approved")).toBeInTheDocument();
    const approvalSection = screen.getByRole("region", { name: "Human approval" });
    expect(within(approvalSection).getByText(/2026/)).toBeInTheDocument();
  });

  it("a 409 AGENT_RUN_APPROVAL_ALREADY_DECIDED shows a banner and auto-refetches to the terminal state", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          409,
          errorEnvelope(
            "AGENT_RUN_APPROVAL_ALREADY_DECIDED",
            "The agent run already has a recorded approval decision that does not match this request.",
          ),
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          data: approvalView({ status: "REJECTED", reviewerName: "Someone Else", decidedAt: "2026-07-23T09:00:00.000Z" }),
        }),
      );

    const fetchMock = vi.mocked(fetch);
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText(
      "The agent run already has a recorded approval decision that does not match this request.",
    );
    await screen.findByText("Rejected");

    const calls = fetchMock.mock.calls;
    expect(calls[calls.length - 2]?.[1]?.method).toBe("POST");
    expect(calls[calls.length - 1]?.[0]).toBe("/v1/agent-runs/run-1/approval");
    expect(calls[calls.length - 1]?.[1]?.method ?? "GET").toBe("GET");
  });

  it("409 convergence keeps Approve/Reject disabled while the automatic GET is unresolved, blocks a second POST, and renders the terminal state once it resolves", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();

    let resolveConvergenceGet!: (value: Response) => void;
    const pendingConvergenceGet = new Promise<Response>((resolve) => {
      resolveConvergenceGet = resolve;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          409,
          errorEnvelope(
            "AGENT_RUN_APPROVAL_ALREADY_DECIDED",
            "The agent run already has a recorded approval decision that does not match this request.",
          ),
        ),
      )
      // The automatic post-409 convergence GET — deliberately left
      // unresolved so the test can assert the disabled window around it.
      .mockImplementationOnce(() => pendingConvergenceGet);

    const fetchMock = vi.mocked(fetch);
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText(
      "The agent run already has a recorded approval decision that does not match this request.",
    );

    // The automatic convergence GET has been issued (this is the call the
    // pending promise above answers) but has not resolved yet.
    const callsAfterConflict = fetchMock.mock.calls.length;
    expect(fetchMock.mock.calls[callsAfterConflict - 1]?.[0]).toBe("/v1/agent-runs/run-1/approval");

    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    // A native disabled <button> does not dispatch a click at all, so this
    // must not add a second POST /approval call while convergence is still
    // in flight.
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(fetchMock.mock.calls.length).toBe(callsAfterConflict);

    resolveConvergenceGet(
      jsonResponse(200, {
        data: approvalView({ status: "REJECTED", reviewerName: "Someone Else", decidedAt: "2026-07-23T09:00:00.000Z" }),
      }),
    );

    await screen.findByText("Rejected");
    expect(screen.queryByLabelText("Reviewer name")).toBeNull();

    const postApprovalCalls = fetchMock.mock.calls.filter(
      (call) => call[0] === "/v1/agent-runs/run-1/approval" && call[1]?.method === "POST",
    );
    expect(postApprovalCalls).toHaveLength(1);
  });

  it("clicking Refresh while PENDING keeps Approve/Reject disabled for the full run-GET-then-approval-GET workflow, re-enabling only once idle", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();

    let resolveRunGet!: (value: Response) => void;
    const pendingRunGet = new Promise<Response>((resolve) => {
      resolveRunGet = resolve;
    });
    let resolveApprovalGet!: (value: Response) => void;
    const pendingApprovalGet = new Promise<Response>((resolve) => {
      resolveApprovalGet = resolve;
    });

    vi.mocked(fetch).mockImplementationOnce(() => pendingRunGet).mockImplementationOnce(() => pendingApprovalGet);

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    // The run GET is in flight; nothing has resolved yet.
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    resolveRunGet(jsonResponse(200, { data: demoRunDetail() }));
    // Still busy: the run GET resolved, but the chained approval GET has
    // started and not yet resolved — the workflow is not idle.
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();

    resolveApprovalGet(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled());
    expect(screen.getByRole("button", { name: "Reject" })).not.toBeDisabled();
  });

  it("a 409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE shows a banner and auto-refetches to NOT_ELIGIBLE", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        jsonResponse(
          409,
          errorEnvelope("AGENT_RUN_NOT_APPROVAL_ELIGIBLE", "The agent run is not eligible for an approval decision."),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("The agent run is not eligible for an approval decision.");
    await screen.findByText("Not eligible");
  });

  it("a 400 validation error shows the banner and leaves the form populated and submittable", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(400, errorEnvelope("REQUEST_BODY_INVALID", "The request body failed validation.")),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("The request body failed validation.");
    expect(screen.getByLabelText("Reviewer name")).toHaveValue("Jacky");
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });

  it("a 503 persistence error shows a safe message and leaves the form available", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await screen.findByText("The database is temporarily unavailable.");
    expect(screen.getByRole("button", { name: "Approve" })).not.toBeDisabled();
  });

  it("an approval-fetch failure still leaves the timeline and report rendered", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Agent activity");

    await screen.findByText("The database is temporarily unavailable.");
    expect(screen.getByText("Resolution report")).toBeInTheDocument();
    expect(screen.queryByText("Approval")).toBeNull();
  });

  it("Refresh Run also refreshes approval, issuing a run GET then an approval GET", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse() }))
      .mockResolvedValueOnce(jsonResponse(201, { data: runDetail() }))
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    render(<App />);
    await submitOrdinary(user);
    await screen.findByText("Not eligible");

    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse(200, { data: runDetail() }))
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "NOT_ELIGIBLE" }) }));

    const fetchMock = vi.mocked(fetch);
    const callsBefore = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(callsBefore + 2));
    expect(fetchMock.mock.calls[callsBefore]?.[0]).toBe("/v1/agent-runs/run-1");
    expect(fetchMock.mock.calls[callsBefore + 1]?.[0]).toBe("/v1/agent-runs/run-1/approval");
  });

  it("a rapid double-click on Approve issues exactly one POST /approval request", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, { data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }) }),
    );
    const fetchMock = vi.mocked(fetch);
    const callsBefore = fetchMock.mock.calls.length;

    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.dblClick(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Decision recorded.");

    const postApprovalCalls = fetchMock.mock.calls
      .slice(callsBefore)
      .filter((call) => call[0] === "/v1/agent-runs/run-1/approval" && call[1]?.method === "POST");
    expect(postApprovalCalls).toHaveLength(1);
  });

  it("blank note is omitted from the serialized request body", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(pollFallbackResponse())));
    vi.mocked(fetch)
      .mockResolvedValueOnce(capabilitiesResponse())
      .mockResolvedValueOnce(jsonResponse(201, { data: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }) }))
      .mockResolvedValueOnce(jsonResponse(201, { data: demoRunDetail() }))
      // Finding 1 (independent review): the POST becoming terminal owner now
      // performs one authoritative getInvestigationState read before the
      // approval fetch below — a harmless 404 here falls back to the POST's
      // own candidate data, exactly as before this fix.
      .mockResolvedValueOnce(pollFallbackResponse())
      .mockResolvedValueOnce(jsonResponse(200, { data: approvalView({ status: "PENDING" }) }));

    window.history.replaceState({}, "", "/?approval-demo=1");
    render(<App />);
    await submitDemo(user);
    await screen.findByText("Pending");

    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(201, { data: approvalView({ status: "APPROVED", reviewerName: "Jacky", decidedAt: "2026-07-23T10:15:00.000Z" }) }),
    );
    await user.type(screen.getByLabelText("Reviewer name"), "Jacky");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await screen.findByText("Decision recorded.");

    const postCall = vi
      .mocked(fetch)
      .mock.calls.find((call) => call[0] === "/v1/agent-runs/run-1/approval" && call[1]?.method === "POST");
    const body = JSON.parse(postCall?.[1]?.body as string);
    expect(body).toEqual({ decision: "APPROVED", reviewerName: "Jacky" });
    expect("note" in body).toBe(false);
  });
});
