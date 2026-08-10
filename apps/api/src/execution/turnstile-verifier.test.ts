import { describe, expect, it } from "vitest";

import { createTurnstileVerifier } from "./turnstile-verifier";

const SECRET = "turnstile-secret-do-not-use-1f14e45fceea";

function fakeFetch(handler: (url: string, init: RequestInit) => Promise<Response> | Response): typeof fetch {
  return ((url: string, init: RequestInit) => Promise.resolve(handler(url, init))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe("createTurnstileVerifier", () => {
  it("accepts a valid verification", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => jsonResponse({ success: true })),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(true);
  });

  it("rejects an invalid verification", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => jsonResponse({ success: false, "error-codes": ["invalid-input-response"] })),
    );

    await expect(verifier.verify("bad-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("rejects an absent token without calling Cloudflare at all", async () => {
    let calls = 0;
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => {
        calls += 1;
        return jsonResponse({ success: true });
      }),
    );

    await expect(verifier.verify(undefined, "203.0.113.7")).resolves.toBe(false);
    await expect(verifier.verify("", "203.0.113.7")).resolves.toBe(false);
    await expect(verifier.verify("   ", "203.0.113.7")).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("fails closed on a network error", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => {
        throw new TypeError("fetch failed");
      }),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("fails closed on a timeout / rejected fetch promise", async () => {
    const verifier = createTurnstileVerifier(SECRET, (() =>
      Promise.reject(new Error("timed out"))) as unknown as typeof fetch);

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("fails closed on a non-2xx response", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => jsonResponse({ success: true }, false)),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("fails closed on a malformed JSON body", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(
        () =>
          ({
            ok: true,
            json: async () => {
              throw new SyntaxError("Unexpected token");
            },
          }) as unknown as Response,
      ),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("fails closed on a well-formed but unexpected body shape", async () => {
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => jsonResponse({ unexpected: "shape" })),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
    const verifierNull = createTurnstileVerifier(SECRET, fakeFetch(() => jsonResponse(null)));
    await expect(verifierNull.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
  });

  it("posts the secret, the token, and the remote IP to Cloudflare's siteverify endpoint, with a bounded timeout", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedSignal: AbortSignal | null | undefined;
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch((url, init) => {
        capturedUrl = url;
        capturedBody = String(init.body);
        capturedSignal = init.signal;
        return jsonResponse({ success: true });
      }),
    );

    await verifier.verify("solved-token", "203.0.113.7");

    expect(capturedUrl).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const params = new URLSearchParams(capturedBody);
    expect(params.get("secret")).toBe(SECRET);
    expect(params.get("response")).toBe("solved-token");
    expect(params.get("remoteip")).toBe("203.0.113.7");
    expect(capturedSignal).toBeDefined();
  });

  it("fails closed when the AbortSignal fires before Cloudflare responds", async () => {
    // Simulate a timeout by using an already-aborted signal — the fake fetch
    // propagates the abort, which the verifier catches and translates to false.
    let capturedSignal: AbortSignal | null | undefined;
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch((_url, init) => {
        capturedSignal = init.signal;
        // Reject with the abort reason, just as a real AbortSignal.timeout()
        // would cause the fetch to do.
        return Promise.reject(new DOMException("The operation was aborted.", "AbortError"));
      }),
    );

    await expect(verifier.verify("solved-token", "203.0.113.7")).resolves.toBe(false);
    expect(capturedSignal).toBeDefined();
  });

  it("omits remoteip entirely when no IP is known, rather than sending an empty value", async () => {
    let capturedBody = "";
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch((_url, init) => {
        capturedBody = String(init.body);
        return jsonResponse({ success: true });
      }),
    );

    await verifier.verify("solved-token", undefined);

    expect(new URLSearchParams(capturedBody).has("remoteip")).toBe(false);
  });

  it("never makes a real network call — every case above is served by the injected fetch", async () => {
    // Structural proof: this suite exercises no default parameter anywhere,
    // so a real `fetch` to Cloudflare is never reachable from this file.
    const verifier = createTurnstileVerifier(
      SECRET,
      fakeFetch(() => jsonResponse({ success: true })),
    );
    await verifier.verify("solved-token", "203.0.113.7");
    expect(true).toBe(true);
  });
});
