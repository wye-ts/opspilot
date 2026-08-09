// default < task-declaration < CLI merge, plus baseline resolution (the exact
// merge-base fallback chain from the frozen plan §3). Every command prints
// its fully resolved configuration (value + source) before doing any work.

import { mergeBaseOutcome, resolveCommitSha } from "./git";
import type { BaselineSource, ResolvedValue } from "./types";

export class BaselineResolutionError extends Error {}

export function resolveField<T>(defaultValue: T, taskValue: T | undefined, cliValue: T | undefined): ResolvedValue<T> {
  if (cliValue !== undefined) return { value: cliValue, source: "cli" };
  if (taskValue !== undefined) return { value: taskValue, source: "task-declaration" };
  return { value: defaultValue, source: "default" };
}

/**
 * Exact fallback chain (§3): CLI --baseline -> task-declaration baseline ->
 * `git merge-base HEAD origin/main` -> `git merge-base HEAD main` -> hard
 * fail. Every branch resolves to exactly one commit SHA; a diverged local
 * `main` is never treated as the baseline via its raw tip, only via its
 * merge-base with HEAD.
 */
export function resolveBaseline(
  cwd: string,
  cliBaseline: string | undefined,
  taskBaseline: string | undefined,
): { sha: string; source: BaselineSource } {
  if (cliBaseline !== undefined) {
    const sha = resolveCommitSha(cwd, cliBaseline);
    if (!sha) {
      throw new BaselineResolutionError(`--baseline "${cliBaseline}" does not resolve to a commit`);
    }
    return { sha, source: "cli" };
  }

  if (taskBaseline !== undefined) {
    const sha = resolveCommitSha(cwd, taskBaseline);
    if (!sha) {
      throw new BaselineResolutionError(
        `task-declaration baseline "${taskBaseline}" does not resolve to a commit`,
      );
    }
    return { sha, source: "task-declaration" };
  }

  // Only the two *expected* misses — the candidate ref not existing here, and
  // two histories genuinely sharing no ancestor — advance the chain. A fatal
  // git failure is never silently downgraded into "try the next candidate":
  // that would let a broken repository masquerade as a diverged one and hand
  // back the wrong baseline (or a misleading "unresolved baseline" message).
  const viaOriginMain = mergeBaseOutcome(cwd, "HEAD", "origin/main");
  if (viaOriginMain.kind === "FATAL") {
    throw new BaselineResolutionError(`baseline resolution failed: ${viaOriginMain.message}`);
  }
  if (viaOriginMain.kind === "FOUND") {
    return { sha: viaOriginMain.sha, source: "merge-base-origin-main" };
  }

  const viaMain = mergeBaseOutcome(cwd, "HEAD", "main");
  if (viaMain.kind === "FATAL") {
    throw new BaselineResolutionError(`baseline resolution failed: ${viaMain.message}`);
  }
  if (viaMain.kind === "FOUND") {
    return { sha: viaMain.sha, source: "merge-base-main" };
  }

  throw new BaselineResolutionError(
    "unresolved baseline: no --baseline given, no task-declaration baseline, and neither " +
      '"git merge-base HEAD origin/main" nor "git merge-base HEAD main" resolved. Supply an ' +
      "explicit --baseline or a task-declaration baseline value.",
  );
}
