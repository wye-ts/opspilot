// Regression coverage for the runGit process boundary and the real chain it
// feeds: runGit -> lookupRef -> mergeBaseOutcome -> resolveBaseline.
//
// The bug: Node's spawnSync reports a signal-terminated child (SIGKILL from
// an OOM killer, a cgroup limit, an external `kill`, etc.) as
// `{ status: null, signal: "SIGKILL" }` — no Git exit code was ever produced.
// runGit used to coerce that `null` into `1` (`result.status ?? 1`), which is
// indistinguishable from git cleanly reporting "no such ref" to every
// downstream parser (lookupRef, mergeBaseOutcome, resolveBaseline). That let
// an aborted git process silently classify as MISSING_REF and advance the
// baseline fallback chain instead of failing closed.
//
// These tests drive the real production functions end to end; only the
// outermost `spawnSync` call is faked, per exact argv, so the scenario
// (missing ref, valid ref, signal kill, spawn failure, corrupt ref) is
// deterministic and platform-independent rather than relying on actually
// signaling a real git process.
import { spawnSync as realSpawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveBaseline, BaselineResolutionError } from "./resolved-config";
import { GitExecutionError, lookupRef, mergeBaseOutcome, runGit } from "./git";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

type CannedResult = {
  status: number | null;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

/** Maps an exact `git <args...>` invocation to a canned spawnSync-shaped result; anything unmatched throws, so an unexpected call (e.g. an unwanted fallback probe) fails the test loudly instead of silently succeeding. */
function mockGit(rules: Record<string, CannedResult>) {
  const mocked = vi.mocked(realSpawnSync);
  mocked.mockReset();
  mocked.mockImplementation(((_cmd: string, args: readonly string[] = []) => {
    const key = args.join(" ");
    const rule = rules[key];
    if (!rule) {
      throw new Error(`unmocked git invocation in test: git ${key}`);
    }
    return {
      status: rule.status,
      signal: rule.signal ?? null,
      stdout: rule.stdout ?? "",
      stderr: rule.stderr ?? "",
      pid: 1,
      output: [],
      error: rule.error,
    } as ReturnType<typeof realSpawnSync>;
  }) as typeof realSpawnSync);
  return mocked;
}

// Every scenario below resolves HEAD identically (it's `a` in every
// mergeBaseOutcome([a, b]) call this test file makes) — factored out so each
// scenario only has to state what's different about it.
const HEAD_SHA = "1111111111111111111111111111111111111111";
const headRules = {
  "rev-parse --verify -q --symbolic-full-name HEAD": { status: 0, stdout: "refs/heads/main\n" },
  "rev-parse --verify -q HEAD^{commit}": { status: 0, stdout: `${HEAD_SHA}\n` },
};

describe("runGit process boundary: signal termination and spawn failure", () => {
  afterEach(() => {
    vi.mocked(realSpawnSync).mockReset();
  });

  it("throws GitExecutionError, not a coerced status, when spawnSync reports signal termination (status: null)", () => {
    mockGit({
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: null, signal: "SIGKILL" },
    });
    expect(() => runGit("/repo", ["rev-parse", "--verify", "-q", "--symbolic-full-name", "origin/main"])).toThrow(
      GitExecutionError,
    );
  });

  it("throws GitExecutionError, not a coerced status, when spawnSync itself fails to execute (result.error)", () => {
    mockGit({
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: null, error: new Error("spawn git ENOENT") },
    });
    expect(() => runGit("/repo", ["rev-parse", "--verify", "-q", "--symbolic-full-name", "origin/main"])).toThrow(
      GitExecutionError,
    );
  });

  it("a normal exit code (0 or 1) still passes through runGit as a plain GitRunResult, never throwing", () => {
    mockGit({
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: 1, stderr: "" },
    });
    expect(runGit("/repo", ["rev-parse", "--verify", "-q", "--symbolic-full-name", "origin/main"])).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });
});

describe("real chain: runGit -> lookupRef -> mergeBaseOutcome -> resolveBaseline", () => {
  afterEach(() => {
    vi.mocked(realSpawnSync).mockReset();
  });

  it("genuine missing ref (origin/main absent) -> MISSING_REF, fallback to main proceeds and resolves", () => {
    const mainSha = "2222222222222222222222222222222222222222";
    mockGit({
      ...headRules,
      // A genuinely absent ref: -q guarantees exit 1 with nothing on stderr.
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: 1, stderr: "" },
      "rev-parse --verify -q --symbolic-full-name main": { status: 0, stdout: "refs/heads/main\n" },
      "rev-parse --verify -q main^{commit}": { status: 0, stdout: `${mainSha}\n` },
      "merge-base HEAD main": { status: 0, stdout: `${mainSha}\n` },
    });

    expect(lookupRef("/repo", "origin/main")).toBe("MISSING");
    expect(mergeBaseOutcome("/repo", "HEAD", "origin/main")).toEqual({ kind: "MISSING_REF", ref: "origin/main" });
    expect(resolveBaseline("/repo", undefined, undefined)).toEqual({ sha: mainSha, source: "merge-base-main" });
  });

  it("normal valid origin/main -> normal FOUND resolution, no fallback attempted", () => {
    const baseSha = "3333333333333333333333333333333333333333";
    mockGit({
      ...headRules,
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: 0, stdout: "refs/remotes/origin/main\n" },
      "rev-parse --verify -q origin/main^{commit}": { status: 0, stdout: `${baseSha}\n` },
      "merge-base HEAD origin/main": { status: 0, stdout: `${baseSha}\n` },
      // No "main" rules registered: if resolveBaseline touched the fallback
      // candidate at all, mockGit's unmocked-invocation throw would fail this
      // test loudly rather than the fallback silently succeeding.
    });

    expect(lookupRef("/repo", "origin/main")).toBe("EXISTS");
    expect(mergeBaseOutcome("/repo", "HEAD", "origin/main")).toEqual({ kind: "FOUND", sha: baseSha });
    expect(resolveBaseline("/repo", undefined, undefined)).toEqual({ sha: baseSha, source: "merge-base-origin-main" });
  });

  it("origin/main lookup is SIGKILL'd (status: null) -> fatal execution failure, never MISSING_REF, fallback never attempted", () => {
    mockGit({
      ...headRules,
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: null, signal: "SIGKILL" },
      // No "main" rules: reaching the fallback at all is itself a failure.
    });

    expect(() => lookupRef("/repo", "origin/main")).toThrow(GitExecutionError);
    expect(() => mergeBaseOutcome("/repo", "HEAD", "origin/main")).toThrow(GitExecutionError);
    const thrown = (() => {
      try {
        resolveBaseline("/repo", undefined, undefined);
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(thrown).toBeInstanceOf(GitExecutionError);
    expect(thrown).not.toBeInstanceOf(BaselineResolutionError);
  });

  it("origin/main lookup fails to spawn (result.error) -> fatal execution failure, no fallback attempted", () => {
    mockGit({
      ...headRules,
      "rev-parse --verify -q --symbolic-full-name origin/main": { status: null, error: new Error("spawn git ENOENT") },
    });

    expect(() => resolveBaseline("/repo", undefined, undefined)).toThrow(GitExecutionError);
  });

  it("origin/main's ref entry exists but is malformed (corrupt ref) -> FATAL/BaselineResolutionError, never MISSING_REF, no fallback", () => {
    mockGit({
      ...headRules,
      // BROKEN: exit 1 (or any nonzero) with something on stderr — a
      // malformed loose-ref/packed-refs entry, not a clean absent ref.
      "rev-parse --verify -q --symbolic-full-name origin/main": {
        status: 128,
        stderr: "fatal: unexpected line in .git/packed-refs: garbage\n",
      },
    });

    expect(lookupRef("/repo", "origin/main")).toBe("BROKEN");
    expect(mergeBaseOutcome("/repo", "HEAD", "origin/main").kind).toBe("FATAL");
    expect(() => resolveBaseline("/repo", undefined, undefined)).toThrow(BaselineResolutionError);
  });
});
