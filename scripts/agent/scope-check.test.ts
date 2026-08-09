import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitFixture, type GitFixture } from "./lib/testing/git-fixture";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SCOPE_CHECK_SCRIPT = join(REPO_ROOT, "scripts", "agent", "scope-check.ts");

function runScopeCheck(cwd: string, args: string[] = []) {
  const result = spawnSync(TSX_BIN, [SCOPE_CHECK_SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("agent:scope-check (e2e)", () => {
  let fixture: GitFixture | undefined;
  let externalDir: string | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
    if (externalDir) {
      rmSync(externalDir, { recursive: true, force: true });
      externalDir = undefined;
    }
  });

  // Task declarations live outside the fixture repo so they never themselves
  // become part of the change set under test.
  function writeExternalTaskDeclaration(content: unknown): string {
    externalDir = mkdtempSync(join(tmpdir(), "task-decl-"));
    const path = join(externalDir, "task.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("NOT_CONFIGURED (exit 0) when no scope is declared anywhere", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/x.ts", "changed");

    const { status, stdout } = runScopeCheck(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).status).toBe("NOT_CONFIGURED");
  });

  it("NOT_CONFIGURED (exit 0) when the task declaration explicitly sets scope: null", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/x.ts", "changed");
    const taskPath = writeExternalTaskDeclaration({
      $schema: "opspilot-harness/task-declaration@1",
      scope: null,
    });

    const { status, stdout } = runScopeCheck(fixture.dir, ["--print-json", "--task", taskPath]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("NOT_CONFIGURED");
    // Distinct from scope: [] — outOfScopePaths must not be populated at all here.
    expect(result.outOfScopePaths).toEqual([]);
  });

  it("PASS when every changed path matches the declared scope", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/src/App.tsx", "changed");

    const { status, stdout } = runScopeCheck(fixture.dir, ["--print-json", "--scope", "apps/web/**"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).status).toBe("PASS");
  });

  it("FAIL (exit 1) when an untracked out-of-scope file appears — still listed in changeSetPaths first", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/src/App.tsx", "changed");
    fixture.writeFile("packages/database/leak.ts", "untracked, out of scope");

    const { status, stdout } = runScopeCheck(fixture.dir, ["--print-json", "--scope", "apps/web/**"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    // Discovery is unfiltered: the out-of-scope path appears in changeSetPaths
    // *and* is flagged in outOfScopePaths — it never silently disappears.
    expect(result.changeSetPaths).toContain("packages/database/leak.ts");
    expect(result.outOfScopePaths).toContain("packages/database/leak.ts");
  });

  it("keeps declared-but-matches-nothing (scope: []) distinct from not-configured", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/src/App.tsx", "changed");
    const taskPath = writeExternalTaskDeclaration({
      $schema: "opspilot-harness/task-declaration@1",
      scope: [],
    });

    const { status, stdout } = runScopeCheck(fixture.dir, ["--print-json", "--task", taskPath]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.scopePatterns).toEqual([]);
    expect(result.outOfScopePaths).toContain("apps/web/src/App.tsx");
  });

  it("--scope overrides a task-declaration scope", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("apps/web/src/App.tsx", "changed");
    const taskPath = writeExternalTaskDeclaration({
      $schema: "opspilot-harness/task-declaration@1",
      scope: ["docs/**"],
    });

    const { status, stdout } = runScopeCheck(fixture.dir, [
      "--print-json",
      "--task",
      taskPath,
      "--scope",
      "apps/web/**",
    ]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).scopePatterns).toEqual(["apps/web/**"]);
  });

  it("writes scope-check.json under .agent/", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    runScopeCheck(fixture.dir, ["--scope", "apps/**"]);
    const written = JSON.parse(readFileSync(join(fixture.dir, ".agent", "scope-check.json"), "utf8"));
    // No changes beyond the initial commit, so nothing is out of scope.
    expect(written.status).toBe("PASS");
    expect(written.scopePatterns).toEqual(["apps/**"]);
  });
});
