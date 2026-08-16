import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, AgentRunOutcomeView, ApprovalView, SuggestedAction } from "./api/types";

/**
 * Focused tests for the page-level "Start new investigation" flow:
 *
 * 1. The CTA is provider-agnostic — a terminal LIVE run gates exactly like a
 *    Demo run, deriving from the persisted run outcome + approval state, and
 *    is never hidden merely because the approval object is absent (the fix:
 *    hide only on a KNOWN pending approval).
 * 2. The reset rewrites the URL canonically — an empty remaining query string
 *    produces `/`, never a bare `/?` — while preserving unrelated parameters
 *    and clearing the app-owned transient `?job=` / `?approval-demo=` params.
 */

const TOKEN = "demo-token-do-not-use-8f14e45fceea";
const JOB_ID = "job-1";
const SUMMARY = "Elevated error rate on billing";
const UUID_A = "11111111-1111-1111-1111-111111111111";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, requestId: "req-1" } };
}

function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function jobResponse(): AgentJobResponse {
  return { id: JOB_ID, ticketId: `DEMO-${UUID_A}`, summary: SUMMARY, createdAt: "2026-07-30T10:00:00.000Z" };
}

function runDetail(
  outcome: AgentRunOutcomeView,
  overrides: Partial<AgentRunDetail["run"]> = {},
): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: JOB_ID,
      attemptNumber: 1,
      status: outcome.type,
      providerMode: "FAKE",
      estimatedCostUsd: null,
      modelIdentifier: null,
      startedAt: "2026-07-30T10:00:00.000Z",
      finishedAt: outcome.type === "RUNNING" ? null : "2026-07-30T10:00:12.000Z",
      createdAt: "2026-07-30T10:00:00.000Z",
      ...overrides,
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome,
  };
}

function completedOutcome(suggestedActions: SuggestedAction[] = []): Extract<AgentRunOutcomeView, { readonly type: "COMPLETED" }> {
  return {
    type: "COMPLETED",
    report: {
      category: "SERVICE_DEGRADATION",
      summary: "A diagnostic check was performed.",
      rootCause: "Upstream latency.",
      customerImpact: "Slow responses.",
      recommendedResolution: "Scale the upstream pool.",
      confidence: 0.6,
      evidence: [],
      suggestedActions,
    },
  };
}

const FAILED: AgentRunOutcomeView = { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." };

function liveRunDetail(outcome: AgentRunOutcomeView = completedOutcome()): AgentRunDetail {
  return runDetail(outcome, {
    providerMode: "LIVE",
    estimatedCostUsd: "0.017956",
    modelIdentifier: "claude-sonnet-5",
  });
}

function demoRunDetail(outcome: AgentRunOutcomeView = completedOutcome()): AgentRunDetail {
  return runDetail(outcome, { providerMode: "FAKE" });
}

function approvalView(status: ApprovalView["status"]): ApprovalView {
  return { runId: "run-1", status, reviewerName: null, note: null, decidedAt: null };
}

const APPROVAL_ACTION: SuggestedAction[] = [
  { type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We'll follow up." }, groundedBy: [] },
];

/**
 * URL-dispatched fetch stub. Capabilities always answer AVAILABLE (so LIVE
 * submissions pass preflight), the authoritative `/investigation` read falls
 * back to 503 so the POST's own candidate is used, and every other request is
 * served from the scripted queue in order.
 */
function mockFetch(...responses: (Response | Promise<Response> | Error)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn((input: unknown, _init?: unknown) => {
    if (String(input) === "/v1/capabilities") return Promise.resolve(capabilitiesResponse());
    if (String(input).endsWith("/investigation")) {
      return Promise.resolve(jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test")));
    }
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request: ${String(input)}`);
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function terminalRunScript(provider: "LIVE" | "FAKE", approval: () => Response, outcome: AgentRunOutcomeView = completedOutcome()) {
  return [
    jsonResponse(201, { data: jobResponse() }),
    jsonResponse(201, { data: provider === "LIVE" ? liveRunDetail(outcome) : demoRunDetail(outcome) }),
    approval(),
  ];
}

const user = () => userEvent.setup();

async function submitDemo(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
  await u.click(screen.getByRole("button", { name: "Start Investigation" }));
}

async function submitLive(u: ReturnType<typeof userEvent.setup>) {
  await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
  await u.click(screen.getByRole("radio", { name: /Live/ }));
  await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
  await u.click(screen.getByRole("button", { name: "Start Investigation" }));
}

const ctaVisible = async () => screen.findByRole("button", { name: "Start new investigation" });
const ctaHidden = async () =>
  waitFor(() => expect(screen.queryByRole("button", { name: "Start new investigation" })).toBeNull());

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Start new investigation CTA — provider-agnostic gating", () => {
  it("LIVE completed with NO_APPROVAL_REQUIRED (NOT_ELIGIBLE) → CTA visible", async () => {
    mockFetch(...terminalRunScript("LIVE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") })));
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaVisible();
  });

  it("LIVE completed with a FAILED approval fetch (approval absent) → CTA visible", async () => {
    // The regression: a terminal run whose approval could not be loaded must
    // not hide the CTA forever — a null approval means "no KNOWN pending".
    mockFetch(
      ...terminalRunScript("LIVE", () => jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "db unavailable"))),
    );
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaVisible();
  });

  it("LIVE failed → CTA visible", async () => {
    mockFetch(...terminalRunScript("LIVE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") }), FAILED));
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaVisible();
  });

  it("LIVE completed + approval APPROVED → CTA visible", async () => {
    mockFetch(
      ...terminalRunScript("LIVE", () => jsonResponse(200, { data: approvalView("APPROVED") }), completedOutcome(APPROVAL_ACTION)),
    );
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaVisible();
  });

  it("LIVE completed + approval REJECTED → CTA visible", async () => {
    mockFetch(
      ...terminalRunScript("LIVE", () => jsonResponse(200, { data: approvalView("REJECTED") }), completedOutcome(APPROVAL_ACTION)),
    );
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaVisible();
  });

  it("LIVE completed + approval PENDING → CTA hidden", async () => {
    mockFetch(
      ...terminalRunScript("LIVE", () => jsonResponse(200, { data: approvalView("PENDING") }), completedOutcome(APPROVAL_ACTION)),
    );
    render(<App />);
    const u = user();
    await submitLive(u);
    await ctaHidden();
  });

  it("Demo completed + NOT_ELIGIBLE → CTA visible (unchanged)", async () => {
    mockFetch(...terminalRunScript("FAKE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") })));
    render(<App />);
    const u = user();
    await submitDemo(u);
    await ctaVisible();
  });

  it("Demo completed + approval PENDING → CTA hidden (unchanged)", async () => {
    mockFetch(
      ...terminalRunScript("FAKE", () => jsonResponse(200, { data: approvalView("PENDING") }), completedOutcome(APPROVAL_ACTION)),
    );
    render(<App />);
    const u = user();
    await submitDemo(u);
    await ctaHidden();
  });
});

describe("Start new investigation reset — canonical URL", () => {
  it("clicking Start new investigation with no remaining query params produces `/`, not `/?`", async () => {
    mockFetch(...terminalRunScript("FAKE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") })));
    render(<App />);
    const u = user();
    await submitDemo(u);
    await u.click(await ctaVisible());

    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.href).toBe("http://localhost:3000/");
  });

  it("approval-demo cleanup does not leave a bare `?`", async () => {
    window.history.replaceState({}, "", "/?approval-demo=1");
    mockFetch(...terminalRunScript("FAKE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") })));
    render(<App />);
    const u = user();
    await submitDemo(u);
    await u.click(await ctaVisible());

    // The app-owned transient ?approval-demo=1 param is cleared with ?job=,
    // and the empty search is canonicalized to `/` — never `/?`.
    await waitFor(() => expect(window.location.search).toBe(""));
    expect(window.location.href).toBe("http://localhost:3000/");
  });

  it("unrelated query parameters are preserved across the reset", async () => {
    window.history.replaceState({}, "", "/?utm_source=newsletter");
    mockFetch(...terminalRunScript("FAKE", () => jsonResponse(200, { data: approvalView("NOT_ELIGIBLE") })));
    render(<App />);
    const u = user();
    await submitDemo(u);
    await u.click(await ctaVisible());

    await waitFor(() => expect(window.location.search).not.toContain("job="));
    expect(window.location.search).toContain("utm_source=newsletter");
    // The preserved param keeps the `?` legitimate — but there is still no
    // trailing bare question mark.
    expect(window.location.href).not.toMatch(/\?$/);
  });
});
