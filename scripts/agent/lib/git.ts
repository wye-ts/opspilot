// Branch/HEAD/status/complete-change-set/diff plumbing. Every discovery and
// diff invocation here is NUL-safe (`-z`, parsed by splitting on `\0`, never
// on newlines) and carries an explicit `--no-renames`, independent of the
// caller's local `diff.renames`/`status.renames`/`merge.renames` git config —
// this is what keeps reconstruction's path-set-equality checkpoints (see
// lib/reconstruction.ts) meaningful.

import { spawnSync } from "node:child_process";

import type { ChangeEntry, ChangeStatus } from "./types";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export class GitError extends Error {
  readonly result: GitRunResult;

  constructor(message: string, result: GitRunResult) {
    super(message);
    this.name = "GitError";
    this.result = result;
  }
}

/**
 * Thrown by `runGit` when the `git` child process never produced a Git exit
 * code at all — it could not be spawned, or it was terminated by a signal
 * (SIGKILL from an OOM killer or cgroup limit, an external `kill`, etc.)
 * rather than exiting normally. `spawnSync` reports the latter as
 * `status: null` with `signal` set; every downstream parser in this file
 * (`lookupRef`'s tri-state, `mergeBaseOutcome`'s fallback classification, the
 * plain `status !== 0` checks) is written entirely in terms of *numeric Git
 * exit codes*, so silently coercing `null` into some chosen number (as this
 * boundary used to do, into `1`) would hand every one of them a fabricated
 * exit code indistinguishable from a real one — `1` in particular reads to
 * `lookupRef` as "git cleanly reported no such ref". This is deliberately not
 * a `GitError`: a `GitError` means git ran to completion and reported a
 * problem via its exit code; this means git never got the chance to.
 */
export class GitExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitExecutionError";
  }
}

/**
 * Only a normally-exited `git` process may produce a `GitRunResult` — i.e.
 * only `spawnSync`'s `status` field, never `signal`, may become the `status`
 * here. Spawn failure (`result.error`) and signal termination
 * (`result.status === null`) are both fatal Git *execution* failures, thrown
 * directly rather than encoded as some magic status number, so that no
 * downstream caller has to know signals exist to stay fail-closed — they get
 * that for free by virtue of never observing an invented exit code.
 */
export function runGit(cwd: string, args: string[]): GitRunResult {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new GitExecutionError(`git ${args.join(" ")} failed to execute: ${result.error.message}`);
  }
  if (result.status === null) {
    const signalNote = result.signal ? ` (terminated by signal ${result.signal})` : " (terminated abnormally)";
    throw new GitExecutionError(`git ${args.join(" ")} produced no exit code${signalNote}`);
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

function requireGit(cwd: string, args: string[]): string {
  const result = runGit(cwd, args);
  if (result.status !== 0) {
    throw new GitError(`git ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`, result);
  }
  return result.stdout;
}

function splitNulRecords(raw: string): string[] {
  return raw.split("\0").filter((entry) => entry.length > 0);
}

/**
 * Splits the first `count` space-delimited fields off a porcelain-v2 record and
 * returns them plus the untouched remainder. The remainder is the raw path: with
 * `-z`, git emits it unquoted and NUL-terminated, so it may legitimately contain
 * spaces, tabs, or newlines and must never be re-split.
 */
function splitLeadingFields(rest: string, count: number): { fields: string[]; remainder: string } | null {
  const fields: string[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i += 1) {
    const space = rest.indexOf(" ", cursor);
    if (space === -1) return null;
    fields.push(rest.slice(cursor, space));
    cursor = space + 1;
  }
  return { fields, remainder: rest.slice(cursor) };
}

export interface PorcelainEntry {
  /** Record type: `1` ordinary change, `u` unmerged, `?` untracked. */
  kind: "1" | "u" | "?";
  /** The two-character `<X><Y>` status field; `"??"` for untracked records. */
  xy: string;
  path: string;
}

/**
 * Parses `git status --porcelain=v2 -z` output. Each record type has its own
 * field count before the path — ordinary (`1`) has 7, unmerged (`u`) has 9 — so
 * they must be parsed separately; sharing one shape silently mis-slices `u`
 * records, and splitting the record on spaces corrupts any path containing a
 * space, tab, or newline.
 *
 * Rename/copy (`2`) records are rejected outright: every caller passes
 * `--no-renames`, and a `2` record additionally carries its original path as a
 * second NUL-terminated field, which record-wise splitting cannot represent —
 * so encountering one means an assumption broke and the read fails closed
 * rather than silently mis-parsing.
 */
export function parsePorcelainV2(raw: string): PorcelainEntry[] {
  const entries: PorcelainEntry[] = [];
  for (const record of splitNulRecords(raw)) {
    const marker = record.slice(0, 2);
    if (marker === "? ") {
      entries.push({ kind: "?", xy: "??", path: record.slice(2) });
      continue;
    }
    if (marker === "! ") {
      continue; // ignored files; only emitted under --ignored, which we never pass
    }
    if (marker === "# ") {
      continue; // header lines (branch info); only emitted under --branch
    }
    if (marker === "2 ") {
      throw new Error(
        `git status --porcelain=v2 emitted a rename/copy record despite --no-renames: ${JSON.stringify(record)}`,
      );
    }
    if (marker !== "1 " && marker !== "u ") {
      throw new Error(`unrecognized git status --porcelain=v2 record: ${JSON.stringify(record)}`);
    }
    const kind = marker[0] as "1" | "u";
    // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` -> 7 fields before the path.
    // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>` -> 9 fields.
    const fieldCount = kind === "1" ? 7 : 9;
    const split = splitLeadingFields(record.slice(2), fieldCount);
    if (!split) {
      throw new Error(`malformed git status --porcelain=v2 "${kind}" record: ${JSON.stringify(record)}`);
    }
    const xy = split.fields[0] ?? "";
    entries.push({ kind, xy, path: split.remainder });
  }
  return entries;
}

export function getCurrentBranch(cwd: string): string | null {
  const result = runGit(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (result.status !== 0) {
    return null; // detached HEAD
  }
  return result.stdout.trim();
}

export function getHeadSha(cwd: string): string {
  return requireGit(cwd, ["rev-parse", "HEAD"]).trim();
}

/** Resolves any ref-ish (SHA, branch, remote-tracking ref) to an exact commit SHA, or null if it doesn't resolve to a commit — for any reason, including the ref not existing at all. Callers that must distinguish "absent" from "exists but broken" use `lookupRef` first (see `mergeBaseOutcome`). */
export function resolveCommitSha(cwd: string, ref: string): string | null {
  const result = runGit(cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (result.status !== 0) {
    return null;
  }
  return result.stdout.trim();
}

export type RefLookup = "MISSING" | "EXISTS" | "BROKEN";

/**
 * Tri-state existence check for `ref`, compatible with git versions well
 * before 2.46 (this repo's CI/dev environments are not guaranteed to have
 * `git show-ref --exists`, so that flag is deliberately not used here).
 *
 * Uses `git rev-parse --verify -q --symbolic-full-name <ref>`:
 * `--symbolic-full-name` only needs to resolve *which* ref `ref` names, never
 * open the object it currently points at, so it reliably returns EXISTS even
 * when that target is corrupt, missing, or not a commit — exactly the cases
 * `mergeBaseOutcome` must classify as FATAL rather than "no such ref".
 *
 * Fails closed rather than pattern-matching one specific git warning string:
 * `-q` guarantees a genuinely absent ref exits 1 with *nothing* on stderr —
 * that exact shape is the only case classified MISSING. Every other outcome —
 * any other nonzero exit, or exit 1 with anything at all on stderr (a
 * malformed loose-ref file, a broken packed-refs line, or any other git
 * error `-q` does not suppress) — is BROKEN, so a git failure mode this code
 * doesn't specifically recognize surfaces as fatal instead of being read as
 * "no such ref".
 */
export function lookupRef(cwd: string, ref: string): RefLookup {
  const result = runGit(cwd, ["rev-parse", "--verify", "-q", "--symbolic-full-name", ref]);
  if (result.status === 0) return "EXISTS";
  if (result.status === 1 && result.stderr.trim().length === 0) return "MISSING";
  return "BROKEN";
}

/**
 * The four distinguishable results of `git merge-base a b`. The two *expected*
 * ones — a ref that simply does not exist here (e.g. no `origin/main` remote
 * tracking ref) and two histories with no common ancestor (exit 1) — are the
 * only ones a fallback chain may treat as "try the next candidate". Anything
 * else (a ref that exists but cannot resolve/peel to a commit — corrupt or
 * missing object, wrong object type — a corrupt object store encountered mid
 * merge-base, an unreadable repo, git not on PATH) is FATAL and must fail
 * closed, never be silently swallowed into "no baseline here".
 */
export type MergeBaseOutcome =
  | { kind: "FOUND"; sha: string }
  | { kind: "MISSING_REF"; ref: string }
  | { kind: "NO_COMMON_ANCESTOR" }
  | { kind: "FATAL"; message: string };

export function mergeBaseOutcome(cwd: string, a: string, b: string): MergeBaseOutcome {
  // Two-step per ref: existence (does this name resolve to *any* object,
  // without opening it) is checked separately from commit-resolution (does it
  // peel to a readable commit). Collapsing these into one `resolveCommitSha`
  // call — as a MISSING_REF classification once did — cannot tell "no such
  // ref" from "ref exists but its target is corrupt/missing/not a commit";
  // the latter is a fatal git problem, not an expected miss a baseline
  // fallback chain may quietly step past. `lookupRef`'s tri-state additionally
  // separates a genuinely absent ref from one whose entry exists but is
  // itself malformed (a broken loose-ref/packed-refs entry) — both cases
  // otherwise look identical to a plain `--verify -q` exit code.
  for (const ref of [a, b]) {
    const lookup = lookupRef(cwd, ref);
    if (lookup === "MISSING") {
      return { kind: "MISSING_REF", ref };
    }
    if (lookup === "BROKEN") {
      return { kind: "FATAL", message: `ref "${ref}" exists but is malformed (broken ref entry)` };
    }
    if (resolveCommitSha(cwd, ref) === null) {
      return { kind: "FATAL", message: `ref "${ref}" exists but does not resolve to a readable commit` };
    }
  }

  const result = runGit(cwd, ["merge-base", a, b]);
  if (result.status === 0) {
    return { kind: "FOUND", sha: result.stdout.trim() };
  }
  if (result.status === 1) {
    return { kind: "NO_COMMON_ANCESTOR" };
  }
  return {
    kind: "FATAL",
    message: `git merge-base ${a} ${b} exited ${result.status}: ${result.stderr.trim()}`,
  };
}

/** Paths that differ between HEAD and the index (i.e. staged changes), sorted. */
export function getStagedPaths(cwd: string): string[] {
  const raw = requireGit(cwd, ["status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=no"]);
  const staged: string[] = [];
  for (const entry of parsePorcelainV2(raw)) {
    if (entry.kind === "?") continue;
    // An unmerged entry always differs from HEAD in the index; an ordinary one
    // does so exactly when its X (staged) column is not ".".
    if (entry.kind === "u" || (entry.xy[0] !== undefined && entry.xy[0] !== ".")) {
      staged.push(entry.path);
    }
  }
  return staged.sort();
}

export interface WorkingTreeStatus {
  trackedModified: string[];
  trackedDeleted: string[];
  untracked: string[];
}

/** Overall dirty-tree report (index + worktree combined vs HEAD), independent of any baseline. */
export function getWorkingTreeStatus(cwd: string): WorkingTreeStatus {
  const raw = requireGit(cwd, ["status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all"]);
  const trackedModified = new Set<string>();
  const trackedDeleted = new Set<string>();
  const untracked: string[] = [];

  for (const entry of parsePorcelainV2(raw)) {
    if (entry.kind === "1") {
      if (entry.xy.includes("D")) {
        trackedDeleted.add(entry.path);
      } else {
        // Covers M/T/A: any other tracked change (including a newly staged
        // add) is reported as "modified" — this schema has no separate
        // "added" bucket.
        trackedModified.add(entry.path);
      }
    } else if (entry.kind === "u") {
      trackedModified.add(entry.path);
    } else {
      untracked.push(entry.path);
    }
  }

  return {
    trackedModified: [...trackedModified].sort(),
    trackedDeleted: [...trackedDeleted].sort(),
    untracked: untracked.sort(),
  };
}

function normalizeTrackedStatus(statusCode: string): ChangeStatus {
  const c = statusCode[0];
  if (c === "A") return "A";
  if (c === "D") return "D";
  return "M";
}

/**
 * The complete, unfiltered change set: tracked changes vs. baselineSha
 * (`git diff --no-renames --name-status -z <baselineSha>`) unioned with
 * untracked files (`git status --porcelain=v2 -z --no-renames
 * --untracked-files=all`, `?` entries — already excludes ignored files).
 * Scope is never applied here; this is what every command discovers before
 * any scope filtering happens.
 */
export function getCompleteChangeSet(cwd: string, baselineSha: string): ChangeEntry[] {
  const entries = new Map<string, ChangeEntry>();

  const trackedRaw = requireGit(cwd, ["diff", "--no-renames", "--name-status", "-z", baselineSha]);
  const trackedRecords = splitNulRecords(trackedRaw);
  for (let i = 0; i < trackedRecords.length; i += 2) {
    const statusCode = trackedRecords[i];
    const path = trackedRecords[i + 1];
    if (!statusCode || path === undefined) continue;
    entries.set(path, { path, status: normalizeTrackedStatus(statusCode) });
  }

  const statusRaw = requireGit(cwd, [
    "status",
    "--porcelain=v2",
    "-z",
    "--no-renames",
    "--untracked-files=all",
  ]);
  for (const entry of parsePorcelainV2(statusRaw)) {
    if (entry.kind === "?" && !entries.has(entry.path)) {
      entries.set(entry.path, { path: entry.path, status: "??" });
    }
  }

  return [...entries.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// core.quotePath=false keeps diff headers unescaped (no octal-escaped
// non-ASCII bytes, no quoting of paths with spaces), which is what
// lib/reconstruction.ts's header parsing relies on.
const NO_QUOTE_PATH = ["-c", "core.quotePath=false"];

// --binary is mandatory on every review-patch invocation: without it git emits
// the unappliable "Binary files a/x and b/x differ" placeholder for any path it
// classifies as binary, so the reconstruction proof could never restore those
// bytes. It also implies --full-index, which only makes the headers more exact.
const REVIEW_PATCH_FLAGS = [...NO_QUOTE_PATH, "diff", "--no-renames", "--binary"];

/** Tracked-path diff vs. baselineSha, never touching the index (no --cached, no rename detection). */
export function diffTrackedPath(cwd: string, baselineSha: string, path: string): string {
  return runGit(cwd, [...REVIEW_PATCH_FLAGS, baselineSha, "--", path]).stdout;
}

/** Untracked-path diff via --no-index (never touches the real index, even transiently). Exit 1 (differences found) is expected, not an error. */
export function diffUntrackedPath(cwd: string, path: string): string {
  const result = spawnSync("git", [...REVIEW_PATCH_FLAGS, "--no-index", "--", "/dev/null", path], {
    cwd,
    encoding: "utf8",
  });
  return result.stdout ?? "";
}

/** NUL-safe `git diff --name-only` against baselineSha, run with cwd scoped to an isolated worktree. */
export function diffNameOnly(cwd: string, baselineSha: string): string[] {
  const raw = requireGit(cwd, ["diff", "--no-renames", "--name-only", "-z", baselineSha]);
  return splitNulRecords(raw);
}

/**
 * The paths represented by an exact diff text, extracted by having git
 * itself parse it — never by reimplementing git's header quoting grammar.
 * `git apply --numstat -z -` reads the diff from stdin, decodes any C-quoted
 * header (the form git uses for a path containing a literal newline or other
 * unsafe byte — quoting that survives even with core.quotePath=false, since
 * an unquoted raw newline would make the header itself unparseable), and
 * emits `<added>\t<deleted>\t<path>` records NUL-terminated, so a decoded
 * path containing a raw newline (or any other byte) is preserved intact
 * rather than corrupting a line-oriented parse. Never touches the working
 * tree or index — numstat only parses the patch text itself.
 */
export function diffNumstatPaths(cwd: string, diffText: string): string[] {
  if (diffText.trim().length === 0) return [];
  const result = spawnSync("git", ["apply", "--numstat", "-z", "-"], { cwd, input: diffText, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    return [];
  }
  const paths: string[] = [];
  for (const record of splitNulRecords(result.stdout ?? "")) {
    // "<added>\t<deleted>\t<path>" — added/deleted are "-" for binary files.
    const match = /^[0-9-]+\t[0-9-]+\t([\s\S]*)$/.exec(record);
    if (match?.[1] !== undefined) paths.push(match[1]);
  }
  return paths;
}

export function worktreeAdd(repoCwd: string, worktreePath: string, commitish: string): void {
  requireGit(repoCwd, ["worktree", "add", "--detach", worktreePath, commitish]);
}

export function worktreeRemove(repoCwd: string, worktreePath: string): GitRunResult {
  return runGit(repoCwd, ["worktree", "remove", "--force", worktreePath]);
}

export function worktreeList(repoCwd: string): string {
  return requireGit(repoCwd, ["worktree", "list"]);
}

/**
 * The absolute paths git currently has registered as worktrees, read from the
 * stable `--porcelain` form rather than the human-readable columns. Used to
 * *prove* the temporary reconstruction worktree is really deregistered, rather
 * than assuming a `worktree remove` that reported nothing actually worked.
 */
export function worktreeRegisteredPaths(repoCwd: string): string[] {
  const raw = requireGit(repoCwd, ["worktree", "list", "--porcelain"]);
  const paths: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) paths.push(line.slice("worktree ".length));
  }
  return paths;
}

export function applyCheck(worktreeCwd: string, diffText: string): boolean {
  if (diffText.trim().length === 0) return true;
  const result = spawnSync("git", ["apply", "--check", "-"], { cwd: worktreeCwd, input: diffText, encoding: "utf8" });
  return (result.status ?? 1) === 0;
}

export function applyDiff(worktreeCwd: string, diffText: string): GitRunResult {
  if (diffText.trim().length === 0) return { stdout: "", stderr: "", status: 0 };
  const result = spawnSync("git", ["apply", "-"], { cwd: worktreeCwd, input: diffText, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}
