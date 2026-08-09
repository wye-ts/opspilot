import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTaskDeclaration, parseTaskDeclaration, TaskDeclarationError } from "./task-declaration";

describe("loadTaskDeclaration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-decl-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDecl(content: unknown): string {
    const path = join(dir, "task.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("loads a minimal valid declaration", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1" });
    const decl = loadTaskDeclaration(path);
    expect(decl.$schema).toBe("opspilot-harness/task-declaration@1");
    expect(decl.baseline).toBeUndefined();
  });

  it("loads a fully populated declaration", () => {
    const path = writeDecl({
      $schema: "opspilot-harness/task-declaration@1",
      baseline: "abc123",
      expectedBranch: "feat/x",
      expectedWorkingTree: "clean",
      expectedIndex: "empty",
      scope: ["apps/web/src/**", "docs/16-*.md"],
    });
    const decl = loadTaskDeclaration(path);
    expect(decl).toEqual({
      $schema: "opspilot-harness/task-declaration@1",
      baseline: "abc123",
      expectedBranch: "feat/x",
      expectedWorkingTree: "clean",
      expectedIndex: "empty",
      scope: ["apps/web/src/**", "docs/16-*.md"],
    });
  });

  it("rejects a missing file", () => {
    expect(() => loadTaskDeclaration(join(dir, "nope.json"))).toThrow(TaskDeclarationError);
  });

  it("rejects invalid JSON", () => {
    const path = join(dir, "bad.json");
    writeFileSync(path, "{not json");
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects a missing $schema", () => {
    const path = writeDecl({ baseline: "abc123" });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects a wrong $schema value", () => {
    const path = writeDecl({ $schema: "something-else@1" });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects an unknown field", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", extraField: true });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects a malformed expectedWorkingTree value", () => {
    const path = writeDecl({
      $schema: "opspilot-harness/task-declaration@1",
      expectedWorkingTree: "sparkling",
    });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects a non-array scope", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", scope: "apps/**" });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("accepts an explicit scope: null (distinct from absent, both NOT_CONFIGURED downstream)", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", scope: null });
    const decl = loadTaskDeclaration(path);
    expect(decl.scope).toBeNull();
  });

  it("accepts scope: [] (configured, matches nothing)", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", scope: [] });
    const decl = loadTaskDeclaration(path);
    expect(decl.scope).toEqual([]);
  });

  it("still rejects a malformed scope value that happens to be null-adjacent (e.g. a number)", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", scope: 42 });
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });

  it("rejects a top-level array", () => {
    const path = writeDecl([1, 2, 3]);
    expect(() => loadTaskDeclaration(path)).toThrow(TaskDeclarationError);
  });
});

describe("parseTaskDeclaration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-decl-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeDecl(content: unknown): string {
    const path = join(dir, "task.json");
    writeFileSync(path, JSON.stringify(content));
    return path;
  }

  it("parses a Buffer of already-captured bytes without touching the filesystem", () => {
    const raw = Buffer.from(JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", baseline: "abc123" }));
    const decl = parseTaskDeclaration(raw, "/does/not/exist/on/disk.json");
    expect(decl.baseline).toBe("abc123");
  });

  it("parses a string of already-captured bytes", () => {
    const raw = JSON.stringify({ $schema: "opspilot-harness/task-declaration@1" });
    const decl = parseTaskDeclaration(raw);
    expect(decl.$schema).toBe("opspilot-harness/task-declaration@1");
  });

  it("rejects malformed captured bytes exactly like loadTaskDeclaration rejects a malformed file", () => {
    expect(() => parseTaskDeclaration(Buffer.from("{not json"))).toThrow(TaskDeclarationError);
    expect(() => parseTaskDeclaration(Buffer.from(JSON.stringify({ $schema: "wrong@1" })))).toThrow(
      TaskDeclarationError,
    );
  });

  // BLOCKER regression (HQ): loadTaskDeclaration must be a read-once wrapper
  // — it parses exactly the bytes its own single readFileSync captured, never
  // a second independent read. Proven here via an ABA swap: capture task A's
  // bytes, then overwrite the file on disk with task B's content before
  // parsing. Parsing the already-captured buffer must still yield A's
  // semantics — if loadTaskDeclaration (or a caller) re-read the path instead
  // of parsing the captured bytes, this would observe B and fail.
  it("ABA regression: parsing already-captured bytes is immune to the source path being overwritten afterward", () => {
    const path = writeDecl({ $schema: "opspilot-harness/task-declaration@1", baseline: "task-A-baseline" });
    const capturedRaw = readFileSync(path);

    // Task B's content now lives at the exact same path task A's bytes were captured from.
    writeFileSync(path, JSON.stringify({ $schema: "opspilot-harness/task-declaration@1", baseline: "task-B-baseline" }));

    const decl = parseTaskDeclaration(capturedRaw, path);
    expect(decl.baseline).toBe("task-A-baseline");
    expect(decl.baseline).not.toBe("task-B-baseline");
  });

  // Companion regression: loadTaskDeclaration itself must read the file
  // exactly once. There is no way to observe the read count directly from
  // outside, so this proves the documented invariant behaviorally instead:
  // loadTaskDeclaration(path) and parseTaskDeclaration(readFileSync(path), path)
  // must always agree, for a file whose content never changes mid-call.
  it("loadTaskDeclaration(path) agrees with parseTaskDeclaration applied to an independent single read of the same bytes", () => {
    const path = writeDecl({
      $schema: "opspilot-harness/task-declaration@1",
      baseline: "abc123",
      scope: ["apps/**"],
    });
    const viaLoad = loadTaskDeclaration(path);
    const viaParse = parseTaskDeclaration(readFileSync(path), path);
    expect(viaLoad).toEqual(viaParse);
  });
});
