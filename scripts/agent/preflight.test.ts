import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitFixture, type GitFixture } from "./lib/testing/git-fixture";

const REPO_ROOT = resolve(__dirname, "..", "..");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const PREFLIGHT_SCRIPT = join(REPO_ROOT, "scripts", "agent", "preflight.ts");

function runPreflight(cwd: string, args: string[] = []) {
  const result = spawnSync(TSX_BIN, [PREFLIGHT_SCRIPT, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

describe("agent:preflight (e2e)", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("PASS on a clean tree with no expectations declared", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).status).toBe("PASS");
  });

  it("PASS on a dirty tree with no expectations declared (dirty alone is never a failure)", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("a.txt", "modified");
    fixture.writeFile("untracked.txt", "new");

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("PASS");
    expect(result.workingTree.trackedModified).toContain("a.txt");
    expect(result.workingTree.untracked).toContain("untracked.txt");
  });

  it("FAILs when a declared --branch expectation is violated", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json", "--branch", "not-main"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.failureReasons.length).toBeGreaterThan(0);
  });

  it("PASSes when a declared --branch expectation is satisfied", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    const { status } = runPreflight(fixture.dir, ["--print-json", "--branch", "main"]);
    expect(status).toBe(0);
  });

  it("FAILs when a declared --working-tree clean expectation is violated by a dirty tree", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("a.txt", "dirty now");

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json", "--working-tree", "clean"]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).status).toBe("FAIL");
  });

  it("FAILs on an unresolved baseline (no --baseline, no task-declaration, no main/origin-main reachable)", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.git("checkout", "--orphan", "other");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("other-init");
    fixture.git("branch", "-D", "main");

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json"]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.status).toBe("FAIL");
    expect(result.failureReasons.some((r: string) => r.includes("unresolved baseline"))).toBe(true);
  });

  it("FAILs on a malformed task declaration", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("task.json", JSON.stringify({ $schema: "wrong@1" }));

    const { status, stdout } = runPreflight(fixture.dir, [
      "--print-json",
      "--task",
      join(fixture.dir, "task.json"),
    ]);
    expect(status).toBe(1);
    const result = JSON.parse(stdout);
    expect(result.failureReasons.some((r: string) => r.includes("malformed task declaration"))).toBe(true);
  });

  it("reports branch: null with no crash on detached HEAD", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.git("checkout", "--detach", sha);

    const { status, stdout } = runPreflight(fixture.dir, ["--print-json"]);
    expect(status).toBe(0);
    expect(JSON.parse(stdout).branch).toBeNull();
  });

  it("writes preflight.json under .agent/ in the target repo", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");

    runPreflight(fixture.dir);
    const written = JSON.parse(readFileSync(join(fixture.dir, ".agent", "preflight.json"), "utf8"));
    expect(written.status).toBe("PASS");
  });

  it("a task-declaration expectedBranch is honored when no --branch flag overrides it", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile(
      "task.json",
      JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", expectedBranch: "not-main" }),
    );

    const { status, stdout } = runPreflight(fixture.dir, [
      "--print-json",
      "--task",
      join(fixture.dir, "task.json"),
    ]);
    expect(status).toBe(1);
    expect(JSON.parse(stdout).status).toBe("FAIL");
  });

  it("an explicit --branch CLI flag overrides a task-declaration expectedBranch", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile(
      "task.json",
      JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", expectedBranch: "not-main" }),
    );

    const { status } = runPreflight(fixture.dir, [
      "--print-json",
      "--task",
      join(fixture.dir, "task.json"),
      "--branch",
      "main",
    ]);
    expect(status).toBe(0);
  });
});
