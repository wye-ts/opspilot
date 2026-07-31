import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";
import type { AgentJobResponse, AgentRunDetail, ApprovalView } from "./api/types";

/**
 * CAPABILITIES ARE DYNAMIC, and the tab used to read them once at mount.
 *
 * `/v1/capabilities` answers a question whose truth changes on its own: another
 * client reserves or reconciles a LIVE run, the daily count or the observed
 * estimate reaches its limit, unknown pricing closes the gate, an unreconciled
 * reservation latches the UTC day shut, midnight opens a fresh budget row, an
 * operator flips the kill switch, or a database outage clears.
 *
 * A mount-time snapshot therefore went stale for the tab's whole lifetime, with
 * two visible consequences:
 *
 *   initially UNAVAILABLE -> server becomes AVAILABLE -> tab stays disabled
 *                            until the user reloads
 *   initially AVAILABLE   -> server becomes UNAVAILABLE -> tab still offers LIVE
 *                            -> createAgentJob succeeds -> startAgentRun refused
 *                            -> an avoidable retained partial workflow
 *
 * The backend admission path was always authoritative and always safe. What was
 * wrong was the product state the browser presented, and the AgentJob rows it
 * created on the strength of it.
 */

const TOKEN = "demo-token-do-not-use-8f14e45fceea";
const HEADER = "X-OpsPilot-Demo-Token";
const JOB_ID = "job-1";
const SUMMARY = "Elevated error rate on billing";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const AVAILABLE = () =>
  jsonResponse(200, { data: { liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" } });
const UNAVAILABLE = () =>
  jsonResponse(200, { data: { liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" } });

function jobResponse(): AgentJobResponse {
  return { id: JOB_ID, ticketId: "DEMO-1", summary: SUMMARY, createdAt: "2026-07-30T10:00:00.000Z" };
}

function liveRunDetail(): AgentRunDetail {
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
    },
    trace: [{ type: "REPORT_GENERATED" }],
    outcome: {
      type: "COMPLETED",
      report: {
        category: "SERVICE_DEGRADATION",
        summary: "s",
        rootCause: "r",
        customerImpact: "c",
        recommendedResolution: "rr",
        confidence: 0.6,
        evidence: [{ evidenceId: "e-1", sourceType: "TOOL_EXECUTION", finding: "f" }],
        suggestedActions: [],
      },
    },
  };
}

function approvalView(): ApprovalView {
  return { runId: "run-1", status: "NOT_ELIGIBLE", reviewerName: null, note: null, decidedAt: null };
}

function errorEnvelope(code: string, message: string) {
  return { error: { code, message, requestId: "req-1" } };
}

/**
 * Capability responses come from their own queue (then a fallback), so
 * investigation assertions stay exact regardless of how many refreshes fire.
 */
let capabilityQueue: (Response | Promise<Response>)[] = [];
let capabilityFallback: () => Response = AVAILABLE;

function mockFetch(...responses: (Response | Promise<Response>)[]) {
  const queue = [...responses];
  // Two parameters, so `call[1]` (the RequestInit) stays typed at the call sites.
  const fetchMock = vi.fn((input: unknown, _init?: unknown) => {
    if (String(input) === "/v1/capabilities") {
      return Promise.resolve(capabilityQueue.shift() ?? capabilityFallback());
    }
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected request: ${String(input)}`);
    return Promise.resolve(next);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function capabilityCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/v1/capabilities");
}

function investigationCalls(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) !== "/v1/capabilities");
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const user = () => userEvent.setup();
const liveRadio = () => screen.getByRole("radio", { name: /Live Claude/ });

/**
 * In retry mode there is no provider radio group to observe, so this simply
 * lets the focus refresh's state update flush before the assertions below.
 */
function liveRadioIsIrrelevantHere(): boolean {
  return screen.queryByRole("radio", { name: /Live Claude/ }) === null;
}

afterEach(() => {
  capabilityQueue = [];
  capabilityFallback = AVAILABLE;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mount", () => {
  it("reads capabilities once and enables LIVE when the server says AVAILABLE", async () => {
    const fetchMock = mockFetch();
    render(<App />);

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    expect(capabilityCalls(fetchMock)).toHaveLength(1);
    expect(investigationCalls(fetchMock)).toHaveLength(0);
  });

  it("keeps LIVE unavailable while the first read is still pending", async () => {
    const pending = deferred<Response>();
    capabilityQueue = [pending.promise];
    mockFetch();
    render(<App />);

    // `null` means "not known yet", and the form treats that as unavailable —
    // so LIVE is never briefly offered before the server has said so.
    expect(liveRadio()).toBeDisabled();
    pending.resolve(AVAILABLE());
    await waitFor(() => expect(liveRadio()).toBeEnabled());
  });

  it("fails closed when the read rejects", async () => {
    capabilityQueue = [Promise.reject(new Error("network down")) as unknown as Response];
    mockFetch();
    render(<App />);

    await waitFor(() => expect(liveRadio()).toBeDisabled());
    expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
  });
});

describe("a stale AVAILABLE is caught by the preflight", () => {
  it("creates NO job when the fresh answer is UNAVAILABLE", async () => {
    // Mount says AVAILABLE, so the user can select LIVE. By the time they
    // submit, the server has closed the day.
    capabilityQueue = [AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch();
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Live Claude is temporarily unavailable. No investigation job was created.");

    // The decisive assertions: nothing was created, and nothing was sent.
    expect(investigationCalls(fetchMock)).toHaveLength(0);
    expect(randomUUID).not.toHaveBeenCalled();
    // And emphatically no silent downgrade.
    expect(screen.queryByRole("heading", { name: "Investigation timeline" })).toBeNull();
  });

  it("disables the LIVE option after the refused preflight", async () => {
    capabilityQueue = [AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    mockFetch();
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await waitFor(() => expect(liveRadio()).toBeDisabled());
  });

  it("leaves FAKE completely unaffected — no preflight, no capability read", async () => {
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: { ...liveRunDetail(), run: { ...liveRunDetail().run, providerMode: "FAKE" } } }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByRole("heading", { name: "Investigation timeline" });

    // The deterministic demo runs whatever LIVE availability says, and it does
    // not spend a capability read to do it: one at mount, none for the run.
    expect(capabilityCalls(fetchMock)).toHaveLength(1);
    expect(investigationCalls(fetchMock)).toHaveLength(3);
  });
});

describe("a stale UNAVAILABLE is caught by focus and visibility", () => {
  it("enables LIVE on window focus without a reload", async () => {
    capabilityQueue = [UNAVAILABLE()];
    capabilityFallback = AVAILABLE;
    const fetchMock = mockFetch();
    render(<App />);

    await waitFor(() => expect(liveRadio()).toBeDisabled());

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    expect(capabilityCalls(fetchMock)).toHaveLength(2);
  });

  it("enables LIVE when the document becomes visible", async () => {
    capabilityQueue = [UNAVAILABLE()];
    capabilityFallback = AVAILABLE;
    mockFetch();
    render(<App />);
    await waitFor(() => expect(liveRadio()).toBeDisabled());

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(liveRadio()).toBeEnabled());
  });

  it("ignores a visibilitychange that reports hidden", async () => {
    capabilityQueue = [UNAVAILABLE()];
    capabilityFallback = AVAILABLE;
    const fetchMock = mockFetch();
    render(<App />);
    await waitFor(() => expect(liveRadio()).toBeDisabled());

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      // A backgrounded tab does not need a fresh answer, and waking the database
      // for one would be pure waste.
      expect(capabilityCalls(fetchMock)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("a completed LIVE run refreshes availability", () => {
  it("disables LIVE for the next investigation when the run used the last slot", async () => {
    // The realistic case: this tab's own run is what closed the day.
    capabilityQueue = [AVAILABLE(), AVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByRole("heading", { name: "Investigation timeline" });
    // The post-terminal refresh reports the day is now closed.
    await waitFor(() => expect(liveRadio()).toBeDisabled());
    // The run itself is untouched by that refresh.
    expect(investigationCalls(fetchMock)).toHaveLength(3);
  });
});

/**
 * RECOVERY IS NOT GATED ON CAPABILITIES — and it used to be.
 *
 * The tab ran the same preflight before a recovery that it runs before a new
 * investigation, and refused to send the request when `/v1/capabilities` said
 * UNAVAILABLE. But availability answers exactly one question — may a NEW paid
 * live run be started? — and it reports UNAVAILABLE when the day's allowance is
 * used up or when an unreconciled reservation has latched the day.
 *
 * Those are the states the request being recovered most often CREATED. So the
 * browser refused to send the one request that would have handed back the run
 * its own original attempt paid for, enforcing a rule the server does not have
 * against the exact case the retained key exists for.
 *
 * The tests that asserted "capability unavailable -> send no recovery request"
 * encoded that defect and are replaced by the ones below.
 */
describe("retained-job recovery ignores the capability snapshot", () => {
  async function reachRetryMode(u: ReturnType<typeof userEvent.setup>) {
    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByRole("heading", { name: "Recover Live Run" });
  }

  function runCreates(fetchMock: ReturnType<typeof vi.fn>) {
    return investigationCalls(fetchMock).filter(
      (call) => String(call[0]).includes("/runs") && (call[1] as RequestInit).method === "POST",
    );
  }

  it("sends the recovery, repeating the same key, while capabilities says UNAVAILABLE", async () => {
    // The headline case: the original attempt consumed the day's final
    // reservation, so the server now reports UNAVAILABLE — and answers the
    // retained key with the run that attempt created.
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);
    // The snapshot is UNAVAILABLE by now, and the button is still usable once a
    // token is typed.
    await u.type(screen.getByLabelText("Live demo access token"), "second-entry");
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeEnabled();
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));

    await screen.findByRole("heading", { name: "Investigation timeline" });

    // The request WAS sent, carried the original key, and the token was fresh.
    const creates = runCreates(fetchMock);
    expect(creates).toHaveLength(2);
    const headers = (creates[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers[HEADER]).toBe("second-entry");
    expect(headers["Idempotency-Key"]).toBe(
      ((creates[0]![1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    // And no second job, so no second ticket id.
    expect(
      investigationCalls(fetchMock).filter((call) => String(call[0]).endsWith("/v1/agent-jobs")),
    ).toHaveLength(1);
  });

  it("renders the replayed original and says nothing new was started", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      // 200 — the server recognized the key and returned the run the lost
      // attempt had already created.
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);
    await u.type(screen.getByLabelText("Live demo access token"), "second-entry");
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));

    await screen.findByRole("heading", { name: "Investigation timeline" });
    await screen.findByText(/no new run was started/i);
    expect(screen.queryByRole("heading", { name: "Recover Live Run" })).toBeNull();
  });

  it("explains that new runs are closed while recovery is still allowed", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);

    // The button being live while the LIVE option elsewhere is closed would
    // otherwise read as an inconsistency rather than a deliberate distinction.
    await screen.findByText(
      /New Live Claude runs are currently unavailable\. Recovery of an existing request is still allowed\./,
    );
  });

  it("keeps the job, the key, and recovery mode when the server refuses a new run", async () => {
    // No keyed run exists, so the server applies the ordinary new-run rules and
    // rejects. The tab must not conclude anything from that beyond "try again".
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      jsonResponse(429, errorEnvelope("LIVE_RUN_BUDGET_EXHAUSTED", "The live agent run allowance for today has been used.")),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);
    await u.type(screen.getByLabelText("Live demo access token"), "second-entry");
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));

    await screen.findByText("The live agent run allowance for today has been used.");
    // Same job, still recoverable, and NO fallback to FAKE anywhere.
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();
    for (const call of investigationCalls(fetchMock)) {
      const body = (call[1] as RequestInit).body;
      if (body) expect(String(body)).not.toContain("FAKE");
    }

    // A second recovery attempt repeats the SAME key — a rejection is never a
    // reason to mint a new one.
    const keys = runCreates(fetchMock).map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"],
    );
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
  });

  it("still requires a freshly typed token", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);

    // Availability was never what made a token necessary — the protected path
    // requires one unconditionally, and the failure cleared the field.
    expect(screen.getByLabelText("Live demo access token")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeDisabled();
    expect(runCreates(fetchMock)).toHaveLength(1);
  });

  it("refreshes availability AFTER the recovery, never to decide whether to send it", async () => {
    // mount, first preflight, post-failure refresh — and then one more, after
    // the recovery resolves. The refresh that follows is best-effort reporting;
    // no refresh precedes the request.
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("PERSISTENCE_UNAVAILABLE", "The database is temporarily unavailable.")),
      jsonResponse(200, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);
    // Everything from here on is the recovery, in order.
    const beforeRecovery = fetchMock.mock.calls.length;
    const capabilitiesBefore = capabilityCalls(fetchMock).length;

    await u.type(screen.getByLabelText("Live demo access token"), "second-entry");
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));
    await screen.findByRole("heading", { name: "Investigation timeline" });

    const sinceClick = fetchMock.mock.calls.slice(beforeRecovery).map((call) => String(call[0]));
    const runPost = sinceClick.findIndex((url) => url.includes("/runs"));
    expect(runPost).toBeGreaterThanOrEqual(0);
    // THE ORDERING ASSERTION: not one capability read stands between the click
    // and the run request. A preflight would necessarily appear here.
    expect(sinceClick.slice(0, runPost)).not.toContain("/v1/capabilities");

    // And the best-effort refresh AFTER the terminal outcome still happens — it
    // reports, it does not gate.
    await waitFor(() => expect(capabilityCalls(fetchMock).length).toBeGreaterThan(capabilitiesBefore));
    // The recovered run is untouched by it.
    expect(screen.getByRole("heading", { name: "Investigation timeline" })).toBeInTheDocument();
  });

  it("keeps recovery usable across a focus refresh that reports AVAILABLE again", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = AVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await reachRetryMode(u);

    // The server recovers; the tab notices on focus. Recovery was never blocked,
    // so this changes only the explanatory copy.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(liveRadioIsIrrelevantHere()).toBe(true));

    // The button stays DISABLED until a token is typed — a LIVE request always
    // needs one, whatever the capability snapshot says.
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeDisabled();

    await u.type(screen.getByLabelText("Live demo access token"), "third-entry");
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeEnabled();
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));
    await screen.findByRole("heading", { name: "Investigation timeline" });

    expect(runCreates(fetchMock)).toHaveLength(2);
    const headers = (runCreates(fetchMock)[1]![1] as RequestInit).headers as Record<string, string>;
    expect(headers[HEADER]).toBe("third-entry");
    expect(
      investigationCalls(fetchMock).filter((call) => String(call[0]).endsWith("/v1/agent-jobs")),
    ).toHaveLength(1);
  });
});

/**
 * The CREATION preflight is untouched. It removes an avoidable failure — an
 * AgentJob created for a run that never had a chance — which is a different
 * thing from blocking a recovery of a run that may already exist.
 */
describe("the new-investigation preflight is unchanged", () => {
  it("still creates no job when the fresh answer is UNAVAILABLE", async () => {
    capabilityQueue = [AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch();
    const randomUUID = vi.spyOn(crypto, "randomUUID");
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    await screen.findByText("Live Claude is temporarily unavailable. No investigation job was created.");
    expect(investigationCalls(fetchMock)).toHaveLength(0);
    expect(randomUUID).not.toHaveBeenCalled();
  });
});

describe("a refresh failure never disturbs the primary result", () => {
  it("keeps the rendered run while failing closed on availability", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE()];
    // The post-terminal refresh rejects.
    capabilityFallback = (() => {
      throw new Error("network down");
    }) as unknown as () => Response;
    mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(201, { data: liveRunDetail() }),
      jsonResponse(200, { data: approvalView() }),
    );
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));

    // The run is rendered and STAYS rendered...
    await screen.findByRole("heading", { name: "Investigation timeline" });
    await waitFor(() => expect(liveRadio()).toBeDisabled());
    expect(screen.getByRole("heading", { name: "Investigation timeline" })).toBeInTheDocument();

    // ...and the failure is not narrated to the user.
    expect(screen.queryByText(/network down/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("race safety", () => {
  it("lets the newest answer win when two refreshes resolve out of order", async () => {
    // The mount read is held open and resolves LAST, with a stale AVAILABLE.
    const slowMount = deferred<Response>();
    capabilityQueue = [slowMount.promise, UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    mockFetch();
    render(<App />);

    // A focus refresh supersedes it and lands first.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(liveRadio()).toBeDisabled());

    // The stale mount response arrives afterwards and must be discarded.
    slowMount.resolve(AVAILABLE());
    await Promise.resolve();
    await Promise.resolve();

    expect(liveRadio()).toBeDisabled();
  });
});

describe("every LIVE request requires a token", () => {
  /**
   * The unavailable -> available transition, which is where a tokenless request
   * used to escape.
   *
   * The form once derived "is a token needed?" from the capability snapshot:
   * when it said UNAVAILABLE, the token field was hidden and a LIVE submission
   * counted as valid. If the preflight then found LIVE had recovered, the
   * browser created an AgentJob and sent an unauthenticated run request —
   * earning an avoidable 401 and stranding a partial workflow.
   *
   * Availability and authentication are different questions. Capability governs
   * whether LIVE can be offered; the protected public path requires
   * authentication unconditionally.
   */
  it("cannot submit LIVE without a token even when the snapshot says UNAVAILABLE", async () => {
    // Mount AVAILABLE so LIVE is selectable, then go UNAVAILABLE — the state in
    // which the token field used to disappear.
    capabilityQueue = [AVAILABLE(), UNAVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch();
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(liveRadio()).toBeDisabled());

    // The field is STILL rendered, and submission is still blocked.
    expect(screen.getByLabelText("Live demo access token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled();

    // Nothing left the browser.
    expect(investigationCalls(fetchMock)).toHaveLength(0);
  });

  it("sends no request at all when a whitespace-only token reaches the parent", async () => {
    // The App-level guard, independent of the form: it returns before the
    // capability request, so not even a capability read is spent.
    capabilityQueue = [AVAILABLE()];
    const fetchMock = mockFetch();
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), "   ");

    // The form itself already refuses whitespace, so the button stays disabled
    // and the guard behind it is never reached in normal use.
    expect(screen.getByRole("button", { name: "Run Investigation" })).toBeDisabled();
    expect(investigationCalls(fetchMock)).toHaveLength(0);
    expect(capabilityCalls(fetchMock)).toHaveLength(1);
  });

  it("keeps the retained job and sends nothing when a LIVE retry has no token", async () => {
    capabilityQueue = [AVAILABLE(), AVAILABLE(), AVAILABLE()];
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
    );
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByRole("heading", { name: "Recover Live Run" });

    // The token was cleared on the failure, so the retry cannot be submitted.
    expect(screen.getByLabelText("Live demo access token")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Recover Live Run" })).toBeDisabled();

    // Job create + refused run, and nothing more.
    expect(investigationCalls(fetchMock)).toHaveLength(2);
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
  });
});

describe("a failed LIVE retry refreshes availability", () => {
  it("keeps the original error, the job, and retry mode, and disables LIVE", async () => {
    // mount, first preflight, post-failure refresh, then the post-recovery-
    // failure refresh reports the day has closed. There is no retry preflight.
    capabilityQueue = [AVAILABLE(), AVAILABLE(), AVAILABLE(), AVAILABLE()];
    capabilityFallback = UNAVAILABLE;
    const fetchMock = mockFetch(
      jsonResponse(201, { data: jobResponse() }),
      jsonResponse(503, errorEnvelope("LIVE_RUNS_DISABLED", "Live agent runs are currently disabled.")),
      jsonResponse(429, errorEnvelope("LIVE_RUN_BUDGET_EXHAUSTED", "The live agent run allowance for today has been used.")),
    );
    render(<App />);
    const u = user();

    await waitFor(() => expect(liveRadio()).toBeEnabled());
    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(liveRadio());
    await u.type(screen.getByLabelText("Live demo access token"), TOKEN);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await screen.findByRole("heading", { name: "Recover Live Run" });

    await u.type(screen.getByLabelText("Live demo access token"), "second-entry");
    await u.click(screen.getByRole("button", { name: "Recover Live Run" }));

    // The retry's OWN error is what the user sees — the refresh that follows
    // cannot replace it.
    await screen.findByText("The live agent run allowance for today has been used.");

    // The recovery path survives: same job, still in retry mode.
    expect(screen.getAllByText(JOB_ID).length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "Recover Live Run" })).toBeInTheDocument();

    // Exactly one job, two run attempts, and no FAKE request anywhere.
    const jobCreates = investigationCalls(fetchMock).filter(
      (call) => String(call[0]).endsWith("/v1/agent-jobs"),
    );
    expect(jobCreates).toHaveLength(1);
    for (const call of investigationCalls(fetchMock)) {
      const body = (call[1] as RequestInit).body;
      if (body) expect(String(body)).not.toContain("FAKE");
    }

    // And the terminal refresh actually happened: the error is still on screen
    // while availability has moved.
    await waitFor(() =>
      expect(screen.getByText("The live agent run allowance for today has been used.")).toBeInTheDocument(),
    );
  });
});

describe("cleanup", () => {
  it("removes the focus and visibility listeners on unmount", async () => {
    const fetchMock = mockFetch();
    const { unmount } = render(<App />);
    await waitFor(() => expect(capabilityCalls(fetchMock)).toHaveLength(1));

    unmount();
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await Promise.resolve();

    // No listener leak: an unmounted tab issues no further reads.
    expect(capabilityCalls(fetchMock)).toHaveLength(1);
  });

  it("does not abort an in-flight investigation when capabilities refresh", async () => {
    // The ownership property. The two lifecycles have separate controllers, so a
    // background focus refresh must not cancel a run the user is waiting on.
    const pendingRun = deferred<Response>();
    const fetchMock = mockFetch(jsonResponse(201, { data: jobResponse() }), pendingRun.promise);
    render(<App />);
    const u = user();

    await u.type(screen.getByLabelText("Issue Summary"), SUMMARY);
    await u.click(screen.getByRole("button", { name: "Run Investigation" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Running agent…"));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(capabilityCalls(fetchMock)).toHaveLength(2));

    // The run request was never aborted — resolving it still produces the run.
    pendingRun.resolve(
      jsonResponse(201, { data: { ...liveRunDetail(), run: { ...liveRunDetail().run, providerMode: "FAKE" } } }),
    );
    await screen.findByRole("heading", { name: "Investigation timeline" });
  });
});
