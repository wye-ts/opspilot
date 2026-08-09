// Builds the provenance block embedded in every gate result, and compares it
// against freshly recomputed facts to classify a prior result as
// CURRENT/STALE/MISSING(+reason) — CONTEXT.md's exact freshness vocabulary,
// never re-running the gate to resolve any of these states.
//
// Freshness has two layers:
//
//  1. State facts — resolved baseline, HEAD, complete-change-set fingerprint.
//  2. Command-semantic resolved configuration — the settings that determine
//     *what the gate actually checked*. A scope-check that passed against one
//     set of scope patterns is not evidence about a different set, even with an
//     identical tree and HEAD. Only semantics are compared, never incidental
//     provenance metadata (agentDir, taskPath, the source tier itself), which
//     say where a run's inputs came from, not what it checked.
//
// Artifact validation is mode-specific and structurally strict: a
// verify-focused.json must never satisfy the verify-final.json contract, since
// focused mode is deliberately the weaker guarantee.

import { existsSync, readFileSync } from "node:fs";

import type {
  BaselineSource,
  ConfigSource,
  Freshness,
  MissingReason,
  NestedResult,
  ProvenanceBlock,
  ResolvedConfig,
  ResolvedValue,
  ScopeCheckResult,
  VerifyMode,
  VerifyResult,
} from "./types";

export function buildProvenance(
  baselineSha: string,
  headSha: string,
  changeSetFingerprint: string,
  resolvedConfig: ProvenanceBlock["resolvedConfig"],
): ProvenanceBlock {
  return { baselineSha, headSha, changeSetFingerprint, resolvedConfig };
}

export interface CurrentFacts {
  baselineSha: string;
  headSha: string;
  changeSetFingerprint: string;
}

export function compareProvenance(stored: ProvenanceBlock, current: CurrentFacts): Freshness {
  const matches =
    stored.baselineSha === current.baselineSha &&
    stored.headSha === current.headSha &&
    stored.changeSetFingerprint === current.changeSetFingerprint;
  return matches ? "CURRENT" : "STALE";
}

// --- structural validation ---------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Strict: every key present must be one this schema version knows about. An artifact carrying an unknown field was produced by a different contract and is not safe to read as this one. */
function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}

const CONFIG_SOURCES = new Set<ConfigSource>(["default", "task-declaration", "cli"]);
const BASELINE_SOURCES = new Set<BaselineSource>([
  "cli",
  "task-declaration",
  "merge-base-origin-main",
  "merge-base-main",
]);

function isResolvedValue(value: unknown, isValidValue: (inner: unknown) => boolean): value is ResolvedValue<unknown> {
  if (!isObject(value) || !hasOnlyKeys(value, ["value", "source"])) return false;
  return typeof value.source === "string" && CONFIG_SOURCES.has(value.source as ConfigSource) && isValidValue(value.value);
}

const RESOLVED_CONFIG_KEYS = [
  "taskPath",
  "agentDir",
  "baselineSha",
  "baselineSource",
  "scope",
  "branch",
  "workingTree",
  "index",
  "mode",
] as const;

function isResolvedConfig(value: unknown): value is ResolvedConfig {
  if (!isObject(value) || !hasOnlyKeys(value, RESOLVED_CONFIG_KEYS)) return false;
  if (!isResolvedValue(value.taskPath, (v) => v === null || typeof v === "string")) return false;
  if (!isResolvedValue(value.agentDir, (v) => typeof v === "string")) return false;
  if (typeof value.baselineSha !== "string") return false;
  if (typeof value.baselineSource !== "string" || !BASELINE_SOURCES.has(value.baselineSource as BaselineSource)) {
    return false;
  }
  if (value.scope !== undefined && !isResolvedValue(value.scope, (v) => v === null || isStringArray(v))) return false;
  if (value.branch !== undefined && !isResolvedValue(value.branch, (v) => v === null || typeof v === "string")) {
    return false;
  }
  if (value.workingTree !== undefined && !isResolvedValue(value.workingTree, (v) => v === "clean" || v === "any")) {
    return false;
  }
  if (value.index !== undefined && !isResolvedValue(value.index, (v) => v === "empty" || v === "any")) return false;
  if (value.mode !== undefined && !isResolvedValue(value.mode, (v) => v === "focused" || v === "final")) return false;
  return true;
}

function isProvenanceBlock(value: unknown): value is ProvenanceBlock {
  if (!isObject(value) || !hasOnlyKeys(value, ["baselineSha", "headSha", "changeSetFingerprint", "resolvedConfig"])) {
    return false;
  }
  return (
    typeof value.baselineSha === "string" &&
    typeof value.headSha === "string" &&
    typeof value.changeSetFingerprint === "string" &&
    isResolvedConfig(value.resolvedConfig)
  );
}

interface ParsedVerifyStep {
  command: string;
  status: "PASS" | "FAIL";
}

function parseVerifyStep(value: unknown): ParsedVerifyStep | null {
  if (!isObject(value)) return null;
  if (!hasOnlyKeys(value, ["command", "status", "exitCode", "durationMs", "logPath", "outputTail"])) return null;
  if (
    typeof value.command !== "string" ||
    (value.status !== "PASS" && value.status !== "FAIL") ||
    typeof value.exitCode !== "number" ||
    typeof value.durationMs !== "number" ||
    typeof value.logPath !== "string" ||
    typeof value.outputTail !== "string"
  ) {
    return null;
  }
  return { command: value.command, status: value.status };
}

// The exact, ordered command list `agent:verify --final` runs — must be kept
// in sync by hand with verify.ts's own FINAL_MODE_STEPS (which additionally
// carries per-step log filenames this validator has no need for). Duplicated
// rather than imported so this lib module never depends on a CLI entrypoint
// script; this is the same kind of single hand-maintained coupling verify.ts
// itself already accepts between FINAL_MODE_STEPS and CI's `verify` job.
// Exported (only) so the test suite can build accurate step sequences from
// the same literal rather than hand-copying it a second time.
export const FINAL_STEP_COMMANDS: readonly string[] = [
  "pnpm typecheck",
  "pnpm test",
  "pnpm build",
  "pnpm --filter @opspilot/web run check:bundle",
];

// Final mode always reports exactly this pair, unconditionally — even on an
// early failure that never runs a step (CONTEXT.md's "always explicitly
// reports" requirement). Must match verify.ts's own literal.
export const FINAL_NOT_RUN: readonly string[] = ["integration", "docker-smoke"];

/**
 * Whether `steps` is a shape the real `agent:verify --final` producer could
 * actually have emitted, given `status`. Checks only what the producer
 * guarantees (CONTEXT.md, verify.ts's FINAL_MODE_STEPS) — not merely that
 * every individual step looks well-formed, which is how a hand-crafted
 * artifact like `{ mode: "final", status: "PASS", steps: [], notRun: [...] }`
 * could otherwise slip through: a real final PASS always ran, and passed, all
 * four steps.
 *
 * - PASS: exactly the four contract commands, in order, every one PASS.
 * - FAIL: either zero steps (an early ground-truth/config failure that never
 *   reached execution) or a fail-fast prefix of the contract commands — some
 *   number of leading PASSes followed by exactly one FAIL, matching how
 *   verify.ts's runFinal stops at the first failing step.
 */
function isValidFinalStepSequence(status: "PASS" | "FAIL", steps: readonly ParsedVerifyStep[]): boolean {
  if (status === "PASS") {
    if (steps.length !== FINAL_STEP_COMMANDS.length) return false;
    return steps.every((step, i) => step.command === FINAL_STEP_COMMANDS[i] && step.status === "PASS");
  }

  // FAIL.
  if (steps.length === 0) return true;
  if (steps.length > FINAL_STEP_COMMANDS.length) return false;
  return steps.every((step, i) => {
    const isLastExecuted = i === steps.length - 1;
    return step.command === FINAL_STEP_COMMANDS[i] && step.status === (isLastExecuted ? "FAIL" : "PASS");
  });
}

/**
 * Builds a validator that accepts a verify result **only** for the given mode.
 * Both the top-level `mode` and the mode recorded in the run's own resolved
 * configuration must agree with it, so a focused artifact placed (or copied,
 * or symlinked) at `verify-final.json` is rejected as INVALID_ARTIFACT rather
 * than read as evidence of the stronger CI-equivalent guarantee.
 *
 * For final mode specifically, `notRun` and `steps` are checked against the
 * exact contract the real producer guarantees (see `isValidFinalStepSequence`)
 * rather than merely "an array of well-shaped steps" — otherwise a doctored
 * `{ status: "PASS", steps: [], notRun: [] }` would pass structural validation
 * while claiming a CI-equivalent guarantee nothing ever ran. Focused mode has
 * no such fixed contract (its steps depend on which workspaces were touched),
 * so it is intentionally not held to the same shape.
 */
export function makeVerifyResultValidator(mode: VerifyMode): ResultValidator<VerifyResult> {
  return (value: unknown): value is VerifyResult => {
    if (!isObject(value)) return false;
    if (!hasOnlyKeys(value, ["mode", "status", "touchedWorkspaces", "steps", "notRun", "failureReasons", "provenance"])) {
      return false;
    }
    if (value.mode !== mode) return false;
    if (value.status !== "PASS" && value.status !== "FAIL") return false;
    if (!isStringArray(value.touchedWorkspaces)) return false;
    if (!Array.isArray(value.steps)) return false;
    const parsedSteps = value.steps.map(parseVerifyStep);
    if (parsedSteps.some((step) => step === null)) return false;
    if (!isStringArray(value.notRun)) return false;
    if (!isStringArray(value.failureReasons)) return false;
    if (!isProvenanceBlock(value.provenance)) return false;
    // The producer always records the mode it ran in; a disagreement between
    // the two means the artifact was assembled by something other than a real run.
    if (value.provenance.resolvedConfig.mode?.value !== mode) return false;

    if (mode === "final") {
      if (value.notRun.length !== FINAL_NOT_RUN.length || !value.notRun.every((v, i) => v === FINAL_NOT_RUN[i])) {
        return false;
      }
      if (!isValidFinalStepSequence(value.status, parsedSteps as ParsedVerifyStep[])) return false;
    }

    return true;
  };
}

export const isFocusedVerifyResult = makeVerifyResultValidator("focused");
export const isFinalVerifyResult = makeVerifyResultValidator("final");

export function isScopeCheckResult(value: unknown): value is ScopeCheckResult {
  if (!isObject(value)) return false;
  if (!hasOnlyKeys(value, ["status", "scopePatterns", "changeSetPaths", "outOfScopePaths", "failureReasons", "provenance"])) {
    return false;
  }
  return (
    (value.status === "PASS" || value.status === "FAIL" || value.status === "NOT_CONFIGURED") &&
    isStringArray(value.scopePatterns) &&
    isStringArray(value.changeSetPaths) &&
    isStringArray(value.outOfScopePaths) &&
    isStringArray(value.failureReasons) &&
    isProvenanceBlock(value.provenance)
  );
}

// --- command-semantic freshness ---------------------------------------------

/**
 * What a consumer can currently re-derive about the scope a scope-check run
 * would resolve. `taskScope` is the scope the *explicitly supplied* task
 * declaration declares right now (null when it declares none);
 * `taskDeclarationSupplied` records whether the consumer was given one at all —
 * a consumer that was not cannot re-derive a task-sourced scope and must say so
 * rather than guess.
 */
export interface CurrentScopeSemantics {
  taskDeclarationSupplied: boolean;
  taskScope: string[] | null;
}

function sameScope(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * Whether a stored scope-check result still reflects the scope semantics in
 * effect now. Per source tier:
 *
 * - `cli`: a `--scope` override is not re-derivable by a consumer that has no
 *   `--scope` of its own, and inventing one would fabricate configuration. A
 *   CLI-sourced scope is therefore never the reason an artifact goes STALE —
 *   the override's semantics are preserved as recorded.
 * - `task-declaration`: re-resolved from the consumer's own explicitly supplied
 *   task declaration. A scope edited in that file after the gate ran makes the
 *   artifact STALE even with an untouched tree and HEAD. With no task
 *   declaration supplied the consumer cannot establish that the gate's scope
 *   still resolves the same way, so it fails closed to STALE (a non-fatal
 *   "re-run the gate" signal, resolved by passing the same `--task`).
 * - `default`: the gate ran with no scope configured; that is still current
 *   only while no scope is configured now either.
 */
export function scopeSemanticsCurrent(stored: ScopeCheckResult, current: CurrentScopeSemantics): boolean {
  const storedScope = stored.provenance.resolvedConfig.scope;
  if (storedScope === undefined) return true; // nothing semantic recorded to compare against

  switch (storedScope.source) {
    case "cli":
      return true;
    case "task-declaration":
      if (!current.taskDeclarationSupplied) return false;
      return sameScope(storedScope.value ?? [], current.taskScope ?? []);
    case "default":
      return current.taskScope === null;
  }
}

// --- loading -----------------------------------------------------------------

export type ResultValidator<T> = (value: unknown) => value is T;

/** Extra, artifact-specific freshness predicate: `false` means the stored run's command semantics no longer hold, so the result is STALE even when the state facts match. */
export type SemanticFreshnessCheck<T> = (result: T) => boolean;

/**
 * Reads a prior gate result and classifies it relative to current facts.
 * Never re-runs the gate. Distinguishes "never produced" (NOT_FOUND) from
 * "present but fails schema validation" (INVALID_ARTIFACT) as a sub-reason
 * under MISSING — both stay MISSING at the top level.
 */
export function loadGateResult<T extends { provenance: ProvenanceBlock }>(
  path: string,
  validate: ResultValidator<T>,
  current: CurrentFacts,
  semanticallyCurrent?: SemanticFreshnessCheck<T>,
): NestedResult<T> {
  if (!existsSync(path)) {
    return { freshness: "MISSING", missingReason: "NOT_FOUND" as MissingReason, result: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { freshness: "MISSING", missingReason: "INVALID_ARTIFACT" as MissingReason, result: null };
  }

  if (!validate(parsed)) {
    return { freshness: "MISSING", missingReason: "INVALID_ARTIFACT" as MissingReason, result: null };
  }

  const factsFreshness = compareProvenance(parsed.provenance, current);
  const freshness: Freshness =
    factsFreshness === "CURRENT" && semanticallyCurrent !== undefined && !semanticallyCurrent(parsed)
      ? "STALE"
      : factsFreshness;
  return { freshness, missingReason: null, result: parsed };
}
