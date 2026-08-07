import { ApiRequestError } from "./http-client";

/**
 * Every poll error is classified into exactly one of these four kinds.
 * The polling state machine (§3) and the failure table (§7) both describe
 * this classifier's output — there is no second independent rule.
 */
export type PollErrorClassification =
  | { readonly kind: "transient" }
  | { readonly kind: "permanent-invalid" }
  | { readonly kind: "not-found" }
  | { readonly kind: "data-corrupt" };

/**
 * The single source of truth mapping an {@link ApiRequestError.code} to a
 * poll-error classification. A plain network/fetch throw (not an
 * `ApiRequestError`) is classified as `transient`.
 */
export function classifyInvestigationPollError(error: unknown): PollErrorClassification {
  if (!(error instanceof ApiRequestError)) return { kind: "transient" };

  switch (error.code) {
    case "AGENT_JOB_NOT_FOUND":
      return { kind: "not-found" };
    case "INTERNAL_DATA_INVALID":
      return { kind: "data-corrupt" };
    case "ROUTE_PARAMETER_INVALID":
      return { kind: "permanent-invalid" };
    case "PERSISTENCE_UNAVAILABLE":
      return { kind: "transient" };
    default:
      // Any other 5xx: bounded retry — a conservative default that never
      // silently retries a KNOWN non-recoverable data-corruption code forever,
      // and never gives up on a genuinely transient server hiccup on its first
      // observation. Any other 4xx: permanent-invalid — fail closed rather than
      // retry a request the server has indicated it will never accept.
      return error.status >= 500 ? { kind: "transient" } : { kind: "permanent-invalid" };
  }
}
