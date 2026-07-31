import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The header a browser (or any caller) presents to request a LIVE run.
 *
 * A header, deliberately — never a query parameter or a path segment. A token
 * in a URL ends up in access logs, in `Referer` headers, in browser history,
 * and in this repository's own request logging, none of which the token gate
 * could then undo.
 */
export const LIVE_RUN_ACCESS_TOKEN_HEADER = "x-opspilot-demo-token";

/**
 * Whether a LIVE request must present the shared demo token.
 *
 * `"absent"` does NOT mean "LIVE is public" — no such mode exists in this
 * milestone. It means no token is configured, which (see
 * run-execution-config.ts) is only a valid state while the kill switch is off
 * and LIVE therefore cannot be served at all. Startup fails rather than
 * producing a servable-but-tokenless LIVE path.
 */
export type LiveRunAccessPolicy =
  | {
      readonly kind: "token-required";
      /**
       * Constant-time comparison against the configured token.
       *
       * The token is captured in this closure and is NOT a property of the
       * returned object. That is stronger than a non-enumerable field: there is
       * no property to read, spread, `JSON.stringify`, `util.inspect`, or log,
       * even deliberately. The only thing callers can do with the token is ask
       * whether a candidate matches it.
       */
      verify(candidate: string | undefined): boolean;
    }
  | { readonly kind: "absent" };

/**
 * Compares two strings without leaking their contents through timing.
 *
 * Both sides are hashed to a fixed 32 bytes first, then compared with
 * `timingSafeEqual`. Hashing is what makes the buffers equal-length, which
 * `timingSafeEqual` requires — and it means the comparison leaks nothing about
 * the configured token's *length* either, which a length check before a
 * byte-wise compare would.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();

  return timingSafeEqual(digestA, digestB);
}

/**
 * Builds the access policy from an already-validated token.
 *
 * Both sides are trimmed before comparison: the configured value is trimmed
 * here, and a candidate is trimmed in `verify`. Environment variables and
 * copy-pasted browser input both routinely pick up surrounding whitespace, and
 * a shared demo token that rejects a correct paste because of a trailing space
 * is a support problem with no security benefit. Interior characters are
 * compared exactly.
 */
export function createLiveRunAccessPolicy(configuredToken: string): LiveRunAccessPolicy {
  const expected = configuredToken.trim();

  if (expected === "") {
    // Callers validate this before calling; guarding anyway means an empty
    // token can never degrade into "any candidate matches".
    throw new Error("createLiveRunAccessPolicy requires a non-empty token.");
  }

  return {
    kind: "token-required",
    verify(candidate: string | undefined): boolean {
      if (candidate === undefined) return false;

      const provided = candidate.trim();
      if (provided === "") return false;

      return constantTimeEquals(provided, expected);
    },
  };
}
