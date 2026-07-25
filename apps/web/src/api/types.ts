// Rich domain shapes are reused, type-only, from @opspilot/contracts — the
// source of truth for report/trace structure. verbatimModuleSyntax (see
// tsconfig.json) makes a value import from this module a compile error, so
// none of this ever enters the bundle at runtime.
import type { AgentTraceEvent, EvidenceReference, ResolutionReport, SuggestedAction } from "@opspilot/contracts";

export type { AgentTraceEvent, EvidenceReference, ResolutionReport, SuggestedAction };

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
