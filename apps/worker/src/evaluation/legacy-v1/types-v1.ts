// FROZEN v1 oracle artifact (OpsPilot #59 Checkpoint A §5): the historical
// TS-internal v1 check/result types, preserved so the offline v1 regression
// oracle can re-score the frozen ts-parity-v1.json fixture. The active
// internal types (../types.ts) are the v2 status-based model — this module
// is unwired from the active runtime and must never change.
//
// EvaluationExpectations is deliberately imported from the shared ../types
// module: its shape did not change between v1 and v2 at Checkpoint A, so the
// frozen oracle reuses it rather than freezing a redundant copy.
import type { CheckReasonCode } from "./check-reason-codes-v1";
import type { ObservedFactsV1 } from "./observed-facts-v1";
import type { EvaluationExpectations } from "../types";

// The historical v1 check result, carrying `passed` (a check passed iff its
// result was a pass; there was no NOT_APPLICABLE state in v1). Retains
// expected/observed for local test/debug purposes, exactly as the original
// v1 internal shape did.
export interface EvaluationCheckResultV1 {
  readonly name: string;
  readonly passed: boolean;
  readonly expected: unknown;
  readonly observed: unknown;
  // Present iff passed === false.
  readonly reasonCode?: CheckReasonCode;
}

export interface EvaluationCaseResultV1Internal {
  readonly caseId: string;
  readonly passed: boolean;
  readonly checks: readonly EvaluationCheckResultV1[];
  readonly observed: ObservedFactsV1;
}

export type { EvaluationExpectations };
