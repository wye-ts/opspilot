import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import * as providerClaude from "./index";

// CommonJS output forbids `import.meta` (TS1470); see module-boundary.test.ts.
const SRC_DIR = join(process.cwd(), "src");

/**
 * Guards the package's public surface from the two failure modes that are
 * invisible in review and only surface at a consumer:
 *
 *  1. A value re-exported with `export { X } from "./y"`. Under CommonJS that
 *     compiles to a live-binding getter, and Vite-node's CJS interop does not
 *     forward getters through a default import — so the ESM worker would read
 *     `undefined` for a property `Object.keys()` still lists. This is the exact
 *     bug documented in packages/agent-runtime/src/index.ts, and the reason
 *     index.ts uses the plain-`const` form throughout.
 *
 *  2. An export silently dropped during a move or refactor. The list below is
 *     the contract; anything removed from index.ts fails here rather than at
 *     whichever consumer happens to import it next.
 *
 * The complementary runtime proof — that the *built* CommonJS output survives
 * the ESM worker's default import under the real `tsx` runtime, not just under
 * Vitest — lives in apps/worker/src/smoke/cjs-interop-smoke.ts, because only
 * the worker consumes this package that way.
 */
// Comments are stripped first. index.ts's own doc comment quotes the forbidden
// form verbatim in order to explain it, and so does this file — prose naming a
// pattern must never be mistaken for the pattern itself.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const INDEX_SOURCE = stripComments(
  readFileSync(join(SRC_DIR, "index.ts"), "utf8"),
);

// Matches a VALUE re-export (`export { A, B } from "./y"`). `export type { … }
// from "./y"` does not match — the `type` keyword sits between `export` and the
// brace — and neither does `export const { A } = x`, which is a destructuring
// assignment with no `from` clause.
const VALUE_RE_EXPORT = /export\s*\{[^}]*\}\s*from\s*["']/g;

const EXPECTED_FUNCTIONS = [
  "isSupportedClaudeModel",
  "requireSupportedClaudeModel",
  "parseProviderConfig",
  "estimateClaudeCostUsd",
  "createLlmProviderFactory",
  "createAnthropicClient",
] as const;

// Classes are `typeof === "function"` too, but they are listed separately
// because a consumer uses them with `new` and `instanceof`, and a plain
// function silently substituted for one would pass the looser check.
const EXPECTED_CLASSES = [
  "ClaudeLlmProvider",
  "UnsupportedClaudeModelError",
  "ProviderConfigError",
  "LiveProviderUnavailableError",
] as const;

const EXPECTED_CONSTANTS = {
  SUPPORTED_CLAUDE_MODEL: "string",
  UNSUPPORTED_CLAUDE_MODEL_MESSAGE: "string",
  DEFAULT_MAX_RETRIES: "number",
  DEFAULT_TIMEOUT_MS: "number",
  CLAUDE_PRICING_TABLE: "object",
} as const;

describe("provider-claude export surface", () => {
  it("re-exports no runtime value through a getter-backed named re-export", () => {
    const offenders = [...INDEX_SOURCE.matchAll(VALUE_RE_EXPORT)].map((match) => match[0]);

    expect(offenders).toEqual([]);
  });

  it("exposes every documented function", () => {
    for (const name of EXPECTED_FUNCTIONS) {
      expect(typeof providerClaude[name], `${name} should be a function`).toBe("function");
    }
  });

  it("exposes every documented class as a constructor", () => {
    for (const name of EXPECTED_CLASSES) {
      const exported = providerClaude[name];
      expect(typeof exported, `${name} should be a constructor`).toBe("function");
      expect(exported.prototype, `${name} should have a prototype`).toBeDefined();
    }
  });

  it("exposes every documented constant with its expected type", () => {
    for (const [name, expectedType] of Object.entries(EXPECTED_CONSTANTS)) {
      expect(typeof providerClaude[name as keyof typeof EXPECTED_CONSTANTS], name).toBe(
        expectedType,
      );
    }
  });

  it("pins the supported model to the one validated value", () => {
    // Not a tautology against claude-model.ts: this asserts the *package
    // surface* still hands consumers the model the request policy was
    // validated for, whatever the module internals are refactored into.
    expect(providerClaude.SUPPORTED_CLAUDE_MODEL).toBe("claude-sonnet-5");
  });

  it("has no undefined value on the namespace object", () => {
    // The getter-interop bug's actual signature: the key is listed but reads
    // back undefined. Nothing on this surface is legitimately undefined.
    const undefinedKeys = Object.keys(providerClaude).filter(
      (key) => providerClaude[key as keyof typeof providerClaude] === undefined,
    );

    expect(undefinedKeys).toEqual([]);
  });
});
