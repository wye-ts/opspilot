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
  | "LIVE_RUNS_DISABLED"
  | "LIVE_RUN_ACCESS_DENIED"
  | "LIVE_RUN_RATE_LIMITED"
  | "LIVE_RUN_CONCURRENCY_LIMIT"
  | "LIVE_RUN_ATTEMPT_LIMIT"
  | "LIVE_RUN_BUDGET_EXHAUSTED"
  | "LIVE_RUN_IDEMPOTENCY_KEY_INVALID"
  | "LIVE_RUN_CONTEXT_INVALID"
  // PUBLIC trial only (issue #39). Its own distinct code — unlike
  // LIVE_RUN_BUDGET_EXHAUSTED, it needs no internal reason classification,
  // since it already carries an unambiguous meaning.
  | "LIVE_RUN_VISITOR_QUOTA_EXHAUSTED"
  // PUBLIC trial only. Distinct and retryable: the frontend re-presents the
  // Turnstile widget rather than offering the FAKE demo, which is what
  // every OTHER PUBLIC rejection does.
  | "LIVE_RUN_TURNSTILE_FAILED";

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
  // 401, not 403: the caller may retry with a credential. The message is fixed
  // and says nothing about whether a token was supplied, whether it was
  // well-formed, or how close it was — every rejection reads identically, and
  // the provided value is never echoed.
  LIVE_RUN_ACCESS_DENIED: {
    status: 401,
    message: "A valid live demo access token is required for a live agent run.",
  },
  // The four 429s below are all admission failures decided before any AgentRun
  // row exists, so no run resource is created and no reservation is consumed.
  //
  // Distinct codes, one status. A caller that reads the code can tell "slow
  // down" from "this job is used up" from "the demo is done for today" — which
  // is genuinely actionable and reveals nothing quantitative. No message
  // carries a limit, a count, a remaining quota, or a budget figure.
  LIVE_RUN_RATE_LIMITED: {
    status: 429,
    message: "Too many live agent run requests. Retry after the interval given in Retry-After.",
  },
  LIVE_RUN_CONCURRENCY_LIMIT: {
    status: 429,
    message: "Another live agent run is already in progress. Retry shortly.",
  },
  LIVE_RUN_ATTEMPT_LIMIT: {
    status: 429,
    message: "This agent job has reached its live run attempt limit.",
  },
  LIVE_RUN_BUDGET_EXHAUSTED: {
    status: 429,
    message: "The live agent run allowance for today has been used. The deterministic demo remains available.",
  },
  // PUBLIC trial only. Same opacity discipline as the code above: no count, no
  // remaining allowance, nothing that distinguishes "this visitor already
  // used today's trial" from any other closed-gate reason at the wire level
  // beyond the code itself.
  LIVE_RUN_VISITOR_QUOTA_EXHAUSTED: {
    status: 429,
    message: "Your live trial run for today has already been used. The deterministic demo remains available.",
  },
  // 401, matching LIVE_RUN_ACCESS_DENIED: both are "present a fresh credential
  // and retry" rejections on the same admission step. Retryable, unlike a
  // quota rejection — a caller may re-solve the challenge and try again.
  LIVE_RUN_TURNSTILE_FAILED: {
    status: 401,
    message: "The bot challenge could not be verified. Please solve it again and retry.",
  },
  // 400, and decided in the same breath as body validation — before the token
  // check, before the rate limiter, and before any lease is taken. A malformed
  // key is a malformed request, exactly like a misspelled providerMode, and the
  // body pipe already answers that class of problem before admission runs.
  //
  // The message names the requirement rather than the offending value: it never
  // echoes what was sent, and it never reports whether a key was absent or
  // merely wrong, so it cannot be used to probe what the server already has.
  LIVE_RUN_IDEMPOTENCY_KEY_INVALID: {
    status: 400,
    message: "A live agent run requires an Idempotency-Key header containing a UUID.",
  },
  // 422, not 409 and not 400. The request itself is well-formed (400 would be
  // wrong) and nothing is concurrently conflicting with it (409 would imply a
  // race that resolving could clear). The referenced job is simply not something
  // this server will execute in LIVE mode: it was created under older input
  // rules, and repeating the request will never change that.
  //
  // The message is actionable and says nothing internal — no stored summary, no
  // measured length, no schema name, no SQL. It states the current rule, which
  // is public and already enforced on POST /v1/agent-jobs, and tells the caller
  // the one thing that works.
  LIVE_RUN_CONTEXT_INVALID: {
    status: 422,
    message:
      "This investigation was created under older input rules and cannot run in LIVE mode. Start a new investigation with a 15–2000 character summary.",
  },
};
