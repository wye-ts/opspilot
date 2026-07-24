export type ApiErrorCode =
  | "REQUEST_BODY_INVALID"
  | "REQUEST_BODY_TOO_LARGE"
  | "ROUTE_PARAMETER_INVALID"
  | "ROUTE_NOT_FOUND"
  | "AGENT_JOB_NOT_FOUND"
  | "AGENT_RUN_NOT_FOUND"
  | "PERSISTENCE_CONFLICT"
  | "PERSISTENCE_UNAVAILABLE"
  | "INTERNAL_DATA_INVALID"
  | "AGENT_EXECUTION_CRASHED"
  | "INTERNAL_ERROR";

interface ApiErrorCatalogEntry {
  readonly status: number;
  readonly message: string;
}

// The single source of truth for every public status/message pair — see
// docs/12-agent-run-api.md. No other code path constructs these strings.
export const API_ERROR_CATALOG: Readonly<Record<ApiErrorCode, ApiErrorCatalogEntry>> = {
  REQUEST_BODY_INVALID: {
    status: 400,
    message: "The request body failed validation.",
  },
  REQUEST_BODY_TOO_LARGE: {
    status: 413,
    message: "The request body exceeded the maximum allowed size.",
  },
  ROUTE_PARAMETER_INVALID: {
    status: 400,
    message: "The request path contained an invalid identifier.",
  },
  ROUTE_NOT_FOUND: {
    status: 404,
    message: "The requested route was not found.",
  },
  AGENT_JOB_NOT_FOUND: {
    status: 404,
    message: "The requested agent job was not found.",
  },
  AGENT_RUN_NOT_FOUND: {
    status: 404,
    message: "The requested agent run was not found.",
  },
  PERSISTENCE_CONFLICT: {
    status: 409,
    message: "The request could not be completed due to a conflicting persisted state.",
  },
  PERSISTENCE_UNAVAILABLE: {
    status: 503,
    message: "The database is temporarily unavailable.",
  },
  INTERNAL_DATA_INVALID: {
    status: 500,
    message: "The server encountered invalid persisted data and could not complete the request.",
  },
  AGENT_EXECUTION_CRASHED: {
    status: 500,
    message: "The agent execution terminated unexpectedly.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "An unexpected internal error occurred.",
  },
};
