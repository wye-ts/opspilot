import { request } from "./http-client";
import type { AgentJobResponse, AgentRunDetail, ApprovalView, RecordApprovalDecisionInput } from "./types";

export interface CreateAgentJobInput {
  readonly ticketId: string;
  readonly summary: string;
}

export function createAgentJob(input: CreateAgentJobInput, signal?: AbortSignal) {
  return request<AgentJobResponse>("/v1/agent-jobs", { method: "POST", body: input, signal });
}

// Sends no body at all — docs/12-agent-run-api.md §5: the run endpoint
// accepts only an absent body or {}, and absent-only normalization means an
// explicit null is rejected. Omitting `body` from the options (rather than
// passing an empty object) keeps this the least surprising choice.
export function startAgentRun(jobId: string, signal?: AbortSignal) {
  return request<AgentRunDetail>(`/v1/agent-jobs/${jobId}/runs`, { method: "POST", signal });
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
