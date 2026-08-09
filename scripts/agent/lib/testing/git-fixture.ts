// Disposable tmp-dir git repo helper for Harness Foundation tests. Uses real
// git plumbing (never mocked) since the logic under test *is* git-plumbing
// behavior. Every fixture lives entirely under its own mkdtemp'd directory and
// never touches the owner's real repository or global git config.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  status: number;
}

export interface GitFixture {
  dir: string;
  git(...args: string[]): GitRunResult;
  writeFile(relPath: string, content: string): void;
  removeFile(relPath: string): void;
  add(...relPaths: string[]): void;
  commit(message: string): string;
  setRemoteRef(name: string, ref: string): string;
  headSha(): string;
  cleanup(): void;
}

const FIXTURE_GIT_ENV = {
  GIT_AUTHOR_NAME: "Harness Fixture",
  GIT_AUTHOR_EMAIL: "harness-fixture@example.invalid",
  GIT_COMMITTER_NAME: "Harness Fixture",
  GIT_COMMITTER_EMAIL: "harness-fixture@example.invalid",
};

export interface RepoStateSnapshot {
  headSha: string;
  status: string;
  worktreeList: string;
}

/** Cross-cutting guardrail: snapshot a fixture's git-visible state before an operation, to assert afterward that a Harness command never mutated it beyond what the test itself expects. */
export function snapshotRepoState(fixture: GitFixture): RepoStateSnapshot {
  return {
    headSha: fixture.git("rev-parse", "HEAD").stdout.trim(),
    status: fixture.git("status", "--porcelain=v2").stdout,
    worktreeList: fixture.git("worktree", "list").stdout,
  };
}

export function createGitFixture(): GitFixture {
  const dir = mkdtempSync(join(tmpdir(), "harness-fixture-"));

  function run(args: string[]): GitRunResult {
    const result = spawnSync("git", args, {
      cwd: dir,
      env: { ...process.env, ...FIXTURE_GIT_ENV },
      encoding: "utf8",
    });
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
  }

  run(["init", "--initial-branch=main"]);
  run(["config", "user.email", FIXTURE_GIT_ENV.GIT_AUTHOR_EMAIL]);
  run(["config", "user.name", FIXTURE_GIT_ENV.GIT_AUTHOR_NAME]);
  run(["config", "commit.gpgsign", "false"]);

  return {
    dir,
    git: (...args: string[]) => run(args),
    writeFile(relPath, content) {
      const full = join(dir, relPath);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    },
    removeFile(relPath) {
      run(["rm", "-f", "--", relPath]);
    },
    add(...relPaths) {
      run(["add", "--", ...relPaths]);
    },
    commit(message) {
      run(["commit", "-m", message, "--no-verify", "--allow-empty"]);
      return run(["rev-parse", "HEAD"]).stdout.trim();
    },
    setRemoteRef(name, ref) {
      const sha = run(["rev-parse", ref]).stdout.trim();
      run(["update-ref", `refs/remotes/${name}`, sha]);
      return sha;
    },
    headSha() {
      return run(["rev-parse", "HEAD"]).stdout.trim();
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
