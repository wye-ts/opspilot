import { useEffect, useId, useRef, useState } from "react";

import type { CapabilitiesView } from "../api/types";

export type ProviderModeChoice = "FAKE" | "LIVE";

export interface InvestigationFormSubmission {
  readonly summary: string;
  readonly approvalDemo: boolean;
  readonly providerMode: ProviderModeChoice;
  /**
   * Present only for a LIVE submission. Travels to the API client, which puts it
   * in a request header and nowhere else.
   */
  readonly liveAccessToken?: string;
}

/**
 * The retained job a LIVE recovery would address.
 *
 * Present ONLY when job creation succeeded and the LIVE run request then failed.
 * Its presence switches the whole form into "Recover Live Run" mode, where the
 * ticket and summary are facts about a row that already exists in PostgreSQL
 * rather than fields the user is composing.
 */
export interface LiveRetryTarget {
  readonly jobId: string;
  readonly ticketId: string;
  readonly summary: string;
}

export interface InvestigationFormProps {
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly capabilities: CapabilitiesView | null;
  readonly onSubmit: (submission: InvestigationFormSubmission) => void;
  /**
   * Non-null puts the form in retry mode. `null` is the ordinary
   * new-investigation form.
   */
  readonly liveRetryTarget: LiveRetryTarget | null;
  /**
   * Submitting in recovery mode. Takes ONLY the freshly typed token: everything
   * else is already fixed — the job by the retained row, the request identity by
   * the key App.tsx carries — and passing a summary here would imply the
   * submission could change what is being recovered.
   */
  readonly onRetryLiveRun: (liveAccessToken: string) => void;
  /** Abandons the retained partial workflow. Local state only — see App.tsx. */
  readonly onStartNewInvestigation: () => void;
}

// The trimmed bounds the API enforces (packages/contracts TicketContextSchema).
// Mirrored here as an AFFORDANCE only — the backend remains authoritative, and a
// request that bypasses this UI with a short summary still receives a 400.
export const SUMMARY_MIN_LENGTH = 15;
export const SUMMARY_MAX_LENGTH = 2000;

const LIVE_UNAVAILABLE_REASON =
  "Live Claude is temporarily unavailable — the deterministic demo is always available.";

// Owns only `summary`, `approvalDemo`, the provider mode, and the live token —
// no ticket-ID field exists here or anywhere in the app. The internal ticket ID
// is derived by App at submit time (see App.tsx).
export function InvestigationForm({
  disabled,
  submitLabel,
  capabilities,
  onSubmit,
  liveRetryTarget,
  onRetryLiveRun,
  onStartNewInvestigation,
}: InvestigationFormProps) {
  const [summary, setSummary] = useState("");
  const [approvalDemo, setApprovalDemo] = useState(false);
  const [providerMode, setProviderMode] = useState<ProviderModeChoice>("FAKE");
  /**
   * MEMORY ONLY.
   *
   * Plain React state, deliberately. There is no localStorage, sessionStorage,
   * cookie, or URL write anywhere in this component — a page reload clears the
   * token by construction rather than by a cleanup handler that could be missed,
   * and a shared demo credential never outlives the tab that typed it.
   */
  const [liveAccessToken, setLiveAccessToken] = useState("");

  const summaryId = useId();
  const approvalDemoId = useId();
  const tokenId = useId();
  const modeGroupId = useId();
  const retryHeadingId = useId();

  // A ref, not state: it must take effect synchronously on the very next
  // click, before React has had a chance to re-render with `disabled=true`
  // from the parent. This is what stops a rapid double-click from calling
  // onSubmit twice — the `disabled` prop alone cannot, since it only updates
  // after a render.
  const submittingRef = useRef(false);

  const trimmedSummary = summary.trim();
  const summaryLongEnough = trimmedSummary.length >= SUMMARY_MIN_LENGTH;
  const summaryShortEnough = trimmedSummary.length <= SUMMARY_MAX_LENGTH;

  const liveAvailable = capabilities?.liveAgentRuns === "AVAILABLE";
  // NOTE: `capabilities.liveAccess` is deliberately NOT consulted here. It once
  // decided whether a token was required at all, which is what allowed a
  // tokenless LIVE submission — see `tokenSatisfied` below. Availability governs
  // whether LIVE can be offered; it never governs whether it needs authenticating.
  // `!= null` catches BOTH null and undefined on purpose. `null` is the real
  // "not retrying" value, but a caller that omits the prop entirely must land on
  // the ordinary creation form — defaulting the other way would silently render
  // a retry banner with no job to retry.
  const retrying = liveRetryTarget != null;
  // In retry mode the provider is fixed to LIVE by the retained job, not by the
  // radio group — the run being retried was a live run, and a retry must not be
  // able to become a different kind of run.
  const liveSelected = retrying || providerMode === "LIVE";
  // A LIVE submission with no token would be a guaranteed 401, so the button
  // stays disabled rather than spending a round trip to be told so.
  /**
   * A LIVE submission ALWAYS needs a token. Not "when the current capability
   * snapshot says so".
   *
   * The previous rule was `!tokenRequired || token.length > 0`, which let an
   * UNAVAILABLE snapshot make a tokenless LIVE submission look valid — the token
   * field was hidden and the submit button enabled. If the preflight then found
   * that LIVE had recovered, the browser would create an AgentJob and send an
   * unauthenticated run request, earning an avoidable 401 and stranding a
   * partial workflow.
   *
   * Availability and authentication are different questions. Capability governs
   * the first; the protected public path requires the second unconditionally.
   */
  const tokenSatisfied = !liveSelected || liveAccessToken.trim().length > 0;

  // Recovery validates ONLY the token. The summary belongs to a row that already
  // exists in PostgreSQL and is not being submitted, so re-checking its length
  // here would let a stored value block a recovery of a run that may already
  // have executed.
  const canSubmit = retrying
    ? !disabled && tokenSatisfied
    : !disabled && summaryLongEnough && summaryShortEnough && tokenSatisfied;

  /**
   * Switching mode is what clears the cross-mode state, in both directions.
   *
   * Back to FAKE clears the token, so it does not linger in memory for a session
   * that has stopped using it. Forward to LIVE clears `approvalDemo`, because the
   * deterministic TICKET-APPROVAL-DEMO scenario has no meaning for a live run —
   * and a live run must never be started under that ticket ID.
   */
  function selectMode(next: ProviderModeChoice) {
    setProviderMode(next);
    if (next === "FAKE") {
      setLiveAccessToken("");
    } else {
      setApprovalDemo(false);
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || submittingRef.current) return;
    submittingRef.current = true;

    if (retrying) {
      // A DIFFERENT handler, not `onSubmit` with extra flags. The two operations
      // hit different endpoints — recovery never touches POST /v1/agent-jobs —
      // and routing them through one callback is exactly how a recovery would
      // end up creating a replacement job by accident.
      onRetryLiveRun(liveAccessToken);
      return;
    }

    onSubmit({
      summary: trimmedSummary,
      // Belt and braces alongside selectMode: a LIVE submission can never carry
      // approvalDemo, whatever sequence of clicks produced this state.
      approvalDemo: liveSelected ? false : approvalDemo,
      providerMode,
      ...(liveSelected && liveAccessToken !== "" ? { liveAccessToken } : {}),
    });
  }

  // Whether the previous render was mid-workflow. Needed to tell "a workflow
  // just ended" from "the form has never run one" — `disabled` is false in both
  // cases, and only the first should clear the token.
  const wasDisabledRef = useRef(false);

  /**
   * Unlocks the form once the parent signals the workflow is no longer active,
   * and CLEARS THE TOKEN at the same moment.
   *
   * The token authorizes one run. Leaving it in the field afterwards would make
   * the field itself the long-lived store the parent no longer is — a shared demo
   * credential sitting in the DOM for the rest of the session, one stray click
   * away from starting another paid run. Clearing on the busy→idle edge covers
   * every terminal outcome with one rule: success, failure, and cancellation all
   * end the same way.
   *
   * The consequence is deliberate: recovering a live run means typing the token
   * again. That is the intended cost of not keeping it.
   */
  useEffect(() => {
    if (!disabled) {
      submittingRef.current = false;
      if (wasDisabledRef.current) setLiveAccessToken("");
    }
    wasDisabledRef.current = disabled;
  }, [disabled]);

  /**
   * Entering recovery mode — or switching to a different retained job — starts
   * from an empty token field.
   *
   * Belt and braces alongside the busy→idle clear above, which already runs on
   * the failure that produces this state. Stating it independently means the
   * "starts empty" guarantee does not depend on the exact order of two effects,
   * and it holds even if a future path reaches retry mode some other way.
   */
  const retryTargetJobId = liveRetryTarget?.jobId ?? null;
  useEffect(() => {
    if (retryTargetJobId !== null) setLiveAccessToken("");
  }, [retryTargetJobId]);

  return (
    <form className="investigation-form" onSubmit={handleSubmit} aria-busy={disabled}>
      {/*
        RECOVERY MODE. Rendered instead of the provider selector and the editable
        summary, because in this mode neither is a choice: the job row already
        exists in PostgreSQL with its ticket and summary, and it was created for a
        LIVE run. Showing an editable summary here would imply a recovery could
        change the investigation it recovers — it cannot, and silently ignoring an
        edit would be worse than not offering one.
      */}
      {retrying && liveRetryTarget !== null ? (
        <div className="form-field form-retry-banner" role="group" aria-labelledby={retryHeadingId}>
          <h2 id={retryHeadingId} className="form-retry-heading">
            Recover Live Run
          </h2>
          <p className="form-help">
            The investigation was created, but the live run did not return an answer. Re-enter
            the live demo access token to recover <strong>this same investigation</strong> — no
            new investigation is created. If the original run did start, it is returned as it
            stands and nothing is charged again; only if it never started is one run attempted.
          </p>
          {/*
            Shown ONLY in recovery mode, and only when new runs are closed.

            Recovery is deliberately not gated on the capability snapshot (see
            App.tsx): availability answers "may a NEW paid run start?", and the
            request being recovered is very often what closed it. So the banner
            explains why the button is still live rather than leaving the user to
            reconcile it with a disabled LIVE option elsewhere.

            The wording promises nothing about the outcome, on purpose. The server
            may still refuse for provider configuration, the kill switch, an
            invalid token, a persistence failure, or because no run was ever
            created for this key — in which case the ordinary new-run rules apply
            and may well reject it.
          */}
          {!liveAvailable ? (
            <p className="form-help">
              New Live Claude runs are currently unavailable. Recovery of an existing request is
              still allowed.
            </p>
          ) : null}
          <dl className="form-retry-details">
            <div>
              <dt>Ticket ID</dt>
              <dd className="mono">{liveRetryTarget.ticketId}</dd>
            </div>
            <div>
              <dt>Job ID</dt>
              <dd className="mono">{liveRetryTarget.jobId}</dd>
            </div>
            <div>
              <dt>Issue summary</dt>
              <dd>{liveRetryTarget.summary}</dd>
            </div>
            <div>
              <dt>Provider</dt>
              <dd>Live Claude</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {!retrying ? (
      <fieldset className="form-field form-field-modes" disabled={disabled}>
        <legend id={modeGroupId}>Provider</legend>
        <div className="mode-options" role="radiogroup" aria-labelledby={modeGroupId}>
          <label className="mode-option">
            <input
              type="radio"
              name="providerMode"
              value="FAKE"
              checked={providerMode === "FAKE"}
              onChange={() => selectMode("FAKE")}
            />
            <span className="mode-option-label">Demo — FAKE</span>
            <span className="mode-option-help">Deterministic, fast, no model cost.</span>
          </label>

          <label className="mode-option">
            <input
              type="radio"
              name="providerMode"
              value="LIVE"
              checked={providerMode === "LIVE"}
              // Rendered DISABLED with a visible reason rather than hidden: a
              // hidden control makes the feature look absent rather than
              // protected.
              disabled={!liveAvailable}
              onChange={() => selectMode("LIVE")}
            />
            <span className="mode-option-label">Live Claude</span>
            <span className="mode-option-help">
              {liveAvailable
                ? "Real claude-sonnet-5. Protected by availability and usage limits."
                : LIVE_UNAVAILABLE_REASON}
            </span>
          </label>
        </div>
      </fieldset>
      ) : null}

      {!retrying ? (
      <div className="form-field">
        <label htmlFor={summaryId}>Issue Summary</label>
        <textarea
          id={summaryId}
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          disabled={disabled}
          rows={4}
          aria-describedby={`${summaryId}-help`}
          placeholder="Describe the issue — e.g. Elevated API error rate on billing-service"
        />
        <p id={`${summaryId}-help`} className="form-help">
          <span>Describe the issue in at least {SUMMARY_MIN_LENGTH} characters.</span>{" "}
          <span className="form-counter">
            {trimmedSummary.length} / {SUMMARY_MIN_LENGTH}
          </span>
          {!summaryShortEnough ? (
            <span className="form-error"> Maximum {SUMMARY_MAX_LENGTH} characters.</span>
          ) : null}
        </p>
      </div>
      ) : null}

      {/*
        Hidden entirely for LIVE. The approval-workflow demo is a property of the
        deterministic scenario, so offering it beside a live run would promise
        behaviour the live provider does not produce.
      */}
      {!liveSelected ? (
        <div className="form-field form-field-checkbox">
          <input
            id={approvalDemoId}
            type="checkbox"
            checked={approvalDemo}
            onChange={(event) => setApprovalDemo(event.target.checked)}
            disabled={disabled}
          />
          <label htmlFor={approvalDemoId}>Approval workflow demo</label>
        </div>
      ) : null}

      {/*
        Rendered whenever LIVE is selected — including retained retry mode — and
        NOT gated on the capability snapshot. A hidden field with a required
        value is how a tokenless submission became possible.
      */}
      {liveSelected ? (
        <div className="form-field">
          <label htmlFor={tokenId}>Live demo access token</label>
          <input
            id={tokenId}
            // type=password so the value is not shoulder-readable and browsers do
            // not offer to autofill it into unrelated fields.
            type="password"
            value={liveAccessToken}
            onChange={(event) => setLiveAccessToken(event.target.value)}
            disabled={disabled}
            autoComplete="off"
            aria-describedby={`${tokenId}-help`}
          />
          <p id={`${tokenId}-help`} className="form-help">
            Used only for this browser session. Not stored on this device.
          </p>
        </div>
      ) : null}

      <div className="form-actions">
        <button type="submit" disabled={!canSubmit}>
          {retrying && !disabled ? "Recover Live Run" : submitLabel}
        </button>

        {/*
          The escape hatch. Without it the retained job is a trap: the only
          submit action retries it, so a user who no longer wants to would have
          to reload the page. Clears LOCAL state only — the job row and any runs
          stay exactly as they are on the server.
        */}
        {retrying ? (
          <button
            type="button"
            className="form-secondary-action"
            onClick={onStartNewInvestigation}
            disabled={disabled}
          >
            Start new investigation
          </button>
        ) : null}
      </div>
    </form>
  );
}
