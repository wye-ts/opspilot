import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * THE BROWSER'S HALF OF IDEMPOTENT LIVE RECOVERY.
 *
 * The defect: the tab entered recovery for EVERY non-abort exception thrown by
 * `startAgentRun` after the AgentJob was created — and that exception does not
 * prove no run was created. Finalization can fail after the provider executed
 * and after the budget was reconciled (the API answers PERSISTENCE_UNAVAILABLE,
 * which it also uses for a pre-run outage), and a successful response can simply
 * be lost in transit. Re-entering the token then started a SECOND paid attempt.
 *
 * The fix the tab is responsible for is small and absolute: carry ONE key per
 * LIVE investigation, send it on the first attempt and on every recovery, and
 * never mint a replacement because a request failed. The server does the rest.
 *
 * These tests therefore assert on the exact header bytes that leave the browser,
 * not on any internal state — the key only does its job if it is on the wire and
 * identical.
 */

const TOKEN = "demo-token-do-not-use-8f14e45fceea";
const RECOVERY_TOKEN = "demo-token-do-not-use-second-entry";
const TOKEN_HEADER = "X-OpsPilot-Demo-Token";
const KEY_HEADER = "Idempotency-Key";
const UUID_A = "11111111-1111-1111-1111-111111111111";
const JOB_ID = "job-1";
const SUMMARY = "Elevated error rate on billing";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function capabilitiesResponse(): Response {
  return jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
}

function jobResponse(): AgentJobResponse {
  return { id: JOB_ID, ticketId: `DEMO-${UUID_A}`, summary: SUMMARY, createdAt: "2026-07-30T10:00:00.000Z" };
}

function liveRunDetail(overrides: Partial<AgentRunDetail["run"]> = {}): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: JOB_ID,
      attemptNumber: 1,
      status: "COMPLETED",
      providerMode: "LIVE",
      estimatedCostUsd: "0.017956",
      modelIdentifier: "claude-sonnet-5",
      startedAt: "2026-07-30T10:00:00.000Z",
      finishedAt: "2026-07-30T10:00:12.000Z",
      createdAt: "2026-07-30T10:00:00.000Z",
      ...overrides,
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "SERVICE_DEGRADATION",
        summary: "A diagnostic check was performed.",
        rootCause: "Upstream latency.",
        customerImpact: "Slow responses.",
        recommendedResolution: "Scale the upstream pool.",
        confidence: 0.6,
        evidence: [
          { evidenceId: "job-1-call-1", sourceType: "TOOL_EXECUTION", finding: "get_service_status completed." },
        ],
        suggestedActions: [],
      },
    },
  };
}

/** The shape a REPLAY comes back as: a run that is still RUNNING, with no outcome. */
function runningReplayDetail(): AgentRunDetail {
  return {
    job: jobResponse(),
    run: {
      id: "run-1",
      jobId: JOB_ID,
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "LIVE",
      estimatedCostUsd: null,
      modelIdentifier: "claude-sonnet-5",
      startedAt: "2026-07-30T10:00:00.000Z",
      finishedAt: null,
      createdAt: "2026-07-30T10:00:00.000Z",
    },
    trace: [],
    outcome: { type: "RUNNING" },
  };
}

function approvalView(): ApprovalView {
  return { runId: "run-1", status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null };
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, requestId: "req-1" } };
}

let capabilityFallback: () => Response = () => capabilitiesResponse();

// Investigation polling (#38) starts concurrently with every submit/retry
// this file exercises and issues its own GET against a URL these tests never
// queue a response for. Like `/v1/capabilities`, it gets its own harmless
// fallback (404 — polling stops immediately) rather than falling into the
// shared queue, where it would either throw "unexpected request" or, worse,
// silently consume a response meant for a job/run/approval call.
function pollFallbackResponse(): Response {
  return jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "not tracked by this test"));
}

function mockFetch(...responses: (Response | Promise<Response> | Error)[]) {
  const queue = [...responses];
  const fetchMock = vi.fn((input: unknown, _init?: unknown) => {
    if (String(input) === "/v1/capabilities") return Promise.resolve(capabilityFallback());
    if (String(input).endsWith("/investigation")) return Promise.resolve(pollFallbackResponse());
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request: ${String(input)}`);
    // An Error models a TRANSPORT failure — the case with no response and no
    // error code at all, which is exactly why an error-code allowlist could
    // never have fixed this.
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function runCreateCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]).includes("/runs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function jobCreateCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (call) =>
      String(call[0]).endsWith("/v1/agent-jobs") && (call[1] as RequestInit | undefined)?.method === "POST",
  );
}

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as RequestInit | undefined)?.headers as Record<string, string>) ?? {};
}

const keysSentBy = (fetchMock: ReturnType<typeof vi.fn>) =>
  runCreateCalls(fetchMock).map((call) => headersOf(call)[KEY_HEADER]);

const user = () => userEvent.setup();

async function submitLive(u: ReturnType<typeof userEvent.setup>, token = TOKEN) {
  await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
  await u.click(screen.getByRole("radio", { name: /Live/ }));
  await u.type(screen.getByLabelText("Live demo access token"), token);
  await u.click(screen.getByRole("button", { name: "Start Investigation" }));
}

async function submitRecovery(u: ReturnType<typeof userEvent.setup>, token = RECOVERY_TOKEN) {
  await u.type(screen.getByLabelText("Live demo access token"), token);
  await u.click(screen.getByRole("button", { name: "Recover Live Run" }));
}

const RUN_REFUSED = () =>
  jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable."));

afterEach(() => {
  capabilityFallback = () => capabilitiesResponse();
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the key on the wire", () => {
  it("sends a well-formed UUID with the first LIVE run request", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);

    await submitLive(user());
    await screen.findByRole("heading", { name: "Agent activity" });

    const [key] = keysSentBy(fetchMock);
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("sends no key on a FAKE run", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(screen.getByRole("button", { name: "Start Investigation" }));
    await screen.findByRole("heading", { name: "Agent activity" });

    // A deterministic run spends nothing, so repeating one is harmless and a key
    // would be ceremony. No token header either.
    const headers = headersOf(runCreateCalls(fetchMock)[0]!);
    expect(headers[KEY_HEADER]).toBeUndefined();
    expect(headers[TOKEN_HEADER]).toBeUndefined();
  });

  it("never puts the key in the URL or the body", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);

    await submitLive(user());
    await screen.findByRole("heading", { name: "Agent activity" });

    const call = runCreateCalls(fetchMock)[0]!;
    const key = headersOf(call)[KEY_HEADER]!;
    expect(String(call[0])).not.toContain(key);
    expect(String((call[1] as RequestInit).body)).not.toContain(key);
  });
});

describe("recovery repeats the key", () => {
  it("sends the SAME key on the recovery as on the failed first attempt", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    const keys = keysSentBy(fetchMock);
    expect(keys).toHaveLength(2);
    // Byte-identical. This is the whole mechanism: the server can only recognize
    // a repeat if the repeat says so.
    expect(keys[1]).toBe(keys[0]);
  });

  it("repeats the key after a TRANSPORT failure, which carries no error code at all", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      // Not an HTTP error — the response was lost. An allowlist of API error
      // codes has nothing to match on here, which is why the fix could not be
      // one.
      new TypeError("Failed to fetch"),
      jsonResponse(200, { data: runningReplayDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    const keys = keysSentBy(fetchMock);
    expect(keys[1]).toBe(keys[0]);
  });

  it("keeps the same key across SEVERAL failed recoveries", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      RUN_REFUSED(),
      RUN_REFUSED(),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u, "second-entry");
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u, "third-entry");
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(3));

    const keys = keysSentBy(fetchMock);
    // Three attempts, one key. A failure is never a reason to mint a new one —
    // that is precisely when a new one would be most expensive.
    expect(new Set(keys).size).toBe(1);
  });

  it("re-enters the TOKEN while reusing the key — opposite lifetimes, on purpose", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u, TOKEN);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    // The field is empty: the credential does not survive the failure.
    expect(screen.getByLabelText("Live demo access token")).toHaveValue("");
    await submitRecovery(u, RECOVERY_TOKEN);
    await screen.findByRole("heading", { name: "Agent activity" });

    const calls = runCreateCalls(fetchMock);
    // The token is FRESH; the key is the SAME. Reusing the credential is what the
    // design refuses; reusing the request identity is what makes it safe.
    expect(headersOf(calls[0]!)[TOKEN_HEADER]).toBe(TOKEN);
    expect(headersOf(calls[1]!)[TOKEN_HEADER]).toBe(RECOVERY_TOKEN);
    expect(headersOf(calls[1]!)[KEY_HEADER]).toBe(headersOf(calls[0]!)[KEY_HEADER]);
  });

  it("creates no second job and no second ticket id", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    // Exactly one POST /v1/agent-jobs across both attempts, so exactly one
    // ticket id was ever generated — the id is minted by that call and nowhere
    // else. Every run request addressed the retained job.
    expect(jobCreateCalls(fetchMock)).toHaveLength(1);
    expect(runCreateCalls(fetchMock).every((call) => String(call[0]).includes(JOB_ID))).toBe(true);
  });
});

describe("what a replay looks like to the user", () => {
  it("a RUNNING replay exits recovery mode and renders the original run", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      // 200 — the server recognized the key and returned the run an earlier
      // request had already created. Still RUNNING, because its finalization is
      // what failed.
      jsonResponse(200, { data: runningReplayDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);

    await screen.findByRole("heading", { name: "Agent activity" });
    // Recovery is over: the form is back to the ordinary creation form.
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Recover Live Run" })).toBeNull();
    // Final UX Pilot fidelity pass — status badges render sentence-case
    // ("Running") now, never the raw enum verbatim.
    expect(screen.getAllByText("Running").length).toBeGreaterThan(0);
    // And a refresh control is there to observe its later state.
    expect(screen.getAllByRole("button", { name: "Refresh" }).length).toBeGreaterThan(0);
  });

  it("says plainly that nothing new was started", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(200, { data: runningReplayDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);

    // The honest description of a 200: this did not consume an attempt.
    await screen.findByText(/no new run was started/i);
  });

  it("a terminal replay exits recovery mode too", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);

    await screen.findByRole("heading", { name: "Agent activity" });
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
    // Final UX Pilot fidelity pass — status badges render sentence-case
    // ("Completed") now, never the raw enum verbatim.
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
  });

  it("says nothing about a replay when the run was genuinely created (201)", async () => {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    // 201 means the recovery DID start the run — the first attempt never got
    // that far. Claiming otherwise would be the mirror-image lie.
    expect(screen.queryByText(/no new run was started/i)).toBeNull();
  });
});

/**
 * THE REPLAY CONFIRMATION MUST SURVIVE THE APPROVAL STEP.
 *
 * The recovery flow announced the replay and then loaded approval, which
 * announced its own thing — so a PENDING approval silently overwrote the one
 * message explaining why no second paid attempt was consumed. The two facts do
 * not compete; both are true. The flow now carries `replayed` through the
 * approval load and emits ONE composed message, in the existing polite region.
 */
describe("the notice when a replay meets an approval", () => {
  function pendingApproval(): ApprovalView {
    return { runId: "run-1", status: "PENDING", reviewerName: null, note: null, decidedAt: null };
  }

  /** The single polite region the app has ever had. */
  const statusRegion = () => screen.getByRole("status");

  async function recoverWith(runResponse: Response, approvalResponse: Response | Error) {
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      runResponse,
      approvalResponse,
    );
    render(<App />);
    const u = user();
    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });
  }

  it("says BOTH things when a replayed run also needs approval", async () => {
    await recoverWith(
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: pendingApproval() }),
    );

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(/no new run was started/i);
    });
    // The approval instruction is still delivered — it is not traded away for
    // the replay confirmation any more than the reverse.
    expect(statusRegion()).toHaveTextContent(/human approval required/i);
  });

  it("keeps the replay-only notice when approval is not pending", async () => {
    await recoverWith(
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(/no new run was started/i);
    });
    expect(statusRegion()).not.toHaveTextContent(/human approval required/i);
  });

  it("keeps the replay notice when the approval fetch FAILS", async () => {
    await recoverWith(
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
    );

    // "No second paid attempt was consumed" is a fact about the run that a
    // failed GET cannot unmake.
    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(/no new run was started/i);
    });
    // The approval failure is still reported, through its own existing channel.
    expect(screen.getByText("The database is temporarily unavailable.")).toBeInTheDocument();
    // And the recovered run is still on screen.
    // Final UX Pilot fidelity pass — status badges render sentence-case
    // ("Completed") now, never the raw enum verbatim.
    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
  });

  it("leaves a genuinely STARTED run with the ordinary completion wording", async () => {
    await recoverWith(
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: pendingApproval() }),
    );

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(/human approval required/i);
    });
    expect(statusRegion()).toHaveTextContent(/investigation complete/i);
    // 201 did create the run, so it must not claim otherwise.
    expect(statusRegion()).not.toHaveTextContent(/no new run was started/i);
  });

  it("emits exactly ONE polite region, not a second one for the replay", async () => {
    await recoverWith(
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: pendingApproval() }),
    );

    await waitFor(() => {
      expect(statusRegion()).toHaveTextContent(/no new run was started/i);
    });
    // Two racing announcements is how this went wrong in the first place; the
    // fix composes one message rather than adding a region.
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(document.querySelectorAll("[aria-live]")).toHaveLength(1);
  });
});

describe("the key's lifetime", () => {
  it("Start new investigation clears it, so the next run gets a fresh one", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await u.click(screen.getByRole("button", { name: "Start new investigation" }));
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull(),
    );

    await submitLive(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    const keys = keysSentBy(fetchMock);
    expect(keys).toHaveLength(2);
    // A NEW investigation is a new request by definition. Carrying the abandoned
    // key forward would ask the server to replay a run belonging to a workflow
    // the user just walked away from.
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("a second investigation after a SUCCESSFUL one also gets a fresh key", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Agent activity" });
    // Milestone-10: the composer collapses once a real job exists, so after
    // the successful run the form is gone. Starting a fresh investigation
    // means leaving the resumed `?job=` view — navigate to "/" and let the
    // popstate handler reset to the ordinary fresh form.
    window.history.pushState(null, "", "/");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Live/ })).toBeEnabled());

    await submitLive(u);
    await waitFor(() => expect(runCreateCalls(fetchMock)).toHaveLength(2));

    const keys = keysSentBy(fetchMock);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it("reaches no storage, cookie, or URL", async () => {
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      RUN_REFUSED(),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await submitLive(u);
    await screen.findByRole("heading", { name: "Recover Live Run" });
    await submitRecovery(u);
    await screen.findByRole("heading", { name: "Agent activity" });

    const key = keysSentBy(fetchMock)[0]!;
    // The key is NOT a credential, and the design does not pretend it is — but it
    // is still ordinary component state and nothing writes it anywhere durable.
    // A key that survived a reload would outlive the job it names.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(window.location.href).not.toContain(key);
    expect(document.body.innerHTML).not.toContain(key);
  });
});
