// Isolated reconstruction-proof strategy (§9): mechanizes the issue-38 manual
// precedent (worktree add --detach, apply, byte-compare, remove), with an
// explicit path-set-equality gate that must pass — twice — before any content
// comparison runs, so a bug in diff generation that silently drops a changed
// path can never still report MATCH. Every git command here is either
// --no-index or explicitly cwd-scoped to the isolated worktree; the owner's
// real HEAD/index/working tree are read-only inputs throughout.

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readEntryContent } from "./fingerprint";
import {
  applyCheck,
  applyDiff,
  diffNameOnly,
  diffNumstatPaths,
  diffTrackedPath,
  diffUntrackedPath,
  getWorkingTreeStatus,
  worktreeAdd,
  worktreeRegisteredPaths,
  worktreeRemove,
} from "./git";
import type { ChangeEntry, ReconstructionProof } from "./types";

export interface ReconstructionOutcome {
  proof: ReconstructionProof;
  diffText: string;
}

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function diffSets(expected: ReadonlySet<string>, actual: ReadonlySet<string>): { missingPaths: string[]; extraPaths: string[] } {
  return {
    missingPaths: [...expected].filter((p) => !actual.has(p)).sort(),
    extraPaths: [...actual].filter((p) => !expected.has(p)).sort(),
  };
}

/**
 * Generates the review.diff content for the complete change set: tracked
 * paths via `git diff <baselineSha> -- <path>` (no rename detection),
 * untracked paths via `git diff --no-index /dev/null <path>` — never
 * touching the real .git/index, even transiently.
 */
export function generateReviewDiff(cwd: string, baselineSha: string, changeSet: readonly ChangeEntry[]): string {
  const sorted = [...changeSet].sort((a, b) => (a.path < b.path ? -1 : 1));
  const parts: string[] = [];
  for (const entry of sorted) {
    const text = entry.status === "??" ? diffUntrackedPath(cwd, entry.path) : diffTrackedPath(cwd, baselineSha, entry.path);
    if (text.length > 0) {
      parts.push(text.endsWith("\n") ? text : `${text}\n`);
    }
  }
  return parts.join("");
}

export interface BuildReconstructionProofOptions {
  /**
   * Test-only seam: substitutes the generated review.diff text with a
   * caller-supplied one, so tests can engineer a diff that omits a path or
   * fails to apply without mocking any git plumbing itself — every other
   * step (path-set A from the real change set, the isolated worktree, apply,
   * byte-compare) still runs against real git. Production callers never pass
   * this.
   */
  diffText?: string;
}

export function buildReconstructionProof(
  cwd: string,
  baselineSha: string,
  changeSet: readonly ChangeEntry[],
  options: BuildReconstructionProofOptions = {},
): ReconstructionOutcome {
  const pathSetA = new Set(changeSet.map((e) => e.path));

  // 1. Diff generation.
  const diffText = options.diffText ?? generateReviewDiff(cwd, baselineSha, changeSet);

  // 2. Path-set checkpoint 1: A (discovered change set) vs B (review.diff's
  // own paths) — extracted by having git itself parse the exact diff text
  // (`git apply --numstat -z -`, NUL-safe, decodes any quoted header) rather
  // than regex-matching human-readable headers, which fails closed for a
  // path containing a literal newline.
  const pathSetB = new Set(diffNumstatPaths(cwd, diffText));
  if (!setsEqual(pathSetA, pathSetB)) {
    return { proof: { status: "PATH_SET_MISMATCH", ...diffSets(pathSetA, pathSetB), cleanupError: null }, diffText };
  }

  // 3. Isolated worktree, entirely outside the repo. The parent dir is
  // canonicalized up front so the registered-worktree check in step 7 can
  // compare against the same absolute path git itself records (on macOS
  // `os.tmpdir()` hands back the `/var` symlink to `/private/var`).
  const parentDir = realpathSync(mkdtempSync(join(tmpdir(), "harness-reconstruction-")));
  const worktreePath = join(parentDir, "worktree");

  let proof: ReconstructionProof | null = null;
  let thrown: unknown = null;
  try {
    proof = runProofInWorktree(cwd, worktreePath, baselineSha, diffText, pathSetA);
  } catch (err) {
    thrown = err;
  }

  // 7. Cleanup is mandatory and *verified*: a proof that leaves its isolated
  // worktree registered has mutated the owner's repository, so it is not a
  // trustworthy proof regardless of what it concluded.
  const cleanupError = cleanUpWorktree(cwd, worktreePath, parentDir);

  if (thrown !== null) {
    if (cleanupError !== null) {
      throw new Error(`${describeError(thrown)}; additionally, reconstruction cleanup failed: ${cleanupError}`);
    }
    throw thrown;
  }

  const computed = proof ?? { status: "APPLY_FAILED" as const, missingPaths: [], extraPaths: [], cleanupError: null };
  if (cleanupError !== null) {
    return {
      proof: {
        status: "CLEANUP_FAILED",
        missingPaths: [],
        extraPaths: [],
        cleanupError: `${cleanupError} (proof before cleanup: ${computed.status})`,
      },
      diffText,
    };
  }

  return { proof: computed, diffText };
}

function runProofInWorktree(
  cwd: string,
  worktreePath: string,
  baselineSha: string,
  diffText: string,
  pathSetA: ReadonlySet<string>,
): ReconstructionProof {
  worktreeAdd(cwd, worktreePath, baselineSha);

  // 4. Apply.
  if (!applyCheck(worktreePath, diffText)) {
    return { status: "APPLY_FAILED", missingPaths: [], extraPaths: [], cleanupError: null };
  }
  const applied = applyDiff(worktreePath, diffText);
  if (applied.status !== 0) {
    return { status: "APPLY_FAILED", missingPaths: [], extraPaths: [], cleanupError: null };
  }

  // 5. Path-set checkpoint 2: C — tracked changes (name-only vs baseline)
  // plus untracked paths actually present on disk after apply, re-derived
  // independently rather than trusted from the original change set.
  const trackedChangedInWorktree = diffNameOnly(worktreePath, baselineSha);
  const untrackedInWorktree = getWorkingTreeStatus(worktreePath).untracked;
  const pathSetC = new Set([...trackedChangedInWorktree, ...untrackedInWorktree]);

  if (!setsEqual(pathSetA, pathSetC)) {
    return { status: "PATH_SET_MISMATCH", ...diffSets(pathSetA, pathSetC), cleanupError: null };
  }

  // 6. Only once A == B == C does the proof proceed: compare every path by
  // object type *and* content, using the same never-follow-a-symlink
  // classification the fingerprint uses. A symlink is compared as its target
  // string (the Git-tracked link representation), never by reading through it,
  // so a link and a regular file holding the link's text are never conflated —
  // and an unsupported object type raises rather than silently comparing equal.
  for (const path of pathSetA) {
    const real = readEntryContent(cwd, path);
    const reconstructed = readEntryContent(worktreePath, path);
    if (real.kind !== reconstructed.kind || real.contentHash !== reconstructed.contentHash) {
      return { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: null };
    }
  }

  return { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null };
}

/** Removes the temporary worktree and its parent dir, then *proves* the registration is gone rather than assuming it. Returns null on success, or a description of everything that went wrong. */
function cleanUpWorktree(repoCwd: string, worktreePath: string, parentDir: string): string | null {
  const problems: string[] = [];

  const removal = worktreeRemove(repoCwd, worktreePath);
  if (removal.status !== 0) {
    problems.push(`"git worktree remove --force" exited ${removal.status}: ${removal.stderr.trim()}`);
  }

  try {
    rmSync(parentDir, { recursive: true, force: true });
  } catch (err) {
    problems.push(`could not remove temp dir ${parentDir}: ${describeError(err)}`);
  }

  try {
    if (worktreeRegisteredPaths(repoCwd).includes(worktreePath)) {
      problems.push(`worktree is still registered at ${worktreePath}`);
    }
  } catch (err) {
    problems.push(`could not verify worktree deregistration: ${describeError(err)}`);
  }

  return problems.length > 0 ? problems.join("; ") : null;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
