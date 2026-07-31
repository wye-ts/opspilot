import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SUPPORTED_CLAUDE_MODEL } from "@opspilot/provider-claude";

/**
 * What the SHIPPED deployment blueprint declares — asserted as a contract, not
 * read as documentation.
 *
 * render.yaml is the one file in this repository that describes a public,
 * money-spending deployment, and it is not covered by typecheck, the bundle
 * guard, or any other test. Two classes of mistake are worth failing a build
 * over: a secret acquiring a literal value, and the rollout inputs disagreeing
 * with what the configuration parser actually requires.
 *
 * The second is not hypothetical. Before this test, the blueprint declared
 * ANTHROPIC_API_KEY but NOT ANTHROPIC_MODEL, while parseProviderConfig rejects a
 * partial Anthropic configuration in both directions. An operator following the
 * documented rollout — "set the key" — would have taken the service DOWN on the
 * next restart, with the kill switch still off and no live feature gained.
 *
 * Parsed with targeted text matching rather than a YAML library: the properties
 * asserted here are lexical (a key is declared, a key has no value, a value is
 * exactly "0"), no YAML dependency exists in this workspace, and adding one to
 * assert five lines would be the larger change.
 */
/**
 * Walks up from the working directory to the repository root.
 *
 * Neither `import.meta.url` nor a fixed relative path works here: this package
 * builds to CommonJS (so `import.meta` is a compile error), and the test may be
 * run from the repo root or from `apps/api` depending on the command. Searching
 * upward for the file is independent of both.
 */
function findBlueprint(): string {
  let directory = process.cwd();
  for (;;) {
    const candidate = resolve(directory, "render.yaml");
    if (existsSync(candidate)) return candidate;

    const parent = dirname(directory);
    if (parent === directory) throw new Error("render.yaml not found above the working directory");
    directory = parent;
  }
}

const BLUEPRINT = readFileSync(findBlueprint(), "utf8");

/**
 * The `- key: NAME` block for one variable: everything from its declaration up
 * to the next `- key:` or end of file.
 *
 * Split rather than matched with a single regex. An earlier version used a
 * `(?=^\s*- key: |\Z)` lookahead, but `\Z` is not a JavaScript regex escape — it
 * matches a literal "Z" — so the LAST declared variable in the file had no
 * terminator and silently returned nothing. Splitting has no such edge.
 */
function blockFor(name: string): string | null {
  const blocks = BLUEPRINT.split(/^\s*- key: /m).slice(1);
  const block = blocks.find((candidate) => candidate.split("\n", 1)[0]?.trim() === name);
  return block ?? null;
}

const DASHBOARD_PROVIDED = ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "LIVE_RUN_ACCESS_TOKEN"];

describe("render.yaml — shipped deployment posture", () => {
  describe("rollout inputs are declared but never valued", () => {
    it.each(DASHBOARD_PROVIDED)("declares %s", (name) => {
      expect(blockFor(name)).not.toBeNull();
    });

    it.each(DASHBOARD_PROVIDED)("gives %s no value, only sync: false", (name) => {
      const block = blockFor(name) ?? "";

      expect(block).toMatch(/sync:\s*false/);
      // The decisive assertion: a `value:` line here would be a committed secret.
      expect(block).not.toMatch(/^\s*value:/m);
    });

    it("contains no credential-shaped or token-shaped literal anywhere", () => {
      expect(BLUEPRINT).not.toMatch(/sk-ant-/);
      expect(BLUEPRINT).not.toMatch(/value:\s*["']?sk-/);
      // A real shared demo token would be a long opaque literal on a value line.
      expect(BLUEPRINT).not.toMatch(/LIVE_RUN_ACCESS_TOKEN[\s\S]{0,80}?^\s*value:/m);
    });
  });

  /**
   * The key and the model are a PAIR. parseProviderConfig throws for
   * key-without-model and for model-without-key, so shipping a fixed
   * ANTHROPIC_MODEL value while the key is absent would break the very
   * deployment this blueprint describes — which is why the model is declared
   * `sync: false` rather than carrying "claude-sonnet-5" inline.
   */
  it("declares the model as a dashboard input rather than a shipped value", () => {
    const block = blockFor("ANTHROPIC_MODEL") ?? "";

    expect(block).toMatch(/sync:\s*false/);
    expect(block).not.toMatch(new RegExp(`value:\\s*["']?${SUPPORTED_CLAUDE_MODEL}`));
  });

  it("documents the supported model value for the operator to set", () => {
    // Set together with the key at rollout time. Documented in a comment so the
    // operator does not have to find the one-member allowlist in the source.
    expect(BLUEPRINT).toContain(SUPPORTED_CLAUDE_MODEL);
  });

  it("pins ANTHROPIC_MAX_RETRIES to 0", () => {
    // Not a secret, so it ships with a value. The API refuses to start with any
    // other value once LIVE is servable — see run-execution-config.ts.
    expect(blockFor("ANTHROPIC_MAX_RETRIES")).toMatch(/value:\s*"0"/);
  });

  describe("the public deployment stays deterministic", () => {
    it("keeps AGENT_RUN_PROVIDER_MODE=FAKE", () => {
      expect(blockFor("AGENT_RUN_PROVIDER_MODE")).toMatch(/value:\s*FAKE/);
    });

    it("keeps the LIVE kill switch false", () => {
      expect(blockFor("LIVE_AGENT_RUNS_ENABLED")).toMatch(/value:\s*"false"/);
    });

    it("keeps LIVE concurrency at exactly 1 where it is declared", () => {
      const block = blockFor("LIVE_RUN_MAX_CONCURRENCY");
      // Optional in the blueprint (the parser defaults to 1), but if present it
      // must be the only accepted value.
      if (block !== null) expect(block).toMatch(/value:\s*"1"/);
    });
  });
});
