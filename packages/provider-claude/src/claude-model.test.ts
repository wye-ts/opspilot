import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SUPPORTED_CLAUDE_MODEL,
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE,
  UnsupportedClaudeModelError,
  isSupportedClaudeModel,
  requireSupportedClaudeModel,
} from "./claude-model";

// This package compiles to CommonJS, where `import.meta` is a compile error
// (TS1470) and vite-node does not reliably provide `__dirname`. The package
// root is the working directory under both `pnpm --filter ... run test` and the
// recursive root `pnpm test`, and the "finds the sources" test below fails
// loudly if this path is ever wrong.
const SRC_DIR = join(process.cwd(), "src");

// packages/provider-claude/src → three levels up is the repository root.
// (Before PR 6B1 this file lived at apps/worker/src/providers and needed four.
// The depth changed with the move, which is exactly why the sibling "finds the
// sources it is meant to police" test exists: a stale path would otherwise
// make the assertion below vacuously pass.)
const AGENT_RUNTIME_SRC = join(SRC_DIR, "..", "..", "..", "packages", "agent-runtime", "src");

function readAllSources(dir: string): { readonly file: string; readonly source: string }[] {
  const out: { file: string; source: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readAllSources(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push({ file: full, source: readFileSync(full, "utf8") });
    }
  }
  return out;
}

describe("supported Claude model", () => {
  it("names exactly one model", () => {
    expect(SUPPORTED_CLAUDE_MODEL).toBe("claude-sonnet-5");
  });

  it("accepts the supported model", () => {
    expect(isSupportedClaudeModel("claude-sonnet-5")).toBe(true);
    expect(requireSupportedClaudeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(requireSupportedClaudeModel("  claude-sonnet-5  ")).toBe("claude-sonnet-5");
  });

  it.each([
    "claude-opus-5",
    "claude-haiku-4-5",
    "claude-fable-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5-20260101",
    "sonnet-5",
    "",
    undefined,
  ])("rejects %o", (model) => {
    expect(() => requireSupportedClaudeModel(model)).toThrow(UnsupportedClaudeModelError);
  });

  it("never echoes the rejected value back in the error", () => {
    // The rejected string is whatever a caller happened to export; it is not
    // repeated, so a mis-pasted credential in that variable cannot surface here.
    try {
      requireSupportedClaudeModel("some-unexpected-value-8f21");
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as Error).message).toBe(UNSUPPORTED_CLAUDE_MODEL_MESSAGE);
      expect((error as Error).message).not.toContain("some-unexpected-value-8f21");
    }
  });
});

describe("vendor knowledge stays out of the neutral runtime", () => {
  it("finds the agent-runtime sources it is meant to police", () => {
    // Guards against a path mistake making the assertion below vacuous.
    const sources = readAllSources(AGENT_RUNTIME_SRC);

    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some((s) => s.file.endsWith("llm-provider-factory.ts"))).toBe(true);
  });

  it("declares no Claude model identifier in packages/agent-runtime", () => {
    // packages/agent-runtime ships inside the API production image and must stay
    // vendor-agnostic: it parameterizes the live model type rather than naming
    // one. Comments are stripped so prose referencing a model by name (e.g. a
    // pointer to this module) is not mistaken for a declaration.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    const violations = readAllSources(AGENT_RUNTIME_SRC)
      .filter(({ file }) => !file.endsWith(".test.ts"))
      .filter(({ source }) => /claude-[a-z0-9-]*\d/.test(stripComments(source)))
      .map(({ file }) => file);

    expect(violations).toEqual([]);
  });
});

// The companion "historical spike runners enforce the same model policy" suite
// moved to apps/worker/src/demo/spike-model-policy.test.ts in PR 6B1. It
// polices files under apps/worker, and this package must not reach into an
// application — the same boundary module-boundary.test.ts enforces for
// imports. The invariant it guards is unchanged.
