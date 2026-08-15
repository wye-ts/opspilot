// Rich domain shapes are reused, type-only, from @opspilot/contracts — the
// source of truth for report/trace structure. verbatimModuleSyntax (see
// tsconfig.json) makes a value import from this module a compile error, so
// none of this ever enters the bundle at runtime.
import type {
  AgentTraceEvent,
  ApprovalDecision,
  EvidenceReference,
  InvestigationEventRecord,
  RecordApprovalDecisionInput,
  StoredResolutionReport,
  SuggestedAction,
} from "@opspilot/contracts";

export type {
  AgentTraceEvent,
  ApprovalDecision,
  EvidenceReference,
  InvestigationEventRecord,
  RecordApprovalDecisionInput,
  StoredResolutionReport,
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
//
// The COMPLETED report is the StoredResolutionReport (evidenceState optional):
// the API's fromReportRead revalidates stored rows against that schema, so a
// pre-#58 report without evidenceState can legitimately arrive here. The web
// layer renders it evidence-state-aware (ReportPanel.tsx) rather than
// re-validating.
export type AgentRunOutcomeView =
  | { readonly type: "RUNNING" }
  | { readonly type: "COMPLETED"; readonly report: StoredResolutionReport }
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
 * engaged even if it wanted to. A discriminated union, not a flat shape with
 * optional fields: `PUBLIC_TRIAL` (issue #39) is the only variant carrying
 * `visitorRunsRemaining` / `turnstileSiteKey`, and the type system keeps
 * either from being read off a `TOKEN_REQUIRED` or `NOT_APPLICABLE` response.
 * Mirrors apps/api's CapabilitiesResponse exactly.
 */
export type CapabilitiesView =
  | { readonly liveAgentRuns: "UNAVAILABLE"; readonly liveAccess: "NOT_APPLICABLE" }
  | { readonly liveAgentRuns: "AVAILABLE"; readonly liveAccess: "TOKEN_REQUIRED" }
  | {
      readonly liveAgentRuns: "AVAILABLE";
      readonly liveAccess: "PUBLIC_TRIAL";
      /** THIS caller's own remaining trial allowance today — 0 or 1, never a global count. */
      readonly visitorRunsRemaining: 0 | 1;
      readonly turnstileSiteKey: string;
    };

/**
 * One snapshot of a job and its latest run — the response from
 * GET /v1/agent-jobs/:jobId/investigation (§2). `run` / `outcome` are `null`
 * and `trace` / `events` are `[]` when the job has no run yet.
 */
export interface InvestigationStateResponse {
  readonly job: AgentJobResponse;
  readonly run: AgentRunRecordView | null;
  readonly trace: readonly AgentTraceEvent[];
  readonly outcome: AgentRunOutcomeView | null;
  readonly events: readonly InvestigationEventRecord[];
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
