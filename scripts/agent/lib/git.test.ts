import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGitFixture, type GitFixture } from "./testing/git-fixture";
import {
  diffNumstatPaths,
  diffTrackedPath,
  diffUntrackedPath,
  getCompleteChangeSet,
  getCurrentBranch,
  getHeadSha,
  getStagedPaths,
  getWorkingTreeStatus,
  lookupRef,
  mergeBaseOutcome,
  parsePorcelainV2,
  resolveCommitSha,
} from "./git";

describe("git plumbing", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("getCurrentBranch returns the branch name on a normal checkout", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    expect(getCurrentBranch(fixture.dir)).toBe("main");
  });

  it("getCurrentBranch returns null on detached HEAD", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    fixture.git("checkout", "--detach", sha);
    expect(getCurrentBranch(fixture.dir)).toBeNull();
  });

  it("resolveCommitSha resolves a valid ref and returns null for an invalid one", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    expect(resolveCommitSha(fixture.dir, "HEAD")).toBe(sha);
    expect(resolveCommitSha(fixture.dir, "does-not-exist")).toBeNull();
  });

  it("mergeBaseOutcome computes the common ancestor commit, not either tip", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const base = fixture.commit("base");
    fixture.git("branch", "feature");
    fixture.writeFile("a.txt", "a2");
    fixture.add("a.txt");
    fixture.commit("on-main");
    fixture.git("checkout", "feature");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("on-feature");

    expect(mergeBaseOutcome(fixture.dir, "feature", "main")).toEqual({ kind: "FOUND", sha: base });
  });

  // Regression (Codex finding: merge-base fallback conflated expected misses
  // with fatal failures). Each expected miss must be distinguishable by kind,
  // so a fallback chain can advance on those two and only those two.
  it("mergeBaseOutcome reports MISSING_REF (not a fatal error) when a candidate ref does not exist", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    expect(mergeBaseOutcome(fixture.dir, "HEAD", "nonexistent-ref")).toEqual({
      kind: "MISSING_REF",
      ref: "nonexistent-ref",
    });
  });

  it("mergeBaseOutcome reports NO_COMMON_ANCESTOR for two unrelated histories", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    fixture.git("checkout", "--orphan", "unrelated");
    fixture.git("rm", "-rf", "--cached", ".");
    fixture.writeFile("b.txt", "b");
    fixture.add("b.txt");
    fixture.commit("unrelated-init");

    expect(mergeBaseOutcome(fixture.dir, "main", "unrelated")).toEqual({ kind: "NO_COMMON_ANCESTOR" });
  });

  it("mergeBaseOutcome reports FATAL when git itself fails on refs that both resolve", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const base = fixture.commit("base");
    fixture.git("branch", "feature");
    fixture.writeFile("m.txt", "m");
    fixture.add("m.txt");
    fixture.commit("on-main");
    fixture.git("checkout", "feature");
    fixture.writeFile("f.txt", "f");
    fixture.add("f.txt");
    fixture.commit("on-feature");

    // Both tips still resolve, but the shared ancestor's object is corrupt, so
    // walking history exits 128. That must never be read as "no common
    // ancestor" and silently advance the baseline fallback chain.
    const objectPath = join(fixture.dir, ".git", "objects", base.slice(0, 2), base.slice(2));
    rmSync(objectPath, { force: true });
    writeFileSync(objectPath, "not-a-zlib-stream");

    const outcome = mergeBaseOutcome(fixture.dir, "main", "feature");
    expect(outcome.kind).toBe("FATAL");
  });

  // Regression (Codex finding: mergeBaseOutcome inferred MISSING_REF merely
  // because `<ref>^{commit}` failed to resolve, which is exactly as true for a
  // ref that genuinely does not exist as for one that exists but points at an
  // unreadable object — collapsing "absent" and "broken" together let a
  // corrupt origin/main silently fall through to local main).
  it("mergeBaseOutcome reports FATAL — not MISSING_REF — when a ref exists but its target object is corrupt", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    // The ref itself is real (update-ref writes a plain pointer, no object
    // read); only the commit object it names is corrupted afterward.
    fixture.git("update-ref", "refs/remotes/origin/main", sha);
    const objectPath = join(fixture.dir, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    rmSync(objectPath, { force: true });
    writeFileSync(objectPath, "not-a-zlib-stream");

    const outcome = mergeBaseOutcome(fixture.dir, "HEAD", "origin/main");
    expect(outcome.kind).toBe("FATAL");
  });

  it("mergeBaseOutcome reports FATAL — not MISSING_REF — when a ref exists but its object is missing entirely", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    fixture.git("update-ref", "refs/remotes/origin/main", sha);
    const objectPath = join(fixture.dir, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    rmSync(objectPath, { force: true }); // gone outright, not merely corrupted

    const outcome = mergeBaseOutcome(fixture.dir, "HEAD", "origin/main");
    expect(outcome.kind).toBe("FATAL");
  });

  it("mergeBaseOutcome reports FATAL — not MISSING_REF — when a ref resolves to a non-commit object", () => {
    fixture = createGitFixture();
    fixture.writeFile("blob-source.txt", "just a blob, not a commit");
    fixture.add("blob-source.txt");
    fixture.commit("init");
    const blobSha = fixture.git("rev-parse", "HEAD:blob-source.txt").stdout.trim();
    fixture.git("update-ref", "refs/remotes/origin/main", blobSha);

    const outcome = mergeBaseOutcome(fixture.dir, "HEAD", "origin/main");
    expect(outcome.kind).toBe("FATAL");
  });

  // The five scenarios HQ asked for explicitly, by name, using "origin/main" —
  // the actual candidate the baseline fallback chain probes first.

  it("(1) genuinely missing origin/main -> MISSING_REF, so a fallback chain may advance", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init"); // no origin/main ref created at all
    expect(mergeBaseOutcome(fixture.dir, "HEAD", "origin/main")).toEqual({
      kind: "MISSING_REF",
      ref: "origin/main",
    });
  });

  it("(2) valid origin/main -> normal FOUND resolution", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const base = fixture.commit("base");
    fixture.setRemoteRef("origin/main", "HEAD");
    fixture.writeFile("a.txt", "a2");
    fixture.add("a.txt");
    fixture.commit("second");

    expect(mergeBaseOutcome(fixture.dir, "HEAD", "origin/main")).toEqual({ kind: "FOUND", sha: base });
  });

  it("(3) origin/main exists but its object is missing/corrupt -> FATAL", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    fixture.git("update-ref", "refs/remotes/origin/main", sha);
    const objectPath = join(fixture.dir, ".git", "objects", sha.slice(0, 2), sha.slice(2));
    rmSync(objectPath, { force: true });
    writeFileSync(objectPath, "not-a-zlib-stream");

    expect(mergeBaseOutcome(fixture.dir, "HEAD", "origin/main").kind).toBe("FATAL");
  });

  it("(4) origin/main exists but names a non-commit object -> FATAL", () => {
    fixture = createGitFixture();
    fixture.writeFile("blob-source.txt", "a blob, not a commit");
    fixture.add("blob-source.txt");
    fixture.commit("init");
    const blobSha = fixture.git("rev-parse", "HEAD:blob-source.txt").stdout.trim();
    fixture.git("update-ref", "refs/remotes/origin/main", blobSha);

    expect(mergeBaseOutcome(fixture.dir, "HEAD", "origin/main").kind).toBe("FATAL");
  });

  // (5) — the exact bug this fix targets. `lookupRef`'s predecessor
  // (`refExists`) called `git rev-parse --verify -q <ref>` and treated *any*
  // nonzero exit as "missing". A malformed ref entry — the loose-ref file
  // exists on disk but its content isn't a valid SHA or "ref: " line — also
  // exits nonzero from that exact call, with git printing "warning: ignoring
  // broken ref" rather than silently returning empty: the ref slot is
  // physically present and unreadable, not absent. The old code could not
  // tell these apart and treated a malformed higher-precedence ref exactly
  // like a missing one, silently falling back to a healthy local main.
  it("(5) origin/main's ref entry is physically present but malformed -> FATAL, never MISSING_REF", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    // A loose ref file whose content is neither a 40-hex SHA nor a "ref: "
    // symref line — physically present, unparseable.
    mkdirSync(join(fixture.dir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(fixture.dir, ".git", "refs", "remotes", "origin", "main"), "not-a-valid-sha-or-symref\n");

    const outcome = mergeBaseOutcome(fixture.dir, "HEAD", "origin/main");
    expect(outcome.kind).toBe("FATAL");
    expect(outcome.kind).not.toBe("MISSING_REF");
  });

  // (6) Same fail-closed requirement as (5), but via a corrupt packed-refs
  // file rather than a corrupt loose ref: `rev-parse --verify -q` fails every
  // ref lookup in the repo with "fatal: unexpected line in packed-refs: ...",
  // exit 128 — a completely different failure shape than the loose-ref case,
  // and one that must never be read as "no such ref" either.
  it("(6) a malformed packed-refs file makes lookups FATAL, never MISSING_REF", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    writeFileSync(join(fixture.dir, ".git", "packed-refs"), "not-a-valid-packed-refs-line\n");

    const outcome = mergeBaseOutcome(fixture.dir, "HEAD", "origin/main");
    expect(outcome.kind).toBe("FATAL");
    expect(outcome.kind).not.toBe("MISSING_REF");
  });

  it("lookupRef itself: MISSING for an absent ref, BROKEN for a malformed one, EXISTS for a valid one", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    mkdirSync(join(fixture.dir, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(fixture.dir, ".git", "refs", "remotes", "origin", "broken"), "garbage\n");

    expect(lookupRef(fixture.dir, "origin/nonexistent")).toBe("MISSING");
    expect(lookupRef(fixture.dir, "origin/broken")).toBe("BROKEN");
    expect(lookupRef(fixture.dir, "main")).toBe("EXISTS");
    expect(lookupRef(fixture.dir, "HEAD")).toBe("EXISTS");
  });

  // Regression: lookupRef used to classify *any* nonzero exit that didn't
  // contain the literal substring "warning: ignoring broken ref" as MISSING.
  // A malformed packed-refs file makes `rev-parse --verify -q` fail with a
  // completely different message ("fatal: unexpected line in packed-refs: ...",
  // exit 128) for *every* ref lookup in the repo, including ones that would
  // otherwise resolve just fine — that fatal condition was falling through to
  // MISSING under the old string-matching logic. lookupRef must fail closed:
  // only a clean "exit 1, nothing on stderr" (what `-q` guarantees for a
  // genuinely absent ref) may be classified MISSING; everything else is BROKEN.
  it("lookupRef classifies a malformed packed-refs file as BROKEN, not MISSING, for every ref it affects", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    writeFileSync(join(fixture.dir, ".git", "packed-refs"), "not-a-valid-packed-refs-line\n");

    expect(lookupRef(fixture.dir, "main")).toBe("BROKEN");
    expect(lookupRef(fixture.dir, "origin/nonexistent")).toBe("BROKEN");
  });

  it("getCompleteChangeSet unions tracked diff-vs-baseline with untracked files", () => {
    fixture = createGitFixture();
    fixture.writeFile("keep.txt", "keep");
    fixture.writeFile("modify.txt", "before");
    fixture.writeFile("delete.txt", "gone-soon");
    fixture.add("keep.txt", "modify.txt", "delete.txt");
    const baseline = fixture.commit("baseline");

    fixture.writeFile("modify.txt", "after");
    fixture.removeFile("delete.txt");
    fixture.writeFile("added.txt", "new tracked");
    fixture.add("added.txt", "modify.txt");
    fixture.writeFile("untracked.txt", "not added");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const byPath = Object.fromEntries(changeSet.map((e) => [e.path, e.status]));

    expect(byPath["modify.txt"]).toBe("M");
    expect(byPath["delete.txt"]).toBe("D");
    expect(byPath["added.txt"]).toBe("A");
    expect(byPath["untracked.txt"]).toBe("??");
    expect(byPath["keep.txt"]).toBeUndefined();
  });

  it("discovers a path containing a space and a path containing a non-ASCII character intact", () => {
    fixture = createGitFixture();
    fixture.writeFile("base.txt", "base");
    fixture.add("base.txt");
    const baseline = fixture.commit("baseline");

    fixture.writeFile("with space.txt", "content");
    fixture.writeFile("café.txt", "content");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const paths = changeSet.map((e) => e.path);
    expect(paths).toContain("with space.txt");
    expect(paths).toContain("café.txt");
  });

  it("discovers a path containing a literal newline intact (NUL-delimited discovery, not newline-split)", () => {
    fixture = createGitFixture();
    fixture.writeFile("base.txt", "base");
    fixture.add("base.txt");
    const baseline = fixture.commit("baseline");

    fixture.writeFile("weird\nname.txt", "content");

    const changeSet = getCompleteChangeSet(fixture.dir, baseline);
    const paths = changeSet.map((e) => e.path);
    expect(paths).toContain("weird\nname.txt");
  });

  it("discovers a rename-without-modification as a discrete delete + add, regardless of the fixture's renames config", () => {
    for (const renamesConfig of ["true", "false"]) {
      fixture = createGitFixture();
      fixture.git("config", "diff.renames", renamesConfig);
      fixture.git("config", "status.renames", renamesConfig);
      fixture.writeFile("original.txt", "identical content, only the name changes");
      fixture.add("original.txt");
      const baseline = fixture.commit("baseline");

      fixture.git("mv", "original.txt", "renamed.txt");
      fixture.add("renamed.txt");

      const changeSet = getCompleteChangeSet(fixture.dir, baseline);
      const byPath = Object.fromEntries(changeSet.map((e) => [e.path, e.status]));
      expect(byPath["original.txt"]).toBe("D");
      expect(byPath["renamed.txt"]).toBe("A");

      fixture.cleanup();
      fixture = undefined;
    }
  });

  it("getStagedPaths reports only index-vs-HEAD differences", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");

    fixture.writeFile("a.txt", "a2");
    fixture.add("a.txt");
    fixture.writeFile("untouched-worktree-only.txt", "not staged");

    expect(getStagedPaths(fixture.dir)).toEqual(["a.txt"]);
  });

  it("getWorkingTreeStatus buckets modified/deleted/untracked", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "before");
    fixture.writeFile("delete.txt", "gone");
    fixture.add("modify.txt", "delete.txt");
    fixture.commit("init");

    fixture.writeFile("modify.txt", "after");
    fixture.removeFile("delete.txt");
    fixture.writeFile("new.txt", "untracked");

    const status = getWorkingTreeStatus(fixture.dir);
    expect(status.trackedModified).toContain("modify.txt");
    expect(status.trackedDeleted).toContain("delete.txt");
    expect(status.untracked).toContain("new.txt");
  });

  // Regression (Codex finding: unmerged porcelain-v2 records were parsed with
  // the ordinary-record field count, and their path was recovered by splitting
  // the record on spaces). An unmerged record has 9 fields before the path, and
  // the path may itself contain spaces, tabs, and newlines.
  it("parses an unmerged (u) record whose path contains a space, a tab, and a newline", () => {
    fixture = createGitFixture();
    const conflictPath = "con flict\tand\nnewline.txt";
    fixture.writeFile(conflictPath, "base\n");
    fixture.add(conflictPath);
    fixture.commit("base");
    fixture.git("checkout", "-b", "other");
    fixture.writeFile(conflictPath, "other\n");
    fixture.add(conflictPath);
    fixture.commit("other");
    fixture.git("checkout", "main");
    fixture.writeFile(conflictPath, "mine\n");
    fixture.add(conflictPath);
    fixture.commit("mine");
    const merge = fixture.git("merge", "other");
    expect(merge.status).not.toBe(0); // a genuine conflict, so `u` records exist

    const raw = fixture.git("status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all").stdout;
    const entries = parsePorcelainV2(raw);
    const unmerged = entries.filter((e) => e.kind === "u");
    expect(unmerged).toHaveLength(1);
    expect(unmerged[0]?.path).toBe(conflictPath);
    expect(unmerged[0]?.xy).toBe("UU");

    // Both consumers of the parse must see the whole, intact path.
    expect(getStagedPaths(fixture.dir)).toEqual([conflictPath]);
    expect(getWorkingTreeStatus(fixture.dir).trackedModified).toContain(conflictPath);
  });

  it("parses an ordinary (1) record whose path contains a space and a tab", () => {
    fixture = createGitFixture();
    const oddPath = "odd name\twith tab.txt";
    fixture.writeFile(oddPath, "before\n");
    fixture.add(oddPath);
    fixture.commit("init");
    fixture.writeFile(oddPath, "after\n");
    fixture.add(oddPath);

    const raw = fixture.git("status", "--porcelain=v2", "-z", "--no-renames", "--untracked-files=all").stdout;
    const ordinary = parsePorcelainV2(raw).filter((e) => e.kind === "1");
    expect(ordinary.map((e) => e.path)).toEqual([oddPath]);
    expect(getStagedPaths(fixture.dir)).toEqual([oddPath]);
  });

  it("parsePorcelainV2 fails closed on a rename/copy record rather than mis-slicing it", () => {
    // `2` records carry a second NUL-terminated original path, which no
    // per-record parse can represent; every caller passes --no-renames, so one
    // appearing means an assumption broke.
    const record = "2 R. N... 100644 100644 100644 abc123 def456 R100 new.txt\0old.txt\0";
    expect(() => parsePorcelainV2(record)).toThrow(/rename\/copy record/);
  });

  it("getHeadSha matches git rev-parse HEAD", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    const sha = fixture.commit("init");
    expect(getHeadSha(fixture.dir)).toBe(sha);
  });
});

describe("diffNumstatPaths", () => {
  let fixture: GitFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it("extracts the paths a diff text represents, for ordinary filenames", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "before\n");
    fixture.add("modify.txt");
    const baseline = fixture.commit("baseline");
    fixture.writeFile("modify.txt", "after\n");

    const diffText = diffTrackedPath(fixture.dir, baseline, "modify.txt");
    expect(diffNumstatPaths(fixture.dir, diffText)).toEqual(["modify.txt"]);
  });

  it("decodes git's C-quoted header and recovers a path containing a literal newline", () => {
    fixture = createGitFixture();
    fixture.writeFile("base.txt", "base");
    fixture.add("base.txt");
    fixture.commit("baseline");
    const nlName = "weird\nname.txt";
    fixture.writeFile(nlName, "hello\n");

    const diffText = diffUntrackedPath(fixture.dir, nlName);
    expect(diffNumstatPaths(fixture.dir, diffText)).toEqual([nlName]);
  });

  it("extracts the path from a binary patch, whose numstat columns are '-'", () => {
    fixture = createGitFixture();
    writeFileSync(join(fixture.dir, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    fixture.add("bin.dat");
    const baseline = fixture.commit("baseline");
    writeFileSync(join(fixture.dir, "bin.dat"), Buffer.from([0x00, 0xfe, 0xfd, 0x03, 0x04]));

    const diffText = diffTrackedPath(fixture.dir, baseline, "bin.dat");
    expect(diffNumstatPaths(fixture.dir, diffText)).toEqual(["bin.dat"]);
  });

  it("returns an empty array for empty diff text", () => {
    fixture = createGitFixture();
    fixture.writeFile("a.txt", "a");
    fixture.add("a.txt");
    fixture.commit("init");
    expect(diffNumstatPaths(fixture.dir, "")).toEqual([]);
  });

  it("still parses paths from a diff whose content will not actually apply cleanly (structure-only parse)", () => {
    fixture = createGitFixture();
    fixture.writeFile("modify.txt", "real baseline content\n");
    fixture.add("modify.txt");
    fixture.commit("baseline");

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

    expect(diffNumstatPaths(fixture.dir, badDiff)).toEqual(["modify.txt"]);
  });
});
