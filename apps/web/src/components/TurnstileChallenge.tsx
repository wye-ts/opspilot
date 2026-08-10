import { useEffect, useRef, useState } from "react";

import { getTurnstileClient } from "../turnstile/turnstile-client";

const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js";
const TURNSTILE_SCRIPT_ID = "opspilot-turnstile-script";

/**
 * Loads Cloudflare's widget script on demand — never in `index.html` — so a
 * private-token deployment, which never renders this component, never fetches
 * a third-party script at all. Idempotent: a second mount reuses the tag a
 * first one already inserted rather than injecting a duplicate.
 */
function loadTurnstileScript(): Promise<boolean> {
  if (getTurnstileClient() !== null) return Promise.resolve(true);

  return new Promise((resolve) => {
    const existing = document.getElementById(TURNSTILE_SCRIPT_ID);
    if (existing !== null) {
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => resolve(false), { once: true });
      return;
    }
    const script = document.createElement("script");
    script.id = TURNSTILE_SCRIPT_ID;
    script.src = TURNSTILE_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener("load", () => resolve(true), { once: true });
    script.addEventListener("error", () => resolve(false), { once: true });
    document.head.appendChild(script);
  });
}

export interface TurnstileChallengeProps {
  readonly siteKey: string;
  /**
   * Fires with the solved token on success, and with `null` on expiry, error,
   * or when the widget is torn down — never left holding a stale token the
   * caller believes is still valid.
   */
  readonly onTokenChange: (token: string | null) => void;
}

/**
 * Rendered ONLY when `liveAccess === "PUBLIC_TRIAL"` and LIVE is selected —
 * never mounted on the private-token path (see InvestigationForm). On solve,
 * surfaces the token via `onTokenChange`; on expiry or error, clears the held
 * token and resets the widget so a fresh solve is required before submit
 * re-enables.
 */
export function TurnstileChallenge({ siteKey, onTokenChange }: TurnstileChallengeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const widgetIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">("loading");

  useEffect(() => {
    let cancelled = false;

    void loadTurnstileScript().then((loaded) => {
      if (cancelled) return;
      const client = getTurnstileClient();
      if (!loaded || client === null || containerRef.current === null) {
        setStatus("unavailable");
        return;
      }

      const widgetId = client.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => onTokenChange(token),
        "expired-callback": () => {
          onTokenChange(null);
          if (widgetIdRef.current !== null) client.reset(widgetIdRef.current);
        },
        "error-callback": () => {
          onTokenChange(null);
          if (widgetIdRef.current !== null) client.reset(widgetIdRef.current);
        },
      });
      widgetIdRef.current = widgetId;
      setStatus("ready");
    });

    return () => {
      cancelled = true;
      onTokenChange(null);
      const client = getTurnstileClient();
      if (client !== null && widgetIdRef.current !== null) {
        client.remove(widgetIdRef.current);
      }
      widgetIdRef.current = null;
    };
    // siteKey is served once by capabilities and does not change mid-session;
    // onTokenChange is a stable setter from the parent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [siteKey]);

  return (
    <div className="form-field">
      <div ref={containerRef} className="turnstile-widget" aria-live="polite" />
      {status === "unavailable" ? (
        <p className="form-error">The verification widget could not load. Reload the page and try again.</p>
      ) : null}
    </div>
  );
}
