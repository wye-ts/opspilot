import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

/**
 * The signed, opaque, long-lived visitor cookie for the PUBLIC LIVE trial
 * (issue #39): a random UUID plus an HMAC-SHA256 signature over
 * `LIVE_PUBLIC_TRIAL_VISITOR_SECRET`. The raw UUID (never the signature) is
 * the `visitor_id` database key — no PII, no counters, in the cookie itself.
 *
 * Mirrors live-run-access.ts's verify style: the secret is captured in this
 * module's closure, never a readable property of anything returned.
 */
export const VISITOR_COOKIE_NAME = "opspilot_visitor_id";

// Long-lived by design (docs/reviews/23-issue-39-public-live-trial-plan.md
// §5) — the UTC-day counters reset daily, not the cookie itself. ~400 days,
// the practical browser-enforced ceiling on Max-Age.
const VISITOR_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface VisitorIdentity {
  /** A fresh, unsigned visitor id. Callers must sign it via `setVisitorCookie` before trusting it. */
  mintVisitorId(): string;
  /**
   * Reads and verifies the visitor cookie. `null` for absent, malformed, or a
   * tampered signature alike — all three are treated identically: a caller
   * with no trustworthy cookie is a new visitor, not an error.
   */
  resolveVisitorId(request: Request): string | null;
  /**
   * Sets the signed cookie, unconditionally — called once Turnstile has
   * passed, regardless of whether the subsequent admission transaction
   * succeeds. See docs/reviews/23-issue-39-public-live-trial-plan.md §5: a
   * quota-exhausted visitor must still converge on a stable identity rather
   * than re-solving Turnstile for nothing on every attempt.
   */
  setVisitorCookie(response: Response, visitorId: string): void;
}

function sign(secret: string, visitorId: string): string {
  return createHmac("sha256", secret).update(visitorId, "utf8").digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers. Both sides here are
  // ALWAYS a fixed-length hex digest from the same HMAC-SHA256 output, so a
  // length mismatch already means "not a signature this module produced" —
  // returning false early leaks nothing an attacker doesn't already know
  // (the digest length is a public constant of the algorithm).
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Reads exactly one cookie by name from the raw `Cookie` header — no cookie-parser dependency. */
function readCookie(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function createVisitorIdentity(secret: string): VisitorIdentity {
  return {
    mintVisitorId: () => randomUUID(),

    resolveVisitorId(request) {
      const raw = readCookie(request, VISITOR_COOKIE_NAME);
      if (raw === null) return null;

      const separator = raw.indexOf(".");
      if (separator === -1) return null;

      const visitorId = raw.slice(0, separator);
      const signature = raw.slice(separator + 1);
      if (!UUID_PATTERN.test(visitorId)) return null;
      if (!constantTimeEquals(signature, sign(secret, visitorId))) return null;

      return visitorId;
    },

    setVisitorCookie(response, visitorId) {
      response.cookie(VISITOR_COOKIE_NAME, `${visitorId}.${sign(secret, visitorId)}`, {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        maxAge: VISITOR_COOKIE_MAX_AGE_MS,
        path: "/",
      });
    },
  };
}
