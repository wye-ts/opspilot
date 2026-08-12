import { useEffect, useId, useRef, useState } from "react";

import type { CapabilitiesView } from "../api/types";
import { presentProviders } from "../provider/provider-presentation";
import { ProviderCard } from "./ProviderCard";
import { TurnstileChallenge } from "./TurnstileChallenge";

export type ProviderModeChoice = "FAKE" | "LIVE";

export interface InvestigationFormSubmission {
  readonly summary: string;
  readonly approvalDemo: boolean;
  readonly providerMode: ProviderModeChoice;
  /**
   * Present only for a PRIVATE LIVE submission. Travels to the API client,
   * which puts it in a request header and nowhere else.
   */
  readonly liveAccessToken?: string;
  /**
   * Present only for a PUBLIC trial LIVE submission (issue #39) — mutually
   * exclusive with `liveAccessToken`, mirroring the server's own
   * per-deployment access mode. Travels to the API client, which puts it in
   * a request header and nowhere else.
   */
  readonly turnstileToken?: string;
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
  /**
   * Pre-selects the deterministic approval-demo scenario on the FAKE/Demo path
   * when the page carries `?approval-demo=1` (read once at App mount). Only a
   * default — the user can still switch to a non-demo run, and switching to
   * LIVE clears it exactly as before.
   */
  readonly defaultApprovalDemo?: boolean;
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

// The PUBLIC trial's stricter ceiling (issue #39) — mirrors
// PUBLIC_TICKET_SUMMARY_MAX_LENGTH (packages/contracts) exactly. The floor is
// shared with the private bound; only the ceiling tightens.
export const PUBLIC_SUMMARY_MAX_LENGTH = 300;

// Owns only `summary`, `approvalDemo`, the provider mode, and the live token —
// no ticket-ID field exists here or anywhere in the app. The internal ticket ID
// is derived by App at submit time (see App.tsx).
export function InvestigationForm({
  disabled,
  submitLabel,
  capabilities,
  defaultApprovalDemo = false,
  onSubmit,
  liveRetryTarget,
  onRetryLiveRun,
  onStartNewInvestigation,
}: InvestigationFormProps) {
  const [summary, setSummary] = useState("");
  const [approvalDemo, setApprovalDemo] = useState(defaultApprovalDemo);
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
  /**
   * Issue #39 — the solved Turnstile token, held only for the duration of one
   * PUBLIC trial submission. `null` means "no valid, unexpired solve held
   * right now" — the same role `liveAccessToken`'s emptiness plays for the
   * private path, and the reason `canSubmit` treats them identically.
   */
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  /**
   * Bumped on the same busy→idle edge that clears the token, and passed to
   * `<TurnstileChallenge key={...}>` below — forcing a full remount, which is
   * what makes the widget itself re-render a fresh, unsolved challenge rather
   * than sitting there visually "solved" while `turnstileToken` has already
   * been cleared underneath it (a state the widget's own callback would never
   * fire again to correct, since nothing re-triggers it).
   */
  const [turnstileResetKey, setTurnstileResetKey] = useState(0);

  const summaryId = useId();
  const tokenId = useId();
  const modeGroupId = useId();
  const retryHeadingId = useId();

  // A ref, not state: it must take effect synchronously on the very next
  // click, before React has had a chance to re-render with `disabled=true`
  // from the parent. This is what stops a rapid double-click from calling
  // onSubmit twice — the `disabled` prop alone cannot, since it only updates
  // after a render.
  const submittingRef = useRef(false);

  /**
   * Narrows `capabilities` to the PUBLIC_TRIAL variant, or `null` — the one
   * place that discriminant is checked, so every other PUBLIC-specific value
   * below (`visitorRunsRemaining`, `turnstileSiteKey`) reads off THIS rather
   * than re-narrowing `capabilities` independently and risking disagreement.
   */
  const publicTrialCapabilities =
    capabilities !== null && capabilities.liveAccess === "PUBLIC_TRIAL" ? capabilities : null;
  const isPublicTrial = publicTrialCapabilities !== null;

  // `!= null` catches BOTH null and undefined on purpose. `null` is the real
  // "not retrying" value, but a caller that omits the prop entirely must land on
  // the ordinary creation form — defaulting the other way would silently render
  // a retry banner with no job to retry.
  const retrying = liveRetryTarget != null;
  // In retry mode the provider is fixed to LIVE by the retained job, not by the
  // radio group — the run being retried was a live run, and a retry must not be
  // able to become a different kind of run.
  const liveSelected = retrying || providerMode === "LIVE";

  const trimmedSummary = summary.trim();
  const summaryLongEnough = trimmedSummary.length >= SUMMARY_MIN_LENGTH;
  // PUBLIC's ceiling is stricter (300, not 2000) — but only while LIVE is
  // actually selected under a PUBLIC_TRIAL deployment; the FAKE form (and a
  // TOKEN_REQUIRED deployment's LIVE form) keep the private 2000 ceiling.
  // Retry mode never applies here: PUBLIC has no retry mechanism (exactly 1
  // attempt, no retry), so `isPublicTrial` and `retrying` are never both true.
  const effectiveSummaryMaxLength =
    isPublicTrial && liveSelected ? PUBLIC_SUMMARY_MAX_LENGTH : SUMMARY_MAX_LENGTH;
  const summaryShortEnough = trimmedSummary.length <= effectiveSummaryMaxLength;

  // Single source of truth for both provider cards (labels, availability,
  // pills, unavailable reasons) — the same pure mapping the card components
  // render. `liveAvailable` is the card-level truth used by the retry banner
  // below and the token-required gating.
  const providers = presentProviders(capabilities);
  const liveAvailable = !providers.live.disabled;
  // NOTE: `capabilities.liveAccess` is deliberately NOT consulted here beyond
  // the PUBLIC_TRIAL narrowing above. It once decided whether a token was
  // required at all, which is what allowed a tokenless LIVE submission — see
  // `tokenSatisfied` below. Availability governs whether LIVE can be offered;
  // it never governs whether it needs authenticating.
  // A LIVE submission with no credential would be a guaranteed rejection, so
  // the button stays disabled rather than spending a round trip to be told so.
  /**
   * A LIVE submission ALWAYS needs a credential. Not "when the current
   * capability snapshot says so".
   *
   * The previous rule was `!tokenRequired || token.length > 0`, which let an
   * UNAVAILABLE snapshot make a tokenless LIVE submission look valid — the token
   * field was hidden and the submit button enabled. If the preflight then found
   * that LIVE had recovered, the browser would create an AgentJob and send an
   * unauthenticated run request, earning an avoidable 401 and stranding a
   * partial workflow.
   *
   * Availability and authentication are different questions. Capability governs
   * the first; whichever protected path is active requires the second
   * unconditionally — a private access token, or (issue #39) a solved
   * Turnstile challenge. The two are mutually exclusive per deployment, so
   * exactly one of these two checks is ever the live one.
   */
  const tokenSatisfied = !liveSelected || (isPublicTrial ? turnstileToken !== null : liveAccessToken.trim().length > 0);

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
      setTurnstileToken(null);
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
      ...(liveSelected && !isPublicTrial && liveAccessToken !== "" ? { liveAccessToken } : {}),
      ...(liveSelected && isPublicTrial && turnstileToken !== null ? { turnstileToken } : {}),
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
      if (wasDisabledRef.current) {
        setLiveAccessToken("");
        // Issue #39: a solved Turnstile token authorizes exactly one attempt,
        // same as the private token above. Bumping the reset key remounts the
        // widget so the user sees a fresh, unsolved challenge rather than one
        // that still looks solved after its token was already spent.
        setTurnstileToken(null);
        setTurnstileResetKey((key) => key + 1);
      }
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
              New Live runs are currently unavailable. Recovery of an existing request is
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
              <dd>Live</dd>
            </div>
          </dl>
        </div>
      ) : null}

      {/*
        Issue #41 polish §6 — compact top availability notice. Rendered only
        when a real, pre-job capability snapshot says LIVE is closed. It is a
        one-line summary; the Live provider card beneath it carries the fuller
        truthful reason. Never renders while a recovery banner is showing (in
        retry mode the provider selector is gone and the notice would be
        explaining a card that does not exist). Runtime truth wins: wording
        follows the actual capability state (temporary vs. daily-quota).
      */}
      {!retrying && !liveAvailable && providers.live.pill !== null ? (
        <p className="composer-availability-notice">
          {providers.live.pill.text === "Daily trial used"
            ? "Live unavailable for today — daily trial used"
            : "Live is temporarily unavailable"}
        </p>
      ) : null}

      {!retrying ? (
      <fieldset className="form-field form-field-modes" disabled={disabled}>
        <legend id={modeGroupId}>Provider</legend>
        <div className="provider-cards" role="radiogroup" aria-labelledby={modeGroupId}>
          <ProviderCard
            presentation={providers.demo}
            name="providerMode"
            checked={providerMode === "FAKE"}
            onChange={() => selectMode("FAKE")}
            disabled={disabled}
          />
          <ProviderCard
            presentation={providers.live}
            name="providerMode"
            checked={providerMode === "LIVE"}
            onChange={() => selectMode("LIVE")}
            disabled={disabled}
          />
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
          // Tightened from 4 → 3 (Issue #41 polish §3) so the Fresh composer
          // reads as a focused operational tool, not a landing page. Still
          // comfortably tappable on mobile.
          rows={3}
          aria-describedby={`${summaryId}-help`}
          placeholder="Describe the issue — e.g. Elevated API error rate on billing-service"
        />
        {/*
          Progressive validation (§8): empty = subtle helper, 1-14 trimmed chars
          = amber add-more-detail warn, >=15 = helper/count disappears and the
          CTA enables. No permanent "n / 15" counter.
        */}
        {trimmedSummary.length >= SUMMARY_MIN_LENGTH ? null : trimmedSummary.length === 0 ? (
          <p id={`${summaryId}-help`} className="form-help form-help--subtle">
            Describe the issue in at least {SUMMARY_MIN_LENGTH} characters.
          </p>
        ) : (
          <p id={`${summaryId}-help`} className="form-help form-help--warn">
            Add more detail — the issue summary needs at least {SUMMARY_MIN_LENGTH} characters.
          </p>
        )}
        {!summaryShortEnough ? (
          <p className="form-error">Maximum {effectiveSummaryMaxLength} characters.</p>
        ) : null}
      </div>
      ) : null}

      {/*
        Rendered whenever LIVE is selected on the PRIVATE token path —
        including retained retry mode, which only ever exists for that path —
        and NOT gated on the capability snapshot. A hidden field with a
        required value is how a tokenless submission became possible.
        Never rendered under PUBLIC_TRIAL: see TurnstileChallenge below.
      */}
      {liveSelected && !isPublicTrial ? (
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

      {/*
        Issue #39 — rendered ONLY when LIVE is selected under a PUBLIC_TRIAL
        deployment. Never mounted alongside the private token field above; the
        two paths are mutually exclusive per deployment. `key` forces a full
        remount (a fresh, unsolved widget) after every submission — see
        turnstileResetKey.
      */}
      {liveSelected && publicTrialCapabilities !== null ? (
        <TurnstileChallenge
          key={turnstileResetKey}
          siteKey={publicTrialCapabilities.turnstileSiteKey}
          onTokenChange={setTurnstileToken}
        />
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
