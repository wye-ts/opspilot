import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guards the properties that keep `packages/provider-claude` a self-contained,
 * relocatable vendor adapter. This test is what made the PR 6B1 move out of
 * `apps/worker/src/providers/` a mechanical `git mv` rather than a rewrite,
 * and it now keeps the package from re-acquiring couplings after the move.
 *
 * Three separate guarantees:
 *
 *  1. Nothing here imports from outside the package except the allowed
 *     workspace packages and three bare specifiers.
 *  2. Nothing here imports `@opspilot/database`. That is what keeps Prisma —
 *     and the whole persistence layer — out of the provider path, so the
 *     package stays usable from any caller and the API image does not pull a
 *     second copy of the database client through it.
 *  3. Nothing here imports the package by its own name, which would create a
 *     resolution cycle through `dist/` that only fails once published.
 *
 * Without these the coupling would reappear silently — a single
 * `import { x } from "../evaluation/..."` is easy to add and invisible in
 * review, and would only surface as a broken build months later, inside the
 * PR that can least afford the surprise.
 */
// This package compiles to CommonJS, where `import.meta` is a compile error
// (TS1470) and vite-node does not reliably provide `__dirname`. The package
// root is the working directory under both `pnpm --filter ... run test` and the
// recursive root `pnpm test`, and the "finds the provider sources" test below
// fails loudly if this path is ever wrong.
const PROVIDERS_DIR = join(process.cwd(), "src");

const FORBIDDEN_WORKSPACE_PACKAGES = new Set(["@opspilot/database", "@opspilot/provider-claude"]);

// Every .ts file the package ships or tests, as of PR 6B2 — which added
// run-provider-usage-collector.ts and its test to PR 6B1's 18. A move that drops
// a file would otherwise leave the assertions below passing over a smaller set.
const EXPECTED_SOURCE_FILE_COUNT = 20;

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
    // An exact count, not a floor: a file silently lost during a move is
    // precisely the failure a floor would let through.
    expect(files).toHaveLength(EXPECTED_SOURCE_FILE_COUNT);
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

  it("never reaches outside the package with a parent-relative import", () => {
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

  // Keeps Prisma and the persistence layer out of the provider path, and
  // keeps the package from importing itself by name.
  it("imports neither @opspilot/database nor its own package name", () => {
    const violations: string[] = [];

    for (const fileName of sourceFiles()) {
      for (const specifier of importSpecifiers(fileName)) {
        if (FORBIDDEN_WORKSPACE_PACKAGES.has(specifier)) {
          violations.push(`${fileName} -> ${specifier}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  // The mirror image of the rule index.ts documents, and the one that actually
  // broke during the PR 6B1 move.
  //
  // apps/worker is ESM, so it must consume CommonJS workspace packages through
  // a DEFAULT import. This package is the opposite: it compiles to CommonJS,
  // and every workspace package it imports also sets `exports.__esModule =
  // true`. Under that flag TypeScript's `__importDefault` helper passes the
  // module through unwrapped, so `mod.default` is `undefined` — a default
  // import here yields undefined at runtime while type-checking perfectly, and
  // while still passing this package's own Vitest run, because vite-node's
  // transform applies ESM semantics to the .ts source rather than the built
  // .js. The failure surfaces only once a consumer loads `dist/`.
  //
  // Named imports are correct here, exactly as in apps/api (also CommonJS).
  it("never default-imports a workspace package", () => {
    const DEFAULT_WORKSPACE_IMPORT = /import\s+\w+\s+from\s+["']@opspilot\/[^"']+["']/g;
    const violations: string[] = [];

    for (const fileName of sourceFiles()) {
      const source = stripComments(readFileSync(join(PROVIDERS_DIR, fileName), "utf8"));
      for (const match of source.matchAll(DEFAULT_WORKSPACE_IMPORT)) {
        violations.push(`${fileName} -> ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });

  // The manifest is the other half of the same guarantee: an allowed import
  // that is not declared as a dependency resolves only by accident of
  // hoisting, and a forbidden one declared here would be a standing invitation.
  it("declares no forbidden dependency in package.json", () => {
    const manifest = JSON.parse(
      readFileSync(join(PROVIDERS_DIR, "..", "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const declared = Object.keys(manifest.dependencies ?? {});

    expect(declared).not.toContain("@opspilot/database");
    expect(declared).toContain("@anthropic-ai/sdk");
    expect(declared).toContain("@opspilot/agent-runtime");
  });
});
