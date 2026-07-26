// Detection rules for the production bundle guard (see docs/08-cicd-deployment.md).
//
// Pure string analysis, no I/O and no Node/DOM APIs, so every rule can be unit
// tested directly against fixture strings. Only apps/web/scripts/check-bundle.ts
// imports this module; no application source does, so it can never reach the
// browser bundle.

export interface BundleViolation {
  readonly rule: string;
  readonly file: string;
  readonly excerpt: string;
}

export interface ForbiddenPattern {
  readonly rule: string;
  readonly reason: string;
  // Deliberately non-global. A non-global RegExp ignores `lastIndex`, so these
  // shared instances are stateless and can never leak match position between
  // files or between test cases.
  readonly pattern: RegExp;
}

const EXCERPT_RADIUS = 40;

// Deliberately narrow. Banning every http(s) string would fail on the benign
// URLs a React production build already contains — `http://www.w3.org/2000/svg`,
// `https://react.dev/errors/`, dependency and license links — and a guard that
// cries wolf gets switched off. Each rule below targets a concrete deployment
// leak instead.
export const FORBIDDEN_PATTERNS: readonly ForbiddenPattern[] = [
  {
    rule: "dev-host-localhost",
    reason: "A development origin reached the production bundle.",
    pattern: /\blocalhost\b/,
  },
  {
    rule: "dev-host-loopback",
    reason: "A development origin (loopback IP) reached the production bundle.",
    pattern: /\b127\.0\.0\.1\b/,
  },
  {
    // The browser must only ever issue relative /v1/... requests (docs/14-web-ui.md
    // §5). An absolute origin whose path reaches /v1 means that contract was broken
    // and the deployment would depend on CORS. The trailing lookahead is what keeps
    // /v10 and /v1beta from matching, and it is a lookahead rather than a consuming
    // group so the delimiter stays out of the reported excerpt.
    rule: "absolute-api-origin",
    reason: "An absolute API origin replaced the relative /v1/... request contract.",
    pattern: /https?:\/\/[^\s"'`\\]*\/v1(?=[/?#"'`\s\\]|$)/,
  },
  {
    rule: "backend-env-name",
    reason: "A backend environment variable name reached the browser.",
    pattern: /\bDATABASE_URL\b/,
  },
  {
    rule: "prisma-runtime",
    reason: "Backend persistence runtime leaked into the browser bundle.",
    pattern: /\bPrismaClient\b/,
  },
  {
    rule: "test-assets",
    reason: "Test-only code was bundled into the production output.",
    pattern: /__tests__|\.test\.[jt]sx?\b|\/src\/test\//,
  },
];

// One violation per rule per file, anchored at the first match: a minified
// bundle can repeat the same leak hundreds of times, and the first occurrence
// is enough to diagnose it.
export function findBundleViolations(file: string, contents: string): readonly BundleViolation[] {
  const violations: BundleViolation[] = [];

  for (const forbidden of FORBIDDEN_PATTERNS) {
    const match = forbidden.pattern.exec(contents);
    if (match === null) {
      continue;
    }

    violations.push({
      rule: forbidden.rule,
      file,
      excerpt: buildExcerpt(contents, match.index, match[0].length),
    });
  }

  return violations;
}

export function explainRule(rule: string): string {
  return FORBIDDEN_PATTERNS.find((forbidden) => forbidden.rule === rule)?.reason ?? rule;
}

// Whitespace is collapsed so a match inside a minified line stays readable on
// one terminal row, and the ellipses make it obvious the excerpt is a window
// rather than the whole value.
function buildExcerpt(contents: string, index: number, length: number): string {
  const start = Math.max(0, index - EXCERPT_RADIUS);
  const end = Math.min(contents.length, index + length + EXCERPT_RADIUS);
  const window = contents.slice(start, end).replace(/\s+/g, " ").trim();

  return `${start > 0 ? "…" : ""}${window}${end < contents.length ? "…" : ""}`;
}
