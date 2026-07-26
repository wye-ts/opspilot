import { describe, expect, it } from "vitest";

import { explainRule, findBundleViolations, FORBIDDEN_PATTERNS } from "./forbidden-patterns";

function rulesFor(contents: string): readonly string[] {
  return findBundleViolations("assets/index-abc123.js", contents).map((violation) => violation.rule);
}

describe("findBundleViolations — real leaks are caught", () => {
  it("catches a localhost origin", () => {
    expect(rulesFor(`fetch("http://localhost:3000/agent-jobs")`)).toContain("dev-host-localhost");
  });

  it("catches a loopback origin", () => {
    expect(rulesFor(`const t="http://127.0.0.1:3000"`)).toContain("dev-host-loopback");
  });

  it("catches a backend environment variable name", () => {
    expect(rulesFor(`const u=process.env.DATABASE_URL`)).toContain("backend-env-name");
  });

  it("catches the Prisma runtime", () => {
    expect(rulesFor(`new PrismaClient({adapter:a})`)).toContain("prisma-runtime");
  });

  it.each([
    ["a __tests__ directory", `import x from "../__tests__/fixtures"`],
    ["a .test.ts source path", `"/src/api/http-client.test.ts"`],
    ["a .test.tsx source path", `"/src/components/ApprovalPanel.test.tsx"`],
    ["a .test.js emitted path", `"assets/App.test.js"`],
    ["the shared test setup directory", `"/src/test/setup.ts"`],
  ])("catches %s", (_label, contents) => {
    expect(rulesFor(contents)).toContain("test-assets");
  });

  it("reports every distinct rule a file violates", () => {
    const rules = rulesFor(`fetch("http://localhost:3000/v1/agent-jobs");const u=DATABASE_URL;`);

    expect(rules).toEqual(
      expect.arrayContaining(["dev-host-localhost", "absolute-api-origin", "backend-env-name"]),
    );
  });
});

// The point of this block. A guard with false positives gets switched off, so
// benign content that a real React production build genuinely contains must
// pass cleanly — this suite is the reason the rules are narrow rather than a
// blanket http(s) ban.
describe("findBundleViolations — benign bundle content is not flagged", () => {
  it.each([
    ["the SVG namespace", `d.createElementNS("http://www.w3.org/2000/svg","path")`],
    ["the MathML namespace", `"http://www.w3.org/1998/Math/MathML"`],
    ["the xlink namespace", `"http://www.w3.org/1999/xlink"`],
    ["the XML namespace", `"http://www.w3.org/XML/1998/namespace"`],
    ["a React documentation link", `"https://react.dev/errors/"+e`],
    ["a dependency homepage in a comment", `/*! see https://github.com/facebook/react for details */`],
    ["an MIT license URL", `/* @license MIT https://opensource.org/licenses/MIT */`],
    ["a relative API path, which is the required contract", `fetch("/v1/agent-jobs",init)`],
    ["a template-built relative path", "fetch(`/v1/agent-runs/${runId}/approval`)"],
    ["a RegExp test call", `if(pattern.test(value)){return null}`],
    ["an identifier merely containing the word test", `const latestRunId=state.latestTestable`],
    ["a word containing localhost as a substring", `const notlocalhostish="x"`],
  ])("does not flag %s", (_label, contents) => {
    expect(findBundleViolations("assets/index-abc123.js", contents)).toEqual([]);
  });

  it("passes a representative benign bundle chunk", () => {
    const chunk = [
      `const N="http://www.w3.org/2000/svg";`,
      `function u(e){throw Error("Minified React error #"+e+"; visit https://react.dev/errors/"+e)}`,
      `async function r(p,o){const s=await fetch(p,o);return s.json()}`,
      `r("/v1/agent-jobs",{method:"POST"});`,
    ].join("\n");

    expect(findBundleViolations("assets/index-abc123.js", chunk)).toEqual([]);
  });
});

// This rule carries the most nuance: it must catch a configured absolute origin
// without catching every URL, and without catching path segments that merely
// begin with "/v1".
describe("absolute-api-origin", () => {
  it.each([
    ["a bare origin plus /v1", `"https://opspilot.onrender.com/v1"`],
    ["an origin plus a /v1 route", `fetch("https://api.example.com/v1/agent-jobs")`],
    ["a plain http origin", `"http://api.example.com/v1/agent-runs/1"`],
    ["an origin with a port", `"https://api.example.com:8443/v1/agent-jobs"`],
    ["a /v1 path followed by a query string", `"https://api.example.com/v1?probe=1"`],
    ["a /v1 path followed by a fragment", `"https://api.example.com/v1#top"`],
    ["a /v1 path at the very end of the file", `https://api.example.com/v1`],
  ])("flags %s", (_label, contents) => {
    expect(rulesFor(contents)).toContain("absolute-api-origin");
  });

  it.each([
    ["a /v10 path segment", `"https://api.example.com/v10/agent-jobs"`],
    ["a /v1beta path segment", `"https://api.example.com/v1beta/models"`],
    ["a /v1x path segment", `"https://api.example.com/v1x"`],
    ["an origin with no /v1 anywhere", `"https://react.dev/errors/"`],
    ["a relative /v1 path", `fetch("/v1/agent-jobs")`],
    ["a /v1 path with no origin at all", `const p="/v1/agent-runs/"+id`],
  ])("does not flag %s", (_label, contents) => {
    expect(rulesFor(contents)).not.toContain("absolute-api-origin");
  });

  it("stops the origin at a quote rather than running across it", () => {
    // Two separate strings; neither is an absolute API origin, and the pattern
    // must not bridge the closing quote of the first into the second.
    expect(rulesFor(`["https://react.dev/errors/","/v1/agent-jobs"]`)).not.toContain(
      "absolute-api-origin",
    );
  });
});

describe("violation reporting", () => {
  it("reports the file it was given and a bounded excerpt", () => {
    const contents = `${"x".repeat(500)}fetch("http://localhost:3000")${"y".repeat(500)}`;
    const [violation] = findBundleViolations("assets/index-abc123.js", contents);

    expect(violation?.file).toBe("assets/index-abc123.js");
    expect(violation?.excerpt).toContain("localhost");
    expect(violation?.excerpt.length).toBeLessThan(150);
    expect(violation?.excerpt.startsWith("…")).toBe(true);
    expect(violation?.excerpt.endsWith("…")).toBe(true);
  });

  it("collapses whitespace so an excerpt stays on one line", () => {
    const [violation] = findBundleViolations("index.html", `a\n\n  localhost  \n\nb`);

    expect(violation?.excerpt).toBe("a localhost b");
  });

  it("returns nothing for empty contents", () => {
    expect(findBundleViolations("index.html", "")).toEqual([]);
  });

  it("is stateless across repeated calls", () => {
    const contents = `"http://localhost:3000"`;

    expect(rulesFor(contents)).toEqual(rulesFor(contents));
    expect(rulesFor(contents)).toEqual(rulesFor(contents));
  });
});

describe("rule table", () => {
  it("uses unique rule names", () => {
    const names = FORBIDDEN_PATTERNS.map((forbidden) => forbidden.rule);

    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every pattern non-global so shared instances stay stateless", () => {
    for (const forbidden of FORBIDDEN_PATTERNS) {
      expect(forbidden.pattern.global).toBe(false);
    }
  });

  it("explains a known rule and falls back to the raw name for an unknown one", () => {
    expect(explainRule("prisma-runtime")).toBe(
      "Backend persistence runtime leaked into the browser bundle.",
    );
    expect(explainRule("not-a-rule")).toBe("not-a-rule");
  });
});
