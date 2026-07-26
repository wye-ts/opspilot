// Production bundle guard CLI (see docs/08-cicd-deployment.md).
//
// Scans the built web bundle for concrete deployment leaks and exits non-zero
// if any are found. Run after `pnpm --filter @opspilot/web run build`:
//
//   pnpm --filter @opspilot/web run check:bundle
//   pnpm --filter @opspilot/web run check:bundle -- path/to/dist
//
// All detection logic lives in the pure, unit-tested module this imports; this
// file only walks the directory and formats output.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  explainRule,
  findBundleViolations,
  type BundleViolation,
} from "../src/build-guard/forbidden-patterns";

const SCANNED_EXTENSIONS = new Set([".js", ".css", ".html"]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// `pnpm run check:bundle -- <dir>` passes the separator itself through to argv,
// so drop it before reading the directory argument.
const [distArgument] = process.argv.slice(2).filter((argument) => argument !== "--");
const distDir = distArgument === undefined ? join(packageRoot, "dist") : resolve(distArgument);

function collectFiles(directory: string): string[] {
  const collected: string[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      collected.push(...collectFiles(entryPath));
      continue;
    }

    if (entry.isFile() && SCANNED_EXTENSIONS.has(extname(entry.name))) {
      collected.push(entryPath);
    }
  }

  // Sorted so the report is byte-identical across machines and CI runs.
  return collected.sort();
}

function reportViolations(violations: readonly BundleViolation[]): void {
  for (const violation of violations) {
    console.error(`  [${violation.rule}] ${violation.file}`);
    console.error(`    ${explainRule(violation.rule)}`);
    console.error(`    ${violation.excerpt}`);
    console.error("");
  }
}

let files: string[];
try {
  files = collectFiles(distDir);
} catch {
  // A guard that silently passes because the bundle is missing is worse than
  // no guard at all, so an unreadable dist is a hard failure.
  console.error(`Bundle guard: cannot read ${distDir}.`);
  console.error("Run `pnpm --filter @opspilot/web run build` first.");
  process.exit(1);
}

if (files.length === 0) {
  console.error(`Bundle guard: no .js, .css, or .html files found in ${distDir}.`);
  console.error("Run `pnpm --filter @opspilot/web run build` first.");
  process.exit(1);
}

const violations = files.flatMap((file) =>
  findBundleViolations(relative(distDir, file), readFileSync(file, "utf8")),
);

// Package-relative while the bundle is where it normally lives; absolute once an
// explicit directory outside the package is passed, since a "../../.." chain is
// harder to read than the path itself.
const scannedLabel = relative(packageRoot, distDir);
const displayedDir = scannedLabel.startsWith("..") ? distDir : scannedLabel;

console.log(`Bundle guard: scanned ${files.length} file(s) in ${displayedDir}`);

if (violations.length > 0) {
  console.error(`FAIL: ${violations.length} violation(s)\n`);
  reportViolations(violations);
  process.exit(1);
}

console.log("OK: no forbidden patterns found.");
