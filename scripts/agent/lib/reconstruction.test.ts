import { symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as git from "./git";
import { getCompleteChangeSet, worktreeList } from "./git";
import { buildReconstructionProof, generateReviewDiff } from "./reconstruction";
import { createGitFixture, type GitFixture } from "./testing/git-fixture";

describe("reconstruction", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  function setUpMixedChangeFixture(): { fixture: GitFixture; baseline: string } {
    const f = createGitFixture();
    f.writeFile("keep.txt", "keep");
    f.writeFile("modify.txt", "before\n");
    f.writeFile("delete.txt", "gone\n");
    f.add("keep.txt", "modify.txt", "delete.txt");
    const baseline = f.commit("baseline");

    f.writeFile("modify.txt", "after\n");
    f.removeFile("delete.txt");
    f.writeFile("added.txt", "new tracked\n");
    f.add("added.txt", "modify.txt");
    f.writeFile("untracked.txt", "not added\n");

    return { fixture: f, baseline };
  }

  it("MATCH on the happy path: add, modify, delete, and untracked content all survive reconstruction", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;

    const changeSet = getCompleteChangeSet(fixture.dir, setup.baseline);
    const outcome = buildReconstructionProof(fixture.dir, setup.baseline, changeSet);

    expect(outcome.proof.status).toBe("MATCH");
    expect(outcome.proof.missingPaths).toEqual([]);
    expect(outcome.proof.extraPaths).toEqual([]);
    expect(outcome.diffText).toContain("modify.txt");
    expect(outcome.diffText).toContain("added.txt");
    expect(outcome.diffText).toContain("untracked.txt");
  });

  it("never leaves a stray worktree registered after a MATCH run", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;
    const changeSet = getCompleteChangeSet(fixture.dir, setup.baseline);

    buildReconstructionProof(fixture.dir, setup.baseline, changeSet);

    const list = worktreeList(fixture.dir);
    // Only the primary worktree (the fixture repo itself) should remain.
    expect(list.trim().split("\n")).toHaveLength(1);
  });

  it("PATH_SET_MISMATCH when the diff omits a tracked and an untracked changed path", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;
    const changeSet = getCompleteChangeSet(fixture.dir, setup.baseline);

    const realDiff = generateReviewDiff(fixture.dir, setup.baseline, changeSet);
    const blocks = realDiff.split(/(?=^diff --git )/m);
    const tampered = blocks
      .filter((block) => !block.startsWith("diff --git a/modify.txt") && !block.startsWith("diff --git a/untracked.txt"))
      .join("");

    const outcome = buildReconstructionProof(fixture.dir, setup.baseline, changeSet, { diffText: tampered });

    expect(outcome.proof.status).toBe("PATH_SET_MISMATCH");
    expect(outcome.proof.missingPaths.sort()).toEqual(["modify.txt", "untracked.txt"]);
    expect(outcome.proof.extraPaths).toEqual([]);
  });

  it("APPLY_FAILED when the diff is engineered not to apply (context does not match baseline content)", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "real baseline content\n");
    fixture.add("modify.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("modify.txt", "changed\n");
    fixture.add("modify.txt");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const badDiff = [
      "diff --git a/modify.txt b/modify.txt",
      "index 0000000..1111111 100644",
      "--- a/modify.txt",
      "+++ b/modify.txt",
      "@@ -1 +1 @@",
      "-this line does not match the real baseline content",
      "+replacement",
      "",
    ].join("\n");

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet, { diffText: badDiff });
    expect(outcome.proof.status).toBe("APPLY_FAILED");
  });

  it("MISMATCH when the diff applies cleanly but reconstructs different content than the real working tree", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "before\n");
    fixture.add("modify.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("modify.txt", "after\n");
    fixture.add("modify.txt");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    // Valid patch against the real baseline content, but produces different
    // final bytes than what the real working tree actually has ("after").
    const divergentDiff = [
      "diff --git a/modify.txt b/modify.txt",
      "index 0000000..1111111 100644",
      "--- a/modify.txt",
      "+++ b/modify.txt",
      "@@ -1 +1 @@",
      "-before",
      "+something-else-entirely",
      "",
    ].join("\n");

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet, { diffText: divergentDiff });
    expect(outcome.proof.status).toBe("MISMATCH");
  });

  it("returns MATCH with empty change set when nothing changed since baseline", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const baseline = fixture.commit("baseline");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    expect(changeSet).toEqual([]);
    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);
    expect(outcome.proof.status).toBe("MATCH");
  });

  it("discovers and reconstructs a filename containing a literal newline (git quotes such headers; extraction must not depend on line-oriented parsing)", () => {
    fixture = createGitFixture();
    const trackedNlName = "tracked\nweird.txt";
    fixture.writeFile(trackedNlName, "before\n");
    fixture.add(trackedNlName);
    const baseline = fixture.commit("baseline");

    fixture.writeFile(trackedNlName, "after\n");
    fixture.add(trackedNlName);
    const untrackedNlName = "untracked\nfile.txt";
    fixture.writeFile(untrackedNlName, "new content\n");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const paths = changeSet.map((e) => e.path);
    expect(paths).toContain(trackedNlName);
    expect(paths).toContain(untrackedNlName);

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);
    expect(outcome.proof.status).toBe("MATCH");
    expect(outcome.proof.missingPaths).toEqual([]);
    expect(outcome.proof.extraPaths).toEqual([]);
  });

  it("handles a deleted file correctly end to end", () => {
    fixture = createGitFixture();
    fixture.writeFile("delete-me.txt", "will be deleted\n");
    fixture.add("delete-me.txt");
    const baseline = fixture.commit("baseline");
    fixture.removeFile("delete-me.txt");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);
    expect(outcome.proof.status).toBe("MATCH");
  });

  // --- Regression: binary changes were diffed without --binary --------------
  // Without it git emits the unappliable "Binary files a/x and b/x differ"
  // placeholder, so binary bytes could never be reconstructed.

  it("reconstructs tracked and untracked binary changes losslessly", () => {
    fixture = createGitFixture();
    const originalBytes = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]);
    writeFileSync(join(fixture.dir, "tracked.bin"), originalBytes);
    fixture.add("tracked.bin");
    const baseline = fixture.commit("baseline");

    const changedBytes = Buffer.from([0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const untrackedBytes = Buffer.from([0xff, 0x00, 0x10, 0x20, 0x00, 0x7f]);
    writeFileSync(join(fixture.dir, "tracked.bin"), changedBytes);
    writeFileSync(join(fixture.dir, "untracked.bin"), untrackedBytes);

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);

    expect(outcome.proof.status).toBe("MATCH");
    // The proof only passes if the patch actually carried the bytes, not the
    // "Binary files ... differ" placeholder.
    expect(outcome.diffText).toContain("GIT binary patch");
    expect(outcome.diffText).not.toContain("Binary files");
  });

  // --- Regression: symlinks were compared by following them -----------------

  it("MATCHes a tracked symlink whose target changed, without following either link", () => {
    fixture = createGitFixture();
    fixture.writeFile("first.txt", "identical\n");
    fixture.writeFile("second.txt", "identical\n");
    symlinkSync("first.txt", join(fixture.dir, "link.txt"));
    fixture.add("first.txt", "second.txt", "link.txt");
    const baseline = fixture.commit("baseline");

    unlinkSync(join(fixture.dir, "link.txt"));
    symlinkSync("second.txt", join(fixture.dir, "link.txt"));
    fixture.add("link.txt");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    expect(changeSet.map((e) => e.path)).toContain("link.txt");

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);
    expect(outcome.proof.status).toBe("MATCH");
  });

  it("MATCHes a newly added untracked symlink as a link, not as a copy of its target", () => {
    fixture = createGitFixture();
    fixture.writeFile("target.txt", "target content\n");
    fixture.add("target.txt");
    const baseline = fixture.commit("baseline");
    symlinkSync("target.txt", join(fixture.dir, "new-link.txt"));

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);

    expect(outcome.proof.status).toBe("MATCH");
    expect(outcome.diffText).toContain("new file mode 120000");
  });

  it("MATCHes a broken symlink (whose target does not exist) rather than reading it as deleted", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a\n");
    fixture.add("a.txt");
    const baseline = fixture.commit("baseline");
    symlinkSync("no-such-target.txt", join(fixture.dir, "dangling.txt"));

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    expect(changeSet.map((e) => e.path)).toContain("dangling.txt");

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet);
    expect(outcome.proof.status).toBe("MATCH");
  });

  it("MISMATCHes when reconstruction produces a regular file where the working tree has a symlink", () => {
    fixture = createGitFixture();
    fixture.writeFile("target.txt", "shared bytes\n");
    fixture.add("target.txt");
    const baseline = fixture.commit("baseline");
    symlinkSync("target.txt", join(fixture.dir, "link.txt"));

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    // A diff that adds a *regular file* whose bytes equal the link's target
    // string. Following the symlink would have compared "shared bytes\n"
    // against "shared bytes\n" and wrongly reported MATCH; comparing the link
    // representation catches the type difference.
    const wrongTypeDiff = [
      "diff --git a/link.txt b/link.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/link.txt",
      "@@ -0,0 +1 @@",
      "+target.txt",
      "\\ No newline at end of file",
      "",
    ].join("\n");

    const outcome = buildReconstructionProof(fixture.dir, baseline, changeSet, { diffText: wrongTypeDiff });
    expect(outcome.proof.status).toBe("MISMATCH");
  });

  // --- Regression: cleanup failure could not affect the reported result -----

  it("still removes the temporary worktree when the proof itself throws mid-run", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;
    const repoDir = setup.fixture.dir;
    const changeSet = getCompleteChangeSet(repoDir, setup.baseline);

    const spy = vi.spyOn(git, "diffNameOnly").mockImplementation(() => {
      throw new Error("simulated mid-proof failure");
    });

    try {
      expect(() => buildReconstructionProof(repoDir, setup.baseline, changeSet)).toThrow(
        "simulated mid-proof failure",
      );
      expect(worktreeList(repoDir).trim().split("\n")).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("CLEANUP_FAILED (never MATCH) when the temporary worktree is still registered afterward", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;
    const changeSet = getCompleteChangeSet(fixture.dir, setup.baseline);

    // Simulate a `git worktree remove` that reports failure and leaves the
    // registration behind — previously the finally block discarded both the
    // exit status and the follow-up `worktree list`, so the run still said MATCH.
    const removeSpy = vi
      .spyOn(git, "worktreeRemove")
      .mockReturnValue({ stdout: "", stderr: "fatal: could not remove worktree", status: 1 });

    try {
      const outcome = buildReconstructionProof(fixture.dir, setup.baseline, changeSet);
      expect(outcome.proof.status).toBe("CLEANUP_FAILED");
      expect(outcome.proof.cleanupError).toContain("still registered");
      // The pre-cleanup conclusion is preserved for diagnosis, but never becomes the status.
      expect(outcome.proof.cleanupError).toContain("MATCH");
    } finally {
      removeSpy.mockRestore();
      // Real cleanup, so the fixture teardown leaves nothing behind.
      const registered = git.worktreeRegisteredPaths(fixture.dir).filter((p) => p !== fixture?.dir);
      for (const path of registered) git.worktreeRemove(fixture.dir, path);
      git.runGit(fixture.dir, ["worktree", "prune"]);
    }
  });

  it("CLEANUP_FAILED when `git worktree remove` fails outright, even though the proof itself matched", () => {
    const setup = setUpMixedChangeFixture();
    fixture = setup.fixture;
    const changeSet = getCompleteChangeSet(fixture.dir, setup.baseline);

    const realRemove = git.worktreeRemove;
    const removeSpy = vi.spyOn(git, "worktreeRemove").mockImplementation((repoCwd, worktreePath) => {
      realRemove(repoCwd, worktreePath);
      return { stdout: "", stderr: "simulated removal failure", status: 128 };
    });

    try {
      const outcome = buildReconstructionProof(fixture.dir, setup.baseline, changeSet);
      expect(outcome.proof.status).toBe("CLEANUP_FAILED");
      expect(outcome.proof.cleanupError).toContain("simulated removal failure");
    } finally {
      removeSpy.mockRestore();
    }
  });
});

describe("generateReviewDiff", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("emits an appliable binary patch rather than the 'Binary files ... differ' placeholder", () => {
    fixture = createGitFixture();
    writeFileSync(join(fixture.dir, "bin.dat"), Buffer.from([0x00, 0x01, 0xff]));
    fixture.add("bin.dat");
    const baseline = fixture.commit("baseline");
    writeFileSync(join(fixture.dir, "bin.dat"), Buffer.from([0x00, 0x02, 0xfe, 0x03]));

    const diffText = generateReviewDiff(fixture.dir, baseline, getCompleteChangeSet(fixture.dir, baseline));
    expect(diffText).toContain("GIT binary patch");
    expect(diffText).not.toContain("Binary files");
  });
});
