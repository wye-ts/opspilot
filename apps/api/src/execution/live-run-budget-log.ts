import { PersistenceError } from "@opspilot/database";

/**
 * Runs a logging side effect and swallows anything it throws.
 *
 * Logging is an OBSERVER. It must never be able to change what the observed code
 * does — and a `console` replaced by a test double, a log-shipping transport, or
 * a serializer that chokes on a value can all throw. Without this boundary, a
 * throwing sink in the admission path would discard an already-acquired
 * concurrency lease (wedging the single LIVE slot until restart) or replace a
 * precise ApiError with an unrelated one; in the reconciliation path it would
 * turn a successful run's 201 into a 500.
 *
 * The catch is deliberately EMPTY. Reporting a logging failure would mean
 * logging — through the same sink that just failed — which is either a second
 * throw or an unbounded recursion. There is no third thing to do with it, and
 * the caller's own result is the outcome that matters.
 */
export function emitLogSafely(emit: () => void): void {
  try {
    emit();
  } catch {
    // Intentionally ignored. See above: there is no safe way to report this.
  }
}

/**
 * The closed set of error classifications this module will emit.
 *
 * `error.name` is a plain, WRITABLE property — `Object.assign(err, { name: ... })`
 * sets it to any string at all, and an error crossing a package boundary is not
 * something this module controls. Emitting it directly would therefore have been
 * a free-text channel wearing a fixed-field costume: exactly the leak the rest of
 * this shape exists to prevent.
 *
 * So the name is not forwarded, it is CLASSIFIED — mapped onto one of three
 * constants by structural checks that no attacker-controlled string can affect.
 */
type ReconciliationErrorName = "PersistenceError" | "Error" | "UnknownError";

function classifyError(error: unknown): ReconciliationErrorName {
  // Order matters: PersistenceError is an Error, so the narrower test comes
  // first. Both are `instanceof` checks against real constructors — a value
  // cannot fake its way into a classification by setting a property.
  if (error instanceof PersistenceError) return "PersistenceError";
  if (error instanceof Error) return "Error";
  return "UnknownError";
}

/**
 * The only place a budget-reconciliation failure reaches the server log.
 *
 * A FIXED SHAPE with a fixed field set, and — critically — NO free text. An
 * earlier version emitted `error.message`, on the reasoning that PersistenceError
 * messages are already sanitized. That reasoning does not hold: this function is
 * handed whatever the failing call threw, and the `error` parameter is `unknown`
 * precisely because it may not be a PersistenceError at all. A driver-level throw
 * carries the connection string; a query builder's throw carries SQL text. Both
 * would have gone straight to stdout, which on this deployment means the hosting
 * provider's log aggregator.
 *
 * So the message is not sanitized here — it is never read. Only two FIXED
 * classifications are emitted, both drawn from closed sets: a three-value
 * classification derived from the error's CONSTRUCTOR (never its writable `name`
 * property — see classifyError), and the PersistenceError code when there is one.
 * Neither can contain caller data.
 *
 * Never logged: the Anthropic credential, the shared demo token, any prompt or
 * provider response body, SQL, a DSN, a stack, or any raw error text.
 *
 * `budgetDate` and `runId` ARE logged: they are the two identifiers an operator
 * needs to find the affected row and reconcile it by hand, and neither is
 * sensitive. No cost figure or count is included — a failed reconciliation has no
 * trustworthy numbers to report by definition.
 *
 * Matches the one-line JSON convention LoggingInterceptor and logProviderEvent
 * already use, so all three are greppable together.
 */
export function logBudgetReconciliationFailure(params: {
  readonly budgetDate: string;
  readonly runId: string | null;
  readonly error: unknown;
}): void {
  const { error } = params;

  emitLogSafely(() =>
    console.error(
      JSON.stringify({
        event: "live_run_budget_reconciliation_failed",
        budgetDate: params.budgetDate,
        runId: params.runId,
        // One of exactly three constants, chosen by constructor. Never the
        // error's own `name`, which any thrown value can set to arbitrary text.
        errorName: classifyError(error),
        // A closed enum from @opspilot/database, or null when the throw was not a
        // PersistenceError. Deliberately NOT a fallback to some other string field:
        // "no code" is the honest answer, and any substitute would reintroduce
        // exactly the free text this shape exists to exclude.
        errorCode: error instanceof PersistenceError ? error.code : null,
      }),
    ),
  );
}

/**
 * How one LIVE admission decision is recorded.
 *
 * A type rather than a bare function reference so the admission controller takes
 * it as an injected dependency — which is what lets tests assert the emitted
 * shape directly instead of parsing stdout.
 *
 * THREE decisions, from a closed set, and the third is why the set is not two.
 * `replayed` means the request was answered by returning a run an earlier request
 * with the same key had already created: no rate-limit slot consumed, no budget
 * read, no concurrency lease, no attempt, no provider call. Recording that as
 * `admitted` would have made a free recovery indistinguishable from a new paid
 * execution in the one place an operator looks to count them.
 */
export type LiveRunAdmissionDecisionLogger = (params: {
  readonly decision: "admitted" | "replayed" | "rejected";
  readonly code: string | null;
  /**
   * Issue #39 — internal-only classification of WHICH condition closed the
   * shared budget gate, set only when `code` is `LIVE_RUN_BUDGET_EXHAUSTED`
   * (see `LiveRunBudgetRejectionReason` in @opspilot/database). `null` for
   * every other decision and every other rejection code — this is never a
   * generic free-text field.
   */
  readonly reason?: string | null;
}) => void;

/**
 * One structured line per LIVE admission decision, emitted by the admission
 * controller for every request it admits, replays, or rejects.
 *
 * Carries no budget figures, counts, or headroom — those belong in the database,
 * not in a log line an operator might paste into an issue. It carries no token,
 * no header value, and no client address either. The decision and its fixed
 * catalog code (plus, for a budget-exhausted rejection, the closed `reason`
 * classification) are what make the safeguards observable; everything
 * quantitative about them stays private.
 */
export const logLiveRunAdmissionDecision: LiveRunAdmissionDecisionLogger = (params) => {
  emitLogSafely(() =>
    console.log(
      JSON.stringify({
        event: "live_run_admission",
        decision: params.decision,
        code: params.code,
        reason: params.reason ?? null,
      }),
    ),
  );
};
