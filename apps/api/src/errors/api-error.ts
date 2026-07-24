import { API_ERROR_CATALOG, type ApiErrorCode } from "./api-error-catalog";

export interface ApiErrorOptions {
  readonly runId?: string;
  readonly cause?: unknown;
}

// The only exception type the API's controllers/filters ever throw or catch
// deliberately — status/message always come from API_ERROR_CATALOG, never
// from a raw underlying error's own message. `cause` is retained solely for
// internal debugging (Error.cause is never serialized to a response or
// printed by the request logger — see docs/12-agent-run-api.md).
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly runId?: string;

  constructor(code: ApiErrorCode, options?: ApiErrorOptions) {
    const entry = API_ERROR_CATALOG[code];
    super(entry.message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.code = code;
    this.status = entry.status;
    if (options?.runId !== undefined) {
      this.runId = options.runId;
    }
  }
}

export interface ErrorEnvelope {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
    readonly requestId: string;
    readonly runId?: string;
  };
}

// Shared by both AllExceptionsFilter (Nest-layer errors) and the raw Express
// parser error handler (pre-Nest layer) — one envelope shape, one place that
// decides what is safe to serialize.
export function buildErrorEnvelope(apiError: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: apiError.code,
      message: apiError.message,
      requestId,
      ...(apiError.runId !== undefined ? { runId: apiError.runId } : {}),
    },
  };
}
