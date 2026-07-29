import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Guards the one property that makes the planned PR 6B move of this directory
 * into `packages/provider-claude` a mechanical `git mv` rather than a rewrite:
 * nothing in here may reach back into the rest of apps/worker.
 *
 * Without this test the coupling would reappear silently — a single
 * `import { x } from "../evaluation/..."` is easy to add and invisible in
 * review, and would only surface as a broken build months later, inside the
 * PR that can least afford the surprise.
 */
const PROVIDERS_DIR = dirname(fileURLToPath(import.meta.url));

const ALLOWED_BARE_SPECIFIERS = new Set(["@anthropic-ai/sdk", "zod", "vitest"]);

const ALLOWED_NODE_BUILTINS = new Set(["node:util", "node:fs", "node:path", "node:url"]);

// Matches `from "..."` in both static imports and `export ... from` clauses.
const FROM_SPECIFIER = /\bfrom\s+["']([^"']+)["']/g;

function sourceFiles(): readonly string[] {
  return readdirSync(PROVIDERS_DIR)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

// Comments are stripped first so prose that *names* a forbidden specifier —
// including this file's own doc comment, which cites one as an example — is
// never mistaken for an actual import.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function importSpecifiers(fileName: string): readonly string[] {
  const source = stripComments(readFileSync(join(PROVIDERS_DIR, fileName), "utf8"));
  return [...source.matchAll(FROM_SPECIFIER)].map((match) => match[1] as string);
}

describe("provider module boundary", () => {
  it("finds the provider sources it is meant to police", () => {
    // A path or glob mistake would make every assertion below vacuously pass.
    const files = sourceFiles();

    expect(files).toContain("claude-llm-provider.ts");
    expect(files).toContain("claude-message-mapping.ts");
    expect(files).toContain("claude-response-normalization.ts");
    expect(files).toContain("claude-tool-schemas.ts");
    expect(files.length).toBeGreaterThanOrEqual(8);
  });

  it("imports nothing from outside this directory except allowed packages", () => {
    const violations: string[] = [];

    for (const fileName of sourceFiles()) {
      for (const specifier of importSpecifiers(fileName)) {
        const isSibling = specifier.startsWith("./");
        const isWorkspacePackage = specifier.startsWith("@opspilot/");
        const isAllowedBare = ALLOWED_BARE_SPECIFIERS.has(specifier);
        const isAllowedBuiltin = ALLOWED_NODE_BUILTINS.has(specifier);

        if (!isSibling && !isWorkspacePackage && !isAllowedBare && !isAllowedBuiltin) {
          violations.push(`${fileName} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it("never reaches up into apps/worker with a parent-relative import", () => {
    const violations: string[] = [];

    for (const fileName of sourceFiles()) {
      for (const specifier of importSpecifiers(fileName)) {
        if (specifier.startsWith("../")) {
          violations.push(`${fileName} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
