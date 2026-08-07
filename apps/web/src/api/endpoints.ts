import { request } from "./http-client";
import type {
  AgentJobResponse,
  AgentRunDetail,
  ApprovalView,
  CapabilitiesView,
  InvestigationStateResponse,
  RecordApprovalDecisionInput,
} from "./types";

/**
 * The header carrying the shared live demo token.
 *
 * A header, never a query parameter — see RequestOptions.headers. Lowercase to
 * match how Node normalizes incoming header names on the server side.
 */
const LIVE_ACCESS_TOKEN_HEADER = "X-OpsPilot-Demo-Token";

/**
 * The header carrying a LIVE run's client request key.
 *
 * NOT a credential, and deliberately not handled like one: it is ordinary App
 * state, it survives a failed attempt on purpose, and it is REUSED across
 * recovery submissions. That reuse is the entire mechanism — the same key means
 * "the same request", so a server that already created a run for it returns that
 * run instead of starting a second paid one.
 *
 * The token is the exact opposite on every count: fresh each time, never
 * retained, never stored beside this. See App.tsx.
 */
const LIVE_RUN_IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export interface CreateAgentJobInput {
  readonly ticketId: string;
  readonly summary: string;
}

export function createAgentJob(input: CreateAgentJobInput, signal?: AbortSignal) {
  return request<AgentJobResponse>("/v1/agent-jobs", { method: "POST", body: input, signal });
}

export interface StartAgentRunInput {
  readonly jobId: string;
  readonly providerMode: "FAKE" | "LIVE";
  /**
   * Held in React state by the caller and passed straight through to a request
   * header. It is never stored, never placed in a URL, and never logged — see
   * InvestigationForm, which owns the only input that produces it.
   */
  readonly liveAccessToken?: string;
  /**
   * REQUIRED for LIVE by the server; typed optional here only because a FAKE
   * call has no use for one. A LIVE request without it earns a 400 rather than
   * starting an unprotected run — which is the safe direction, since the point
   * of the key is that a repeat can be recognized.
   */
  readonly idempotencyKey?: string;
}

/**
 * Sends an explicit `providerMode`, which the run endpoint has accepted since
 * PR 6B1 (docs/12-agent-run-api.md §5). An absent body would still work and
 * would mean "use the server default", but sending the mode the user actually
 * chose is what makes a LIVE selection unambiguous rather than dependent on how
 * the deployment happens to be configured.
 *
 * Both extra headers are attached ONLY on the LIVE branch. A FAKE request omits
 * them entirely rather than sending empty values, so the deterministic demo
 * carries no credential material at all — and no idempotency key either, since a
 * FAKE run costs nothing and repeating one is harmless.
 *
 * The RESPONSE STATUS is meaningful and is returned to the caller: 201 means
 * this request created the run, 200 means the server recognized the key and
 * replayed a run an earlier request had already created. The body is identical.
 */
export function startAgentRun(input: StartAgentRunInput, signal?: AbortSignal) {
  const live = input.providerMode === "LIVE";
  const sendToken = live && (input.liveAccessToken ?? "") !== "";
  const sendKey = live && (input.idempotencyKey ?? "") !== "";

  const headers: Record<string, string> = {
    ...(sendToken ? { [LIVE_ACCESS_TOKEN_HEADER]: input.liveAccessToken as string } : {}),
    ...(sendKey ? { [LIVE_RUN_IDEMPOTENCY_KEY_HEADER]: input.idempotencyKey as string } : {}),
  };

  return request<AgentRunDetail>(`/v1/agent-jobs/${input.jobId}/runs`, {
    method: "POST",
    body: { providerMode: input.providerMode },
    signal,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
}

// Read on mount AND refreshed thereafter — on focus, on tab visibility, before
// a LIVE run is started, and after every LIVE run finishes (see App.tsx). The
// answer is dynamic, so a single load-time read would go stale for the rest of
// the tab's life. Used so the LIVE option can render disabled with a visible reason
// rather than being hidden — a hidden control makes the feature look absent
// rather than protected.
export function getCapabilities(signal?: AbortSignal) {
  return request<CapabilitiesView>("/v1/capabilities", { signal });
}

export function getAgentRun(runId: string, signal?: AbortSignal) {
  return request<AgentRunDetail>(`/v1/agent-runs/${runId}`, { signal });
}

export function getApproval(runId: string, signal?: AbortSignal) {
  return request<ApprovalView>(`/v1/agent-runs/${runId}/approval`, { signal });
}

export function recordApproval(runId: string, input: RecordApprovalDecisionInput, signal?: AbortSignal) {
  return request<ApprovalView>(`/v1/agent-runs/${runId}/approval`, { method: "POST", body: input, signal });
}

/** Anonymous read — same as every other read on this demo. No new authorization concept. */
export function getInvestigationState(jobId: string, signal?: AbortSignal) {
  return request<InvestigationStateResponse>(`/v1/agent-jobs/${jobId}/investigation`, { signal });
}
