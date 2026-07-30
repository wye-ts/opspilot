import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The two historical live spike runners have their own env contract — they do
 * not go through parseProviderConfig — so the one-model policy has to be
 * enforced at their own call sites. This suite is what keeps that true.
 *
 * It lived in the provider package's claude-model.test.ts until PR 6B1 moved
 * that package to packages/provider-claude. It polices files under
 * apps/worker, so it belongs here: the provider package must not reach into an
 * application, which is the same boundary module-boundary.test.ts enforces for
 * imports. The assertions are unchanged from the pre-move version.
 */
const DEMO_DIR = dirname(fileURLToPath(import.meta.url));

const SPIKE_FILES = ["run-claude-agent-spike.ts", "run-rag-live-spike.ts"] as const;

// Comments are stripped before the negative scans below, so prose that *names*
// a forbidden pattern — including the comments explaining why it is forbidden
// — is never mistaken for the pattern itself.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("historical spike runners enforce the same model policy", () => {
  it("finds both spike entry points", () => {
    // Guards against a path mistake making every assertion below vacuous —
    // exactly the failure the PR 6B1 move would otherwise have introduced
    // silently.
    for (const file of SPIKE_FILES) {
      expect(() => readFileSync(join(DEMO_DIR, file), "utf8")).not.toThrow();
    }
  });

  it.each(SPIKE_FILES)("%s validates the model through the shared validator", (file) => {
    const source = readFileSync(join(DEMO_DIR, file), "utf8");

    expect(source).toContain("requireSupportedClaudeModel(process.env.ANTHROPIC_MODEL)");
  });

  it.each(SPIKE_FILES)("%s has no unchecked ANTHROPIC_MODEL path", (file) => {
    const source = stripComments(readFileSync(join(DEMO_DIR, file), "utf8"));

    // The two ways an unvalidated model previously reached the adapter.
    expect(source).not.toContain('requireEnv("ANTHROPIC_MODEL")');
    expect(source).not.toMatch(/model:\s*process\.env\.ANTHROPIC_MODEL/);
  });

  it.each(SPIKE_FILES)("%s validates before constructing the Anthropic client", (file) => {
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
