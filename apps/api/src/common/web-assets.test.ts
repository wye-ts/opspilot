import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isWebDistServable, resolveWebDistDir } from "./web-assets";

const ORIGINAL_WEB_DIST_DIR = process.env.WEB_DIST_DIR;

afterEach(() => {
  if (ORIGINAL_WEB_DIST_DIR === undefined) {
    delete process.env.WEB_DIST_DIR;
  } else {
    process.env.WEB_DIST_DIR = ORIGINAL_WEB_DIST_DIR;
  }
});

describe("resolveWebDistDir", () => {
  it("defaults to two levels up from the given base directory, under apps/web/dist", () => {
    delete process.env.WEB_DIST_DIR;
    const baseDir = path.resolve("/app/apps/api/dist");

    expect(resolveWebDistDir(baseDir)).toBe(path.resolve("/app/apps/web/dist"));
  });

  it("prefers WEB_DIST_DIR over the computed default", () => {
    process.env.WEB_DIST_DIR = "/custom/web/dist";

    expect(resolveWebDistDir("/app/apps/api/dist")).toBe("/custom/web/dist");
  });
});

describe("isWebDistServable", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns true when index.html exists in the directory", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opspilot-web-dist-"));
    writeFileSync(path.join(tempDir, "index.html"), "<html></html>");

    expect(isWebDistServable(tempDir)).toBe(true);
  });

  it("returns false when index.html is missing", () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "opspilot-web-dist-"));

    expect(isWebDistServable(tempDir)).toBe(false);
  });

  it("returns false when the directory itself does not exist", () => {
    expect(isWebDistServable("/nonexistent/opspilot-web-dist-fixture")).toBe(false);
  });
});
