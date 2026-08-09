import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeChangeSetFingerprint, readEntryContent, UnsupportedChangeEntryError } from "./fingerprint";
import type { ChangeEntry } from "./types";

describe("computeChangeSetFingerprint", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "fingerprint-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is stable for the same content regardless of input order", () => {
    writeFileSync(join(dir, "a.txt"), "a-content");
    writeFileSync(join(dir, "b.txt"), "b-content");
    const entriesA: ChangeEntry[] = [
      { path: "a.txt", status: "M" },
      { path: "b.txt", status: "A" },
    ];
    const entriesB: ChangeEntry[] = [
      { path: "b.txt", status: "A" },
      { path: "a.txt", status: "M" },
    ];
    expect(computeChangeSetFingerprint(dir, entriesA)).toBe(computeChangeSetFingerprint(dir, entriesB));
  });

  it("changes when file content changes", () => {
    writeFileSync(join(dir, "a.txt"), "before");
    const entries: ChangeEntry[] = [{ path: "a.txt", status: "M" }];
    const before = computeChangeSetFingerprint(dir, entries);

    writeFileSync(join(dir, "a.txt"), "after");
    const after = computeChangeSetFingerprint(dir, entries);

    expect(before).not.toBe(after);
  });

  it("uses a deleted-file sentinel when the path does not exist on disk", () => {
    const entries: ChangeEntry[] = [{ path: "deleted.txt", status: "D" }];
    // Should not throw despite the file being absent.
    expect(() => computeChangeSetFingerprint(dir, entries)).not.toThrow();
  });

  it("differs between a present file and an absent (deleted) one even with the same path/status shape", () => {
    const entries: ChangeEntry[] = [{ path: "x.txt", status: "M" }];
    const deletedFingerprint = computeChangeSetFingerprint(dir, entries);

    writeFileSync(join(dir, "x.txt"), "now present");
    const presentFingerprint = computeChangeSetFingerprint(dir, entries);

    expect(deletedFingerprint).not.toBe(presentFingerprint);
  });

  it("changes when the status of an otherwise-identical entry changes", () => {
    writeFileSync(join(dir, "a.txt"), "same content");
    const asModified: ChangeEntry[] = [{ path: "a.txt", status: "M" }];
    const asAdded: ChangeEntry[] = [{ path: "a.txt", status: "A" }];
    expect(computeChangeSetFingerprint(dir, asModified)).not.toBe(computeChangeSetFingerprint(dir, asAdded));
  });

  it("returns a 64-char hex sha256 digest", () => {
    const digest = computeChangeSetFingerprint(dir, []);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- Regression: ambiguous `<status>\t<path>\t<hash>\n` framing -----------
  // Git permits tabs and newlines in a path, so the old tab/newline-framed
  // record could be reproduced byte-for-byte by a *different* change set.

  function write(relPath: string, content: string): void {
    const full = join(dir, relPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  /** The exact record the frozen (now amended) framing produced, for constructing a genuine collision. */
  function legacyFrame(entries: readonly { status: string; path: string; hash: string }[]): string {
    return entries.map((e) => `${e.status}\t${e.path}\t${e.hash}\n`).join("");
  }

  it("distinguishes two change sets whose legacy tab/newline framing was byte-identical", () => {
    // Two ordinary entries sharing one content hash frame to exactly the same
    // bytes as a single entry whose path embeds that hash, a newline, and the
    // second record's status/path — because tab and newline are legal in a Git
    // path but were being used as field and record separators.
    const content = "shared content";
    const contentHash = createHash("sha256").update(Buffer.from(content)).digest("hex");
    const craftedPath = `a.txt\t${contentHash}\nM\tb.txt`;

    write("a.txt", content);
    write("b.txt", content);
    write(craftedPath, content);

    const twoEntries: ChangeEntry[] = [
      { path: "a.txt", status: "M" },
      { path: "b.txt", status: "M" },
    ];
    const oneCraftedEntry: ChangeEntry[] = [{ path: craftedPath, status: "M" }];

    // Precondition: under the legacy framing these really were indistinguishable.
    expect(legacyFrame([
      { status: "M", path: "a.txt", hash: contentHash },
      { status: "M", path: "b.txt", hash: contentHash },
    ])).toBe(legacyFrame([{ status: "M", path: craftedPath, hash: contentHash }]));

    // Under NUL framing they are not.
    expect(computeChangeSetFingerprint(dir, twoEntries)).not.toBe(computeChangeSetFingerprint(dir, oneCraftedEntry));
  });

  it("distinguishes a single path containing a tab from the two paths it could be misread as", () => {
    const content = "same";
    const contentHash = createHash("sha256").update(Buffer.from(content)).digest("hex");
    // Same construction, exercised on the field separator alone: the crafted
    // path swallows the first record's hash field and the second record's status.
    const craftedPath = `one.txt\t${contentHash}\nM\ttwo.txt`;

    write("one.txt", content);
    write("two.txt", content);
    write(craftedPath, content);

    const asOnePath: ChangeEntry[] = [{ path: craftedPath, status: "M" }];
    const asTwoPaths: ChangeEntry[] = [
      { path: "one.txt", status: "M" },
      { path: "two.txt", status: "M" },
    ];

    expect(computeChangeSetFingerprint(dir, asOnePath)).not.toBe(computeChangeSetFingerprint(dir, asTwoPaths));
  });

  // --- Regression: symlinks were followed instead of hashed as links --------

  it("hashes a symlink as its target string, not as the bytes of what it points at", () => {
    write("target.txt", "pointed-at content");
    symlinkSync("target.txt", join(dir, "link.txt"));
    const asLink = computeChangeSetFingerprint(dir, [{ path: "link.txt", status: "A" }]);

    // Replace the link with a regular file holding the *same* bytes the link
    // resolved to. Following the link would make these two fingerprints equal.
    unlinkSync(join(dir, "link.txt"));
    write("link.txt", "pointed-at content");
    const asRegularFile = computeChangeSetFingerprint(dir, [{ path: "link.txt", status: "A" }]);

    expect(asLink).not.toBe(asRegularFile);
  });

  it("changes when only a symlink's target changes, even though both targets hold identical bytes", () => {
    write("first.txt", "identical");
    write("second.txt", "identical");
    symlinkSync("first.txt", join(dir, "link.txt"));
    const before = computeChangeSetFingerprint(dir, [{ path: "link.txt", status: "M" }]);

    unlinkSync(join(dir, "link.txt"));
    symlinkSync("second.txt", join(dir, "link.txt"));
    const after = computeChangeSetFingerprint(dir, [{ path: "link.txt", status: "M" }]);

    expect(before).not.toBe(after);
  });

  it("treats a broken symlink as a present symlink, not as a deleted path", () => {
    symlinkSync("nowhere-at-all.txt", join(dir, "broken.txt"));
    const entry = readEntryContent(dir, "broken.txt");
    expect(entry.kind).toBe("symlink");
    expect(entry.contentHash).not.toBeNull();

    // A genuinely absent path is still classified as deleted.
    expect(readEntryContent(dir, "never-existed.txt")).toEqual({ kind: "deleted", contentHash: null });
  });

  it("fails closed on a filesystem object type v1 cannot represent", () => {
    mkdirSync(join(dir, "a-directory"));
    expect(() => computeChangeSetFingerprint(dir, [{ path: "a-directory", status: "A" }])).toThrow(
      UnsupportedChangeEntryError,
    );
  });
});
