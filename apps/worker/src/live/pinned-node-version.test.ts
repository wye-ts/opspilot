import { describe, expect, it } from "vitest";

import {
  NodeVersionGateError,
  assertPinnedNodeVersion,
  parseNvmrcVersion,
  parseRunningVersion,
} from "./pinned-node-version";

const NVMRC = () => "22.21.0\n";

describe("parseNvmrcVersion", () => {
  it("reads a bare pinned version", () => {
    expect(parseNvmrcVersion("22.21.0")).toEqual({ components: [22, 21, 0], version: "22.21.0" });
  });

  it("tolerates the trailing newline nvm writes", () => {
    expect(parseNvmrcVersion("22.21.0\n").version).toBe("22.21.0");
  });

  it("tolerates a v prefix", () => {
    expect(parseNvmrcVersion("v22.21.0\n").version).toBe("22.21.0");
  });

  it("accepts a coarser pin and keeps only the components it declares", () => {
    expect(parseNvmrcVersion("22\n")).toEqual({ components: [22], version: "22" });
  });

  // An alias is a legitimate .nvmrc value that this gate genuinely cannot
  // resolve — so it must fail closed rather than be normalized into a number.
  it.each(["lts/*", "node", "", "   ", "not-a-version"])(
    "refuses a shape it cannot resolve: %j",
    (contents) => {
      expect(() => parseNvmrcVersion(contents)).toThrow(NodeVersionGateError);
    },
  );
});

describe("parseRunningVersion", () => {
  it("reads components from process.versions.node's shape", () => {
    expect(parseRunningVersion("22.21.0")).toEqual([22, 21, 0]);
    expect(parseRunningVersion("26.7.0")).toEqual([26, 7, 0]);
  });

  it("throws on an unreadable version", () => {
    expect(() => parseRunningVersion("unknown")).toThrow(NodeVersionGateError);
  });
});

describe("assertPinnedNodeVersion", () => {
  it("passes on the exact pinned version and reports what it matched", () => {
    const result = assertPinnedNodeVersion("test-script", {
      readNvmrc: NVMRC,
      runningVersion: "22.21.0",
    });

    expect(result).toEqual({ expectedVersion: "22.21.0", runningVersion: "22.21.0" });
  });

  // THE REGRESSION THIS GUARD'S FIRST DRAFT SHIPPED. It compared the major
  // version only, on the reasoning that "a patch difference cannot change the
  // bundled undici" — and a test asserted 22.9.0 PASSES, mislabelling a minor
  // difference as a patch one. Node 22.21.0 bundles undici 6.22.0 while later
  // 22.x releases ship 6.24.1/6.27.0/6.28.0, so the undici version — which
  // decides the transport this guard protects — moves across minor releases.
  // A near-miss must be refused, not waved through as "close enough".
  it.each(["22.9.0", "22.20.0", "22.21.1", "22.22.0", "24.18.0", "26.7.0"])(
    "refuses a version that is not the pinned one: %s",
    (runningVersion) => {
      expect(() =>
        assertPinnedNodeVersion("test-script", { readNvmrc: NVMRC, runningVersion }),
      ).toThrow(NodeVersionGateError);
    },
  );

  it("refuses a mismatch and names both versions plus the remedy", () => {
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

  // A coarser pin stays meaningful rather than unsatisfiable: only the
  // components .nvmrc declares are compared.
  it("honours a major-only pin by comparing only the declared component", () => {
    const coarse = () => "22\n";
    expect(() =>
      assertPinnedNodeVersion("test-script", { readNvmrc: coarse, runningVersion: "22.9.0" }),
    ).not.toThrow();
    expect(() =>
      assertPinnedNodeVersion("test-script", { readNvmrc: coarse, runningVersion: "26.7.0" }),
    ).toThrow(NodeVersionGateError);
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

  // The guard reads the pin at runtime rather than hardcoding it, so this
  // tracks .nvmrc rather than a literal copied beside it.
  it("reads the REAL .nvmrc by default and agrees with the repository pin", () => {
    expect(() =>
      assertPinnedNodeVersion("test-script", { runningVersion: "22.21.0" }),
    ).not.toThrow();

    expect(() =>
      assertPinnedNodeVersion("test-script", { runningVersion: "26.7.0" }),
    ).toThrow(NodeVersionGateError);
  });
});
