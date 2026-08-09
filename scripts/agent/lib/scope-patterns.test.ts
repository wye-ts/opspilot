import { describe, expect, it } from "vitest";

import { matchesAnyPattern, matchesPattern } from "./scope-patterns";

describe("scope-patterns", () => {
  it("matches a literal path exactly", () => {
    expect(matchesPattern("docs/08-cicd-deployment.md", "docs/08-cicd-deployment.md")).toBe(true);
    expect(matchesPattern("docs/09-resume-notes.md", "docs/08-cicd-deployment.md")).toBe(false);
  });

  it("* matches within a single path segment only", () => {
    expect(matchesPattern("docs/16-investigation-event-contract.md", "docs/16-*.md")).toBe(true);
    expect(matchesPattern("docs/reviews/16-x.md", "docs/16-*.md")).toBe(false);
  });

  it("** matches zero or more path segments", () => {
    expect(matchesPattern("apps/web/src/index.ts", "apps/web/src/**")).toBe(true);
    expect(matchesPattern("apps/web/src/deep/nested/file.ts", "apps/web/src/**")).toBe(true);
  });

  it("** in the middle matches zero or more intermediate segments", () => {
    expect(matchesPattern("apps/foo/bar/test/x.ts", "apps/**/test/*.ts")).toBe(true);
    expect(matchesPattern("apps/test/x.ts", "apps/**/test/*.ts")).toBe(true);
    expect(matchesPattern("apps/x.ts", "apps/**/x.ts")).toBe(true);
  });

  it("does not match a path outside the pattern", () => {
    expect(matchesPattern("packages/database/src/index.ts", "apps/web/src/**")).toBe(false);
  });

  it("matchesAnyPattern checks across multiple patterns", () => {
    const patterns = ["apps/web/src/**", "docs/16-*.md"];
    expect(matchesAnyPattern("apps/web/src/App.tsx", patterns)).toBe(true);
    expect(matchesAnyPattern("docs/16-investigation-event-contract.md", patterns)).toBe(true);
    expect(matchesAnyPattern("packages/database/src/index.ts", patterns)).toBe(false);
  });

  it("escapes regex-special characters in literal segments", () => {
    expect(matchesPattern("a.b.ts", "a.b.ts")).toBe(true);
    expect(matchesPattern("aXb.ts", "a.b.ts")).toBe(false);
  });
});
