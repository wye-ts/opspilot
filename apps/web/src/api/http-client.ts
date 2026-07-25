import type { ApiErrorEnvelope, ApiSuccessEnvelope } from "./types";

// The only public error type this module throws. status/code/message/requestId
// come either from the server's own closed error catalog (safe to display
// verbatim — see docs/12-agent-run-api.md) or from one of the two synthetic
// codes below. No raw response body, cause, or stack is ever retained.
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export interface ApiResult<T> {
  readonly data: T;
  readonly status: number;
}

function isSuccessEnvelope<T>(value: unknown): value is ApiSuccessEnvelope<T> {
  return typeof value === "object" && value !== null && "data" in value;
}

// Requires exactly the fields ApiErrorEnvelope's type promises: code/message/
// requestId as strings, and runId — when present at all — also a string.
// A body that satisfies only code/message (e.g. missing or non-string
// requestId) is REJECTED as UNEXPECTED_RESPONSE rather than accepted with an
// undefined requestId silently smuggled through the `value is
// ApiErrorEnvelope` type predicate into ApiRequestError's `string | null`
// parameter.
function isErrorEnvelope(value: unknown): value is ApiErrorEnvelope {
  if (typeof value !== "object" || value === null || !("error" in value)) return false;
  const error = (value as { error: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  const { code, message, requestId, runId } = error as {
    code?: unknown;
    message?: unknown;
    requestId?: unknown;
    runId?: unknown;
  };
  if (typeof code !== "string" || typeof message !== "string" || typeof requestId !== "string") return false;
  if (runId !== undefined && typeof runId !== "string") return false;
  return true;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface RequestOptions {
  readonly method?: "GET" | "POST";
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
}

// The only source file that calls fetch. Every path is relative (/v1/...) —
// there is no base-URL concatenation and no configuration value, so the
// browser can never issue a cross-origin request (see vite.config.ts's proxy).
export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  const hasBody = options.body !== undefined;

  // Built conditionally, not with possibly-undefined values on every key —
  // under exactOptionalPropertyTypes, assigning `key: undefined` to a
  // RequestInit property is a type error distinct from omitting the key.
  const init: RequestInit = { method: options.method ?? "GET" };
  if (hasBody) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  if (options.signal !== undefined) {
    init.signal = options.signal;
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    // No literal API origin in this string — see vite.config.ts's proxy and
    // §16's build-inspection grep, which asserts the bundle contains no
    // absolute API origin at all (every real request stays relative).
    throw new ApiRequestError(
      0,
      "NETWORK_UNAVAILABLE",
      "Could not reach the OpsPilot API. Make sure it is running locally.",
      null,
    );
  }

  const parsed = await parseBody(response);

  if (response.ok) {
    if (!isSuccessEnvelope<T>(parsed)) {
      throw new ApiRequestError(
        response.status,
        "UNEXPECTED_RESPONSE",
        "The server returned an unexpected response.",
        null,
      );
    }
    return { data: parsed.data, status: response.status };
  }

  if (!isErrorEnvelope(parsed)) {
    throw new ApiRequestError(
      response.status,
      "UNEXPECTED_RESPONSE",
      "The server returned an unexpected response.",
      null,
    );
  }

  throw new ApiRequestError(response.status, parsed.error.code, parsed.error.message, parsed.error.requestId);
}
