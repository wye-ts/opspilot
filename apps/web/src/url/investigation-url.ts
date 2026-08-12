/**
 * Pure URL helpers for the `?job=<uuid>` query parameter used by live
 * investigation polling and resume (#38). History API calls stay in App.tsx;
 * these functions only read and construct strings.
 */

// Version nibble `4` and variant nibble `[89ab]` — true v4, not any
// hyphenated hexadecimal UUID (independent review Finding 7 — Codex review:
// the previous pattern accepted the nil UUID and every other
// version/variant, contradicting the documented v4 contract).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Returns `true` when `value` looks like a v4 UUID — a local regex, never a
 * zod parse or a request. A malformed `?job=` value is rejected before any
 * network call leaves the browser.
 */
export function isUuid(value: string): boolean {
  return UUID_V4_RE.test(value);
}

/** Reads the `job` query parameter from a URL search string. */
export function readJobParam(search: string): string | null {
  return new URLSearchParams(search).get("job");
}

/**
 * Reads the `approval-demo` flag (`?approval-demo=1`) from a URL search
 * string. The milestone-10 relocation keeps the deterministic approvable
 * Demo reachable after the public `Approval workflow demo` checkbox is
 * removed — this is its deep link, mirroring the `?job=` reading pattern.
 * Only the literal value `1` (or the spelled-out `true`) enables it; anything
 * else (including a bare `?approval-demo`) is ignored, so an accidental empty
 * flag never flips a public visitor into the approval-demo path.
 */
export function readApprovalDemoParam(search: string): boolean {
  const value = new URLSearchParams(search).get("approval-demo");
  return value === "1" || value === "true";
}

/** Returns the search string with `job=<uuid>` set (adding or replacing). */
export function withJobParam(jobId: string, currentSearch?: string): string {
  const params = new URLSearchParams(currentSearch ?? "");
  params.set("job", jobId);
  return params.toString();
}

/** Returns the search string with the `job` parameter removed. */
export function withoutJobParam(currentSearch?: string): string {
  const params = new URLSearchParams(currentSearch ?? "");
  params.delete("job");
  return params.toString();
}

/**
 * Returns a canonical full URL (`pathname` + optional search) after removing
 * the app-owned transient investigation parameters — `job` and the hidden
 * `approval-demo` flag. When no query parameters remain, the URL carries NO
 * `?` at all: a reset produces `/`, never a bare `/?` (Fix: the previous
 * `` `?${withoutJobParam(...)}` `` pattern serialized an empty search as a
 * dangling question mark). Unrelated query parameters are preserved.
 */
export function urlWithTransientParamsRemoved(pathname: string, currentSearch?: string): string {
  const params = new URLSearchParams(currentSearch ?? "");
  params.delete("job");
  params.delete("approval-demo");
  const search = params.toString();
  return search ? `${pathname}?${search}` : pathname;
}
