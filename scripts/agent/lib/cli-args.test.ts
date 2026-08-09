import { describe, expect, it } from "vitest";

import { assertKnownFlags, CliArgsError, getBooleanFlag, getStringFlag, parseArgsList, parseCommonArgs } from "./cli-args";

describe("parseArgsList", () => {
  it("parses value flags", () => {
    const raw = parseArgsList(["--task", "path/to/task.json", "--baseline", "HEAD~1"]);
    expect(raw.get("task")).toBe("path/to/task.json");
    expect(raw.get("baseline")).toBe("HEAD~1");
  });

  it("parses boolean flags with no following value consumed", () => {
    const raw = parseArgsList(["--print-json", "--focused"]);
    expect(raw.get("print-json")).toBe(true);
    expect(raw.get("focused")).toBe(true);
  });

  it("accumulates a repeated non-boolean flag as comma-joined", () => {
    const raw = parseArgsList(["--scope", "apps/web/**", "--scope", "docs/16-*.md"]);
    expect(raw.get("scope")).toBe("apps/web/**,docs/16-*.md");
  });

  it("throws on a value flag missing its value", () => {
    expect(() => parseArgsList(["--task"])).toThrow(CliArgsError);
  });

  it("throws on a bare non-flag argument", () => {
    expect(() => parseArgsList(["bogus"])).toThrow(CliArgsError);
  });
});

describe("parseCommonArgs", () => {
  it("extracts task/baseline/agent-dir/print-json", () => {
    const raw = parseArgsList(["--task", "t.json", "--baseline", "abc", "--agent-dir", "/tmp/x", "--print-json"]);
    const common = parseCommonArgs(raw);
    expect(common).toEqual({ task: "t.json", baseline: "abc", agentDir: "/tmp/x", printJson: true });
  });

  it("defaults to undefined/false when nothing is passed", () => {
    const common = parseCommonArgs(new Map());
    expect(common).toEqual({ task: undefined, baseline: undefined, agentDir: undefined, printJson: false });
  });
});

describe("getStringFlag / getBooleanFlag", () => {
  it("read through the raw map", () => {
    const raw = parseArgsList(["--out", "dir", "--render-md"]);
    expect(getStringFlag(raw, "out")).toBe("dir");
    expect(getBooleanFlag(raw, "render-md")).toBe(true);
    expect(getBooleanFlag(raw, "missing")).toBe(false);
  });
});

describe("assertKnownFlags", () => {
  it("accepts every common flag with no command-specific flags declared", () => {
    const raw = parseArgsList(["--task", "t.json", "--baseline", "HEAD~1", "--agent-dir", "/tmp/x", "--print-json"]);
    expect(() => assertKnownFlags(raw, [])).not.toThrow();
  });

  it("accepts a declared command-specific flag alongside common flags", () => {
    const raw = parseArgsList(["--out", "dir", "--task", "t.json"]);
    expect(() => assertKnownFlags(raw, ["out", "render-md"])).not.toThrow();
  });

  it("rejects an unknown flag not in COMMON_FLAGS or the declared command flags", () => {
    const raw = parseArgsList(["--out", "dir", "--review-dri", "custom"]);
    expect(() => assertKnownFlags(raw, ["out", "render-md"])).toThrow(CliArgsError);
    expect(() => assertKnownFlags(raw, ["out", "render-md"])).toThrow(/--review-dri/);
  });

  it("rejects a flag that is valid on a different command but not declared here", () => {
    const raw = parseArgsList(["--scope", "apps/web/**"]);
    expect(() => assertKnownFlags(raw, ["out", "render-md"])).toThrow(CliArgsError);
  });
});
