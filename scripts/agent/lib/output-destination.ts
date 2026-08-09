// Guards every Harness-owned persistent write target codex-review produces
// (review-findings.json, review-summary.md, codex-review.log) against
// silently becoming untracked evidence that falsifies the freshness check
// that already ran: an in-repo destination Git does not ignore changes the
// complete change set the instant these files are written, making a
// successful artifact stale before its own ink is dry. A destination outside
// the repository carries no such risk and is always allowed.
//
// Classification is physical, not lexical: a target path that lexically
// looks outside the repo can still traverse a symlinked ancestor into an
// unignored in-repo directory, so both the target and the repo root are
// resolved to their real (symlink-free) location before comparison. The
// target need not exist yet — only the nearest existing ancestor is
// `realpath`'d; the unresolved suffix is appended as-is, and no directory is
// ever created merely to perform the check.
//
// The target's own final path component is deliberately never followed
// through a symlink, even when it already exists as one: every persistent
// artifact here is written via `lib/atomic-write.ts`'s same-directory
// temp-file-then-rename, and a rename onto an existing pathname replaces that
// pathname itself rather than following it — a pre-existing final-component
// symlink pointing outside the repo would still have its own (in-repo)
// pathname clobbered by the rename. Only the target's ancestors are resolved
// through symlinks; the basename is always taken literally.
//
// Independently of repo/ignore classification, a persistent write target
// that resolves to the same physical file as an evidence input this run
// already read (the task declaration, review.json, review.diff) is always
// unsafe: those inputs are typically Git-ignored themselves (living under
// `.agent/`), so the repo/ignore rule alone would wave them through, but
// writing there would silently overwrite evidence the run's own freshness
// checks depend on.
//
// The alias check therefore compares two distinct identities, because a
// write destination and an evidence input are reached through different
// filesystem operations with different symlink semantics:
//
//   write destination identity: physical ancestors + literal final basename
//     (resolvePhysicalPath — a same-directory atomic rename onto an existing
//     pathname replaces that pathname itself; it never follows a
//     final-component symlink)
//
//   evidence read identity: fully dereferenced read target, including the
//     final symlink (resolveEvidenceReadIdentity — evidence is read via
//     plain readFileSync, which *does* follow a final-component symlink)
//
// An evidence input whose own pathname collides with a destination's write
// identity is unsafe (regardless of what that pathname currently contains or
// points to — the rename would clobber the pathname evidence was read
// from). An evidence input that is itself a symlink whose target *is* a
// destination's write identity is also unsafe (readFileSync would silently
// start returning this run's own freshly written bytes). Both comparisons
// are required; neither subsumes the other.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface OutputDestinationCheck {
  safe: boolean;
  /** Null when safe; a human-readable reason otherwise. */
  reason: string | null;
}

export interface EvidenceInput {
  /** Path as given on the command line / resolved config — need not exist relative to cwd. */
  path: string;
  /** Human-readable label used in the failure reason. */
  label: string;
}

/**
 * Resolves `targetPath` to the physical location a same-directory atomic
 * rename onto it actually lands at: every ancestor directory is resolved to
 * its real, symlink-free location (walking up to the nearest existing one
 * and appending any not-yet-existing suffix unresolved — no directory is
 * ever created to perform this), but the final path component itself is
 * always taken literally, never `realpath`'d, regardless of whether it
 * already exists or is itself a symlink.
 */
export function resolvePhysicalPath(targetPath: string): string {
  const resolvedTarget = resolve(targetPath);
  const parent = dirname(resolvedTarget);
  if (parent === resolvedTarget) {
    // The filesystem root itself — nothing to split off.
    return resolvedTarget;
  }
  return join(resolvePhysicalAncestor(parent), basename(resolvedTarget));
}

/**
 * Resolves `evidencePath` to the physical location that a plain
 * `readFileSync(evidencePath)` would actually read from: every path
 * component — including the final one — is dereferenced through symlinks,
 * unlike `resolvePhysicalPath`, which deliberately leaves a target's final
 * component literal to model atomic-rename replace-not-follow semantics.
 * Falls back to `resolvePhysicalPath` when the path cannot be fully
 * dereferenced (missing, broken symlink, permission error): a real
 * `readFileSync` would fail identically in that case, so there is no live
 * read to alias by physical identity, and the fallback still catches a
 * same-string collision against a not-yet-existing write destination.
 */
export function resolveEvidenceReadIdentity(evidencePath: string): string {
  try {
    return realpathSync(resolve(evidencePath));
  } catch {
    return resolvePhysicalPath(evidencePath);
  }
}

function resolvePhysicalAncestor(dirPath: string): string {
  let current = dirPath;
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) {
      // Unreachable in practice (the filesystem root always exists), but
      // fail back to lexical resolution rather than looping forever.
      return dirPath;
    }
    suffix.unshift(basename(current));
    current = parent;
  }
  const realBase = realpathSync(current);
  return suffix.length > 0 ? join(realBase, ...suffix) : realBase;
}

/** The repo root is a reference boundary, never an atomic-rename target — resolved fully, including its own final component. */
function resolvePhysicalRepoRoot(repoRoot: string): string {
  return realpathSync(resolve(repoRoot));
}

function isInsideRepo(repoRootPhysical: string, targetPhysical: string): boolean {
  const rel = relative(repoRootPhysical, targetPhysical);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Two literal (never-follow-final-symlink) physical paths refer to the same
// on-disk entry when their lstat device+inode pair matches. This catches a
// case-insensitive-filesystem alias (e.g. "Review-Findings.json" vs.
// "review-findings.json") that resolvePhysicalPath's string comparison alone
// misses: its final path component is deliberately taken literally, never
// realpath'd (to preserve atomic-rename replace-not-follow semantics), so two
// differently-cased names for the identical directory entry still produce two
// different physical-path strings even though a rename to either one
// clobbers the very same file. Only meaningful when both sides already
// exist — a target that does not yet exist cannot alias anything by
// filesystem identity, only by the (already-handled) path-string case above.
function sameFilesystemEntry(physicalPathA: string, physicalPathB: string): boolean {
  try {
    const a = lstatSync(physicalPathA);
    const b = lstatSync(physicalPathB);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

// Checked by exact file path, not by directory: a gitignore pattern like
// `*.log` ignores the file without necessarily ignoring the directory that
// contains it, so checking the containing directory alone could reject a
// destination that is actually safe (or accept one that is not).
function isGitIgnored(repoRoot: string, targetPhysical: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", targetPhysical], { cwd: repoRoot, encoding: "utf8" });
  return result.status === 0;
}

/**
 * A destination file path is safe when:
 * 1. it does not physically alias any current evidence input, AND
 * 2. it is physically outside the repository, or physically inside it and
 *    Git-ignored.
 *
 * Anything else fails closed. Both the target and (for rule 2) the repo root
 * are compared by physical location, so a symlink cannot be used to make an
 * unsafe destination look safe, or vice versa.
 */
export function checkOutputDestination(
  repoRoot: string,
  targetPath: string,
  label: string,
  evidenceInputs: readonly EvidenceInput[] = [],
): OutputDestinationCheck {
  const targetPhysical = resolvePhysicalPath(targetPath);

  for (const input of evidenceInputs) {
    // Write-identity collision: the evidence input's own pathname (ancestors
    // resolved, final component literal) is exactly the destination's write
    // target — the rename would clobber the pathname evidence was read from,
    // regardless of what that pathname currently contains or points to.
    const inputWriteIdentity = resolvePhysicalPath(input.path);
    // Read-identity collision: the evidence input is itself a symlink (or
    // behind one) whose fully dereferenced target *is* the destination's
    // write target — a plain readFileSync of the evidence path follows that
    // symlink, unlike the atomic-rename write it would alias.
    const inputReadIdentity = resolveEvidenceReadIdentity(input.path);
    const aliasesTarget =
      inputWriteIdentity === targetPhysical ||
      sameFilesystemEntry(inputWriteIdentity, targetPhysical) ||
      inputReadIdentity === targetPhysical ||
      sameFilesystemEntry(inputReadIdentity, targetPhysical);
    if (aliasesTarget) {
      return {
        safe: false,
        reason: `${label} destination "${targetPath}" resolves to the same file as ${input.label} ("${input.path}") — writing there would overwrite evidence this run depends on`,
      };
    }
  }

  const repoRootPhysical = resolvePhysicalRepoRoot(repoRoot);
  if (!isInsideRepo(repoRootPhysical, targetPhysical)) {
    return { safe: true, reason: null };
  }
  if (isGitIgnored(repoRoot, targetPhysical)) {
    return { safe: true, reason: null };
  }
  return {
    safe: false,
    reason: `${label} destination "${targetPath}" is inside the repository and not Git-ignored — writing to it would make this run's own artifact stale`,
  };
}
