const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * A hard ceiling on how long a single Cloudflare siteverify POST may take.
 * Cloudflare's edge responds in well under 1s in normal operation; 10s leaves
 * generous headroom for a slow path or a cold TLS handshake while still
 * bounding the worst case. Set as a constant rather than an env var: there is
 * no operator reason to tune this, and it must never be unbounded.
 */
const TURNSTILE_SITEVERIFY_TIMEOUT_MS = 10_000;

/**
 * Verifies a solved Cloudflare Turnstile challenge for the PUBLIC LIVE trial
 * (issue #39). One HTTPS POST to Cloudflare's `siteverify`, and nothing else —
 * this is the only seam between the server and Cloudflare, not a generic
 * CAPTCHA framework.
 *
 * FAIL-CLOSED on any infra error: a network failure, a non-2xx response, a
 * malformed body, or a thrown exception all resolve to `false`, the same
 * boundary-translation posture `budgetOpen` uses in live-run-admission.ts. An
 * unverifiable challenge is never treated as a solved one.
 *
 * The timeout is bounded by TURNSTILE_SITEVERIFY_TIMEOUT_MS — a hung
 * connection cannot hold the public admission path open indefinitely.
 */
export interface TurnstileVerifier {
  verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean>;
}

function isSuccessResponse(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "success" in value &&
    (value as { success: unknown }).success === true
  );
}

/**
 * `fetchImpl` is injectable so unit tests never make a real network call — see
 * turnstile-verifier.test.ts. Defaults to the global `fetch` in production.
 */
export function createTurnstileVerifier(
  secretKey: string,
  fetchImpl: typeof fetch = fetch,
): TurnstileVerifier {
  return {
    async verify(token, remoteIp) {
      if (token === undefined || token.trim() === "") return false;

      try {
        const body = new URLSearchParams({ secret: secretKey, response: token });
        if (remoteIp !== undefined && remoteIp !== "") {
          body.set("remoteip", remoteIp);
        }

        const response = await fetchImpl(TURNSTILE_SITEVERIFY_URL, {
          method: "POST",
          body,
          signal: AbortSignal.timeout(TURNSTILE_SITEVERIFY_TIMEOUT_MS),
        });
        if (!response.ok) return false;

        const parsed: unknown = await response.json();
        return isSuccessResponse(parsed);
      } catch {
        return false;
      }
    },
  };
}
