import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, AgentRunOutcomeView, ApprovalView } from "./api/types";

/**
 * Issue #41 polish-pass tests (§18 focused items). These pin the USER-FACING
 * polish behaviors — the Fresh value proposition, compact Run Details primary
 * fields + Technical details disclosure, the page-level terminal `Start new
 * investigation` entry point (§8) and its visibility/reset rules, and the
 * approved browser title — without weakening any #34–#40 / #39 semantic test.
 */

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

function runDetail(outcome: AgentRunOutcomeView, overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: "job-1",
      attemptNumber: 1,
      status: outcome.type,
      providerMode: "FAKE",
      // A FAKE run made no provider call, so there is no measured cost.
      estimatedCostUsd: null,
      modelIdentifier: null,
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: outcome.type === "RUNNING" ? null : "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome,
    ...overrides,
  };
}

const COMPLETED: Extract<AgentRunOutcomeView, { readonly type: "COMPLETED" }> = {
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
};
const FAILED: AgentRunOutcomeView = { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." };
const RUNNING: AgentRunOutcomeView = { type: "RUNNING" };

function completedRunDetail(overrides: Partial<AgentRunDetail> = {}): AgentRunDetail {
  return runDetail(COMPLETED, overrides);
}

function liveRunDetail(): AgentRunDetail {
  return completedRunDetail({
    run: {
      id: "run-live",
      jobId: "job-1",
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "LIVE",
      estimatedCostUsd: "0.12",
      modelIdentifier: "claude-sonnet-5",
      startedAt: "2026-07-23T10:00:00.000Z",
      finishedAt: "2026-07-23T10:00:01.000Z",
      createdAt: "2026-07-23T10:00:00.000Z",
    },
  });
}

function demoRunDetail(): AgentRunDetail {
  return completedRunDetail({
    job: jobResponse({ ticketId: "TICKET-APPROVAL-DEMO" }),
    outcome: {
      type: "COMPLETED",
      report: {
        ...COMPLETED.report,
        suggestedActions: [{ type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." } }],
      },
    },
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

function errorEnvelope(code: string, message: string, requestId = "req-1") {
  return { error: { code, message, requestId } };
}

function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });
}

interface MockFetchOptions {
  readonly run?: () => Response;
  readonly approval?: () => Response;
}

/**
 * URL-dispatched fetch stub. `/v1/capabilities` always answers (it is probed
 * on mount AND again by `Start new investigation`'s refreshCapabilities), the
 * workflow uses the scripted `run`/`approval` options, and any unscripted
 * poll GET answers 503 so polling stops invisibly to these assertions.
 */
function mockFetch(options: MockFetchOptions = {}) {
  const fetchMock = vi.fn((input: unknown, init?: unknown) => {
    const url = String(input);
    const method = (init as RequestInit | undefined)?.method ?? "GET";
    if (url === "/v1/capabilities") {
      return Promise.resolve(capabilitiesResponse());
    }
    if (url === "/v1/agent-jobs" && method === "POST") {
      return Promise.resolve(jsonResponse(201, { data: jobResponse() }));
    }
    if (url.endsWith("/runs") && method === "POST") {
      return Promise.resolve((options.run ?? (() => jsonResponse(201, { data: completedRunDetail() })))());
    }
    if (url.endsWith("/approval")) {
      return Promise.resolve((options.approval ?? (() => jsonResponse(200, { data: approvalView() })))());
    }
    return Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test")));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jobPostCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/v1/agent-jobs" && String((call[1] as RequestInit | undefined)?.method ?? "GET") === "POST").length;
}

async function submit(user: ReturnType<typeof userEvent.setup>, summary = "Elevated error rate") {
  await user.type(screen.getByLabelText("Issue Summary"), summary);
  await user.click(screen.getByRole("button", { name: "Start Investigation" }));
}

function withApprovalDemoParam() {
  window.history.replaceState({}, "", "/?approval-demo=1");
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Issue #41 polish — user-facing copy", () => {
  it("Fresh value proposition communicates AI agent + diagnostics + resolution + human approval (§18.1)", async () => {
    mockFetch();
    render(<App />);

    const value = await screen.findByText(/Investigate issues with an AI agent/i);
    expect(value.textContent).toMatch(/runs diagnostics/);
    expect(value.textContent).toMatch(/generates a resolution/);
    expect(value.textContent).toMatch(/proposes actions for human approval/);
    // Demo/Live is no longer the product promise.
    expect(value.textContent).not.toMatch(/deterministic demo or Live/);
  });
});

describe("Issue #41 polish — compact Run Details (§12 / §18.9-18.11)", () => {
  async function renderCompletedRun(user: ReturnType<typeof userEvent.setup>, run: () => Response) {
    // App derives the ticket ID from crypto.randomUUID (never the job body).
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(UUID_A);
    const fetchMock = mockFetch({ run, approval: () => jsonResponse(200, { data: approvalView() }) });
    render(<App />);
    await submit(user);
    await screen.findByText("Run details");
    const section = screen.getByText("Run details").closest("section");
    if (section === null) throw new Error("no run-details section");
    return { fetchMock, section };
  }

  it("primary fields are Provider / Model / Duration / Attempt, with `Demo` not `FAKE` (§18.9-18.10)", async () => {
    const user = userEvent.setup();
    const { section } = await renderCompletedRun(user, () => jsonResponse(201, { data: completedRunDetail() }));

    for (const label of ["Provider", "Model", "Duration", "Attempt"]) {
      expect(within(section).getByText(label)).toBeInTheDocument();
    }
    expect(within(section).getByText("Demo")).toBeInTheDocument();
    expect(within(section).queryByText("FAKE")).toBeNull();
  });

  it("a LIVE run shows `Live`, never the raw `LIVE` enum (§18.9)", async () => {
    const user = userEvent.setup();
    const { section } = await renderCompletedRun(user, () => jsonResponse(201, { data: liveRunDetail() }));

    expect(within(section).getByText("Live")).toBeInTheDocument();
    expect(within(section).queryByText("LIVE")).toBeNull();
  });

  it("Ticket/Job/Run IDs stay reachable behind Technical details (§18.11)", async () => {
    const user = userEvent.setup();
    const { section } = await renderCompletedRun(user, () => jsonResponse(201, { data: completedRunDetail() }));

    expect(within(section).getByText("Technical details")).toBeInTheDocument();
    expect(within(section).getByText(`DEMO-${UUID_A}`)).toBeInTheDocument();
    expect(within(section).getByText("job-1")).toBeInTheDocument();
    expect(within(section).getByText("run-1")).toBeInTheDocument();
  });
});

describe("Issue #41 polish — page-level terminal Start new investigation (§8 / §18.14-18.20)", () => {
  it("FAILED run → bottom Start new investigation is shown (§18.14)", async () => {
    const user = userEvent.setup();
    mockFetch({ run: () => jsonResponse(201, { data: runDetail(FAILED) }) });
    render(<App />);
    await submit(user);

    await screen.findByRole("button", { name: "Start new investigation" });
  });

  it("RUNNING run → Start new investigation is NOT shown (§18.14)", async () => {
    const user = userEvent.setup();
    mockFetch({ run: () => jsonResponse(201, { data: runDetail(RUNNING) }) });
    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");

    expect(screen.queryByRole("button", { name: "Start new investigation" })).toBeNull();
  });

  it("COMPLETED run with a resolved (NOT_ELIGIBLE) approval → Start new investigation is shown (§18.14)", async () => {
    const user = userEvent.setup();
    mockFetch({ run: () => jsonResponse(201, { data: completedRunDetail() }) });
    render(<App />);
    await submit(user);

    await screen.findByRole("button", { name: "Start new investigation" });
  });

  it("the top Current Investigation card no longer contains any Start/New investigation CTA (§18.18)", async () => {
    const user = userEvent.setup();
    mockFetch({ run: () => jsonResponse(201, { data: completedRunDetail() }) });
    render(<App />);
    await submit(user);

    // The CTA exists page-level…
    const cta = await screen.findByRole("button", { name: "Start new investigation" });
    // …but the Current Investigation card is metadata-only: no CTA inside it.
    const card = screen.getByText("Current investigation").closest("section");
    if (card === null) throw new Error("no current-investigation section");
    expect(within(card).queryByRole("button", { name: /Start new investigation|New investigation/ })).toBeNull();
    expect(cta.closest(".current-investigation")).toBeNull();
  });

  it("pending human approval keeps prominence — Start new investigation is hidden while PENDING (§18.16)", async () => {
    const user = userEvent.setup();
    withApprovalDemoParam();
    mockFetch({
      run: () => jsonResponse(201, { data: demoRunDetail() }),
      approval: () => jsonResponse(200, { data: approvalView({ status: "PENDING" }) }),
    });
    render(<App />);
    await submit(user, "Approval demo issue");
    await screen.findByText("Pending");

    expect(screen.queryByRole("button", { name: "Start new investigation" })).toBeNull();
    // The decision surface stays prominent and actionable.
    expect(screen.getByLabelText("Reviewer name")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });

  it("Start new investigation reuses the reset path and creates no job until the user submits again (§18.15)", async () => {
    const user = userEvent.setup();
    const fetchMock = mockFetch({ run: () => jsonResponse(201, { data: completedRunDetail() }) });
    render(<App />);
    await submit(user);
    await screen.findByRole("button", { name: "Start new investigation" });

    const jobPostsBefore = jobPostCount(fetchMock);
    await user.click(screen.getByRole("button", { name: "Start new investigation" }));

    // Composer returns; the terminal surfaces clear.
    await screen.findByRole("button", { name: "Start Investigation" });
    expect(screen.queryByText("Current investigation")).toBeNull();
    expect(screen.queryByText("Run details")).toBeNull();

    // The reset itself never creates a job.
    await waitFor(() => expect(jobPostCount(fetchMock)).toBe(jobPostsBefore));

    // A fresh user submission is what creates the next job.
    await submit(user);
    await waitFor(() => expect(jobPostCount(fetchMock)).toBe(jobPostsBefore + 1));
  });
});

describe("Issue #41 polish — Agent Activity checklist (§11 / §18.9-18.10)", () => {
  it("renders compact checklist glyphs, never numbered 1/2/3 step circles (§18.9)", async () => {
    const user = userEvent.setup();
    mockFetch({
      run: () =>
        jsonResponse(201, {
          data: completedRunDetail({
            trace: [
              { type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "get_service_status" },
              { type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "get_service_status" },
              { type: "REPORT_GENERATED" },
            ],
          }),
        }),
    });
    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");

    const steps = [...document.querySelectorAll(".trace-timeline-step")];
    expect(steps.length).toBeGreaterThan(0);
    // No numbered ordinals — every glyph is a checkmark/dot, never a digit.
    for (const step of steps) {
      expect(step.textContent).not.toMatch(/^[0-9]+$/);
    }
    // The paired request → completion both resolve to completed green checks.
    expect(steps.map((step) => step.textContent)).toEqual(["✓", "✓", "✓"]);
  });

  it("uses consistent sentence-case `Technical details` disclosure text (§18.10)", async () => {
    const user = userEvent.setup();
    mockFetch({ run: () => jsonResponse(201, { data: completedRunDetail() }) });
    render(<App />);
    await submit(user);
    await screen.findByText("Agent activity");

    const disclosures = screen.getAllByText("Technical details");
    expect(disclosures.length).toBeGreaterThan(0);
    for (const disclosure of disclosures) {
      expect(disclosure.textContent).toBe("Technical details");
    }
  });
});

describe("Issue #41 polish — browser title (§15 / §18.17)", () => {
  it("the approved browser title is set statically", () => {
    // Locate index.html from either the repo root or the apps/web cwd —
    // vitest may be launched from either.
    const candidates = [
      resolve(process.cwd(), "apps/web/index.html"),
      resolve(process.cwd(), "index.html"),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found === undefined) throw new Error("could not locate index.html");
    const html = readFileSync(found, "utf8");
    expect(html).toContain("<title>OpsPilot — AI Operations Investigator</title>");
  });
});
