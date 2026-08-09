import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeFileAtomic, writeJsonAtomic } from "./atomic-write";

describe("atomic-write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the target file with the given content", () => {
    const target = join(dir, "out.txt");
    writeFileAtomic(target, "hello");
    expect(readFileSync(target, "utf8")).toBe("hello");
  });

  it("creates intermediate directories", () => {
    const target = join(dir, "nested", "deeper", "out.txt");
    writeFileAtomic(target, "hi");
    expect(readFileSync(target, "utf8")).toBe("hi");
  });

  it("leaves no temp file behind after a successful write", () => {
    const target = join(dir, "out.txt");
    writeFileAtomic(target, "hello");
    const entries = readdirSync(dir);
    expect(entries).toEqual(["out.txt"]);
  });

  it("overwrites an existing file atomically (no truncated intermediate state observable)", () => {
    const target = join(dir, "out.txt");
    writeFileAtomic(target, "first");
    writeFileAtomic(target, "second-longer-content");
    expect(readFileSync(target, "utf8")).toBe("second-longer-content");
    expect(readdirSync(dir)).toEqual(["out.txt"]);
  });

  it("writeJsonAtomic serializes and round-trips JSON", () => {
    const target = join(dir, "out.json");
    writeJsonAtomic(target, { a: 1, b: [1, 2, 3] });
    const parsed = JSON.parse(readFileSync(target, "utf8"));
    expect(parsed).toEqual({ a: 1, b: [1, 2, 3] });
  });

  it("succeeds when the target directory already exists", () => {
    const target = join(dir, "sub", "out.txt");
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileAtomic(target, "ok");
    expect(existsSync(target)).toBe(true);
  });
});
