import { describe, expect, it } from "vitest";

import {
  NodeVersionGateError,
  assertPinnedNodeVersion,
  parseNvmrcMajor,
  parseRunningMajor,
} from "./pinned-node-version";

const NVMRC = () => "22.21.0\n";

describe("parseNvmrcMajor", () => {
  it("reads a bare pinned version", () => {
    expect(parseNvmrcMajor("22.21.0")).toEqual({ major: 22, version: "22.21.0" });
  });

  it("tolerates the trailing newline nvm writes", () => {
    expect(parseNvmrcMajor("22.21.0\n")).toEqual({ major: 22, version: "22.21.0" });
  });

  it("tolerates a v prefix", () => {
    expect(parseNvmrcMajor("v22.21.0\n")).toEqual({ major: 22, version: "22.21.0" });
  });

  it("accepts a major-only pin", () => {
    expect(parseNvmrcMajor("22\n")).toEqual({ major: 22, version: "22" });
  });

  // An alias is a legitimate .nvmrc value that this gate genuinely cannot
  // resolve — so it must fail closed rather than be normalized into a number.
  it.each(["lts/*", "node", "", "   ", "not-a-version"])(
    "refuses a shape it cannot resolve: %j",
    (contents) => {
      expect(() => parseNvmrcMajor(contents)).toThrow(NodeVersionGateError);
    },
  );
});

describe("parseRunningMajor", () => {
  it("reads the major from process.versions.node's shape", () => {
    expect(parseRunningMajor("22.21.0")).toBe(22);
    expect(parseRunningMajor("26.7.0")).toBe(26);
  });

  it("throws on an unreadable version", () => {
    expect(() => parseRunningMajor("unknown")).toThrow(NodeVersionGateError);
  });
});

describe("assertPinnedNodeVersion", () => {
  it("passes on the pinned major and reports what it matched", () => {
    const result = assertPinnedNodeVersion("test-script", {
      readNvmrc: NVMRC,
      runningVersion: "22.21.0",
    });

    expect(result).toEqual({
      expectedMajor: 22,
      expectedVersion: "22.21.0",
      runningVersion: "22.21.0",
    });
  });

  // The gate is deliberately major-only: a patch difference cannot change the
  // bundled undici, so failing on one would make it fire for a reason it
  // cannot justify.
  it("passes on a different PATCH of the pinned major", () => {
    expect(() =>
      assertPinnedNodeVersion("test-script", { readNvmrc: NVMRC, runningVersion: "22.9.0" }),
    ).not.toThrow();
  });

  it("refuses a mismatched major and names both versions plus the remedy", () => {
    let thrown: unknown;
    try {
      assertPinnedNodeVersion("measure-completion-rate", {
        readNvmrc: NVMRC,
        runningVersion: "26.7.0",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NodeVersionGateError);
    const message = (thrown as Error).message;

    expect(message).toContain("measure-completion-rate");
    expect(message).toContain("REFUSING TO START");
    expect(message).toContain("22.21.0");
    expect(message).toContain("26.7.0");
    expect(message).toContain("nvm use");
  });

  // Fails closed, and distinguishably: an operator must be able to tell
  // "your Node is wrong" from "I could not check".
  it("fails closed when .nvmrc cannot be read, with a distinct message", () => {
    let thrown: unknown;
    try {
      assertPinnedNodeVersion("test-script", {
        readNvmrc: () => {
          throw new Error("ENOENT");
        },
        runningVersion: "22.21.0",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(NodeVersionGateError);
    const message = (thrown as Error).message;

    expect(message).toContain("Could not read .nvmrc");
    expect(message).not.toContain("REFUSING TO START");
    // The underlying filesystem error carries a path and is not part of the
    // remedy, so it must not be echoed.
    expect(message).not.toContain("ENOENT");
  });

  it("fails closed when .nvmrc holds an alias it cannot resolve", () => {
    expect(() =>
      assertPinnedNodeVersion("test-script", {
        readNvmrc: () => "lts/*\n",
        runningVersion: "22.21.0",
      }),
    ).toThrow(NodeVersionGateError);
  });

  // The guard reads the pin at runtime rather than hardcoding it, so that this
  // test tracks .nvmrc rather than a literal copied beside it.
  it("reads the REAL .nvmrc by default and agrees with the repository pin", () => {
    expect(() =>
      assertPinnedNodeVersion("test-script", { runningVersion: "22.21.0" }),
    ).not.toThrow();

    expect(() =>
      assertPinnedNodeVersion("test-script", { runningVersion: "26.7.0" }),
    ).toThrow(NodeVersionGateError);
  });
});
