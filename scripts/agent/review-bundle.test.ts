import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as git from "./lib/git";
import { createGitFixture, type GitFixture } from "./lib/testing/git-fixture";
import { computeReviewBundle, renderMarkdown } from "./review-bundle";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PREFLIGHT_SCRIPT = join(REPO_ROOT, "scripts", "agent", "preflight.ts");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "agent", "verify.ts");
const SCOPE_CHECK_SCRIPT = join(REPO_ROOT, "scripts", "agent", "scope-check.ts");
const REVIEW_BUNDLE_SCRIPT = join(REPO_ROOT, "scripts", "agent", "review-bundle.ts");

function run(script: string, cwd: string, args: string[] = []) {
  const result = spawnSync(TSX_BIN, [script, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

function runReviewBundle(cwd: string, args: string[] = []) {
  return run(REVIEW_BUNDLE_SCRIPT, cwd, args);
}

// Several tests below chain multiple CLI invocations (verify, then
// scope-check, then review-bundle) against the same fixture repo. In the
// real repo .agent/ is gitignored (frozen plan §1/§12 step 14); mirroring
// that here keeps one command's own artifacts from polluting the next
// command's change-set discovery within the same test.
function baseFixture(): { fixture: GitFixture; baseline: string } {
  const fixture = createGitFixture();
  // node_modules/ and pnpm-lock.yaml gitignored: this fixture has no real
  // install, so a bare `pnpm --filter ... run <script>` writes node_modules
  // bookkeeping files and can rewrite an incomplete lockfile with generated
  // settings/importers sections — real pnpm behavior, but incidental to what
  // these tests exercise. Gitignoring both keeps that noise out of change-set
  // discovery between chained CLI invocations (real opspilot repo commits a
  // fully-formed lockfile that a plain typecheck run never needs to rewrite).
  fixture.writeFile(".gitignore", ".agent/\nnode_modules/\npnpm-lock.yaml\n");
  fixture.writeFile("a.txt", "a");
  fixture.add(".gitignore", "a.txt");
  const baseline = fixture.commit("init");
  fixture.setRemoteRef("origin/main", "HEAD");
  return { fixture, baseline };
}

describe("agent:review-bundle (e2e, spawned CLI)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("happy path: no prior gates run, MATCH, status OK, exit 0", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("changed.txt", "new content");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.reconstructionProof.status).toBe("MATCH");
    expect(result.verify.focused.freshness).toBe("MISSING");
    expect(result.verify.focused.missingReason).toBe("NOT_FOUND");
    expect(result.scopeCheck.freshness).toBe("MISSING");
    expect(result.scopeCheck.missingReason).toBe("NOT_FOUND");
  });

  it("all-CURRENT: verify --focused and scope-check both run first, review-bundle reports them CURRENT", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("docs/x.md", "doc change");

    const verifyRun = run(VERIFY_SCRIPT, fixture.dir, ["--focused"]);
    expect(verifyRun.status).toBe(0);
    const scopeRun = run(SCOPE_CHECK_SCRIPT, fixture.dir, ["--scope", "docs/**"]);
    expect(scopeRun.status).toBe(0);

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.verify.focused.freshness).toBe("CURRENT");
    expect(result.scopeCheck.freshness).toBe("CURRENT");
    expect(result.scopeCheck.result.status).toBe("PASS");
  });

  it("STALE via fingerprint mismatch: editing a file after verify ran, review-bundle still exits 0", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "first version");

    const verifyRun = run(VERIFY_SCRIPT, fixture.dir, ["--focused"]);
    expect(verifyRun.status).toBe(0);

    // Edit the file after verify ran — the fingerprint captured in
    // verify-focused.json's provenance no longer matches current disk state.
    fixture.writeFile("apps/web/x.ts", "edited after verify ran");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.verify.focused.freshness).toBe("STALE");
  });

  it("STALE via HEAD mismatch: committing after scope-check ran", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");
    fixture.add("apps/web/x.ts");

    const scopeRun = run(SCOPE_CHECK_SCRIPT, fixture.dir, ["--scope", "apps/**"]);
    expect(scopeRun.status).toBe(0);

    fixture.commit("commit after scope-check ran");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json", "--baseline", setup.baseline]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.scopeCheck.freshness).toBe("STALE");
  });

  it("neither gate ever run: both MISSING + NOT_FOUND, exit 0", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.verify.focused).toEqual({ freshness: "MISSING", missingReason: "NOT_FOUND", result: null });
    expect(result.verify.final).toEqual({ freshness: "MISSING", missingReason: "NOT_FOUND", result: null });
    expect(result.scopeCheck).toEqual({ freshness: "MISSING", missingReason: "NOT_FOUND", result: null });
  });

  it("a hand-corrupted result file on disk: MISSING + INVALID_ARTIFACT, no crash, exit 0", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "change");
    fixture.writeFile(".agent/verify-focused.json", "{not actually valid json");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.verify.focused).toEqual({ freshness: "MISSING", missingReason: "INVALID_ARTIFACT", result: null });
  });

  it("a verify run that legitimately failed: nested CURRENT+FAIL, collector status OK, exit 0 (gate-vs-collector)", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile(
      "apps/web/package.json",
      JSON.stringify({
        name: "@opspilot/web",
        private: true,
        scripts: { typecheck: 'node -e "process.exit(1)"' },
      }),
    );
    fixture.writeFile("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
    fixture.writeFile("apps/web/x.ts", "change");

    const verifyRun = run(VERIFY_SCRIPT, fixture.dir, ["--focused"]);
    expect(verifyRun.status).toBe(1); // the gate itself genuinely failed

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0); // the collector still succeeds at collecting
    const result = JSON.parse(stdout);
    expect(result.status).toBe("OK");
    expect(result.verify.focused.freshness).toBe("CURRENT");
    expect(result.verify.focused.result.status).toBe("FAIL");
  });

  it("writes review.diff and, with --render-md, review.md", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "content");

    const { status } = runReviewBundle(fixture.dir, ["--render-md"]);
    expect(status).toBe(0);
    const diff = readFileSync(join(fixture.dir, ".agent", "review", "review.diff"), "utf8");
    expect(diff).toContain("x.txt");
    const md = readFileSync(join(fixture.dir, ".agent", "review", "review.md"), "utf8");
    expect(md).toContain("# Review bundle");
    expect(md).toContain("status: OK");
  });

  it("FAILs (exit 1) on an unresolved baseline", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.git("checkout", "--orphan", "other");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("other-init");
    fixture.git("branch", "-D", "main");

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toContain("unresolved baseline");
  });

  it("respects a custom --out directory", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "content");

    const { status } = runReviewBundle(fixture.dir, ["--out", join(fixture.dir, "custom-out")]);
    expect(status).toBe(0);
    const written = JSON.parse(readFileSync(join(fixture.dir, "custom-out", "review.json"), "utf8"));
    expect(written.status).toBe("OK");
  });

  it("does not mutate the fixture repo's git-visible state beyond .agent/**", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "content");
    const headBefore = fixture.headSha();

    runReviewBundle(fixture.dir);

    expect(fixture.headSha()).toBe(headBefore);
    const worktrees = fixture.git("worktree", "list").stdout.trim().split("\n");
    expect(worktrees).toHaveLength(1);
  });

  // Regression (Codex finding: freshness compared only baseline/HEAD/
  // fingerprint, so a scope-check artifact stayed CURRENT after the scope it
  // had actually checked against changed underneath it).
  it("STALE when the task declaration's scope changed after scope-check ran, with an untouched tree and HEAD", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");

    // Task declarations live outside the fixture repo so editing one never
    // itself perturbs the change set, HEAD, or the fingerprint.
    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    const declaration = { $schema: "opspilot-harness/task-declaration@1", scope: ["apps/**"] };
    writeFileSync(taskPath, JSON.stringify(declaration));

    try {
      const scopeRun = run(SCOPE_CHECK_SCRIPT, fixture.dir, ["--task", taskPath]);
      expect(scopeRun.status).toBe(0);

      const before = JSON.parse(runReviewBundle(fixture.dir, ["--print-json", "--task", taskPath]).stdout);
      expect(before.scopeCheck.freshness).toBe("CURRENT");

      // Only the declared scope changes — no file in the repo is touched.
      writeFileSync(taskPath, JSON.stringify({ ...declaration, scope: ["apps/**", "packages/**"] }));

      const after = runReviewBundle(fixture.dir, ["--print-json", "--task", taskPath]);
      expect(after.status).toBe(0); // STALE is not a collector failure
      const afterResult = JSON.parse(after.stdout);
      expect(afterResult.scopeCheck.freshness).toBe("STALE");
      expect(afterResult.scopeCheck.result.scopePatterns).toEqual(["apps/**"]);
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("a task-sourced scope that review-bundle was given no --task for fails closed to STALE", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");

    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", scope: ["apps/**"] }));

    try {
      expect(run(SCOPE_CHECK_SCRIPT, fixture.dir, ["--task", taskPath]).status).toBe(0);

      const result = JSON.parse(runReviewBundle(fixture.dir, ["--print-json"]).stdout);
      expect(result.scopeCheck.freshness).toBe("STALE");
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it("a --scope-sourced scope stays CURRENT: review-bundle has no --scope and never invents one", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");

    expect(run(SCOPE_CHECK_SCRIPT, fixture.dir, ["--scope", "apps/**"]).status).toBe(0);

    const result = JSON.parse(runReviewBundle(fixture.dir, ["--print-json"]).stdout);
    expect(result.scopeCheck.freshness).toBe("CURRENT");
    expect(result.scopeCheck.result.scopePatterns).toEqual(["apps/**"]);
  });

  // Regression (Codex finding: a single mode-agnostic validator let a focused
  // artifact be read out of verify-final.json as the CI-equivalent guarantee).
  it("a focused result placed at verify-final.json is INVALID_ARTIFACT, never read as a final result", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");

    expect(run(VERIFY_SCRIPT, fixture.dir, ["--focused"]).status).toBe(0);
    const focusedArtifact = readFileSync(join(fixture.dir, ".agent", "verify-focused.json"), "utf8");
    writeFileSync(join(fixture.dir, ".agent", "verify-final.json"), focusedArtifact);

    const result = JSON.parse(runReviewBundle(fixture.dir, ["--print-json"]).stdout);
    expect(result.verify.focused.freshness).toBe("CURRENT");
    expect(result.verify.final).toEqual({ freshness: "MISSING", missingReason: "INVALID_ARTIFACT", result: null });
  });

  // Regression (Codex finding, second re-review: a hand-doctored
  // verify-final.json claiming `status: "PASS"` with `steps: []` and
  // `notRun: []`, given otherwise-current provenance, must not be read as
  // CURRENT/PASS — that would let review-bundle report the CI-equivalent
  // guarantee for a run that never executed a single step).
  it("a doctored verify-final.json (PASS, empty steps, empty notRun) with current provenance is INVALID_ARTIFACT, not CURRENT/PASS", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("apps/web/x.ts", "change");

    // This fixture has no real pnpm scripts to run --final against, so a
    // genuinely current provenance block is captured via a real --focused run
    // (safe with zero touched-workspace scripts) and reused verbatim on a
    // hand-doctored final result — provenance is real, only
    // mode/status/steps/notRun are the attack the validator must catch.
    expect(run(VERIFY_SCRIPT, fixture.dir, ["--focused"]).status).toBe(0);
    const focusedArtifact = JSON.parse(readFileSync(join(fixture.dir, ".agent", "verify-focused.json"), "utf8"));
    const doctored = {
      mode: "final",
      status: "PASS",
      touchedWorkspaces: [],
      steps: [],
      notRun: [],
      failureReasons: [],
      provenance: {
        ...focusedArtifact.provenance,
        resolvedConfig: { ...focusedArtifact.provenance.resolvedConfig, mode: { value: "final", source: "cli" } },
      },
    };
    writeFileSync(join(fixture.dir, ".agent", "verify-final.json"), JSON.stringify(doctored));

    const result = JSON.parse(runReviewBundle(fixture.dir, ["--print-json"]).stdout);
    expect(result.verify.final).toEqual({ freshness: "MISSING", missingReason: "INVALID_ARTIFACT", result: null });
  });

  // Regression (Codex finding: binary changes were diffed without --binary, so
  // the review patch carried an unappliable placeholder).
  it("reconstructs a binary change losslessly and records it in review.diff", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    writeFileSync(join(fixture.dir, "asset.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));

    const { status, stdout } = runReviewBundle(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.reconstructionProof.status).toBe("MATCH");
    expect(result.git.changedPaths).toContain("asset.bin");

    const diff = readFileSync(join(fixture.dir, ".agent", "review", "review.diff"), "utf8");
    expect(diff).toContain("GIT binary patch");
  });

  it("the printed resolved configuration reflects explicit --task/--agent-dir/--baseline as cli-sourced, not default", () => {
    const setup = baseFixture();
    fixture = setup.fixture;
    fixture.writeFile("x.txt", "content");
    const taskPath = join(fixture.dir, "task.json");
    fixture.writeFile("task.json", JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" }));
    const customAgentDir = join(fixture.dir, "custom-agent-dir");

    const { stderr } = runReviewBundle(fixture.dir, [
      "--task",
      taskPath,
      "--agent-dir",
      customAgentDir,
      "--baseline",
      setup.baseline,
    ]);

    expect(stderr).toContain(`taskPath: "${taskPath}" (source: cli)`);
    expect(stderr).toContain(`agentDir: "${customAgentDir}" (source: cli)`);
    expect(stderr).toContain(`baselineSha: ${setup.baseline} (source: cli)`);
  });
});

describe("computeReviewBundle (direct import — resolved configuration truthfulness)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("records taskPath as cli-sourced with the actual path when --task is supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("init");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      cliTaskPath: "/some/explicit/task.json",
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.taskPath).toEqual({ value: "/some/explicit/task.json", source: "cli" });
  });

  it("records taskPath as default (null) when --task is not supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("init");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.taskPath).toEqual({ value: null, source: "default" });
  });

  it("records agentDir as cli-sourced with the actual path when --agent-dir is supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("init");
    const customAgentDir = join(fixture.dir, "custom-agent-dir");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      cliAgentDir: customAgentDir,
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.agentDir).toEqual({ value: customAgentDir, source: "cli" });
  });

  it("records agentDir as default when --agent-dir is not supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("init");
    const defaultAgentDir = join(fixture.dir, ".agent");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: defaultAgentDir,
      cliBaseline: baseline,
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.agentDir).toEqual({ value: defaultAgentDir, source: "default" });
  });

  it("records baselineSource as cli when --baseline is explicitly supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("init");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.baselineSha).toBe(baseline);
    expect(resolvedConfig.baselineSource).toBe("cli");
  });

  it("records baselineSource as the merge-base fallback (not cli) when --baseline is not supplied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    const { resolvedConfig } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      taskDeclaration: null,
      taskDeclarationError: null,
    });

    expect(resolvedConfig.baselineSource).toBe("merge-base-origin-main");
  });
});

describe("computeReviewBundle (direct import — diff-injection scenarios)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("a diff engineered not to apply -> APPLY_FAILED, collector status FAILED", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "real baseline content\n");
    fixture.add("modify.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("modify.txt", "changed\n");
    fixture.add("modify.txt");

    const badDiff = [
      "diff --git a/modify.txt b/modify.txt",
      "index 0000000..1111111 100644",
      "--- a/modify.txt",
      "+++ b/modify.txt",
      "@@ -1 +1 @@",
      "-this does not match the real baseline content",
      "+replacement",
      "",
    ].join("\n");

    const { result } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      taskDeclaration: null,
      taskDeclarationError: null,
      diffTextOverride: badDiff,
    });

    expect(result.reconstructionProof.status).toBe("APPLY_FAILED");
    expect(result.status).toBe("FAILED");
    expect(result.failureReason).toContain("APPLY_FAILED");
  });

  it("a diff-generation stub omitting a tracked and an untracked path -> PATH_SET_MISMATCH, collector status FAILED", () => {
    fixture = createGitFixture();
    fixture.writeFile("keep.txt", "keep");
    fixture.writeFile("modify.txt", "before\n");
    fixture.add("keep.txt", "modify.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("modify.txt", "after\n");
    fixture.add("modify.txt");
    fixture.writeFile("untracked.txt", "not added\n");

    // A diff that only covers modify.txt — omits the untracked.txt entry the
    // real change set discovers, simulating a diff-generation bug.
    const stubDiff = [
      "diff --git a/modify.txt b/modify.txt",
      "index 0000000..1111111 100644",
      "--- a/modify.txt",
      "+++ b/modify.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");

    const { result } = computeReviewBundle({
      cwd: fixture.dir,
      agentDirDefault: join(fixture.dir, ".agent"),
      cliBaseline: baseline,
      taskDeclaration: null,
      taskDeclarationError: null,
      diffTextOverride: stubDiff,
    });

    expect(result.reconstructionProof.status).toBe("PATH_SET_MISMATCH");
    expect(result.reconstructionProof.missingPaths).toEqual(["untracked.txt"]);
    expect(result.status).toBe("FAILED");
  });

  // Regression / contract amendment (HQ-approved): CLEANUP_FAILED is a fifth
  // reconstructionProof.status alongside MATCH/MISMATCH/APPLY_FAILED/
  // PATH_SET_MISMATCH. It must make the collector fail overall and must never
  // be readable as successful reconstruction evidence, exactly like the other
  // three failure statuses.
  it("CLEANUP_FAILED makes the collector FAIL overall and is never mistaken for MATCH", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("a.txt", "changed");

    const removeSpy = vi
      .spyOn(git, "worktreeRemove")
      .mockReturnValue({ stdout: "", stderr: "simulated removal failure", status: 128 });

    try {
      const { result } = computeReviewBundle({
        cwd: fixture.dir,
        agentDirDefault: join(fixture.dir, ".agent"),
        cliBaseline: baseline,
        taskDeclaration: null,
        taskDeclarationError: null,
      });

      expect(result.reconstructionProof.status).toBe("CLEANUP_FAILED");
      expect(result.reconstructionProof.cleanupError).toContain("simulated removal failure");
      expect(result.status).toBe("FAILED");
      expect(result.failureReason).toContain("CLEANUP_FAILED");
    } finally {
      removeSpy.mockRestore();
    }
  });
});

describe("renderMarkdown", () => {
  it("renders exactly the facts already in the result, nothing invented", () => {
    const md = renderMarkdown({
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: "a".repeat(40),
        headSha: "b".repeat(40),
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
    });

    expect(md).toContain("status: OK");
    expect(md).toContain("x.txt");
    expect(md).toContain("MATCH");
  });
});
