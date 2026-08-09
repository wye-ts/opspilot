// Shared TS types for every JSON artifact the Harness Foundation writes.
// See CONTEXT.md for the frozen vocabulary these shapes encode.

export type ConfigSource = "default" | "task-declaration" | "cli";

export interface ResolvedValue<T> {
  value: T;
  source: ConfigSource;
}

export type BaselineSource =
  | "cli"
  | "task-declaration"
  | "merge-base-origin-main"
  | "merge-base-main";

export interface ResolvedConfig {
  taskPath: ResolvedValue<string | null>;
  agentDir: ResolvedValue<string>;
  baselineSha: string;
  baselineSource: BaselineSource;
  // Command-specific fields, present only on the commands that accept them:
  // scope on scope-check, branch/workingTree/index on preflight, mode on verify.
  scope?: ResolvedValue<string[] | null>;
  branch?: ResolvedValue<string | null>;
  workingTree?: ResolvedValue<"clean" | "any">;
  index?: ResolvedValue<"empty" | "any">;
  mode?: ResolvedValue<"focused" | "final">;
}

export interface ProvenanceBlock {
  baselineSha: string;
  headSha: string;
  changeSetFingerprint: string;
  resolvedConfig: ResolvedConfig;
}

export type ChangeStatus = "A" | "M" | "D" | "??";

export interface ChangeEntry {
  path: string;
  status: ChangeStatus;
}

export interface ToolAvailabilityEntry {
  tool: string;
  available: boolean;
  version: string | null;
}

export interface ExpectationCheck {
  name: string;
  declared: string | null;
  observed: string | null;
  satisfied: boolean;
}

export interface PreflightResult {
  status: "PASS" | "FAIL";
  branch: string | null;
  staged: string[];
  workingTree: {
    trackedModified: string[];
    trackedDeleted: string[];
    untracked: string[];
  };
  expectations: ExpectationCheck[];
  docPointers: string[];
  toolingAvailability: ToolAvailabilityEntry[];
  failureReasons: string[];
  provenance: ProvenanceBlock;
}

export type StepStatus = "PASS" | "FAIL";

export interface VerifyStep {
  command: string;
  status: StepStatus;
  exitCode: number;
  durationMs: number;
  logPath: string;
  outputTail: string;
}

export type VerifyMode = "focused" | "final";

export interface VerifyResult {
  mode: VerifyMode;
  status: "PASS" | "FAIL";
  touchedWorkspaces: string[];
  steps: VerifyStep[];
  notRun: string[];
  failureReasons: string[];
  provenance: ProvenanceBlock;
}

export type ScopeCheckStatus = "PASS" | "FAIL" | "NOT_CONFIGURED";

export interface ScopeCheckResult {
  status: ScopeCheckStatus;
  scopePatterns: string[];
  changeSetPaths: string[];
  outOfScopePaths: string[];
  failureReasons: string[];
  provenance: ProvenanceBlock;
}

export type Freshness = "CURRENT" | "STALE" | "MISSING";
export type MissingReason = "NOT_FOUND" | "INVALID_ARTIFACT" | null;

export interface NestedResult<T> {
  freshness: Freshness;
  missingReason: MissingReason;
  result: T | null;
}

export type ReconstructionStatus =
  | "MATCH"
  | "MISMATCH"
  | "APPLY_FAILED"
  | "PATH_SET_MISMATCH"
  | "CLEANUP_FAILED";

export interface ReconstructionProof {
  status: ReconstructionStatus;
  missingPaths: string[];
  extraPaths: string[];
  /**
   * Non-null only when `status` is CLEANUP_FAILED: what the proof could not
   * clean up (and what it had concluded before cleanup was attempted). A proof
   * whose isolated worktree is still registered is not a trustworthy proof, so
   * CLEANUP_FAILED overrides any otherwise-successful outcome.
   */
  cleanupError: string | null;
}

export interface ReviewBundleResult {
  status: "OK" | "FAILED";
  failureReason: string | null;
  git: {
    baselineSha: string;
    headSha: string;
    branch: string | null;
    changedPaths: string[];
    diffHash: string;
  };
  reconstructionProof: ReconstructionProof;
  verify: {
    focused: NestedResult<VerifyResult>;
    final: NestedResult<VerifyResult>;
  };
  scopeCheck: NestedResult<ScopeCheckResult>;
}

export interface TaskDeclaration {
  $schema: "opspilot-harness/task-declaration@1";
  baseline?: string;
  expectedBranch?: string;
  expectedWorkingTree?: "clean" | "any";
  expectedIndex?: "empty" | "any";
  // Absent and explicit null are both NOT_CONFIGURED; [] is configured and
  // matches nothing — the two must stay distinguishable downstream.
  scope?: string[] | null;
}
