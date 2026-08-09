import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runCodexReview } from "./codex-invocation";
import { createCodexStub, type CodexStub } from "./testing/codex-stub";

function baseOptions(stub: CodexStub, overrides: Partial<Parameters<typeof runCodexReview>[0]> = {}) {
  return {
    cwd: process.cwd(),
    reviewJsonRaw: Buffer.from('{"status":"OK"}'),
    reviewDiffRaw: Buffer.from("diff --git a/x b/x\n"),
    taskDeclarationRaw: null,
    timeoutMs: 10000,
    codexBin: stub.binPath,
    ...overrides,
  };
}

describe("runCodexReview", () => {
  let stub: CodexStub | undefined;
  let scratchDirs: string[] = [];

  afterEach(() => {
    stub?.cleanup();
    stub = undefined;
    for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
    scratchDirs = [];
  });

  it("success: returns OK, invoked, exit 0, and the raw output text", () => {
    stub = createCodexStub();
    const outcome = runCodexReviewWithEnv(baseOptions(stub), {
      CODEX_STUB_MODE: "success",
      CODEX_STUB_PAYLOAD: '{"verdict":"NEEDS_FIXES","findings":[]}',
    });

    expect(outcome.invoked).toBe(true);
    expect(outcome.status).toBe("OK");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.outputLastMessageText).toContain("NEEDS_FIXES");
    expect(outcome.rawLog).not.toBeNull();
    expect(outcome.rawLog as string).toContain("exitCode: 0");
  });

  it("nonzero exit: FAILED/CODEX_EXECUTION_FAILED, exitCode preserved, raw log still returned", () => {
    stub = createCodexStub();
    const options = baseOptions(stub);
    const outcome = runCodexReviewWithEnv(options, { CODEX_STUB_MODE: "nonzero", CODEX_STUB_EXIT_CODE: "7" });

    expect(outcome.invoked).toBe(true);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCategory).toBe("CODEX_EXECUTION_FAILED");
    expect(outcome.exitCode).toBe(7);
    expect(outcome.failureReason).toContain("exited 7");
    expect(outcome.rawLog).not.toBeNull();
    expect(outcome.rawLog as string).toContain("exitCode: 7");
  });

  // MINOR regression (HQ): a spawn failure where no child process was ever
  // started (ENOENT/EACCES) must report invoked: false, distinct from a
  // timeout/signal after a child actually launched (see the timeout test
  // below, which stays invoked: true). Node's spawnSync reports this via
  // `pid` — 0 (or undefined) when the process was never started, a real
  // positive pid otherwise, even when killed by a timeout.
  it("nonexistent binary: FAILED/CODEX_EXECUTION_FAILED, invoked: false (no child process was ever started), null exitCode", () => {
    const options = baseOptions({ binPath: "/definitely/not/a/real/codex/binary", dir: "", cleanup() {} });
    const outcome = runCodexReview(options);

    expect(outcome.invoked).toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCategory).toBe("CODEX_EXECUTION_FAILED");
    expect(outcome.exitCode).toBeNull();
    expect(outcome.failureReason).toContain("failed to execute");
    expect(outcome.rawLog).toBeNull();
  });

  // Retained separately from the nonexistent-binary test above: a child
  // process was actually launched here (it really did start sleeping) before
  // being killed by the timeout, so invoked stays true even though the
  // outcome is still a failure with no exit code.
  it("times out: FAILED/CODEX_EXECUTION_FAILED with null exitCode, invoked: true (child was actually launched), does not wait for the full hang", () => {
    stub = createCodexStub();
    const options = baseOptions(stub, { timeoutMs: 300 });
    const start = Date.now();
    const outcome = runCodexReviewWithEnv(options, { CODEX_STUB_MODE: "hang", CODEX_STUB_SLEEP_SECONDS: "5" });
    const elapsedMs = Date.now() - start;

    expect(outcome.invoked).toBe(true);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCategory).toBe("CODEX_EXECUTION_FAILED");
    expect(outcome.exitCode).toBeNull();
    expect(elapsedMs).toBeLessThan(4000);
  }, 10000);

  it("a pre-existing file at the forced invocation-scoped temp path is CODEX_EXECUTION_FAILED, stub never spawned", () => {
    stub = createCodexStub();
    const tempDirOverride = mkdtempSync(join(tmpdir(), "harness-codex-preexisting-"));
    scratchDirs.push(tempDirOverride);
    writeFileSync(join(tempDirOverride, "output-last-message.json"), "stale leftover content");

    const options = baseOptions(stub, { tempDirOverride });
    // Mode would fail loudly if the stub were actually invoked — proving it wasn't.
    const outcome = runCodexReviewWithEnv(options, { CODEX_STUB_MODE: "nonzero" });

    expect(outcome.invoked).toBe(false);
    expect(outcome.status).toBe("FAILED");
    expect(outcome.failureCategory).toBe("CODEX_EXECUTION_FAILED");
    expect(outcome.failureReason).toContain("already exists");
    expect(outcome.rawLog).toBeNull();
  });

  it("emits well past node's default 1 MiB maxBuffer to stdout and still returns OK with a valid payload", () => {
    stub = createCodexStub();
    const options = baseOptions(stub);
    const outcome = runCodexReviewWithEnv(options, {
      CODEX_STUB_MODE: "large-output",
      CODEX_STUB_LARGE_OUTPUT_BYTES: String(4 * 1024 * 1024), // 4 MiB: past node's 1 MiB default, well under the 32 MiB bound
      CODEX_STUB_PAYLOAD: '{"verdict":"READY_FOR_OWNER_REVIEW","findings":[]}',
    });

    expect(outcome.invoked).toBe(true);
    expect(outcome.status).toBe("OK");
    expect(outcome.exitCode).toBe(0);
    expect(outcome.outputLastMessageText).toContain("READY_FOR_OWNER_REVIEW");
  }, 15000);

  it("writes the exact caller-supplied bytes into invocation-scoped snapshot files, not just the same length", () => {
    stub = createCodexStub();
    const tempDirOverride = mkdtempSync(join(tmpdir(), "harness-codex-snapshot-"));
    scratchDirs.push(tempDirOverride);
    const captureDir = mkdtempSync(join(tmpdir(), "harness-codex-snapshot-capture-"));
    scratchDirs.push(captureDir);
    const capturePath = join(captureDir, "captured-review.json");

    const reviewJsonRaw = Buffer.from('{"marker":"exact-bytes-check"}');
    const options = baseOptions(stub, { tempDirOverride, reviewJsonRaw });
    const outcome = runCodexReviewWithEnv(options, {
      CODEX_STUB_MODE: "aba-swap-and-restore",
      CODEX_STUB_ABA_CAPTURE_SOURCE: "review.json",
      CODEX_STUB_ABA_CAPTURE_PATH: capturePath,
    });

    expect(outcome.status).toBe("OK");
    expect(readFileSync(capturePath)).toEqual(reviewJsonRaw);
  });

  it("cleans up its invocation-scoped temp directory afterward", () => {
    stub = createCodexStub();
    const tempDirOverride = mkdtempSync(join(tmpdir(), "harness-codex-cleanup-"));
    // Do not push to scratchDirs — asserting cleanup already removes it; a
    // second removal in afterEach would be a harmless no-op if this failed.

    const options = baseOptions(stub, { tempDirOverride });
    runCodexReviewWithEnv(options, { CODEX_STUB_MODE: "success" });

    expect(existsSync(tempDirOverride)).toBe(false);
  });
});

// spawnSync inherits the current process env by default; tests set stub
// behavior via env vars without polluting the parent process's env for other
// tests.
function runCodexReviewWithEnv(
  options: Parameters<typeof runCodexReview>[0],
  env: Record<string, string>,
): ReturnType<typeof runCodexReview> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    previous[key] = process.env[key];
    process.env[key] = env[key];
  }
  try {
    return runCodexReview(options);
  } finally {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}
