import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { LIVE_RUN_ACCESS_TOKEN_HEADER, createLiveRunAccessPolicy } from "./live-run-access";

const TOKEN = "demo-token-do-not-use-8f14e45fceea";

describe("createLiveRunAccessPolicy", () => {
  it("accepts the exact configured token", () => {
    const policy = createLiveRunAccessPolicy(TOKEN);

    expect(policy.kind).toBe("token-required");
    expect(policy.kind === "token-required" && policy.verify(TOKEN)).toBe(true);
  });

  it.each([
    ["a wrong token", "wrong-token"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a prefix of the token", TOKEN.slice(0, -1)],
    ["the token plus a character", `${TOKEN}x`],
    ["a case-shifted token", TOKEN.toUpperCase()],
  ])("rejects %s", (_label, candidate) => {
    const policy = createLiveRunAccessPolicy(TOKEN);
    if (policy.kind !== "token-required") throw new Error("expected a token-required policy");

    expect(policy.verify(candidate)).toBe(false);
  });

  it("rejects an absent header rather than treating it as a match", () => {
    const policy = createLiveRunAccessPolicy(TOKEN);
    if (policy.kind !== "token-required") throw new Error("expected a token-required policy");

    expect(policy.verify(undefined)).toBe(false);
  });

  it("trims surrounding whitespace on both sides", () => {
    // A shared demo token gets pasted into a browser field and set through a
    // dashboard; both routinely add surrounding whitespace. Interior characters
    // are still compared exactly.
    const policy = createLiveRunAccessPolicy(`  ${TOKEN}  `);
    if (policy.kind !== "token-required") throw new Error("expected a token-required policy");

    expect(policy.verify(TOKEN)).toBe(true);
    expect(policy.verify(`  ${TOKEN}\n`)).toBe(true);
    expect(policy.verify(TOKEN.replace("-", " "))).toBe(false);
  });

  it("refuses to build a policy from an empty token", () => {
    // An empty configured token must never degrade into "every candidate
    // matches" — that would be a tokenless public LIVE path by accident.
    expect(() => createLiveRunAccessPolicy("")).toThrow(/non-empty token/);
    expect(() => createLiveRunAccessPolicy("   ")).toThrow(/non-empty token/);
  });

  // The token is captured in a closure, not stored as a property. These tests
  // pin that: there is nothing to read, spread, serialize, or log.
  describe("token containment", () => {
    it("exposes no property carrying the token value", () => {
      const policy = createLiveRunAccessPolicy(TOKEN);

      expect(Object.keys(policy)).toEqual(["kind", "verify"]);
      expect(Object.values(policy)).not.toContain(TOKEN);
      expect(Reflect.ownKeys(policy)).not.toContain(TOKEN);
    });

    it("never leaks the token through JSON.stringify", () => {
      const policy = createLiveRunAccessPolicy(TOKEN);

      expect(JSON.stringify(policy)).not.toContain(TOKEN);
      expect(JSON.stringify({ config: policy })).not.toContain(TOKEN);
    });

    it("never leaks the token through util.inspect or console formatting", () => {
      const policy = createLiveRunAccessPolicy(TOKEN);

      expect(inspect(policy, { depth: 10 })).not.toContain(TOKEN);
      expect(`${String(policy)} ${inspect(policy)}`).not.toContain(TOKEN);
    });

    it("never leaks the token through an object spread", () => {
      const policy = createLiveRunAccessPolicy(TOKEN);
      const spread = { ...policy };

      expect(JSON.stringify(spread)).not.toContain(TOKEN);
      expect(Object.values(spread)).not.toContain(TOKEN);
    });

    it("never leaks the token through the verify function's own source", () => {
      const policy = createLiveRunAccessPolicy(TOKEN);
      if (policy.kind !== "token-required") throw new Error("expected a token-required policy");

      // Function.prototype.toString exposes the body, not closed-over values.
      expect(policy.verify.toString()).not.toContain(TOKEN);
    });
  });
});

describe("LIVE_RUN_ACCESS_TOKEN_HEADER", () => {
  it("is a lowercase header name, matching Node's normalized request headers", () => {
    expect(LIVE_RUN_ACCESS_TOKEN_HEADER).toBe("x-opspilot-demo-token");
    expect(LIVE_RUN_ACCESS_TOKEN_HEADER).toBe(LIVE_RUN_ACCESS_TOKEN_HEADER.toLowerCase());
  });
});
