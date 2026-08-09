import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkOutputDestination, resolveEvidenceReadIdentity, resolvePhysicalPath } from "./output-destination";
import { createGitFixture, type GitFixture } from "./testing/git-fixture";

describe("resolvePhysicalPath", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Rename semantics (required regression, HQ): a same-directory atomic
  // rename onto an existing pathname replaces that pathname itself rather
  // than following it, so resolvePhysicalPath must never realpath a target's
  // own final component — only its ancestors.
  it("does not follow a final-component symlink: an existing symlink target resolves to its own literal pathname, not its link target", () => {
    dir = mkdtempSync(join(tmpdir(), "physpath-"));
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);

    expect(resolvePhysicalPath(link)).not.toBe(resolvePhysicalPath(real));
    expect(resolvePhysicalPath(link)).toBe(join(realpathSync(dir), "link"));
  });

  it("resolves ancestor symlinks (not the final component) for a nonexistent target, appending the rest without creating anything", () => {
    dir = mkdtempSync(join(tmpdir(), "physpath-"));
    const real = join(dir, "real");
    mkdirSync(real);
    const link = join(dir, "link");
    symlinkSync(real, link);

    const target = join(link, "nested", "does-not-exist.json");
    expect(resolvePhysicalPath(target)).toBe(join(realpathSync(real), "nested", "does-not-exist.json"));
  });

  it("matches realpath's resolution of the nearest existing ancestor when the target itself has no symlink components", () => {
    dir = mkdtempSync(join(tmpdir(), "physpath-"));
    mkdirSync(join(dir, "a"));
    const target = join(dir, "a", "b.json");
    expect(resolvePhysicalPath(target)).toBe(join(realpathSync(join(dir, "a")), "b.json"));
  });
});

// BLOCKER regression (HQ): write-destination semantics and evidence-read
// semantics must diverge exactly where a final path component is a symlink —
// resolvePhysicalPath models an atomic rename (never follows it),
// resolveEvidenceReadIdentity models a plain readFileSync (always follows
// it).
describe("resolveEvidenceReadIdentity vs. resolvePhysicalPath", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("follows a final-component symlink to its dereferenced target, unlike resolvePhysicalPath", () => {
    dir = mkdtempSync(join(tmpdir(), "evidence-read-"));
    const real = join(dir, "real.json");
    writeFileSync(real, "{}");
    const link = join(dir, "link.json");
    symlinkSync(real, link);

    expect(resolveEvidenceReadIdentity(link)).toBe(realpathSync(real));
    expect(resolveEvidenceReadIdentity(link)).not.toBe(resolvePhysicalPath(link));
    // resolvePhysicalPath keeps taking the link's own literal pathname, exactly as it does for a write target.
    expect(resolvePhysicalPath(link)).toBe(join(realpathSync(dir), "link.json"));
  });

  it("agrees with resolvePhysicalPath when the path has no symlink components at all", () => {
    dir = mkdtempSync(join(tmpdir(), "evidence-read-"));
    const plain = join(dir, "plain.json");
    writeFileSync(plain, "{}");

    expect(resolveEvidenceReadIdentity(plain)).toBe(resolvePhysicalPath(plain));
  });

  it("falls back to resolvePhysicalPath's literal-ancestor resolution for a nonexistent / broken-symlink path, since readFileSync would fail identically", () => {
    dir = mkdtempSync(join(tmpdir(), "evidence-read-"));
    const missing = join(dir, "does-not-exist.json");
    expect(resolveEvidenceReadIdentity(missing)).toBe(resolvePhysicalPath(missing));

    const brokenLink = join(dir, "broken-link.json");
    symlinkSync(join(dir, "nope.json"), brokenLink);
    expect(resolveEvidenceReadIdentity(brokenLink)).toBe(resolvePhysicalPath(brokenLink));
  });
});

describe("checkOutputDestination", () => {
  let fixture: GitFixture | undefined;
  let externalDir: string | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
    if (externalDir !== undefined) rmSync(externalDir, { recursive: true, force: true });
    externalDir = undefined;
  });

  function baseFixture(): GitFixture {
    const f = createGitFixture();
    f.writeFile(".gitignore", ".agent/\n");
    f.writeFile("a.txt", "a");
    f.add(".gitignore", "a.txt");
    f.commit("init");
    return f;
  }

  it("a destination clearly outside the repo is safe", () => {
    fixture = baseFixture();
    externalDir = mkdtempSync(join(tmpdir(), "output-dest-external-"));
    const result = checkOutputDestination(fixture.dir, join(externalDir, "out.json"), "out");
    expect(result).toEqual({ safe: true, reason: null });
  });

  it("a destination inside the repo and Git-ignored is safe", () => {
    fixture = baseFixture();
    const result = checkOutputDestination(fixture.dir, join(fixture.dir, ".agent", "out.json"), "out");
    expect(result).toEqual({ safe: true, reason: null });
  });

  it("a destination inside the repo and not Git-ignored fails closed", () => {
    fixture = baseFixture();
    const result = checkOutputDestination(fixture.dir, join(fixture.dir, "unignored-out.json"), "out");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("not Git-ignored");
  });

  // Required regression A: an apparently outside-repo destination whose
  // parent is a symlink into an unignored in-repo directory must resolve to
  // its physical (in-repo, unignored) location and fail closed.
  it("a lexically outside-repo destination that physically traverses a symlink into an unignored repo directory fails closed", () => {
    fixture = baseFixture();
    fixture.writeFile("unignored-target/.keep", "");
    externalDir = mkdtempSync(join(tmpdir(), "output-dest-external-"));
    const symlinkParent = join(externalDir, "out-parent");
    symlinkSync(join(fixture.dir, "unignored-target"), symlinkParent);

    const target = join(symlinkParent, "review-findings.json");
    // Lexically, target sits entirely outside both fixture.dir and externalDir's real location.
    expect(target.startsWith(fixture.dir)).toBe(false);

    const result = checkOutputDestination(fixture.dir, target, "out");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("not Git-ignored");
  });

  it("a lexically outside-repo destination that physically traverses a symlink into a Git-ignored repo directory stays safe", () => {
    fixture = baseFixture();
    externalDir = mkdtempSync(join(tmpdir(), "output-dest-external-"));
    const symlinkParent = join(externalDir, "out-parent");
    symlinkSync(join(fixture.dir, ".agent"), symlinkParent);

    const target = join(symlinkParent, "review-findings.json");
    const result = checkOutputDestination(fixture.dir, target, "out");
    expect(result).toEqual({ safe: true, reason: null });
  });

  // Required regression (HQ): the alias check treats every evidence input
  // uniformly — task declaration, review.json, and review.diff alike — none
  // of them may be silently overwritten by a persistent write target that
  // resolves to the exact same pathname. (In the real CLI, review.json and
  // review.diff always keep their fixed basenames, so this exact literal
  // collision is only reachable in the unit; it exercises the same code path
  // codex-review.ts wires all three evidence inputs through.)
  it.each([
    ["review.json", "review.json"],
    ["review.diff", "review.diff"],
  ])("a destination that literally aliases the %s evidence input fails closed even when it would otherwise be safe (in-repo, ignored)", (label, filename) => {
    fixture = baseFixture();
    const evidencePath = join(fixture.dir, ".agent", "review", filename);
    fixture.writeFile(`.agent/review/${filename}`, "content");

    // The --out target happens to be configured to the exact same path as the evidence input.
    const result = checkOutputDestination(fixture.dir, evidencePath, "review-findings.json (--out)", [
      { path: evidencePath, label },
    ]);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain(label);
  });

  // A destination that is itself an existing symlink pointing at an evidence
  // input's real bytes is *not* an alias by rename semantics: a
  // same-directory rename onto that pathname replaces the symlink itself,
  // never writing through it to the evidence file's real content, so the
  // evidence input stays untouched either way.
  it("a destination that is an existing symlink to an evidence input's real file is not treated as an alias", () => {
    fixture = baseFixture();
    const reviewJsonPath = join(fixture.dir, ".agent", "review", "review.json");
    fixture.writeFile(".agent/review/review.json", "{}");

    mkdirSync(join(fixture.dir, ".agent", "codex"), { recursive: true });
    const target = join(fixture.dir, ".agent", "codex", "review-findings.json");
    symlinkSync(reviewJsonPath, target);

    const result = checkOutputDestination(fixture.dir, target, "review-findings.json (--out)", [
      { path: reviewJsonPath, label: "review.json" },
    ]);
    expect(result).toEqual({ safe: true, reason: null });
  });

  // Required regression 2 (HQ): an unignored in-repo destination that is
  // itself an existing symlink to an outside-repo file must still classify
  // as in-repo/unsafe — an atomic rename onto that pathname replaces the
  // symlink itself (its own, in-repo, pathname), it never follows the
  // symlink to write through to whatever it currently points at.
  it("an existing final-component symlink to an outside-repo file still classifies as in-repo/unsafe", () => {
    fixture = baseFixture();
    externalDir = mkdtempSync(join(tmpdir(), "output-dest-external-"));
    const outsideFile = join(externalDir, "outside-data.json");
    writeFileSync(outsideFile, "{}");

    mkdirSync(join(fixture.dir, "unignored-dir"));
    const target = join(fixture.dir, "unignored-dir", "link-file.json");
    symlinkSync(outsideFile, target);

    const result = checkOutputDestination(fixture.dir, target, "out");
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("not Git-ignored");
  });

  it("a destination that does not alias any evidence input is unaffected by the alias check", () => {
    fixture = baseFixture();
    const reviewJsonPath = join(fixture.dir, ".agent", "review", "review.json");
    fixture.writeFile(".agent/review/review.json", "{}");

    const target = join(fixture.dir, ".agent", "codex", "review-findings.json");
    const result = checkOutputDestination(fixture.dir, target, "review-findings.json (--out)", [
      { path: reviewJsonPath, label: "review.json" },
    ]);
    expect(result).toEqual({ safe: true, reason: null });
  });

  // BLOCKER regression (HQ): on a case-insensitive filesystem, two
  // differently-cased spellings of the same directory entry are the exact
  // same physical file, but resolvePhysicalPath's plain string comparison
  // alone cannot see that — its final path component is deliberately never
  // realpath'd (to preserve atomic-rename replace-not-follow semantics), so a
  // case-variant alias needs the lstat device+inode identity check as well.
  // Only run where the fixture filesystem is empirically case-insensitive —
  // never assumed by OS name alone.
  it("a case-variant destination that resolves to the same on-disk entry as an evidence input is treated as an alias on a case-insensitive filesystem", (ctx) => {
    fixture = baseFixture();
    const reviewJsonPath = join(fixture.dir, ".agent", "review", "review.json");
    fixture.writeFile(".agent/review/review.json", "{}");

    const caseVariantPath = join(fixture.dir, ".agent", "review", "REVIEW.JSON");
    if (!existsSync(caseVariantPath)) {
      ctx.skip(); // empirically case-sensitive fixture filesystem — nothing to prove here
      return;
    }

    const result = checkOutputDestination(fixture.dir, caseVariantPath, "review-findings.json (--out)", [
      { path: reviewJsonPath, label: "review.json" },
    ]);
    expect(result.safe).toBe(false);
    expect(result.reason).toContain("review.json");
  });

  // The identity check must not turn a genuinely different (case-sensitive)
  // file into a false-positive alias merely because it happens to share a
  // directory with the evidence input.
  it("a same-directory file with an unrelated name is not treated as an alias", () => {
    fixture = baseFixture();
    const reviewJsonPath = join(fixture.dir, ".agent", "review", "review.json");
    fixture.writeFile(".agent/review/review.json", "{}");
    fixture.writeFile(".agent/review/review.diff", "diff --git a/x b/x\n");

    const target = join(fixture.dir, ".agent", "review", "review.diff");
    const result = checkOutputDestination(fixture.dir, target, "review-findings.json (--out)", [
      { path: reviewJsonPath, label: "review.json" },
    ]);
    expect(result).toEqual({ safe: true, reason: null });
  });

  // BLOCKER regressions 1-4 (HQ): an evidence input that is itself a
  // final-component symlink whose *target* is a persistent write destination
  // must be classified unsafe. resolvePhysicalPath alone (write semantics)
  // cannot see this — it deliberately never follows the evidence path's own
  // final symlink either — so this exercises the new evidence-read-identity
  // comparison specifically. Covers all three evidence inputs the real CLI
  // wires through (task declaration, review.json, review.diff) against both
  // review-findings.json and review-summary.md destinations.
  it.each([
    ["task declaration (--task)", "review-findings.json (--out)"],
    ["task declaration (--task)", "review-summary.md (--out)"],
    ["review.json", "review-findings.json (--out)"],
    ["review.diff", "review-findings.json (--out)"],
  ])(
    "an evidence input (%s) that is a final-component symlink to the %s destination fails closed, leaving the destination's bytes unchanged",
    (evidenceLabel, destinationLabel) => {
      fixture = baseFixture();
      const targetPath = join(fixture.dir, ".agent", "codex", "review-findings.json");
      const originalTargetBytes = "pre-existing destination content";
      fixture.writeFile(".agent/codex/review-findings.json", originalTargetBytes);

      const evidenceLinkPath = join(fixture.dir, ".agent", "evidence-link.json");
      symlinkSync(targetPath, evidenceLinkPath);

      const result = checkOutputDestination(fixture.dir, targetPath, destinationLabel, [
        { path: evidenceLinkPath, label: evidenceLabel },
      ]);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(evidenceLabel);
      expect(readFileSync(targetPath, "utf8")).toBe(originalTargetBytes);
    },
  );

  // Same shape as above but for the write-destination side of the pair HQ
  // called out explicitly: review.json and review.diff evidence inputs
  // symlinked at their real (fixed) CLI-wired paths, not a synthetic path.
  it.each([
    ["review.json", "review.json"],
    ["review.diff", "review.diff"],
  ])(
    "%s as a final-component symlink to a persistent write destination is classified unsafe",
    (label, filename) => {
      fixture = baseFixture();
      const targetPath = join(fixture.dir, ".agent", "codex", "review-findings.json");
      fixture.writeFile(".agent/codex/review-findings.json", "destination content");

      const evidencePath = join(fixture.dir, ".agent", "review", filename);
      mkdirSync(dirname(evidencePath), { recursive: true });
      symlinkSync(targetPath, evidencePath);

      const result = checkOutputDestination(fixture.dir, targetPath, "review-findings.json (--out)", [
        { path: evidencePath, label },
      ]);
      expect(result.safe).toBe(false);
      expect(result.reason).toContain(label);
    },
  );
});
