import { request } from "./http-client";
import type {
  AgentJobResponse,
  AgentRunDetail,
  ApprovalView,
  CapabilitiesView,
  RecordApprovalDecisionInput,
} from "./types";

/**
 * The header carrying the shared live demo token.
 *
 * A header, never a query parameter — see RequestOptions.headers. Lowercase to
 * match how Node normalizes incoming header names on the server side.
 */
const LIVE_ACCESS_TOKEN_HEADER = "X-OpsPilot-Demo-Token";

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
}

/**
 * Sends an explicit `providerMode`, which the run endpoint has accepted since
 * PR 6B1 (docs/12-agent-run-api.md §5). An absent body would still work and
 * would mean "use the server default", but sending the mode the user actually
 * chose is what makes a LIVE selection unambiguous rather than dependent on how
 * the deployment happens to be configured.
 *
 * The token header is attached ONLY on the LIVE branch. A FAKE request omits it
 * entirely rather than sending an empty value, so the deterministic demo carries
 * no credential material at all.
 */
export function startAgentRun(input: StartAgentRunInput, signal?: AbortSignal) {
  const sendToken = input.providerMode === "LIVE" && (input.liveAccessToken ?? "") !== "";

  return request<AgentRunDetail>(`/v1/agent-jobs/${input.jobId}/runs`, {
    method: "POST",
    body: { providerMode: input.providerMode },
    signal,
    ...(sendToken ? { headers: { [LIVE_ACCESS_TOKEN_HEADER]: input.liveAccessToken as string } } : {}),
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
