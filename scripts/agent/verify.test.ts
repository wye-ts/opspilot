import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitFixture, type GitFixture } from "./lib/testing/git-fixture";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const VERIFY_SCRIPT = join(REPO_ROOT, "scripts", "agent", "verify.ts");

function runVerify(cwd: string, args: string[] = []) {
  const result = spawnSync(TSX_BIN, [VERIFY_SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

// A fixture repo doubling as: (a) a real git repo, for baseline/change-set
// discovery, and (b) a minimal pnpm workspace with fast stub
// typecheck/test/build/check:bundle scripts, so --final e2e coverage never
// touches the real opspilot repo's own `pnpm test` (which would otherwise
// recursively re-trigger `agent:test` — see the frozen plan's "no recursive
// self-invocation" guardrail).
function createVerifyFixture(): GitFixture {
  const fixture = createGitFixture();
  fixture.writeFile(
    "package.json",
    JSON.stringify({
      name: "fixture-root",
      private: true,
      scripts: {
        typecheck: "node -e \"console.log('STUB_TYPECHECK_RAN'); process.exit(0)\"",
        test: "node -e \"console.log('STUB_TEST_RAN'); process.exit(0)\"",
        build: "node -e \"console.log('STUB_BUILD_RAN'); process.exit(0)\"",
      },
    }),
  );
  fixture.writeFile("pnpm-workspace.yaml", 'packages:\n  - "apps/*"\n');
  fixture.writeFile(
    "apps/web/package.json",
    JSON.stringify({
      name: "@opspilot/web",
      private: true,
      scripts: {
        typecheck: "node -e \"console.log('STUB_WEB_TYPECHECK_RAN'); process.exit(0)\"",
        test: "node -e \"console.log('STUB_WEB_TEST_RAN'); process.exit(0)\"",
        "check:bundle": "node -e \"console.log('STUB_CHECKBUNDLE_RAN'); process.exit(0)\"",
      },
    }),
  );
  fixture.writeFile(
    "packages/contracts/package.json",
    JSON.stringify({ name: "@opspilot/contracts", private: true, scripts: {} }),
  );
  fixture.add(".");
  fixture.commit("fixture workspace");
  fixture.setRemoteRef("origin/main", "HEAD");
  return fixture;
}

describe("agent:verify (e2e)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("requires exactly one of --focused / --final", () => {
    fixture = createVerifyFixture();
    const neither = runVerify(fixture.dir, []);
    expect(neither.status).toBe(1);

    const both = runVerify(fixture.dir, ["--focused", "--final"]);
    expect(both.status).toBe(1);
  });

  it("--focused with zero touched workspaces (docs-only change) PASSes with empty steps", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("README.md", "docs only change");
    fixture.add("README.md");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("PASS");
    expect(result.steps).toEqual([]);
    expect(result.touchedWorkspaces).toEqual([]);
  });

  it("--focused maps a change under apps/web to the @opspilot/web workspace and runs its scripts", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/src/App.tsx");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.touchedWorkspaces).toEqual(["@opspilot/web"]);
    expect(result.steps.length).toBe(2);
    expect(result.steps.every((s: { status: string }) => s.status === "PASS")).toBe(true);
  });

  it("--focused skips a script that is absent from a touched workspace's package.json", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("packages/contracts/src/index.ts", "// changed");
    fixture.add("packages/contracts/src/index.ts");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.touchedWorkspaces).toEqual(["@opspilot/contracts"]);
    expect(result.steps).toEqual([]);
  });

  // Regression (Codex finding: an unreadable/unparseable manifest was caught
  // and read as "no scripts", so a directly touched workspace was silently
  // skipped and the run still reported PASS).
  it("--focused FAILs when a directly touched workspace's package.json is not valid JSON", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("apps/web/package.json", '{"name": "@opspilot/web", "scripts": {');
    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/package.json", "apps/web/src/App.tsx");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.steps).toEqual([]);
    expect(result.failureReasons.join("\n")).toContain("apps/web/package.json");
  });

  it("--focused FAILs when a directly touched workspace's package.json is unreadable", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/src/App.tsx");
    chmodSync(join(fixture.dir, "apps/web/package.json"), 0o000);

    try {
      const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
      expect(status).toBe(1);
      const result = JSON.parse(stdout);
      expect(result.status).toBe("FAIL");
      expect(result.failureReasons.join("\n")).toContain("apps/web/package.json");
    } finally {
      chmodSync(join(fixture.dir, "apps/web/package.json"), 0o644);
    }
  });

  it("--focused FAILs when a touched workspace's package.json is valid JSON but not an object", () => {
    fixture = createVerifyFixture();
    fixture.writeFile("apps/web/package.json", '"not an object"');
    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/package.json", "apps/web/src/App.tsx");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).status).toBe("FAIL");
  });

  it("--focused still PASSes when an *untouched* workspace has a broken package.json", () => {
    fixture = createVerifyFixture();
    // The broken manifest is part of the baseline, so packages/contracts is
    // never touched by this change set and has no bearing on what focused
    // verification needed to run.
    fixture.writeFile("packages/contracts/package.json", "{ broken");
    fixture.add("packages/contracts/package.json");
    fixture.commit("pre-existing broken manifest");
    fixture.setRemoteRef("origin/main", "HEAD");

    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/src/App.tsx");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("PASS");
    expect(result.touchedWorkspaces).toEqual(["@opspilot/web"]);
  });

  it("--focused reports FAIL and exit 1 when a touched workspace's script genuinely fails", () => {
    fixture = createVerifyFixture();
    const pkg = JSON.parse(readFileSync(join(fixture.dir, "apps/web/package.json"), "utf8"));
    pkg.scripts.typecheck = "node -e \"process.exit(1)\"";
    fixture.writeFile("apps/web/package.json", JSON.stringify(pkg));
    fixture.writeFile("apps/web/src/App.tsx", "// changed");
    fixture.add("apps/web/package.json", "apps/web/src/App.tsx");

    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.steps.some((s: { status: string }) => s.status === "FAIL")).toBe(true);
  });

  it("--final always reports the fixed integration/docker-smoke notRun pair", () => {
    fixture = createVerifyFixture();
    const { status, stdout } = runVerify(fixture.dir, ["--final", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.notRun).toEqual(["integration", "docker-smoke"]);
  });

  it("--final still reports notRun: [integration, docker-smoke] on an early failure that never runs any step (unresolved baseline)", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.git("checkout", "--orphan", "other");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("other-init");
    fixture.git("branch", "-D", "main");

    const { status, stdout } = runVerify(fixture.dir, ["--final", "--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.steps).toEqual([]);
    expect(result.notRun).toEqual(["integration", "docker-smoke"]);
  });

  it("--final still reports notRun: [integration, docker-smoke] on a malformed task declaration (no steps run)", () => {
    fixture = createVerifyFixture();
    const externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const taskPath = join(externalDir, "task.json");
    writeFileSync(taskPath, JSON.stringify({ $schema: "wrong@1" }));

    const { status, stdout } = runVerify(fixture.dir, ["--final", "--print-json", "--task", taskPath]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.steps).toEqual([]);
    expect(result.notRun).toEqual(["integration", "docker-smoke"]);

    rmSync(externalDir, { recursive: true, force: true });
  });

  it("--focused's notRun stays empty (the notRun guarantee is specific to final mode)", () => {
    fixture = createVerifyFixture();
    const { status, stdout } = runVerify(fixture.dir, ["--focused", "--print-json"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).notRun).toEqual([]);
  });

  it("--final runs the fixture's fast stub commands, not the real opspilot repo's pnpm test", () => {
    fixture = createVerifyFixture();
    const { status, stdout } = runVerify(fixture.dir, ["--final", "--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.steps).toHaveLength(4);
    const combinedOutput = result.steps.map((s: { outputTail: string }) => s.outputTail).join("\n");
    expect(combinedOutput).toContain("STUB_TYPECHECK_RAN");
    expect(combinedOutput).toContain("STUB_TEST_RAN");
    expect(combinedOutput).toContain("STUB_BUILD_RAN");
    expect(combinedOutput).toContain("STUB_CHECKBUNDLE_RAN");
    // Every step should complete in well under a second — proof these are
    // the fixture's fast stubs, not a real multi-package pnpm typecheck/test/build.
    for (const step of result.steps as Array<{ durationMs: number }>) {
      expect(step.durationMs).toBeLessThan(5000);
    }
  });

  it("--final stops at the first failing step (fail-fast, matching CI step ordering)", () => {
    fixture = createVerifyFixture();
    const pkg = JSON.parse(readFileSync(join(fixture.dir, "package.json"), "utf8"));
    pkg.scripts.typecheck = "node -e \"process.exit(1)\"";
    fixture.writeFile("package.json", JSON.stringify(pkg));
    fixture.add("package.json");

    const { status, stdout } = runVerify(fixture.dir, ["--final", "--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].status).toBe("FAIL");
  });

  it("writes verify-focused.json / verify-final.json under .agent/", () => {
    fixture = createVerifyFixture();
    runVerify(fixture.dir, ["--focused"]);
    const written = JSON.parse(readFileSync(join(fixture.dir, ".agent", "verify-focused.json"), "utf8"));
    expect(written.mode).toBe("focused");
  });
});
