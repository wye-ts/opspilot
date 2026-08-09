import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { renderMarkdown } from "./codex-review";
import { codexArtifactFreshness } from "./lib/provenance";
import { createCodexStub, type CodexStub } from "./lib/testing/codex-stub";
import { createGitFixture, type GitFixture } from "./lib/testing/git-fixture";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "agent", "verify.ts");
const REVIEW_BUNDLE_SCRIPT = join(REPO_ROOT, "scripts", "agent", "review-bundle.ts");
const CODEX_REVIEW_SCRIPT = join(REPO_ROOT, "scripts", "agent", "codex-review.ts");

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function run(script: string, cwd: string, args: string[] = [], envOverrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(TSX_BIN, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...envOverrides },
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function runReviewBundle(cwd: string, args: string[] = []) {
  return run(REVIEW_BUNDLE_SCRIPT, cwd, args);
}

// The real codex CLI is never invoked here — a disposable stub script stands
// in for it, shared across every test in this file since its behavior is
// entirely driven by env vars supplied per-invocation.
const stub = createCodexStub();
afterAll(() => stub.cleanup());

function pathWithStub(): string {
  return `${stub.dir}:${process.env.PATH ?? ""}`;
}

// A PATH containing only git's real directory (plus basic system dirs) and
// deliberately excluding the stub — used by the "codex absent" test so it
// doesn't depend on whether a real codex-cli happens to be installed
// elsewhere on this machine's PATH.
function minimalPathWithGit(): string {
  const which = spawnSync("which", ["git"], { encoding: "utf8" });
  const gitDir = dirname(which.stdout.trim());
  // tsx's shebang is `#!/usr/bin/env node`, so node's own directory must stay
  // resolvable too, or spawning the CLI itself fails (exit 127) before the
  // harness ever gets a chance to look for codex.
  const nodeDir = dirname(process.execPath);
  return [gitDir, nodeDir, "/usr/bin", "/bin"].join(":");
}

function runCodexReviewCli(
  cwd: string,
  args: string[] = [],
  stubEnv: Record<string, string> = {},
  path: string = pathWithStub(),
) {
  return run(CODEX_REVIEW_SCRIPT, cwd, args, { ...stubEnv, PATH: path });
}

// Mirrors review-bundle.test.ts's baseFixture: .agent/ (and pnpm/node
// bookkeeping) gitignored so a chained verify -> review-bundle -> codex-review
// sequence within one test never lets one command's own artifacts pollute the
// next command's change-set discovery.
function baseFixture(): { fixture: GitFixture; baseline: string } {
  const fixture = createGitFixture();
  fixture.writeFile(".gitignore", ".agent/\nnode_modules/\npnpm-lock.yaml\n");
  fixture.writeFile("a.txt", "a");
  fixture.add(".gitignore", "a.txt");
  const baseline = fixture.commit("init");
  fixture.setRemoteRef("origin/main", "HEAD");
  return { fixture, baseline };
}

// Like baseFixture(), but with an extra file already tracked at the baseline
// commit (at a known, explicit mode) — needed by the executable-bit-drift
// regressions below, which require a path that is already tracked (so a
// mode-only change against it registers as a further modification) rather
// than newly added.
function baseFixtureWithTrackedFile(mode: number): { fixture: GitFixture; baseline: string } {
  const fixture = createGitFixture();
  fixture.writeFile(".gitignore", ".agent/\nnode_modules/\npnpm-lock.yaml\n");
  fixture.writeFile("mode.txt", "original content");
  fixture.chmodFile("mode.txt", mode);
  fixture.add(".gitignore", "mode.txt");
  const baseline = fixture.commit("init");
  fixture.setRemoteRef("origin/main", "HEAD");
  return { fixture, baseline };
}

/** Whether this fixture's git config + filesystem combination actually records a mode-only change as "old mode"/"new mode" diff lines — false under core.filemode=false or a filesystem that ignores chmod. */
function gitTracksFileMode(fixture: GitFixture, baseline: string, relPath: string): boolean {
  const diff = fixture.git("diff", baseline, "--", relPath).stdout;
  return diff.includes("old mode") && diff.includes("new mode");
}

function sampleFinding() {
  return {
    severity: "MAJOR",
    title: "off-by-one",
    location: "x.txt:1",
    reproduction: "n/a",
    whyItMatters: "n/a",
    smallestFix: "n/a",
    missingTest: "n/a",
  };
}

describe("agent:codex-review (e2e, spawned CLI, stubbed codex on PATH)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("missing review.json → INPUT_MISSING, exit 1, codexExec never invoked, provenance still resolved", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAILED");
    expect(result.failureCategory).toBe("INPUT_MISSING");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.reviewInput.freshness).toBe("MISSING");
    expect(result.reviewInput.missingReason).toBe("NOT_FOUND");
    expect(result.provenance).not.toBeNull();
  });

  it("review.json present but status FAILED → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const doctored = {
      status: "FAILED",
      failureReason: "reconstruction proof: MISMATCH",
      git: {
        baselineSha: setup.baseline,
        headSha: fixture.headSha(),
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint: "e".repeat(64),
      },
      reconstructionProof: { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(doctored));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // MAJOR regression (HQ), command level: a review.json that is internally
  // contradictory — status: "OK" alongside a MISMATCH reconstructionProof, a
  // combination the real agent:review-bundle producer never emits — must fail
  // isReviewBundleResult's structural validation outright (INPUT_INVALID),
  // never be read as a trustworthy CURRENT/STALE bundle.
  it("review.json internally contradictory (status OK with a MISMATCH reconstructionProof) → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const contradictory = {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: setup.baseline,
        headSha: fixture.headSha(),
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint: "e".repeat(64),
      },
      reconstructionProof: { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(contradictory));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // Codex finding (structured-codex-review-v1): a hand-doctored review.json
  // that marks a nested verify result CURRENT but embeds a provenance block
  // describing a different baseline/head/fingerprint than the bundle's own
  // top-level git facts is not a shape the real agent:review-bundle producer
  // could ever emit (loadGateResult only marks CURRENT once compareProvenance
  // already confirmed agreement) — it must fail isReviewBundleResult's
  // structural validation outright (INPUT_INVALID), never be read as
  // trustworthy CURRENT evidence.
  it("review.json with a forged CURRENT nested verify result (mismatched provenance) → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const headSha = fixture.headSha();
    const resolvedConfig = {
      taskPath: { value: null, source: "default" },
      agentDir: { value: "/repo/.agent", source: "default" },
      baselineSha: setup.baseline,
      baselineSource: "merge-base-main",
      mode: { value: "focused", source: "cli" },
    };
    const forged = {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: setup.baseline,
        headSha,
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint: "e".repeat(64),
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: {
          freshness: "CURRENT",
          missingReason: null,
          result: {
            mode: "focused",
            status: "PASS",
            touchedWorkspaces: [],
            steps: [],
            notRun: [],
            failureReasons: [],
            // Deliberately a different baseline/fingerprint than the
            // top-level git facts above — a forged CURRENT claim.
            provenance: {
              baselineSha: "f".repeat(40),
              headSha: "f".repeat(40),
              changeSetFingerprint: "f".repeat(64),
              resolvedConfig,
            },
          },
        },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(forged));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // Codex finding (structured-codex-review-v1, HQ-adjudicated MAJOR): a
  // review.json whose nested scope-check result is CURRENT and claims PASS,
  // but still carries a real FAIL's outOfScopePaths/failureReasons, is not a
  // shape the real agent:scope-check producer could ever emit — it must fail
  // isReviewBundleResult's structural validation outright (INPUT_INVALID),
  // never be treated as trustworthy CURRENT evidence that Codex is invoked
  // against.
  it("(E) review.json with a CURRENT scope-check result claiming PASS but carrying non-empty outOfScopePaths/failureReasons → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const headSha = fixture.headSha();
    const changeSetFingerprint = "e".repeat(64);
    const resolvedConfig = {
      taskPath: { value: null, source: "default" },
      agentDir: { value: "/repo/.agent", source: "default" },
      baselineSha: setup.baseline,
      baselineSource: "merge-base-main",
      scope: { value: ["docs/**"], source: "task-declaration" },
    };
    const forged = {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: setup.baseline,
        headSha,
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint,
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: {
        freshness: "CURRENT",
        missingReason: null,
        result: {
          // A real FAIL's fields left in place, but status hand-doctored to PASS.
          status: "PASS",
          scopePatterns: ["docs/**"],
          changeSetPaths: ["x.txt"],
          outOfScopePaths: ["x.txt"],
          failureReasons: ["1 path(s) outside declared scope: x.txt"],
          provenance: {
            baselineSha: setup.baseline,
            headSha,
            changeSetFingerprint,
            resolvedConfig,
          },
        },
      },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(forged));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // MAJOR regression (HQ-adjudicated, structured-codex-review-v1 final
  // re-review): a review.json whose nested CURRENT verify result is
  // internally contradictory — status: "PASS" but failureReasons non-empty,
  // a combination the real agent:verify producer never emits — must fail
  // isReviewBundleResult's structural validation outright (INPUT_INVALID),
  // never be treated as trustworthy CURRENT evidence that Codex is invoked
  // against.
  it("(F) review.json with a CURRENT verify result claiming PASS but carrying non-empty failureReasons → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const headSha = fixture.headSha();
    const changeSetFingerprint = "e".repeat(64);
    const resolvedConfig = {
      taskPath: { value: null, source: "default" },
      agentDir: { value: "/repo/.agent", source: "default" },
      baselineSha: setup.baseline,
      baselineSource: "merge-base-main",
      mode: { value: "focused", source: "cli" },
    };
    const forged = {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: setup.baseline,
        headSha,
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint,
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: {
          freshness: "CURRENT",
          missingReason: null,
          result: {
            // A real FAIL's failureReasons left in place, but status
            // hand-doctored to PASS.
            mode: "focused",
            status: "PASS",
            touchedWorkspaces: [],
            steps: [],
            notRun: [],
            failureReasons: ["step failed: pnpm test (exit 1)"],
            provenance: { baselineSha: setup.baseline, headSha, changeSetFingerprint, resolvedConfig },
          },
        },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(forged));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // MAJOR regression (HQ-adjudicated, structured-codex-review-v1 final
  // re-review): a review.json with top-level status "OK" (implying the
  // reconstruction proof matched) but a reconstructionProof that is MATCH
  // while still carrying a cleanupError — a combination the real
  // reconstruction producer never emits (buildReconstructionProof only sets a
  // non-null cleanupError when it also forces status to CLEANUP_FAILED) —
  // must fail isReviewBundleResult's structural validation outright
  // (INPUT_INVALID), never be treated as trustworthy OK/MATCH evidence that
  // Codex is invoked against.
  it("(G) review.json with top-level OK + MATCH reconstructionProof carrying a cleanupError → INPUT_INVALID, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const forged = {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: setup.baseline,
        headSha: fixture.headSha(),
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint: "e".repeat(64),
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: "leaked worktree" },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
    fixture.writeFile(".agent/review/review.json", JSON.stringify(forged));
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x.txt b/x.txt\n");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_INVALID");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  it("happy path: bundle CURRENT, no --task, well-formed payload → status OK, exit 0, files written, summary matches renderMarkdown", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.failureCategory).toBeNull();
    expect(result.taskDeclarationHash).toBeNull();
    expect(result.reviewJsonHash).not.toBeNull();
    expect(result.reviewDiffHash).not.toBeNull();
    expect(result.codexExec.invoked).toBe(true);
    expect(result.codexExec.exitCode).toBe(0);
    expect(result.payload.verdict).toBe("READY_FOR_OWNER_REVIEW");

    const findingsPath = join(fixture.dir, ".agent", "codex", "review-findings.json");
    const summaryPath = join(fixture.dir, ".agent", "codex", "review-summary.md");
    expect(existsSync(findingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(findingsPath, "utf8")).status).toBe("OK");
    expect(readFileSync(summaryPath, "utf8")).toBe(renderMarkdown(result));
  });

  // Codex finding (structured-codex-review-v1): persistence of the three
  // artifacts codex-review writes (review-summary.md, codex-review.log,
  // review-findings.json) is not transactional — but review-findings.json is
  // the canonical "this run completed" marker, so it must never be left
  // looking complete when the rest of this run's persistence failed. A prior
  // successful run leaves a status: OK review-findings.json on disk; this
  // run then fails to persist its diagnostic codex-review.log (its
  // .agent/logs directory is made unwritable, while .agent/codex — where
  // review-findings.json/review-summary.md live — stays fully writable), and
  // the stale OK artifact must not survive this failed run.
  it("a persistence failure on the non-canonical log output leaves no review-findings.json behind, including removing a stale one from a prior successful run", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const firstRun = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(firstRun.status).toBe(0);

    const findingsPath = join(fixture.dir, ".agent", "codex", "review-findings.json");
    const logsDir = join(fixture.dir, ".agent", "logs");
    expect(existsSync(findingsPath)).toBe(true);
    expect(JSON.parse(readFileSync(findingsPath, "utf8")).status).toBe("OK");

    chmodSync(logsDir, 0o500); // read + execute only: blocks creating/renaming files inside it
    try {
      const secondRun = runCodexReviewCli(fixture.dir, ["--print-json"]);
      expect(secondRun.status).toBe(1);
      expect(existsSync(findingsPath)).toBe(false);
    } finally {
      chmodSync(logsDir, 0o700);
    }
  });

  it("with --task pointing at a valid declaration → status OK, taskDeclarationHash non-null", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));
    // review-bundle's own taskDeclarationHash must be bound to the same
    // --task path/bytes codex-review is about to be invoked with, or the new
    // pre-invocation freshness check (correctly) reports INPUT_STALE.
    expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.status).toBe("OK");
      expect(result.taskDeclarationHash).not.toBeNull();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  // BLOCKER regression (HQ), command level: taskDeclarationHash and the
  // task-derived facts baked into the result (here, provenance.baselineSha
  // via the declaration's "baseline" field) must describe the exact same
  // captured bytes. Only holds if hashing (Step 1) and parsing both derive
  // from a single read of --task rather than each independently re-reading
  // the path.
  it("taskDeclarationHash and baseline resolution both describe the exact same captured task-declaration bytes", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("second.txt", "second commit content");
    fixture.add("second.txt");
    const taskBaseline = fixture.commit("second");
    fixture.writeFile("third.txt", "change after the declared baseline");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    const declarationBytes = JSON.stringify({
      $schema: "opspilot-harness/task-declaration@1",
      baseline: taskBaseline,
    });
    writeFileSync(taskPath, declarationBytes);

    try {
      expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.taskDeclarationHash).toBe(sha256(readFileSync(taskPath)));
      // Only reachable if the baseline used for provenance came from parsing
      // the very same bytes the hash was computed over.
      expect(result.provenance.baselineSha).toBe(taskBaseline);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("stub emits NEEDS_FIXES with real findings → still exit 0, status OK", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_PAYLOAD: JSON.stringify({ verdict: "NEEDS_FIXES", findings: [sampleFinding()] }),
    });
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.payload.verdict).toBe("NEEDS_FIXES");
    expect(result.payload.findings).toHaveLength(1);
  });

  it("editing an already-changed file after bundle generation → INPUT_STALE, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "first version");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    fixture.writeFile("x.txt", "edited after review-bundle ran");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.codexExec.invoked).toBe(false);
  });

  it("a new untracked file after bundle generation → INPUT_STALE, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    fixture.writeFile("new-file.txt", "new");

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.codexExec.invoked).toBe(false);
  });

  // BLOCKER regression (HQ): changeSetFingerprint deliberately never hashes
  // file mode bits (fingerprint.ts's "Known v1 cut"), and review.diff's own
  // on-disk bytes are untouched by a chmod elsewhere in the tree — so neither
  // of the pre-existing pre-invocation checks alone can catch a Git-relevant
  // executable-bit-only change made to an already-bundled path after
  // agent:review-bundle ran. A regenerated diff over the current change set
  // must be compared against the frozen review.diff bytes hash to close this.
  it("BLOCKER regression: a tracked file's content AND mode both change before bundling, then only the executable bit is toggled again afterward → INPUT_STALE, codex never invoked", (ctx) => {
    const setup = baseFixtureWithTrackedFile(0o644);
    fixture = setup.fixture;

    fixture.writeFile("mode.txt", "content changed for the bundle");
    fixture.chmodFile("mode.txt", 0o755);

    if (!gitTracksFileMode(fixture, setup.baseline, "mode.txt")) {
      ctx.skip(); // this fixture's git config/filesystem does not observe mode changes
      return;
    }

    expect(runReviewBundle(fixture.dir).status).toBe(0);

    // Content is untouched from here on — only the executable bit moves.
    // review.diff's own bytes on disk are unaffected, and the fingerprint
    // (content-only) stays identical, so only the regenerated-diff check can
    // catch this.
    fixture.chmodFile("mode.txt", 0o644);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.codexExec.invoked).toBe(false);
  });

  // Same BLOCKER regression, opposite direction: the mode change is *absent*
  // from the frozen review.diff (mode matched baseline when the bundle was
  // taken) and is introduced only afterward.
  it("BLOCKER regression: a tracked file's content changes before bundling (mode unchanged), then the executable bit is toggled on afterward → INPUT_STALE, codex never invoked", (ctx) => {
    const setup = baseFixtureWithTrackedFile(0o644);
    fixture = setup.fixture;

    fixture.writeFile("mode.txt", "content changed for the bundle");

    fixture.chmodFile("mode.txt", 0o755);
    const tracksMode = gitTracksFileMode(fixture, setup.baseline, "mode.txt");
    fixture.chmodFile("mode.txt", 0o644);
    if (!tracksMode) {
      ctx.skip(); // this fixture's git config/filesystem does not observe mode changes
      return;
    }

    expect(runReviewBundle(fixture.dir).status).toBe(0);

    fixture.chmodFile("mode.txt", 0o755);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.codexExec.invoked).toBe(false);
  });

  // BLOCKER TOCTOU regression (HQ): the same executable-bit-only drift, but
  // introduced by the stub *during* codex exec itself — must be caught by the
  // post-invocation re-check (codexArtifactFreshness's seventh fact), not
  // just the pre-invocation one.
  it("TOCTOU BLOCKER regression: codex stub toggles only a tracked file's executable bit during its own execution → INPUT_STALE, payload null, exit 1", (ctx) => {
    const setup = baseFixtureWithTrackedFile(0o644);
    fixture = setup.fixture;

    fixture.chmodFile("mode.txt", 0o755);
    const tracksMode = gitTracksFileMode(fixture, setup.baseline, "mode.txt");
    fixture.chmodFile("mode.txt", 0o644);
    if (!tracksMode) {
      ctx.skip(); // this fixture's git config/filesystem does not observe mode changes
      return;
    }

    fixture.writeFile("mode.txt", "content changed for the bundle");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_MODE: "mutate-then-succeed",
      CODEX_STUB_CHMOD_FILE: join(fixture.dir, "mode.txt"),
      CODEX_STUB_CHMOD_MODE: "755",
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAILED");
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.payload).toBeNull();
  });

  // Pre-invocation freshness gap (HQ P1): review.json/review.diff can stay
  // byte-identical while the gitignored task declaration at the same --task
  // path is silently swapped underneath them. review-bundle's
  // taskDeclarationHash binds the bundle to the exact task bytes that
  // produced it, so this must be caught before Codex is ever invoked — not
  // just by the post-invocation TOCTOU re-check below, which only protects
  // against a swap during the (potentially long) codex exec call itself.
  it("bundle generated under task A, then only task bytes change to task B (same --task path) → INPUT_STALE, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));

    try {
      expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

      // Same path, different (still valid) bytes — task A -> task B.
      writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", expectedIndex: "any" }));

      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("INPUT_STALE");
      expect(result.codexExec.invoked).toBe(false);
      expect(result.payload).toBeNull();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("bundle generated with no --task, then codex-review run with --task → INPUT_STALE", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("INPUT_STALE");
      expect(result.codexExec.invoked).toBe(false);
      expect(result.payload).toBeNull();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("bundle generated with --task, then codex-review run with no --task → INPUT_STALE", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));

    try {
      expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("INPUT_STALE");
      expect(result.codexExec.invoked).toBe(false);
      expect(result.payload).toBeNull();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  // review.json regenerated alone (nested verify evidence differs; tree/HEAD/
  // review.diff are untouched) must prove the earlier Codex artifact STALE via
  // codexArtifactFreshness, since reviewJsonHash moved underneath it.
  it("a prior Codex artifact is proven STALE via codexArtifactFreshness when review.json is regenerated alone", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    expect(run(VERIFY_SCRIPT, fixture.dir, ["--focused"]).status).toBe(0);
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const first = runCodexReviewCli(fixture.dir, ["--print-json"]);
    expect(first.status).toBe(0);
    const firstResult = JSON.parse(first.stdout);
    expect(firstResult.status).toBe("OK");

    // Regenerate review.json alone: remove the prior verify-focused.json (a
    // gitignored .agent/ artifact — removing it never perturbs the tracked/
    // untracked change set, HEAD, or the fingerprint) so the rerun embeds a
    // MISSING verify.focused instead of CURRENT, changing review.json's bytes
    // with the tree/review.diff completely unchanged.
    rmSync(join(fixture.dir, ".agent", "verify-focused.json"));
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const regeneratedReviewJson = readFileSync(join(fixture.dir, ".agent", "review", "review.json"));
    const regeneratedReviewJsonHash = sha256(regeneratedReviewJson);
    expect(regeneratedReviewJsonHash).not.toBe(firstResult.reviewJsonHash);

    const freshness = codexArtifactFreshness(
      firstResult.provenance,
      firstResult.reviewJsonHash,
      firstResult.reviewDiffHash,
      firstResult.taskDeclarationHash,
      {
        baselineSha: firstResult.provenance.baselineSha,
        headSha: firstResult.provenance.headSha,
        changeSetFingerprint: firstResult.provenance.changeSetFingerprint,
      },
      regeneratedReviewJsonHash,
      firstResult.reviewDiffHash,
      firstResult.taskDeclarationHash,
      firstResult.reviewDiffHash,
    );
    expect(freshness).toBe("STALE");
  });

  it("TOCTOU: stub mutates an already-changed fixture file during its own execution → INPUT_STALE, payload null, exit 1", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "before");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_MODE: "mutate-then-succeed",
      CODEX_STUB_MUTATE_FILE: join(fixture.dir, "x.txt"),
      CODEX_STUB_MUTATE_CONTENT: "mutated during codex exec",
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAILED");
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.payload).toBeNull();
  });

  it("TOCTOU: stub overwrites review.json during its own execution → INPUT_STALE, payload null, exit 1", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_MODE: "mutate-then-succeed",
      CODEX_STUB_MUTATE_FILE: join(fixture.dir, ".agent", "review", "review.json"),
      CODEX_STUB_MUTATE_CONTENT: "mutated review.json bytes",
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.payload).toBeNull();
  });

  it("TOCTOU: stub overwrites review.diff during its own execution → INPUT_STALE, payload null, exit 1", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_MODE: "mutate-then-succeed",
      CODEX_STUB_MUTATE_FILE: join(fixture.dir, ".agent", "review", "review.diff"),
      CODEX_STUB_MUTATE_CONTENT: "mutated review.diff bytes",
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("INPUT_STALE");
    expect(result.payload).toBeNull();
  });

  // BLOCKER regression (HQ): evidence swapped out and restored before codex
  // exec returns must not be able to influence what Codex reviewed. The stub
  // captures the invocation-scoped snapshot file sitting next to
  // --output-last-message (the exact bytes runCodexReview wrote from the
  // already-hashed in-memory content) *before* swapping the mutable original
  // review.json on disk and then restoring it — proving the captured
  // "reviewed" bytes are the frozen pre-swap original, never the swap, even
  // though the mutable original is bit-for-bit restored by the time the
  // post-invocation freshness re-check runs (so this legitimately reports OK).
  it("ABA: evidence swapped and restored during codex exec never reaches the reviewer — snapshot stays frozen at the pre-swap bytes", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const reviewJsonPath = join(fixture.dir, ".agent", "review", "review.json");
    const originalReviewJson = readFileSync(reviewJsonPath);

    const captureDir = mkdtempSync(join(tmpdir(), "codex-review-aba-capture-"));
    const capturePath = join(captureDir, "captured-review.json");

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
        CODEX_STUB_MODE: "aba-swap-and-restore",
        CODEX_STUB_ABA_CAPTURE_SOURCE: "review.json",
        CODEX_STUB_ABA_CAPTURE_PATH: capturePath,
        CODEX_STUB_MUTATE_FILE: reviewJsonPath,
        CODEX_STUB_MUTATE_CONTENT: "swapped evidence bytes — must never reach the reviewer",
        CODEX_STUB_RESTORE_FILE: reviewJsonPath,
        CODEX_STUB_RESTORE_CONTENT: originalReviewJson.toString("utf8"),
      });

      // The swap was fully restored before codex exec returned, so the
      // post-invocation freshness re-check legitimately sees CURRENT — this
      // is expected to succeed. What matters is what was captured.
      expect(status).toBe(0);
      const result = JSON.parse(stdout);
      expect(result.status).toBe("OK");

      const captured = readFileSync(capturePath);
      expect(captured).toEqual(originalReviewJson);
      expect(captured.toString("utf8")).not.toContain("swapped evidence bytes");
    } finally {
      rmSync(captureDir, { recursive: true, force: true });
    }
  });

  it("TOCTOU regression: task declaration bytes change during the call → INPUT_STALE, payload null, exit 1", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));
    // Bundle must be bound to this same --task path/bytes, or the new
    // pre-invocation check reports INPUT_STALE before codex exec is ever
    // invoked — this test is specifically exercising the post-invocation
    // TOCTOU re-check, which requires actually reaching codex exec first.
    expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath], {
        CODEX_STUB_MODE: "mutate-then-succeed",
        CODEX_STUB_MUTATE_FILE: taskPath,
        CODEX_STUB_MUTATE_CONTENT: JSON.stringify({
          $schema: "opspilot-harness/task-declaration@1",
          expectedBranch: "changed",
        }),
      });
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("INPUT_STALE");
      expect(result.payload).toBeNull();
      expect(result.codexExec.invoked).toBe(true);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("TOCTOU regression: task declaration disappears during the call → INPUT_STALE, payload null, exit 1", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));
    expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath], {
        CODEX_STUB_MODE: "mutate-then-succeed",
        CODEX_STUB_DELETE_FILE: taskPath,
      });
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("INPUT_STALE");
      expect(result.payload).toBeNull();
      expect(result.codexExec.invoked).toBe(true);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("a prior Codex artifact captured with --task is proven STALE via codexArtifactFreshness when only the task declaration's bytes change afterward", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));
    expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

    try {
      const first = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(first.status).toBe(0);
      const firstResult = JSON.parse(first.stdout);
      expect(firstResult.status).toBe("OK");

      // Only the task declaration's bytes change — no file in the repo, and
      // neither review.json nor review.diff, is touched.
      writeFileSync(
        taskPath,
        JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", expectedBranch: "something-else" }),
      );
      const currentTaskDeclarationHash = sha256(readFileSync(taskPath));

      const freshness = codexArtifactFreshness(
        firstResult.provenance,
        firstResult.reviewJsonHash,
        firstResult.reviewDiffHash,
        firstResult.taskDeclarationHash,
        {
          baselineSha: firstResult.provenance.baselineSha,
          headSha: firstResult.provenance.headSha,
          changeSetFingerprint: firstResult.provenance.changeSetFingerprint,
        },
        firstResult.reviewJsonHash,
        firstResult.reviewDiffHash,
        currentTaskDeclarationHash,
        firstResult.reviewDiffHash,
      );
      expect(freshness).toBe("STALE");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("stub writes non-JSON output → CODEX_OUTPUT_INVALID", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], { CODEX_STUB_MODE: "bad-json" });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_OUTPUT_INVALID");
    expect(result.payload).toBeNull();
  });

  it("stub writes schema-invalid output (missing required field) → CODEX_OUTPUT_INVALID", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_PAYLOAD: JSON.stringify({ verdict: "READY_FOR_OWNER_REVIEW" }),
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_OUTPUT_INVALID");
  });

  it("stub writes a self-contradictory output (READY_FOR_OWNER_REVIEW with findings listed) → CODEX_OUTPUT_INVALID", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {
      CODEX_STUB_PAYLOAD: JSON.stringify({ verdict: "READY_FOR_OWNER_REVIEW", findings: [sampleFinding()] }),
    });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_OUTPUT_INVALID");
  });

  it("stub exits nonzero → CODEX_EXECUTION_FAILED, raw log still written", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], { CODEX_STUB_MODE: "nonzero" });
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_EXECUTION_FAILED");
    expect(result.codexExec.invoked).toBe(true);
    expect(result.codexExec.logPath).not.toBeNull();
    expect(readFileSync(result.codexExec.logPath, "utf8")).toContain("exitCode:");
    expect(result.provenance).not.toBeNull();
  });

  it("codex absent from PATH → CODEX_UNAVAILABLE, codex never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json"], {}, minimalPathWithGit());
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_UNAVAILABLE");
    expect(result.codexExec.invoked).toBe(false);
    expect(result.provenance).not.toBeNull();
  });

  // MINOR regression (HQ): a hanging `codex --version` must not wedge the
  // command indefinitely — the probe is bounded to min(--timeout-ms, 5000ms)
  // regardless of how large --timeout-ms itself is, and a timed-out probe
  // fails closed without ever reaching the real (timed) invocation.
  it("hanging codex --version probe fails closed (CODEX_UNAVAILABLE) within a bounded time, codex exec never invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const start = Date.now();
    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--timeout-ms", "600000"], {
      CODEX_STUB_HANG_VERSION: "1",
      CODEX_STUB_VERSION_SLEEP_SECONDS: "30",
    });
    const elapsedMs = Date.now() - start;

    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("CODEX_UNAVAILABLE");
    expect(result.codexExec.invoked).toBe(false);
    expect(elapsedMs).toBeLessThan(9000);
  }, 15000);

  it("malformed task declaration (bytes read fine, fails validation) → GROUND_TRUTH_UNRESOLVED, provenance null, taskDeclarationHash non-null", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "wrong-schema" }));

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("GROUND_TRUTH_UNRESOLVED");
      expect(result.provenance).toBeNull();
      expect(result.taskDeclarationHash).not.toBeNull();
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("task declaration path unreadable → GROUND_TRUTH_UNRESOLVED, provenance null, taskDeclarationHash null", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const { status, stdout } = runCodexReviewCli(fixture.dir, [
      "--print-json",
      "--task",
      "/definitely/not/a/real/task.json",
    ]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("GROUND_TRUTH_UNRESOLVED");
    expect(result.provenance).toBeNull();
    expect(result.taskDeclarationHash).toBeNull();
  });

  it("respects --review-dir (read) and --out (write) overrides", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    // Both dirs live outside the fixture repo: anything written inside it
    // would show up as a new untracked file in codex-review's own freshly
    // recomputed change set, making its pre-invocation freshness check see
    // drift that was never really there.
    const externalDir = mkdtempSync(join(tmpdir(), "codex-review-dirs-"));
    const customReviewDir = join(externalDir, "custom-review");
    const customOutDir = join(externalDir, "custom-codex-out");

    try {
      expect(runReviewBundle(fixture.dir, ["--out", customReviewDir]).status).toBe(0);

      const { status } = runCodexReviewCli(fixture.dir, ["--review-dir", customReviewDir, "--out", customOutDir]);
      expect(status).toBe(0);
      expect(existsSync(join(customOutDir, "review-findings.json"))).toBe(true);
      expect(existsSync(join(customOutDir, "review-summary.md"))).toBe(true);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  // MAJOR regression (HQ): a custom --out that lands inside the repo but is
  // still Git-ignored (not just the default .agent/) must stay safe — only an
  // unignored in-repo destination is the problem.
  it("--out inside the repo but Git-ignored (a custom pattern, not just the default .agent/) still succeeds", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile(".gitignore", ".agent/\nnode_modules/\npnpm-lock.yaml\ncustom-ignored-out/\n");
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--out", "custom-ignored-out"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.failureCategory).toBeNull();
    expect(existsSync(join(fixture.dir, "custom-ignored-out", "review-findings.json"))).toBe(true);
  });

  // MAJOR regression (HQ): an in-repo --out Git does NOT ignore must fail
  // closed before Codex is ever invoked — writing there would make this run's
  // own successful artifact stale the instant it's written.
  //
  // Required regression (HQ): OUTPUT_DESTINATION_UNSAFE is the one exception
  // to "the result artifact is always written" — the unsafe --out must end
  // up with neither review-findings.json nor review-summary.md written to it.
  it("--out inside the repo and not Git-ignored fails closed before codex is invoked, and writes no artifact at all", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--out", "unignored-out"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
    expect(result.failureReason).toContain("review-findings.json");
    expect(result.codexExec.invoked).toBe(false);
    expect(existsSync(join(fixture.dir, "unignored-out", "review-findings.json"))).toBe(false);
    expect(existsSync(join(fixture.dir, "unignored-out", "review-summary.md"))).toBe(false);
  });

  // MAJOR regression (HQ): the log destination is validated independently of
  // --out — an --agent-dir whose logs/ subdirectory is unignored must also
  // fail closed, even when --out itself points somewhere safe.
  it("codex-review.log destination inside the repo and not Git-ignored fails closed before codex is invoked", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const externalOutDir = mkdtempSync(join(tmpdir(), "codex-review-safe-out-"));
    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, [
        "--print-json",
        "--review-dir",
        join(fixture.dir, ".agent", "review"),
        "--agent-dir",
        "custom-agent-dir",
        "--out",
        externalOutDir,
      ]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
      expect(result.failureReason).toContain("codex-review.log");
      expect(result.codexExec.invoked).toBe(false);
    } finally {
      rmSync(externalOutDir, { recursive: true, force: true });
    }
  });

  // Required regression A (HQ): a --out that lexically looks outside the
  // repo, but whose parent physically resolves (via a symlink) into an
  // unignored in-repo directory, must fail closed by its physical location —
  // lexical resolution alone would wrongly wave this through as "outside".
  it("--out that lexically looks outside the repo but physically resolves via a symlink into an unignored repo directory fails closed", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    fixture.writeFile("unignored-target/.keep", "");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const externalDir = mkdtempSync(join(tmpdir(), "codex-review-symlink-out-"));
    try {
      const symlinkParent = join(externalDir, "out-parent");
      symlinkSync(join(fixture.dir, "unignored-target"), symlinkParent);
      const outDir = join(symlinkParent, "codex-out");
      expect(outDir.startsWith(fixture.dir)).toBe(false);

      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--out", outDir]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
      expect(result.codexExec.invoked).toBe(false);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  // Required regressions B/C/D (HQ): an explicit --task path that physically
  // aliases one of this command's own persistent write targets must fail
  // closed before Codex is ever invoked — otherwise a successful run would
  // silently overwrite the task declaration evidence it was bound to. Since
  // OUTPUT_DESTINATION_UNSAFE now writes no persistent artifact at all, the
  // aliased task file's original bytes must also survive the run untouched.
  it.each([
    ["review-findings.json", [".agent", "codex", "review-findings.json"]],
    ["review-summary.md", [".agent", "codex", "review-summary.md"]],
    ["codex-review.log", [".agent", "logs", "codex-review.log"]],
  ])("an explicit --task path that aliases the default %s destination fails closed before codex is invoked, leaving the task bytes unchanged", (label, segments) => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const taskPath = join(fixture.dir, ...segments);
    mkdirSync(dirname(taskPath), { recursive: true });
    const originalTaskBytes = JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" });
    writeFileSync(taskPath, originalTaskBytes);

    expect(runReviewBundle(fixture.dir, ["--task", taskPath]).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
    expect(result.failureReason).toContain(label);
    expect(result.codexExec.invoked).toBe(false);
    expect(readFileSync(taskPath, "utf8")).toBe(originalTaskBytes);
  });

  // BLOCKER regressions A/B (HQ): output-destination safety must be
  // evaluated independently of an earlier ground-truth/input failure. Here
  // the --task itself is malformed (fails schema validation), which alone
  // would set GROUND_TRUTH_UNRESOLVED — but that diagnostic result must never
  // be persisted over the very --task path that failed to parse, so the
  // safety check overrides it to OUTPUT_DESTINATION_UNSAFE instead, leaving
  // the malformed task's original bytes untouched and writing no artifact.
  it.each([
    ["review-findings.json", [".agent", "codex", "review-findings.json"]],
    ["review-summary.md", [".agent", "codex", "review-summary.md"]],
  ])(
    "a malformed --task located at the default %s destination fails closed as OUTPUT_DESTINATION_UNSAFE (not GROUND_TRUTH_UNRESOLVED), leaving the original bytes unchanged and writing no artifact",
    (label, segments) => {
      const setup = baseFixture();
      fixture = setup.fixture;
      fixture.writeFile("x.txt", "change");

      const taskPath = join(fixture.dir, ...segments);
      mkdirSync(dirname(taskPath), { recursive: true });
      const malformedTaskBytes = JSON.stringify({ $schema: "not-a-real-schema" });
      writeFileSync(taskPath, malformedTaskBytes);

      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
      expect(result.failureReason).toContain(label);
      expect(result.codexExec.invoked).toBe(false);
      expect(readFileSync(taskPath, "utf8")).toBe(malformedTaskBytes);
      // Approved contract exception (README.md): OUTPUT_DESTINATION_UNSAFE
      // may carry provenance === null when it overrides an earlier
      // GROUND_TRUTH_UNRESOLVED that never let baseline/HEAD/fingerprint
      // resolve — the malformed --task here means exactly that.
      expect(result.provenance).toBeNull();

      const siblingLabel = label === "review-findings.json" ? "review-summary.md" : "review-findings.json";
      expect(existsSync(join(fixture.dir, ".agent", "codex", siblingLabel))).toBe(false);
    },
  );

  // BLOCKER regression C (HQ): a missing/invalid review input must not
  // suppress the output-destination safety check either — an unsafe --out
  // still must receive no persistent artifact even when the run was already
  // going to fail for an unrelated (ground-truth-independent) reason.
  it("missing review.json plus an unsafe --out still fails closed as OUTPUT_DESTINATION_UNSAFE, writing no artifact", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    // Deliberately no agent:review-bundle run — review.json/review.diff are missing.

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--out", "unignored-out"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
    expect(result.codexExec.invoked).toBe(false);
    expect(existsSync(join(fixture.dir, "unignored-out", "review-findings.json"))).toBe(false);
    expect(existsSync(join(fixture.dir, "unignored-out", "review-summary.md"))).toBe(false);
  });

  // BLOCKER regression (HQ): case-insensitive filesystem alias. An explicit
  // --task path that is merely a case-variant spelling of this run's own
  // default review-findings.json destination must still be classified
  // OUTPUT_DESTINATION_UNSAFE. Only run where the fixture filesystem is
  // empirically case-insensitive — never assumed by OS name alone.
  it("a case-variant --task path aliasing the default review-findings.json destination is classified OUTPUT_DESTINATION_UNSAFE", (ctx) => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const outDir = join(fixture.dir, ".agent", "codex");
    mkdirSync(outDir, { recursive: true });
    const lowerCasePath = join(outDir, "review-findings.json");
    const upperCaseVariant = join(outDir, "Review-Findings.json");
    const originalTaskBytes = JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" });
    writeFileSync(lowerCasePath, originalTaskBytes);

    if (!existsSync(upperCaseVariant)) {
      ctx.skip(); // empirically case-sensitive fixture filesystem — nothing to prove here
      return;
    }

    expect(runReviewBundle(fixture.dir, ["--task", upperCaseVariant]).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--task", upperCaseVariant]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
    expect(result.codexExec.invoked).toBe(false);
    expect(readFileSync(lowerCasePath, "utf8")).toBe(originalTaskBytes);
  });

  // BLOCKER regression (HQ): output-destination safety can change *during*
  // the (potentially long) codex exec call itself. The pre-invocation check
  // sees a perfectly safe external --out parent; the stub then swaps that
  // exact ancestor directory to a symlink into an unignored repo directory
  // before it returns. The revalidation immediately before persistence must
  // catch this — no artifact/log may be written through the replacement, and
  // no evidence bytes may change.
  it("output destination safety re-checked immediately before persistence catches an ancestor swapped to a symlink during codex exec", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    fixture.writeFile("unignored-target/.keep", "");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const externalDir = mkdtempSync(join(tmpdir(), "codex-review-swap-parent-"));
    const outParent = join(externalDir, "out-parent");
    mkdirSync(outParent);
    const outDir = join(outParent, "codex-out");

    const reviewJsonBefore = readFileSync(join(fixture.dir, ".agent", "review", "review.json"));

    try {
      const { status, stdout } = runCodexReviewCli(fixture.dir, ["--print-json", "--out", outDir], {
        CODEX_STUB_MODE: "swap-ancestor-to-symlink",
        CODEX_STUB_SWAP_PATH: outParent,
        CODEX_STUB_SWAP_LINK_TARGET: join(fixture.dir, "unignored-target"),
      });

      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.failureCategory).toBe("OUTPUT_DESTINATION_UNSAFE");
      expect(result.codexExec.invoked).toBe(true);
      expect(existsSync(join(fixture.dir, "unignored-target", "codex-out", "review-findings.json"))).toBe(false);
      expect(readFileSync(join(fixture.dir, ".agent", "review", "review.json"))).toEqual(reviewJsonBefore);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("prints a one-line status by default, full JSON only with --print-json", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stdout } = runCodexReviewCli(fixture.dir, []);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe("codex-review: OK");
  });

  // Codex finding (structured-codex-review-v1): an unknown/misspelled flag
  // (e.g. a typo of --review-dir) must be rejected outright, before any
  // evidence selection, Codex availability probing, or provider invocation —
  // not silently ignored and fallen through to running with the unintended
  // default.
  it("rejects an unknown/misspelled flag (--review-dri) before evidence selection or codex invocation", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stderr } = runCodexReviewCli(fixture.dir, ["--review-dri", "somewhere"]);
    expect(status).toBe(1);
    expect(stderr).toContain("--review-dri");
    expect(existsSync(join(fixture.dir, ".agent", "codex", "review-findings.json"))).toBe(false);
  });

  it("rejects a non-positive-integer --timeout-ms", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    expect(runReviewBundle(fixture.dir).status).toBe(0);

    const { status, stderr } = runCodexReviewCli(fixture.dir, ["--timeout-ms", "0"]);
    expect(status).toBe(1);
    expect(stderr).toContain("--timeout-ms");
  });
});

describe("renderMarkdown (codex-review)", () => {
  it("renders exactly the facts already in the result, nothing invented", () => {
    const md = renderMarkdown({
      status: "OK",
      failureCategory: null,
      failureReason: null,
      payload: { verdict: "NEEDS_FIXES", findings: [sampleFinding() as never] },
      reviewInput: {
        freshness: "CURRENT",
        missingReason: null,
        reviewJsonPath: "/repo/.agent/review/review.json",
        reviewDiffPath: "/repo/.agent/review/review.diff",
      },
      codexExec: { invoked: true, exitCode: 0, durationMs: 1234, logPath: "/repo/.agent/logs/codex-review.log" },
      reviewJsonHash: "a".repeat(64),
      reviewDiffHash: "b".repeat(64),
      taskDeclarationHash: null,
      provenance: {
        baselineSha: "c".repeat(40),
        headSha: "d".repeat(40),
        changeSetFingerprint: "e".repeat(64),
        resolvedConfig: {
          taskPath: { value: null, source: "default" },
          agentDir: { value: "/repo/.agent", source: "default" },
          baselineSha: "c".repeat(40),
          baselineSource: "merge-base-main",
        },
      },
    });

    expect(md).toContain("status: OK");
    expect(md).toContain("verdict: NEEDS_FIXES");
    expect(md).toContain("off-by-one");
    expect(md).toContain("no task declaration");
  });

  it("renders failureCategory/failureReason prominently with no findings section when FAILED", () => {
    const md = renderMarkdown({
      status: "FAILED",
      failureCategory: "INPUT_STALE",
      failureReason: "input changed while codex exec was running",
      payload: null,
      reviewInput: {
        freshness: "STALE",
        missingReason: null,
        reviewJsonPath: "/repo/.agent/review/review.json",
        reviewDiffPath: "/repo/.agent/review/review.diff",
      },
      codexExec: { invoked: true, exitCode: 0, durationMs: 1234, logPath: "/repo/.agent/logs/codex-review.log" },
      reviewJsonHash: "a".repeat(64),
      reviewDiffHash: "b".repeat(64),
      taskDeclarationHash: null,
      provenance: {
        baselineSha: "c".repeat(40),
        headSha: "d".repeat(40),
        changeSetFingerprint: "e".repeat(64),
        resolvedConfig: {
          taskPath: { value: null, source: "default" },
          agentDir: { value: "/repo/.agent", source: "default" },
          baselineSha: "c".repeat(40),
          baselineSource: "merge-base-main",
        },
      },
    });

    expect(md).toContain("status: FAILED");
    expect(md).toContain("failureCategory: INPUT_STALE");
    expect(md).toContain("input changed while codex exec was running");
    expect(md).not.toContain("## Findings");
  });

  it("renders 'provenance unavailable' when provenance is null", () => {
    const md = renderMarkdown({
      status: "FAILED",
      failureCategory: "GROUND_TRUTH_UNRESOLVED",
      failureReason: "unresolved baseline",
      payload: null,
      reviewInput: {
        freshness: "MISSING",
        missingReason: "NOT_FOUND",
        reviewJsonPath: "/repo/.agent/review/review.json",
        reviewDiffPath: "/repo/.agent/review/review.diff",
      },
      codexExec: { invoked: false, exitCode: null, durationMs: null, logPath: null },
      reviewJsonHash: null,
      reviewDiffHash: null,
      taskDeclarationHash: null,
      provenance: null,
    });

    expect(md).toContain("provenance unavailable");
  });
});
