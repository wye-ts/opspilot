// Rich domain shapes are reused, type-only, from @opspilot/contracts — the
// source of truth for report/trace structure. verbatimModuleSyntax (see
// tsconfig.json) makes a value import from this module a compile error, so
// none of this ever enters the bundle at runtime.
import type {
  AgentTraceEvent,
  ApprovalDecision,
  EvidenceReference,
  RecordApprovalDecisionInput,
  ResolutionReport,
  SuggestedAction,
} from "@opspilot/contracts";

export type {
  AgentTraceEvent,
  ApprovalDecision,
  EvidenceReference,
  RecordApprovalDecisionInput,
  ResolutionReport,
  SuggestedAction,
};

// The apps/api envelope shapes below are NOT published by @opspilot/contracts
// (they live in apps/api/src/**/dto/*.mapper.ts, not a package) — declaring
// them locally is the only option short of a backend refactor, not avoidable
// duplication of an available type.

export interface AgentJobResponse {
  readonly id: string;
  readonly ticketId: string;
  readonly summary: string;
  readonly createdAt: string;
}

export interface AgentRunRecordView {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly providerMode: string;
  readonly modelIdentifier: string | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  /**
   * A decimal USD STRING, or null when the cost is not known.
   *
   * A string, never a number: money as a JSON number would be a float here,
   * reintroducing the rounding the server's integer nanoUSD path exists to
   * prevent. Null covers every FAKE run (no provider call was made) and any LIVE
   * run whose pricing could not be established — the UI hides the row entirely
   * rather than rendering "$0.00", which would assert a measured free run.
   */
  readonly estimatedCostUsd: string | null;
}

// run.status/outcome.code are typed string, not narrowed unions — the API
// mappers forward them as string, so narrowing here would assert a
// guarantee the wire format does not make.
export type AgentRunOutcomeView =
  | { readonly type: "RUNNING" }
  | { readonly type: "COMPLETED"; readonly report: ResolutionReport }
  | { readonly type: "FAILED"; readonly code: string; readonly message: string };

export interface AgentRunDetail {
  readonly job: AgentJobResponse;
  readonly run: AgentRunRecordView;
  readonly trace: readonly AgentTraceEvent[];
  readonly outcome: AgentRunOutcomeView;
}

// Declared locally rather than imported: the status union that backs the API
// response is `AgentRunApprovalStatus` in @opspilot/database
// (packages/database/src/types.ts), NOT @opspilot/contracts. A browser bundle
// must not take a dependency on the database package to name four strings.
export type ApprovalStatus = "NOT_ELIGIBLE" | "PENDING" | "APPROVED" | "REJECTED";

// Mirrors AgentRunApprovalResponseData exactly (apps/api/src/agent-run-approvals/
// dto/agent-run-approval-response.mapper.ts) — the same body is returned by both
// GET and POST, including the 200 idempotent replay. `decidedAt` arrives as an
// ISO string, already converted from Date by that mapper.
export interface ApprovalView {
  readonly runId: string;
  readonly status: ApprovalStatus;
  readonly reviewerName: string | null;
  readonly note: string | null;
  readonly decidedAt: string | null;
}

/**
 * What the server will let this browser do right now.
 *
 * Deliberately opaque: `UNAVAILABLE` covers capability absent, kill switch off,
 * and daily budget exhausted alike, so the UI cannot report which safeguard is
 * engaged even if it wanted to. There is no `PUBLIC` access mode in this
 * release — LIVE is always token-protected when it is available at all.
 */
export interface CapabilitiesView {
  readonly liveAgentRuns: "AVAILABLE" | "UNAVAILABLE";
  readonly liveAccess: "TOKEN_REQUIRED" | "NOT_APPLICABLE";
}

export interface ApiSuccessEnvelope<T> {
  readonly data: T;
}

export interface ApiErrorEnvelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly runId?: string;
  };
}
