import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { createVisitorIdentity, VISITOR_COOKIE_NAME } from "./visitor-identity";

const SECRET = "visitor-secret-do-not-use-9f14e45fceea";
const OTHER_SECRET = "different-secret-do-not-use-2f14e45fceea";

function requestWithCookie(cookie: string | undefined): Request {
  return { headers: cookie !== undefined ? { cookie } : {} } as unknown as Request;
}

/** Captures exactly what setVisitorCookie passed to res.cookie(). */
function capturingResponse(): { response: Response; calls: Array<[string, string, Record<string, unknown>]> } {
  const calls: Array<[string, string, Record<string, unknown>]> = [];
  const response = {
    cookie: (name: string, value: string, options: Record<string, unknown>) => {
      calls.push([name, value, options]);
    },
  } as unknown as Response;
  return { response, calls };
}

describe("createVisitorIdentity", () => {
  it("mints a fresh, unsigned UUID", () => {
    const identity = createVisitorIdentity(SECRET);
    const a = identity.mintVisitorId();
    const b = identity.mintVisitorId();

    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(a).not.toBe(b);
  });

  describe("round trip", () => {
    it("resolves a valid signed cookie back to the exact visitor id", () => {
      const identity = createVisitorIdentity(SECRET);
      const visitorId = identity.mintVisitorId();
      const { response, calls } = capturingResponse();

      identity.setVisitorCookie(response, visitorId);
      const [, cookieValue] = calls[0]!;

      const resolved = identity.resolveVisitorId(requestWithCookie(`${VISITOR_COOKIE_NAME}=${cookieValue}`));
      expect(resolved).toBe(visitorId);
    });

    it("survives being interleaved with other cookies", () => {
      const identity = createVisitorIdentity(SECRET);
      const visitorId = identity.mintVisitorId();
      const { response, calls } = capturingResponse();
      identity.setVisitorCookie(response, visitorId);
      const [, cookieValue] = calls[0]!;

      const resolved = identity.resolveVisitorId(
        requestWithCookie(`other=1; ${VISITOR_COOKIE_NAME}=${cookieValue}; another=2`),
      );
      expect(resolved).toBe(visitorId);
    });
  });

  describe("a tampered signature is not trusted", () => {
    it("treats a signature signed with a DIFFERENT secret as absent", () => {
      const minted = createVisitorIdentity(OTHER_SECRET);
      const identity = createVisitorIdentity(SECRET);
      const visitorId = minted.mintVisitorId();
      const { response, calls } = capturingResponse();
      minted.setVisitorCookie(response, visitorId);
      const [, cookieValue] = calls[0]!;

      // Verified with the WRONG secret — must not be trusted.
      expect(identity.resolveVisitorId(requestWithCookie(`${VISITOR_COOKIE_NAME}=${cookieValue}`))).toBeNull();
    });

    it("treats a flipped signature character as absent", () => {
      const identity = createVisitorIdentity(SECRET);
      const visitorId = identity.mintVisitorId();
      const { response, calls } = capturingResponse();
      identity.setVisitorCookie(response, visitorId);
      const [, cookieValue] = calls[0]!;

      const [id, signature] = cookieValue.split(".");
      const flipped = signature!.startsWith("0") ? `1${signature!.slice(1)}` : `0${signature!.slice(1)}`;
      const tampered = `${id}.${flipped}`;

      expect(identity.resolveVisitorId(requestWithCookie(`${VISITOR_COOKIE_NAME}=${tampered}`))).toBeNull();
    });

    it("treats a visitor id substituted under a still-valid-looking signature as absent", () => {
      const identity = createVisitorIdentity(SECRET);
      const { response, calls } = capturingResponse();
      identity.setVisitorCookie(response, identity.mintVisitorId());
      const [, cookieValue] = calls[0]!;
      const [, signature] = cookieValue.split(".");

      const swapped = `00000000-0000-4000-8000-000000000000.${signature}`;
      expect(identity.resolveVisitorId(requestWithCookie(`${VISITOR_COOKIE_NAME}=${swapped}`))).toBeNull();
    });
  });

  describe("a malformed cookie value is not trusted", () => {
    const identity = createVisitorIdentity(SECRET);

    it.each([
      ["no cookie header at all", undefined],
      ["cookie header present but this cookie absent", "other=1"],
      ["no separator between id and signature", "not-a-valid-cookie-value"],
      ["empty value", `${VISITOR_COOKIE_NAME}=`],
      ["non-UUID id", `${VISITOR_COOKIE_NAME}=not-a-uuid.abc123`],
      ["UUID with empty signature", `${VISITOR_COOKIE_NAME}=11111111-1111-4111-8111-111111111111.`],
    ])("%s → resolves null", (_label, cookieHeader) => {
      expect(identity.resolveVisitorId(requestWithCookie(cookieHeader))).toBeNull();
    });
  });

  describe("production-safe cookie attributes", () => {
    it("sets httpOnly, Secure, SameSite=Lax, a long Max-Age, and an opaque UUID payload", () => {
      const identity = createVisitorIdentity(SECRET);
      const visitorId = identity.mintVisitorId();
      const { response, calls } = capturingResponse();

      identity.setVisitorCookie(response, visitorId);

      expect(calls).toHaveLength(1);
      const [name, value, options] = calls[0]!;
      expect(name).toBe(VISITOR_COOKIE_NAME);
      expect(options).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax" });
      // Long-lived: the UTC-day counters reset daily, not the cookie itself.
      expect(options.maxAge as number).toBeGreaterThan(300 * 24 * 60 * 60 * 1000);

      // The payload is the UUID plus a hex signature — no PII, no counters,
      // no free text of any kind.
      const [id, signature] = value.split(".");
      expect(id).toBe(visitorId);
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });
  });
});
