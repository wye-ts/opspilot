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
  | "INTERNAL_ERROR"
  | "AGENT_RUN_NOT_APPROVAL_ELIGIBLE"
  | "AGENT_RUN_APPROVAL_ALREADY_DECIDED"
  | "LIVE_NOT_CONFIGURED"
  | "LIVE_RUNS_DISABLED";

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
  AGENT_RUN_NOT_APPROVAL_ELIGIBLE: {
    status: 409,
    message: "The agent run is not eligible for an approval decision.",
  },
  AGENT_RUN_APPROVAL_ALREADY_DECIDED: {
    status: 409,
    message: "The agent run already has a recorded approval decision that does not match this request.",
  },
  // Both are admission failures: they are decided before any AgentRun row
  // exists, so no run resource is created and an error envelope is the honest
  // response. A failure *after* the row exists returns 201 with the persisted
  // FAILED run instead — see agent-runs.controller.ts.
  //
  // Two distinct codes, same status. A public caller that inspects the error
  // code (rather than just the HTTP status or the near-identical message
  // text) can tell no-credential apart from switched-off — the codes are not
  // collapsed. The similar wording is only so neither message body leaks more
  // about the deployment's security posture than the code already does.
  LIVE_NOT_CONFIGURED: {
    status: 503,
    message: "Live agent runs are not available on this server.",
  },
  LIVE_RUNS_DISABLED: {
    status: 503,
    message: "Live agent runs are currently disabled.",
  },
};
