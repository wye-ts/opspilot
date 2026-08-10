/**
 * The only seam between this app and Cloudflare's Turnstile widget (issue
 * #39) — wraps the global `window.turnstile` object the CDN script attaches,
 * and nothing else. Not a generic CAPTCHA framework: there is exactly one
 * provider, and this module exists so the rest of the app never touches
 * `window.turnstile` directly and tests never need a real script load.
 */

export interface TurnstileRenderOptions {
  readonly sitekey: string;
  readonly callback: (token: string) => void;
  readonly "expired-callback": () => void;
  readonly "error-callback": () => void;
}

interface WindowTurnstile {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: WindowTurnstile;
  }
}

export interface TurnstileClient {
  render(container: HTMLElement, options: TurnstileRenderOptions): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

/**
 * `null` when the CDN script has not loaded (or failed to) — callers render a
 * fallback rather than throwing, since a missing widget is a recoverable UI
 * state (reload, ad blocker, offline), not a programming error.
 */
export function getTurnstileClient(): TurnstileClient | null {
  if (typeof window === "undefined" || window.turnstile === undefined) {
    return null;
  }
  const turnstile = window.turnstile;
  return {
    render: (container, options) => turnstile.render(container, options),
    reset: (widgetId) => turnstile.reset(widgetId),
    remove: (widgetId) => turnstile.remove(widgetId),
  };
}
