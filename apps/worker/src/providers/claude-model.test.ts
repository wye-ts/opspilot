import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SUPPORTED_CLAUDE_MODEL,
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE,
  UnsupportedClaudeModelError,
  isSupportedClaudeModel,
  requireSupportedClaudeModel,
} from "./claude-model";

const DEMO_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "demo");
const AGENT_RUNTIME_SRC = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "agent-runtime",
  "src",
);

// Comments are stripped before every source scan below. Prose that *names* a
// forbidden pattern — including the comments this change added explaining why
// the pattern is forbidden — must not be mistaken for the pattern itself.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

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

describe("historical spike runners enforce the same model policy", () => {
  const spikeFiles = ["run-claude-agent-spike.ts", "run-rag-live-spike.ts"] as const;

  it("finds both spike entry points", () => {
    for (const file of spikeFiles) {
      expect(() => readFileSync(join(DEMO_DIR, file), "utf8")).not.toThrow();
    }
  });

  it.each(spikeFiles)("%s validates the model through the shared validator", (file) => {
    const source = readFileSync(join(DEMO_DIR, file), "utf8");

    expect(source).toContain("requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL)");
  });

  it.each(spikeFiles)("%s has no unchecked ANTHROPIC_MODEL path", (file) => {
    const source = stripComments(readFileSync(join(DEMO_DIR, file), "utf8"));

    // The two ways an unvalidated model previously reached the adapter.
    expect(source).not.toContain('requireEnv("ANTHROPIC_MODEL")');
    expect(source).not.toMatch(/model:\s*process\.env\.ANTHROPIC_MODEL/);
  });

  it.each(spikeFiles)("%s validates before constructing the Anthropic client", (file) => {
    const source = readFileSync(join(DEMO_DIR, file), "utf8");

    const validationAt = source.indexOf("requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL)");
    const clientAt = source.indexOf("new Anthropic(");

    expect(validationAt).toBeGreaterThan(-1);
    expect(clientAt).toBeGreaterThan(-1);
    // Ordering matters: an unsupported model must never get as far as a
    // constructed, network-capable client.
    expect(validationAt).toBeLessThan(clientAt);
  });
});
