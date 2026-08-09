import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTaskDeclaration, TaskDeclarationError } from "./task-declaration";

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
