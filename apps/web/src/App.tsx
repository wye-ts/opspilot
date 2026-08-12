import { useEffect, useRef, useState } from "react";

import {
  createAgentJob,
  getAgentRun,
  getApproval,
  getCapabilities,
  getInvestigationState,
  recordApproval,
  startAgentRun,
} from "./api/endpoints";
import { ApiRequestError } from "./api/http-client";
import type {
  AgentJobResponse,
  AgentRunDetail,
  AgentRunOutcomeView,
  AgentRunRecordView,
  AgentTraceEvent,
  ApprovalView,
  CapabilitiesView,
  InvestigationStateResponse,
  RecordApprovalDecisionInput,
} from "./api/types";
import type { InvestigationEventRecord, InvestigationRunStatus } from "@opspilot/contracts";
import { ActionRequiredBanner } from "./components/ActionRequiredBanner";
import { AppFooter } from "./components/AppFooter";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { CurrentInvestigation } from "./components/CurrentInvestigation";
import { ErrorBanner, type DisplayableError } from "./components/ErrorBanner";
import { InvestigationForm, type InvestigationFormSubmission } from "./components/InvestigationForm";
import { InvestigationProgressTimeline } from "./components/InvestigationProgressTimeline";
import { ProductHeader } from "./components/ProductHeader";
import { useInvestigationPoll, type PollCallbacks, type PollStopReason } from "./hooks/useInvestigationPoll";
import {
  applyAcceptedSnapshotDerivation,
  type ExecutionStageDerivation,
  type ExecutionStageDerivationState,
} from "./investigation-progress/execution-stage-derivation";
import { isNewerInvestigationSnapshot } from "./investigation-progress/investigation-snapshot";
import {
  isFinalizationAuthorized,
  markFinalizationSettled,
  resolveTerminalObservation,
  type TerminalSettlementClaim,
  type TerminalSettlementIdentity,
} from "./investigation-progress/terminal-settlement";
import {
  isUuid,
  readApprovalDemoParam,
  readJobParam,
  withJobParam,
  withoutJobParam,
} from "./url/investigation-url";
import { InvestigationSummary } from "./components/InvestigationSummary";
import { ReportPanel } from "./components/ReportPanel";
import { SuggestedActionsPanel } from "./components/SuggestedActionsPanel";
import { TraceTimeline } from "./components/TraceTimeline";
import { useElapsedTime, formatElapsed } from "./hooks/useElapsedTime";
import { runStatusBadge } from "./run/run-overview-presentation";
import { findFailedExecutionStageLabel } from "./investigation-progress/execution-stage-rows";
import {
  deriveInvestigationProgressStages,
  stageFailureAnnouncement,
  investigationCompleteAnnouncement,
  INVESTIGATION_COMPLETE_ANNOUNCEMENT,
  APPROVAL_REQUIRED_ANNOUNCEMENT,
  STAGE_LABELS,
  type ApprovalLoadStatus,
  type InvestigationProgressStageKey,
} from "./investigation-progress/investigation-progress-stages";

type Phase =
  | "idle"
  | "checking-availability"
  | "creating-job"
  | "running-agent"
  | "loading-approval"
  | "refreshing-run"
  | "submitting-approval"
  | "resuming";

/**
 * The four request-lifecycle phases below read their text from
 * `STAGE_LABELS` (investigation-progress-stages.ts) — ONE canonical
 * stage-label source for the visual Progress Timeline, the submit button's
 * busy copy, and the sole `role="status"` live region, rather than three
 * independently-worded copies of the same idea that could drift apart.
 */
const PHASE_LABELS: Record<Phase, string> = {
  idle: "Start Investigation",
  /**
   * The LIVE preflight.
   *
   * A real phase rather than a silent await, for two reasons. It is honest — the
   * user has submitted and something is happening — and, more importantly, the
   * form's unlock depends on observing a busy -> idle EDGE. Awaiting the
   * capability refresh before any phase change meant a whole workflow could
   * complete without `disabled` ever rendering `true`, so `submittingRef` was
   * never cleared and the form stayed locked against every later submission,
   * with the token still in the field.
   */
  "checking-availability": STAGE_LABELS.availability.active,
  "creating-job": STAGE_LABELS.job.active,
  "running-agent": STAGE_LABELS.run.active,
  "loading-approval": STAGE_LABELS.approval.active,
  "refreshing-run": "Refreshing…",
  "submitting-approval": "Recording decision…",
  resuming: "Restoring investigation…",
};

/**
 * The poll pause reasons that offer a "Check again" affordance — a fresh
 * bounded polling session for the SAME job, resetting every budget/counter.
 * `terminal` / `not-found` / `permanent-invalid` / `aborted` are genuinely
 * over: no resume is offered for them.
 */
const CHECK_AGAIN_REASONS = new Set<PollStopReason>(["transient-ceiling", "time-ceiling", "data-corrupt"]);

// Fixed, safe wording for a contradictory terminal observation — never
// interpolates either observation's code, message, or report. Worded like
// every other stage-failure announcement (stageFailureAnnouncement).
const TERMINAL_INCONSISTENCY_NOTICE =
  "This investigation reported inconsistent results and could not be settled. Refresh or start a new investigation.";

// Finding 4 (independent review): fixed, safe wording for the two
// PERMANENT poll-failure classifications — never the raw server/persistence
// text, and never a reason to auto-retry.
const INVESTIGATION_NOT_FOUND_NOTICE = "This investigation is no longer available.";
const PERMANENT_POLL_ERROR_NOTICE =
  "This investigation's live progress could not be tracked. The result already shown remains accurate.";

const CONFLICT_APPROVAL_ERROR_CODES = new Set(["AGENT_RUN_APPROVAL_ALREADY_DECIDED", "AGENT_RUN_NOT_APPROVAL_ELIGIBLE"]);

const APPROVAL_DEMO_TICKET_ID = "TICKET-APPROVAL-DEMO";

function generateOrdinaryTicketId(): string {
  return `DEMO-${crypto.randomUUID()}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toDisplayableError(error: unknown): DisplayableError {
  if (error instanceof ApiRequestError) {
    return { code: error.code, message: error.message, requestId: error.requestId };
  }
  return {
    code: "UNEXPECTED_CLIENT_ERROR",
    message: "Something went wrong in the browser. Please try again.",
    requestId: null,
  };
}

// The sole stateful component. Owns the chained create-job -> start-run
// workflow, internal ticket-ID derivation, partial-failure/Retry Run
// recovery, and race safety via an AbortController plus a monotonic
// generation counter (a superseded response's `generation !== current`
// check discards it even if abort() didn't stop it in time).
export function App() {
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [job, setJob] = useState<AgentJobResponse | null>(null);
  const [run, setRun] = useState<AgentRunDetail | null>(null);
  const [approval, setApproval] = useState<ApprovalView | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<DisplayableError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * What the server says it can serve, REFRESHED throughout the tab's life —
   * see refreshCapabilities for the triggers and the race rules.
   *
   * Not a mount-time snapshot: the answer changes on its own (another client
   * reserves or reconciles a run, a limit is reached, a day rolls over, an
   * operator flips the kill switch), so reading it once left the tab presenting
   * state that could be hours out of date.
   *
   * `null` means "not known", which the form treats as LIVE unavailable —
   * failing closed, so the LIVE option is never offered on a stale or failed
   * read.
   */
  const [capabilities, setCapabilities] = useState<CapabilitiesView | null>(null);
  /**
   * The provider MODE of the run currently in flight — and deliberately nothing
   * else.
   *
   * This used to be a `{ providerMode, liveAccessToken }` pair, so the shared
   * demo credential outlived the request it authorized: it sat in component
   * state for the whole session, surviving every completed run, every failure,
   * and every switch back to FAKE, readable by anything with a handle on this
   * component. Keeping it was only ever in service of "Retry Run", which is a
   * poor trade for a credential's lifetime.
   *
   * The token now exists in exactly one place — the form field the user typed it
   * into — and reaches `startAgentRun` as a local argument that goes out of scope
   * when the call returns. Retry keeps the mode; the token has to be re-entered.
   */
  const [activeProviderMode, setActiveProviderMode] = useState<"FAKE" | "LIVE">("FAKE");
  /**
   * Whether a LIVE run request has ACTUALLY BEEN REFUSED, leaving a job with no
   * run behind it.
   *
   * Explicit state, not an inference. An earlier version derived retry mode from
   * `job !== null && run === null && activeProviderMode === "LIVE"` — but that is
   * also true during the ORDINARY first attempt, in the window between
   * `setJob(createdJob)` and the run request resolving. The form would flip into
   * "Recover Live Run" — announcing that the live run did not return an answer —
   * while that very run was still in flight, and the token-clearing effect would
   * wipe the field mid-request.
   *
   * A pending request and a failed one are genuinely different facts, and no
   * combination of nullable resource fields can tell them apart. Only the code
   * that observes the rejection knows, so only it sets this.
   */
  const [liveRetryPending, setLiveRetryPending] = useState(false);
  /**
   * The client request key for the LIVE run of the CURRENT job — the thing that
   * makes recovery safe rather than expensive.
   *
   * THE DEFECT THIS CLOSES. The browser used to offer recovery for every
   * non-abort exception thrown by `startAgentRun` after the job was created. But
   * that exception does not prove no run was created. Finalization can fail
   * AFTER the provider executed and after the budget was reconciled — the API
   * answers PERSISTENCE_UNAVAILABLE, which it also uses for a pre-run outage —
   * and a successful response can simply be lost in transit. In both cases
   * re-entering the token started a SECOND paid attempt for the first one's
   * ambiguity.
   *
   * No allowlist of error codes can fix that. A transport failure has no code,
   * and PERSISTENCE_UNAVAILABLE is genuinely raised at both stages. The only
   * thing that distinguishes "the same request again" from "a new request" is
   * something the CLIENT carries, so the client carries it.
   *
   * THE RULE, in one sentence: a new key is generated only when a new AgentJob
   * is, never because a request failed.
   *
   * NOT A CREDENTIAL, and deliberately not treated like one. It is plain state
   * that SURVIVES failure — the opposite of the access token, which lives only as
   * a function argument and has to be retyped. Reusing the key is the point;
   * reusing the token is what the design refuses. They are never stored together.
   */
  const [liveRequestKey, setLiveRequestKey] = useState<string | null>(null);
  /**
   * Bumped to remount InvestigationForm, discarding the state it owns.
   *
   * The form owns `summary`, `providerMode`, `approvalDemo`, `liveAccessToken`,
   * and `submittingRef`; the parent cannot reach any of them. Remounting on a
   * changed `key` is the one reset that cannot miss a field — including a ref,
   * which no prop-driven effect would clear.
   */
  const [formResetKey, setFormResetKey] = useState(0);
  /**
   * Mount-time read of `?approval-demo=1` (§7 / plan F2). With the public
   * `Approval workflow demo` checkbox removed, this is the deterministic,
   * bookmarkable deep link that keeps the approvable Demo reachable on the
   * FAKE path. Read once, lazily, exactly like `?job=` is read on mount; the
   * LIVE path still clears the selection at submit/switch, so a Live run never
   * uses the approval-demo ticket.
   */
  const [defaultApprovalDemo] = useState<boolean>(() => readApprovalDemoParam(window.location.search));
  /**
   * The submitted issue/provider snapshot — captured once, before the first
   * request of a submission, and kept until the user explicitly starts a new
   * investigation. Distinct from `job`/`run`: this exists to satisfy "the
   * submitted issue and provider selection remain visible" even in the window
   * BEFORE `job` exists (during the LIVE preflight or job creation itself),
   * which no existing state could answer.
   */
  const [submittedSummary, setSubmittedSummary] = useState<{
    readonly summary: string;
    readonly providerMode: "FAKE" | "LIVE";
  } | null>(null);
  // Epoch ms. `submittedAt` starts the elapsed clock; `submittedFinishedAt`
  // freezes it. Both are reset together at the start of every tracked
  // submission/retry. Refresh can freeze the clock only when it observes the
  // current RUNNING run's first terminal outcome; later refresh and approval
  // actions never restart or refreeze the measurement.
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);
  const [submittedFinishedAt, setSubmittedFinishedAt] = useState<number | null>(null);
  // Set ONLY at the exact request boundary that failed, because `phase`
  // returns to "idle" on both success and failure and so cannot by itself
  // tell the Progress Timeline which stage — if any — actually stopped.
  const [failedStage, setFailedStage] = useState<InvestigationProgressStageKey | null>(null);
  // See investigation-progress-stages.ts: driven only by the approval fetch
  // itself, never by `phase`, since `loading-approval` is also reused by
  // refreshRun and the approval-decision 409-convergence path.
  const [approvalLoadStatus, setApprovalLoadStatus] = useState<ApprovalLoadStatus>("idle");

  // ── Investigation polling state (#38) ───────────────────────────────
  const [events, setEvents] = useState<readonly InvestigationEventRecord[]>([]);
  const [executionStageDerivation, setExecutionStageDerivation] = useState<ExecutionStageDerivation>({ kind: "legacy" });
  const [minAttemptNumber, setMinAttemptNumber] = useState(0);
  const terminalSettlementClaimRef = useRef<TerminalSettlementClaim | null>(null);
  /**
   * The reason polling is currently PAUSED, or `null` when it is not paused
   * (idle, actively polling, or genuinely stopped). Drives the "Check again"
   * affordance — shown ONLY for the three pausable reasons, never for
   * terminal/not-found/permanent-invalid/aborted.
   */
  const [pausedReason, setPausedReason] = useState<PollStopReason | null>(null);
  /**
   * True only for a resumed job that has no run yet. `hasRetainedPartialWorkflow`
   * would otherwise treat this exactly like a fresh submission's mid-creation
   * window or a genuine LIVE run refusal — offering "Retry Run"/"Recover Live
   * Run" for a provider mode we cannot safely infer from a job-only resume
   * (there is no persisted record of the ORIGINAL provider selection once no
   * run exists). Reset on every new submission and on leaving the resumed state.
   */
  const [resumedJobOnly, setResumedJobOnly] = useState(false);

  // Refs that mirror the state above, kept current by the "Synced" setter
  // wrappers below — never by a separate useEffect, so there is no window in
  // which a ref could read a value one render stale. `applyObservedRunOutcome`
  // and the poll-callback factory close over these refs (never the bare state
  // variables), because those closures are created once per submission/retry/
  // resume and MUST see the latest values on every later tick, not the values
  // that existed at closure-creation time.
  const jobRef = useRef<AgentJobResponse | null>(null);
  const runRef = useRef<AgentRunDetail | null>(null);
  const eventsRef = useRef<readonly InvestigationEventRecord[]>([]);
  // Holds the derivation TOGETHER WITH the run identity it was computed for
  // (independent review Findings 5/6 — Codex review) — never the bare
  // `ExecutionStageDerivation` alone, so `applyDerivationForCandidate` can
  // tell "the same run got a corrupt snapshot" apart from "a different
  // run/attempt/job's first snapshot happens to be corrupt" before ever
  // reusing `lastGoodStages`.
  const executionStageStateRef = useRef<ExecutionStageDerivationState | null>(null);
  const minAttemptNumberRef = useRef(0);
  // The pollGeneration of the last ACCEPTED poll-sourced snapshot — distinct
  // from the poll hook's own internal generation, which is never read outside
  // the hook. Used only by isNewerInvestigationSnapshot's poll-stale check.
  const lastAcceptedPollGenerationRef = useRef(-1);

  function setJobSynced(value: AgentJobResponse | null) {
    jobRef.current = value;
    setJob(value);
  }
  function setRunSynced(value: AgentRunDetail | null) {
    runRef.current = value;
    setRun(value);
  }
  function setEventsSynced(value: readonly InvestigationEventRecord[]) {
    eventsRef.current = value;
    setEvents(value);
  }
  /** Resets execution-stage derivation to the fresh, identity-less baseline. */
  function resetExecutionStageDerivation() {
    executionStageStateRef.current = null;
    setExecutionStageDerivation({ kind: "legacy" });
  }
  /**
   * The ONE place every ingestion path (poll, POST/Refresh authoritative
   * final snapshot, mount/popstate resume, retry/recovery) computes and
   * stores execution-stage derivation — independent review Findings 5/6
   * (Codex review). Delegates to the pure, identity-scoped
   * `applyAcceptedSnapshotDerivation` so `lastGoodStages` is never reused
   * across a job/run/attempt change, and so a canonical-invalid result can
   * never be silently dropped by a call site that forgot to check it.
   */
  function applyDerivationForCandidate(
    candidateJob: AgentJobResponse,
    candidateRun: AgentRunRecordView,
    candidateEvents: readonly InvestigationEventRecord[],
  ): ExecutionStageDerivation {
    const identity = { jobId: candidateJob.id, runId: candidateRun.id, attemptNumber: candidateRun.attemptNumber };
    const nextState = applyAcceptedSnapshotDerivation(
      identity,
      candidateEvents,
      candidateRun.status as InvestigationRunStatus,
      new Date().toISOString(),
      executionStageStateRef.current,
    );
    executionStageStateRef.current = nextState;
    setExecutionStageDerivation(nextState.derivation);
    return nextState.derivation;
  }
  function setMinAttemptNumberSynced(value: number) {
    minAttemptNumberRef.current = value;
    setMinAttemptNumber(value);
  }
  /**
   * Finding 5 (final Codex re-review): the ONE place a persisted run's
   * provider mode is applied once a run exists — never `setActiveProviderMode`
   * alone. A job-only resume has no persisted mode yet, so `submittedSummary`
   * is provisionally seeded with a guess; once a run-bearing snapshot
   * arrives (from any ingestion path), its ACTUAL persisted mode must
   * replace that guess everywhere it is read from: `activeProviderMode` is
   * read directly by the "Current investigation" card and by
   * `deriveInvestigationProgressStages`' stage composition, so both of those
   * must move together with `submittedSummary.providerMode` — the captured-
   * submission snapshot — or the page would show contradictory persisted
   * facts. `InvestigationSummary`'s Run details already reads the mode
   * directly off the persisted `run`, so it needs no separate synchronization
   * here.
   */
  function applyPersistedProviderMode(providerMode: "FAKE" | "LIVE") {
    setActiveProviderMode(providerMode);
    setSubmittedSummary((prev) => (prev !== null ? { ...prev, providerMode } : prev));
  }

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  // A SECOND, independent pair for capability reads — see refreshCapabilities.
  // Sharing the investigation's would let a background focus refresh abort a run.
  const capabilityControllerRef = useRef<AbortController | null>(null);
  const capabilityGenerationRef = useRef(0);

  // Polling gets its own generation, strictly separate from the main App
  // workflow generation — see useInvestigationPoll.
  const poll = useInvestigationPoll();

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  /**
   * Re-reads capabilities, race-safely, and returns what the server said.
   *
   * Capabilities are DYNAMIC, and a mount-time snapshot goes stale for the rest
   * of the tab's life. LIVE availability moves on its own: another client
   * reserves or reconciles a run, the daily count or the observed estimate hits
   * its limit, unknown pricing closes the gate, an unreconciled reservation
   * latches the UTC day shut, midnight opens a fresh row, an operator flips the
   * kill switch, or a database outage clears. Reading once produced two visible
   * failures — a tab stuck disabled until reload, and a tab still offering LIVE
   * that creates an AgentJob only to have the run refused.
   *
   * OWNERSHIP. This has its OWN controller and generation, deliberately separate
   * from `controllerRef`/`generationRef`. Sharing them would mean starting an
   * investigation cancels a capability read, and — far worse — that a background
   * focus refresh aborts an investigation in flight. The two lifecycles are
   * unrelated and must not be able to interrupt each other.
   *
   * LATEST WINS. Every call bumps `capabilityGenerationRef` and aborts the
   * previous request; a response whose generation is no longer current is
   * discarded rather than applied. Two refreshes resolving out of order
   * therefore cannot leave the older answer on screen.
   *
   * FAILS CLOSED. Any failure — including an abort — leaves `null`, which the
   * form treats as LIVE unavailable. A transient error can only ever hide the
   * LIVE option, never offer one the server would refuse. Nothing about the
   * response is logged.
   */
  async function refreshCapabilities(): Promise<CapabilitiesView | null> {
    capabilityControllerRef.current?.abort();
    const controller = new AbortController();
    capabilityControllerRef.current = controller;
    const generation = ++capabilityGenerationRef.current;

    try {
      const result = await getCapabilities(controller.signal);
      if (generation !== capabilityGenerationRef.current) return null;
      setCapabilities(result.data);
      return result.data;
    } catch {
      // Covers an abort too: a superseded read has nothing to say, and the
      // generation check below keeps it from clobbering the newer answer.
      if (generation !== capabilityGenerationRef.current) return null;
      setCapabilities(null);
      return null;
    }
  }

  /**
   * Mount, plus every point at which the tab has reason to believe the answer
   * may have moved: the user came back to it, or a workflow just finished.
   *
   * Deliberately NOT a polling interval. Mount, focus/visibility, the two
   * preflights, and the post-workflow refresh cover the cases that matter
   * without a timer waking a free-tier database up for a page nobody is looking
   * at.
   */
  useEffect(() => {
    void refreshCapabilities();

    const onFocus = () => {
      void refreshCapabilities();
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void refreshCapabilities();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      // Generation FIRST, then the abort. Bumping it invalidates any response
      // already in flight, so a read that resolves between the abort call and
      // the promise actually settling cannot write state on an unmounted
      // component. Aborting alone would leave that window open.
      capabilityGenerationRef.current += 1;
      // Aborts whatever capability read is outstanding — never an investigation,
      // which the separate cleanup above owns.
      capabilityControllerRef.current?.abort();
    };
    // Mount-only: refreshCapabilities closes over refs and setState, both stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mount-time resume: if the URL carries a valid ?job=<uuid>, restore that
  // investigation. Runs once on mount, before any popstate handler is
  // attached.
  useEffect(() => {
    const jobParam = readJobParam(window.location.search);
    if (jobParam === null) {
      // No job param on initial load — nothing to resume, ordinary fresh form.
    } else if (!isUuid(jobParam)) {
      setNotice("That investigation link isn't valid.");
      window.history.replaceState(null, "", `?${withoutJobParam(window.location.search)}`);
    } else {
      void resumeInvestigationFromJobParam(jobParam);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // popstate: Back/Forward restores the correct job via the SAME resume
  // function as mount-time restore, or resets to the fresh form when ?job=
  // is absent — without touching history, since a popstate transition must
  // never itself write a new/replaced history entry for the "no job" case.
  useEffect(() => {
    const onPopState = () => {
      const jobParam = readJobParam(window.location.search);
      if (jobParam === null) {
        invalidateInFlightWorkflows();
        resetToFreshFormState();
        // Finding 6's same root cause: invalidateInFlightWorkflows() just
        // aborted any in-flight capability read with no replacement — see
        // startNewInvestigation's identical call for the same reason.
        void refreshCapabilities();
      } else if (isUuid(jobParam)) {
        void resumeInvestigationFromJobParam(jobParam);
      } else {
        // Malformed job param reached via popstate (e.g. a manually edited
        // URL navigated to via Back/Forward) — no request, safe notice,
        // strip the malformed param with replaceState, fresh form.
        invalidateInFlightWorkflows();
        resetToFreshFormState();
        setNotice("That investigation link isn't valid.");
        window.history.replaceState(null, "", `?${withoutJobParam(window.location.search)}`);
        void refreshCapabilities();
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function beginWorkflow(): { signal: AbortSignal; generation: number } {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    return { signal: controller.signal, generation };
  }

  function isStale(generation: number): boolean {
    return generation !== generationRef.current;
  }

  /**
   * Bumps the main workflow generation (aborting the in-flight POST,
   * createAgentJob, getAgentRun, loadApproval, or recordApproval), aborts
   * and invalidates capabilities, stops and invalidates polling, and clears
   * the terminal settlement claim — all BEFORE hydrating or resetting any
   * target state. Called by popstate, mount-time resume, and
   * startNewInvestigation.
   */
  function invalidateInFlightWorkflows(): { signal: AbortSignal; generation: number } {
    const next = beginWorkflow(); // bumps main generation, aborts main controller,
                                  // and clears terminalSettlementClaimRef
    terminalSettlementClaimRef.current = null;
    capabilityControllerRef.current?.abort();
    capabilityGenerationRef.current += 1;
    poll.stop("aborted");
    return next;
  }

  // Never throws — a failed approval fetch must not unwind the run that was
  // already committed to the page. Reuses the caller's signal/generation
  // rather than calling beginWorkflow() again, since it is a continuation of
  // the caller's workflow, not a new one. Returns the fetched ApprovalView (or
  // null on a stale/aborted/reported-error result) so callers can decide the
  // right accessible-notice wording for their own flow (see runInvestigation/
  // retryRun/refreshRun) without this function needing to know which flow
  // called it.
  //
  // `trackInvestigationProgress` exists because `loading-approval` is a real
  // GET issued by FIVE different call sites: the initial submission, a FAKE
  // retry, a LIVE recovery, a manual Refresh, and the 409-conflict
  // convergence reload. Only the first three (plus a Refresh that discovers
  // a RUNNING run's first terminal outcome) are steps of "completing THIS
  // investigation" — an ORDINARY manual Refresh or a 409 reload can happen
  // long after the Progress Timeline already reads Completed, and must not
  // flip it back to Active or Failed. Only call sites that are part of the
  // tracked workflow pass `true`.
  async function loadApproval(
    runId: string,
    signal: AbortSignal,
    generation: number,
    options: { readonly reportError: boolean; readonly trackInvestigationProgress: boolean },
  ): Promise<ApprovalView | null> {
    if (options.trackInvestigationProgress) setApprovalLoadStatus("loading");
    try {
      const result = await getApproval(runId, signal);
      if (isStale(generation)) return null;
      setApproval(result.data);
      // A LOADED read, including a NOT_ELIGIBLE result — "loaded" means the
      // fetch itself succeeded, never a claim about the returned status.
      if (options.trackInvestigationProgress) setApprovalLoadStatus("loaded");
      return result.data;
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return null;
      if (options.reportError) {
        setError(toDisplayableError(thrown));
        setApproval(null);
      }
      // reportError: false is the 409-convergence path — the server's 409
      // message stays on screen instead of being overwritten by this GET's
      // error, and `approval` is left untouched rather than inventing state.
      if (options.trackInvestigationProgress) setApprovalLoadStatus("failed");
      return null;
    }
  }

  type ApprovalFetchResult =
    | { readonly kind: "success"; readonly approval: ApprovalView }
    | { readonly kind: "error"; readonly error: unknown };

  /**
   * Finding 2 (final Codex re-review): NETWORK IO ONLY — no React state
   * writes — so terminal finalization's authorization can be rechecked
   * BEFORE any write reaches the screen. Distinct from `loadApproval`
   * above, which commits unconditionally and is used by call sites that are
   * not terminal-settlement races (`refreshRun`, the 409-convergence
   * reload) and so have nothing to recheck.
   */
  async function fetchApprovalResult(runId: string, signal: AbortSignal): Promise<ApprovalFetchResult> {
    try {
      const result = await getApproval(runId, signal);
      return { kind: "success", approval: result.data };
    } catch (thrown) {
      return { kind: "error", error: thrown };
    }
  }

  /**
   * Commits a terminal-finalization approval fetch result. Called ONLY
   * immediately after `isFinalizationAuthorized` has just been rechecked, so
   * every write here is conditioned on the caller still being the
   * authorized owner — never called for an unauthorized/contradicted
   * continuation, which returns before this is reached and therefore writes
   * nothing at all (no `approval`, no `approvalLoadStatus`, no error
   * banner).
   */
  function commitApprovalResultAtomically(result: ApprovalFetchResult): ApprovalView | null {
    if (result.kind === "success") {
      setApproval(result.approval);
      setApprovalLoadStatus("loaded");
      return result.approval;
    }
    setError(toDisplayableError(result.error));
    setApproval(null);
    setApprovalLoadStatus("failed");
    return null;
  }

  /**
   * Clears EVERY piece of state that belongs to the PREVIOUS investigation —
   * visible result, error/progress/elapsed display, and ownership of the
   * retry/idempotency machinery — and initializes the NEW submission's
   * snapshot/progress state. Called before ANY request of a fresh
   * submission, including the LIVE preflight, so a slow or refused preflight
   * is never shown next to a stale prior run's full result.
   *
   * `activeProviderMode` and `liveRequestKey` are reset HERE rather than
   * later in `runInvestigation` specifically so nothing between this call and
   * the eventual `startAgentRun` request can read a value that still belongs
   * to the investigation being replaced.
   *
   * Deliberately NOT used by retryRun/retryLiveRunWithToken: those resume an
   * EXISTING job and must keep it — and `liveRequestKey`/`liveRetryPending`
   * with it — intact. This helper is only for a genuinely new submission.
   */
  function beginNewSubmissionDisplay(submission: { readonly summary: string; readonly providerMode: "FAKE" | "LIVE" }) {
    setTicketId(null);
    setJobSynced(null);
    setRunSynced(null);
    setApproval(null);
    setError(null);
    setNotice(null);
    setLiveRetryPending(false);
    setLiveRequestKey(null);
    setActiveProviderMode(submission.providerMode);
    setSubmittedSummary({ summary: submission.summary, providerMode: submission.providerMode });
    setSubmittedAt(Date.now());
    setSubmittedFinishedAt(null);
    setFailedStage(null);
    setApprovalLoadStatus("idle");
    setEventsSynced([]);
    resetExecutionStageDerivation();
    setMinAttemptNumberSynced(0);
    setPausedReason(null);
    setResumedJobOnly(false);
  }

  /**
   * Every terminal-ownership decision this App makes funnels through here —
   * the blocking POST's resolution AND every poll snapshot alike (§2 of the
   * implementation prompt). `source` distinguishes the two ONLY for the
   * poll-regressive guard below; the terminal-ownership decision itself
   * (owner/duplicate/inconsistent-terminal-status) applies identically
   * regardless of source.
   *
   * Reads exclusively from the *Ref mirrors (never the bare state variables)
   * because this is called from closures created once per submission/retry/
   * resume/poll-session — closures that must observe the LATEST state on
   * every later invocation, not the state that existed when they were
   * created.
   */
  async function applyObservedRunOutcome(params: {
    readonly job: AgentJobResponse;
    readonly run: AgentRunRecordView;
    readonly trace: readonly AgentTraceEvent[];
    readonly outcome: AgentRunOutcomeView;
    readonly events: readonly InvestigationEventRecord[];
    readonly signal: AbortSignal;
    readonly generation: number;
    readonly source: "post" | "poll";
    readonly pollGeneration: number | null;
    /**
     * True ONLY for the resume path, whose `events` already came from a
     * `getInvestigationState` read in the SAME function call — fetching a
     * second one for Finding 1's authoritative-refresh step below would be a
     * redundant, wasted request. Every other "post" caller (submit/retry/
     * retryLiveRunWithToken) leaves this `false`: their run POST response
     * never carries canonical `events[]` at all.
     */
    readonly skipAuthoritativeFinalRead: boolean;
  }): Promise<
    | { readonly kind: "stale" }
    | { readonly kind: "discarded" }
    | { readonly kind: "running" }
    | { readonly kind: "inconsistent" }
    | { readonly kind: "duplicate" }
    | { readonly kind: "owner"; readonly outcome: "COMPLETED"; readonly loadedApproval: ApprovalView | null }
    | { readonly kind: "owner"; readonly outcome: "FAILED" }
  > {
    const {
      job: candidateJob,
      run: candidateRun,
      trace: candidateTrace,
      outcome: candidateOutcome,
      events: candidateEvents,
      signal,
      generation,
      source,
      pollGeneration,
      skipAuthoritativeFinalRead,
    } = params;

    // Stale/regressive guard FIRST — before any state write, for both
    // non-terminal and terminal candidates alike.
    if (isStale(generation)) return { kind: "stale" };

    // Finding 4 (independent review, Codex review): monotonic attempt
    // guards apply to EVERY observation source — poll, POST, resume, manual
    // Refresh, and an authoritative final-read continuation alike — not
    // only poll (isNewerInvestigationSnapshot's own attempt-monotonicity
    // rule below still runs for source === "poll" only, for its OTHER
    // rules: stale poll generation, null-run regression, fewer events,
    // RUNNING-after-terminal). A candidate for an attempt strictly below
    // whatever is currently held can never be applied by ANY source.
    if (runRef.current !== null && candidateRun.attemptNumber < runRef.current.run.attemptNumber) {
      return { kind: "discarded" };
    }

    if (source === "poll") {
      const currentSnapshot: InvestigationStateResponse = {
        job: jobRef.current ?? candidateJob,
        run: runRef.current?.run ?? null,
        trace: runRef.current?.trace ?? [],
        outcome: runRef.current?.outcome ?? null,
        events: eventsRef.current,
      };
      const incomingSnapshot: InvestigationStateResponse = {
        job: candidateJob,
        run: candidateRun,
        trace: candidateTrace,
        outcome: candidateOutcome,
        events: candidateEvents,
      };
      const accepted = isNewerInvestigationSnapshot(
        currentSnapshot,
        jobRef.current?.id ?? candidateJob.id,
        lastAcceptedPollGenerationRef.current,
        minAttemptNumberRef.current,
        incomingSnapshot,
        pollGeneration ?? 0,
      );
      if (!accepted) return { kind: "discarded" };
      if (pollGeneration !== null) lastAcceptedPollGenerationRef.current = pollGeneration;
    }

    if (candidateOutcome.type === "RUNNING") {
      setJobSynced(candidateJob);
      setRunSynced({ job: candidateJob, run: candidateRun, trace: candidateTrace, outcome: candidateOutcome });
      setEventsSynced(candidateEvents);
      // Finding 1 (independent review, Codex review): job-only resume polls
      // until a run appears — once it does, the persisted run's OWN
      // provider mode must replace whatever provisional mode the resume's
      // job-only hydration guessed. Harmless for every other source: their
      // own submission already set `activeProviderMode` correctly, and the
      // persisted run's mode always matches it.
      //
      // Finding 5 (final Codex re-review): synchronized via
      // `applyPersistedProviderMode`, not `setActiveProviderMode` alone — the
      // "Current investigation" card and the Timeline's stage composition
      // both read `activeProviderMode`, which must move together with
      // `submittedSummary.providerMode` or the page shows contradictory
      // persisted facts.
      applyPersistedProviderMode(candidateRun.providerMode === "LIVE" ? "LIVE" : "FAKE");
      setResumedJobOnly(false);
      const derivation = applyDerivationForCandidate(candidateJob, candidateRun, candidateEvents);
      if (derivation.kind === "canonical-invalid") {
        // Fail closed: pause polling rather than silently falling back to
        // legacy inference for a run that IS canonical but whose stream is
        // currently unreadable.
        poll.stop("data-corrupt");
      } else {
        // Finding 3 (final Codex re-review): a VALID snapshot clears any
        // data-corrupt pause a prior invalid snapshot (or a resumed
        // first-snapshot corruption via `enterPaused`) left behind — this
        // is the "Check again returns valid canonical data -> clear the
        // pause" half of the recovery contract for a still-RUNNING run.
        setPausedReason(null);
      }
      return { kind: "running" };
    }

    // Terminal candidate (COMPLETED or FAILED) — decide ownership BEFORE any
    // terminal state write.
    const identity: TerminalSettlementIdentity = {
      jobId: candidateJob.id,
      runId: candidateRun.id,
      attemptNumber: candidateRun.attemptNumber,
      generation,
    };
    const { decision, nextClaim } = resolveTerminalObservation(terminalSettlementClaimRef.current, identity, candidateOutcome.type);
    terminalSettlementClaimRef.current = nextClaim;

    if (decision.kind === "inconsistent-terminal-status" || decision.kind === "already-inconsistent") {
      // The first accepted terminal state is preserved untouched — nothing
      // about run/outcome/events is written from this contradictory (or
      // already-known-contradictory) observation.
      poll.stop("terminal");
      setNotice(TERMINAL_INCONSISTENCY_NOTICE);
      setPhase("idle");
      return { kind: "inconsistent" };
    }

    // Finding 1: the blocking POST's own response never carries canonical
    // `events[]` — only a poll snapshot (source === "poll") or the resume
    // read (skipAuthoritativeFinalRead === true) already has authoritative
    // detail. If the POST is the one becoming OWNER of this terminal
    // outcome, `candidateEvents` may be stale/empty (whatever `eventsRef`
    // happened to hold when the POST won the race). Before permanently
    // freezing the canonical Timeline, fetch ONE authoritative
    // `getInvestigationState` read under the SAME generation and use its
    // events/trace/outcome instead. A "duplicate" observation never needs
    // this: the FIRST observer already applied authoritative detail, and
    // this second one only re-applies the same state harmlessly.
    let finalJob = candidateJob;
    let finalRun = candidateRun;
    let finalTrace = candidateTrace;
    let finalOutcome: AgentRunOutcomeView = candidateOutcome;
    let finalEvents = candidateEvents;

    if (source === "post" && decision.kind === "owner" && !skipAuthoritativeFinalRead) {
      try {
        const authoritative = (await getInvestigationState(candidateJob.id, signal)).data;
        if (isStale(generation)) return { kind: "stale" };

        // Finding 1 (final Codex re-review): the authoritative read itself
        // may discover a NEWER attempt than the one this POST is trying to
        // settle (another client started attempt 2 while this attempt's
        // final read was in flight). The OLD attempt must never settle,
        // stop polling, or run terminal side effects over a newer one —
        // route the newer snapshot through the ordinary accepted-
        // observation path instead, under the SAME generation/signal, so
        // ownership/monotonicity/canonical-invalid handling all apply
        // exactly as they would for a poll-observed snapshot.
        // `skipAuthoritativeFinalRead: true` — this response already IS an
        // authoritative read, so no second one is fetched for it. If the
        // newer attempt is itself still RUNNING, this recursion lands in
        // the RUNNING branch above, which never stops polling — leaving
        // attempt 2's polling live, exactly as required.
        if (authoritative.run !== null && authoritative.run.attemptNumber > candidateRun.attemptNumber) {
          return await applyObservedRunOutcome({
            job: authoritative.job,
            run: authoritative.run,
            trace: authoritative.trace,
            outcome: authoritative.outcome ?? { type: "RUNNING" },
            events: authoritative.events,
            signal,
            generation,
            source: "post",
            pollGeneration: null,
            skipAuthoritativeFinalRead: true,
          });
        }

        const matchesExpectedIdentity =
          authoritative.job.id === candidateJob.id &&
          authoritative.run !== null &&
          authoritative.run.id === candidateRun.id &&
          authoritative.run.attemptNumber === candidateRun.attemptNumber &&
          authoritative.outcome !== null;

        if (matchesExpectedIdentity && authoritative.outcome!.type === candidateOutcome.type) {
          finalJob = authoritative.job;
          finalRun = authoritative.run!;
          finalTrace = authoritative.trace;
          finalOutcome = authoritative.outcome!;
          finalEvents = authoritative.events;
        } else if (
          matchesExpectedIdentity &&
          (authoritative.outcome!.type === "COMPLETED" || authoritative.outcome!.type === "FAILED")
        ) {
          // Finding 1: same job/run/attempt, but the authoritative read
          // reports the OPPOSITE terminal status from the POST's own
          // candidate — an impossible internal-consistency failure. Marked
          // inconsistent and failed closed; never falls back to the POST's
          // own (now-suspect) candidate.
          const contradiction = resolveTerminalObservation(terminalSettlementClaimRef.current, identity, authoritative.outcome!.type);
          terminalSettlementClaimRef.current = contradiction.nextClaim;
          poll.stop("terminal");
          setNotice(TERMINAL_INCONSISTENCY_NOTICE);
          setPhase("idle");
          return { kind: "inconsistent" };
        }
        // Any other mismatch (unexpected) falls back to the POST's own
        // candidate below — never applied, and never treated as a second
        // inconsistency; the coordinator already decided ownership.
      } catch (thrown) {
        if (isStale(generation)) return { kind: "stale" };
        // A transient final-read failure must NOT undo the already-known
        // terminal run/report outcome, and must NOT duplicate side effects
        // — proceed with the POST's own candidate data (last-good canonical
        // detail; applyDerivationForCandidate below never fabricates
        // completion it cannot support).
      }
    }

    // Finding 4 (independent review, Codex review): re-evaluate monotonicity
    // against the CURRENT held run, not the value observed before the
    // (possibly long) authoritative-read await above — polling may have
    // accepted a strictly newer attempt while this read was in flight. Never
    // fall back to an older candidate over a newer one; leave the newer,
    // already-current snapshot untouched instead, and do not stop its
    // polling (falling through to `poll.stop("terminal")` below would).
    if (runRef.current !== null && finalRun.attemptNumber < runRef.current.run.attemptNumber) {
      return { kind: "discarded" };
    }

    // Finding 3 (independent review, Codex review): `resolveTerminalObservation`
    // decided ownership BEFORE the authoritative-read await above — it
    // cannot see a contradictory observation that arrived DURING that
    // await. Revalidate now, using the ref's LATEST value, before this
    // owner performs its first terminal write.
    if (decision.kind === "owner" && !isFinalizationAuthorized(terminalSettlementClaimRef.current, identity)) {
      return { kind: "inconsistent" };
    }

    setJobSynced(finalJob);
    setRunSynced({ job: finalJob, run: finalRun, trace: finalTrace, outcome: finalOutcome });
    setEventsSynced(finalEvents);
    applyPersistedProviderMode(finalRun.providerMode === "LIVE" ? "LIVE" : "FAKE");
    setResumedJobOnly(false);
    const derivation = applyDerivationForCandidate(finalJob, finalRun, finalEvents);
    poll.stop("terminal");
    // Elapsed-time bugfix: the clock freezes HERE, synchronously with the
    // run/status sync above — the SAME render that shows the run as
    // terminal also freezes its elapsed time, for every terminal
    // observation (owner AND duplicate alike; both derive the identical
    // value from the same `finalRun`, so re-applying it for a duplicate is
    // harmless/idempotent). Always the run's OWN persisted `finishedAt` —
    // never `Date.now()` — so resuming an already-completed/failed run
    // shows the SAME real duration no matter how long the page was open
    // before this observation, and a contradictory observation arriving
    // later (e.g. during the COMPLETED branch's approval fetch below) can
    // never leave the clock ticking past a status already shown as
    // terminal. `finishedAt === null` on a terminal run is a data anomaly
    // the elapsed-time hook fails safe for — see useElapsedTime's
    // `isTerminal` contract — rather than inventing a number from
    // `Date.now()`.
    setSubmittedFinishedAt(finalRun.finishedAt !== null ? new Date(finalRun.finishedAt).getTime() : null);
    // Finding 3 (final Codex re-review): a canonical-invalid derivation
    // must enter the SAME fail-closed data-corrupt pause regardless of
    // ingestion path (terminal poll, terminal POST/Refresh authoritative
    // final read, or a resumed COMPLETED run funnelled through here) — the
    // known terminal report/outcome above remains visible, but canonical
    // detail stays explicitly untrusted. `enterPaused` establishes a
    // resumable job-keyed session with ZERO automatic request; "Check
    // again" performs the one fresh bounded GET. A later duplicate
    // observation re-running this same branch with valid data clears the
    // pause below via the ordinary `poll.stop("terminal")` ->
    // `onStop("terminal")` path (not a pausable reason), without repeating
    // any terminal side effect.
    if (derivation.kind === "canonical-invalid") {
      poll.enterPaused(finalJob.id, createPollCallbacks(generation, signal));
      setPausedReason("data-corrupt");
    }

    if (decision.kind === "duplicate") {
      // Harmlessly re-applies the SAME authoritative terminal state — no
      // approval load, no terminal notice a second time. (The elapsed
      // clock above IS re-applied, but idempotently — same `finalRun`,
      // same value.)
      setPhase("idle");
      return { kind: "duplicate" };
    }

    // owner — the once-only terminal side effects.
    if (finalOutcome.type === "COMPLETED") {
      setPhase("loading-approval");
      setApprovalLoadStatus("loading");
      // Finding 2 (final Codex re-review): network IO is separated from the
      // React writes it produces. Every write below is conditioned on
      // `isFinalizationAuthorized` being rechecked AFTER this await, so a
      // contradictory observation that arrives while this fetch is in
      // flight leaves ZERO trace from this continuation: no `approval`, no
      // `approvalLoadStatus`, no error banner, no notice, no phase rewrite
      // — the inconsistency notice the contradictory observation already
      // installed stands untouched. (The run/status/elapsed-clock sync
      // above already happened and is not part of this continuation.)
      const fetchResult = await fetchApprovalResult(finalRun.id, signal);
      if (isStale(generation)) return { kind: "stale" };
      if (!isFinalizationAuthorized(terminalSettlementClaimRef.current, identity)) {
        return { kind: "inconsistent" };
      }
      const loadedApproval = commitApprovalResultAtomically(fetchResult);
      setNotice(investigationCompleteAnnouncement(loadedApproval?.status === "PENDING"));
      setPhase("idle");
      terminalSettlementClaimRef.current = markFinalizationSettled(terminalSettlementClaimRef.current, identity);
      return { kind: "owner", outcome: "COMPLETED", loadedApproval };
    }
    // Finding 3: no await occurred between the check above and here, but
    // revalidate anyway, immediately before this write, per the same rule.
    if (!isFinalizationAuthorized(terminalSettlementClaimRef.current, identity)) {
      return { kind: "inconsistent" };
    }
    setNotice(stageFailureAnnouncement("run"));
    setPhase("idle");
    terminalSettlementClaimRef.current = markFinalizationSettled(terminalSettlementClaimRef.current, identity);
    return { kind: "owner", outcome: "FAILED" };
  }

  /**
   * Builds a fresh `PollCallbacks` closing over ONE workflow's own
   * generation/signal — never the poll hook's internal generation, and never
   * shared across two different workflows (submit, retry, resume each call
   * this once, at their own `poll.start(...)` call site).
   */
  function createPollCallbacks(generation: number, signal: AbortSignal): PollCallbacks {
    return {
      onSnapshot: ({ snapshot, pollGeneration }) => {
        if (snapshot.run === null || snapshot.outcome === null) return; // no run yet — keep polling
        void applyObservedRunOutcome({
          job: snapshot.job,
          run: snapshot.run,
          trace: snapshot.trace,
          outcome: snapshot.outcome,
          events: snapshot.events,
          signal,
          generation,
          source: "poll",
          pollGeneration,
          skipAuthoritativeFinalRead: false, // ignored for source==="poll" — a poll snapshot's events ARE already authoritative
        });
      },
      onError: () => {
        // Transient backoff is silent by design — the last good snapshot
        // stays on screen. `onStop` is what surfaces a pause to the UI.
      },
      onStop: (reason) => {
        setPausedReason(CHECK_AGAIN_REASONS.has(reason) ? reason : null);
        // Finding 4 (independent review): the hook already classifies
        // `not-found`/`permanent-invalid` correctly, but previously nothing
        // in App surfaced them — the stale investigation, and `?job=`,
        // simply stayed on screen forever with no explanation. A stale
        // callback from a workflow this App has already moved on from (a
        // later submission, retry, resume, or navigation already bumped the
        // generation) is ignored — it must never touch the CURRENT job/URL.
        if (isStale(generation)) return;
        if (reason === "not-found") {
          // The job itself no longer exists server-side — tear the whole
          // workflow down, not just polling, so nothing pending (e.g. a
          // slow startAgentRun for this same job) can still write state.
          invalidateInFlightWorkflows();
          resetToFreshFormState();
          setNotice(INVESTIGATION_NOT_FOUND_NOTICE);
          window.history.replaceState(null, "", `?${withoutJobParam(window.location.search)}`);
        } else if (reason === "permanent-invalid") {
          // The investigation itself is untouched — only live progress
          // tracking stopped. Never raw server/persistence/provider text,
          // and never auto-retried (see CHECK_AGAIN_REASONS above, which
          // deliberately excludes this reason).
          setNotice(PERMANENT_POLL_ERROR_NOTICE);
        }
      },
    };
  }

  /**
   * Resets every piece of display/session state to the ordinary fresh-form
   * baseline, WITHOUT touching history and WITHOUT invalidating in-flight
   * workflows itself — callers that need either of those call them
   * separately, in the required order (invalidate BEFORE reset). Shared by
   * `startNewInvestigation` (which also strips `?job=`) and the popstate
   * "no job"/malformed-job branches (which must not call a helper that
   * performs `replaceState` mid-transition for the plain "no job" case).
   */
  function resetToFreshFormState() {
    setTicketId(null);
    setJobSynced(null);
    setRunSynced(null);
    setApproval(null);
    setError(null);
    setNotice(null);
    setLiveRetryPending(false);
    setLiveRequestKey(null);
    setEventsSynced([]);
    resetExecutionStageDerivation();
    setMinAttemptNumberSynced(0);
    setFormResetKey((key) => key + 1);
    setSubmittedSummary(null);
    setSubmittedAt(null);
    setSubmittedFinishedAt(null);
    setFailedStage(null);
    setApprovalLoadStatus("idle");
    setPausedReason(null);
    setResumedJobOnly(false);
    setPhase("idle");
  }

  /**
   * The ONE resume code path for both mount-time `?job=` restoration and
   * `popstate` navigation to a different job — never duplicated (§6 of the
   * implementation prompt).
   *
   * Invalidates every in-flight workflow FIRST (main generation, capability
   * request, polling, terminal claim), then reads one consistent snapshot
   * via `getInvestigationState`, then hydrates display/session state from
   * it. A COMPLETED run is settled through the SAME `applyObservedRunOutcome`
   * coordinator the submit/poll paths use, so a resumed COMPLETED run can
   * never double-fetch approval if a stray poll tick also observes it.
   */
  async function resumeInvestigationFromJobParam(jobId: string) {
    const { signal, generation } = invalidateInFlightWorkflows();
    /**
     * Finding 6 (independent review): `invalidateInFlightWorkflows()` just
     * aborted whatever capability read was in flight (including the very
     * first one, fired by the mount-time capabilities effect) without ever
     * starting a replacement — capabilities stayed `null` (LIVE reads as
     * unavailable) until an unrelated focus/visibility event. Firing a
     * fresh, generation-safe read here — concurrently with the investigation
     * snapshot fetch below, not sequenced after it — covers every exit path
     * of this function (job-only/RUNNING/FAILED/COMPLETED hydration AND the
     * 404/error branches) with one call, reusing the existing
     * `refreshCapabilities()` helper rather than a second network path.
     */
    void refreshCapabilities();
    setPhase("resuming");

    let state: InvestigationStateResponse;
    try {
      const result = await getInvestigationState(jobId, signal);
      if (isStale(generation)) return;
      state = result.data;
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      if (thrown instanceof ApiRequestError && thrown.code === "AGENT_JOB_NOT_FOUND") {
        resetToFreshFormState();
        setNotice(INVESTIGATION_NOT_FOUND_NOTICE);
        window.history.replaceState(null, "", `?${withoutJobParam(window.location.search)}`);
        return;
      }
      // INTERNAL_DATA_INVALID, a network failure, or PERSISTENCE_UNAVAILABLE:
      // fail closed and preserve the URL/job identity so the user can retry
      // — a transient or corrupt-data failure must never silently strip a
      // link the server might still be able to serve a moment later.
      setError(toDisplayableError(thrown));
      setNotice(null);
      setPhase("idle");
      return;
    }

    // Hydrate display/session state from the snapshot.
    const resumedProviderMode: "FAKE" | "LIVE" = state.run?.providerMode === "LIVE" ? "LIVE" : "FAKE";
    setJobSynced(state.job);
    setTicketId(state.job.ticketId);
    setActiveProviderMode(resumedProviderMode);
    setSubmittedSummary({ summary: state.job.summary, providerMode: resumedProviderMode });
    setSubmittedAt(state.run !== null ? new Date(state.run.startedAt).getTime() : new Date(state.job.createdAt).getTime());
    setLiveRetryPending(false);
    setLiveRequestKey(null);
    setError(null);
    setFailedStage(null);
    setPausedReason(null);
    // Finding 4 (final Codex re-review): approval is scoped to a RUN
    // identity, not the tab. A previous job's approval (reviewer/note/
    // status, and the action-required banner/decision controls it drives)
    // must never remain visible or actionable under a DIFFERENT resumed
    // job/run — cleared here, before any snapshot branch below applies, so
    // every exit path (job-only, RUNNING, FAILED, COMPLETED) starts clean.
    // Only a COMPLETED current run re-loads its OWN approval, below.
    setApproval(null);
    setApprovalLoadStatus("idle");

    if (state.run === null) {
      // Job-only state — no run exists yet for this job. A resumed LIVE job
      // with no run cannot safely mint a fresh liveRequestKey (would risk a
      // second paid execution), so `resumedJobOnly` suppresses the
      // Retry-Run/Recover-Live-Run affordances entirely; the ordinary fresh
      // form remains the way forward ("start a new investigation").
      setRunSynced(null);
      setEventsSynced([]);
      resetExecutionStageDerivation();
      setSubmittedFinishedAt(null);
      setApprovalLoadStatus("idle");
      setResumedJobOnly(true);
      setNotice(null);
      setPhase("idle");
      /**
       * Finding 1 (independent review, Codex review): the API/plan model
       * "job exists, run not committed yet" as a real, expected window —
       * the ORIGINAL server request (from before this reload) may still be
       * executing and can commit/complete the run at any moment. A fresh
       * submission keeps polling through this exact window; resume must
       * not do less. No `startAgentRun`/LIVE recovery is issued from here —
       * only the bounded job-keyed `GET .../investigation` poll, under
       * THIS resume's own generation/signal. `createPollCallbacks`'s
       * `onSnapshot` already ignores a run-less snapshot ("keep polling")
       * and routes the FIRST run-bearing one through
       * `applyObservedRunOutcome`, which hydrates the run/events and —
       * critically for this path — replaces the provisional job-only
       * `activeProviderMode` guess with the persisted run's actual mode.
       */
      poll.start(state.job.id, createPollCallbacks(generation, signal));
      return;
    }

    setResumedJobOnly(false);
    const resumedRun: AgentRunDetail = { job: state.job, run: state.run, trace: state.trace, outcome: state.outcome! };
    setRunSynced(resumedRun);
    setEventsSynced(state.events);
    const derivation = applyDerivationForCandidate(state.job, state.run, state.events);

    if (state.run.status === "RUNNING") {
      setSubmittedFinishedAt(null);
      setApprovalLoadStatus("idle");
      setNotice(null);
      setPhase("idle");
      // Finding 3 (final Codex re-review): a first-snapshot canonical-invalid
      // RUNNING resume fails closed exactly like a mid-flight poll tick that
      // observes corruption — zero automatic requests, but a resumable
      // job-keyed session IS established (via `enterPaused`, not
      // `poll.start`) so the required "Check again" affordance can perform
      // one fresh bounded GET on demand.
      if (derivation.kind === "canonical-invalid") {
        poll.enterPaused(state.job.id, createPollCallbacks(generation, signal));
        setPausedReason("data-corrupt");
      } else {
        poll.start(state.job.id, createPollCallbacks(generation, signal));
      }
      return;
    }

    if (state.run.status === "FAILED") {
      // P1 (final independent review): FAILED is terminal, so the initial
      // resumed observation must establish the SAME durable terminal
      // settlement claim as every other accepted terminal path — funnelled
      // through the shared coordinator rather than a second ad hoc
      // terminal-decision implementation. `skipAuthoritativeFinalRead: true`
      // — `state.events` above ALREADY came from a `getInvestigationState`
      // read in this same function call. The coordinator's own terminal
      // write freezes the elapsed clock from `state.run.finishedAt` itself
      // (never `Date.now()`) and applies the same canonical-invalid
      // data-corrupt pause policy uniformly (the known failure outcome
      // above remains visible, but canonical detail stays untrusted with a
      // functional "Check again") — see `applyObservedRunOutcome`.
      await applyObservedRunOutcome({
        job: state.job,
        run: state.run,
        trace: state.trace,
        outcome: state.outcome!,
        events: state.events,
        signal,
        generation,
        source: "post",
        pollGeneration: null,
        skipAuthoritativeFinalRead: true,
      });
      return;
    }

    // COMPLETED — settle exactly once through the shared coordinator.
    // `skipAuthoritativeFinalRead: true` — `state.events` above ALREADY came
    // from a getInvestigationState read in this same function call; Finding
    // 1's authoritative-refresh step would be a redundant second fetch here.
    await applyObservedRunOutcome({
      job: state.job,
      run: state.run,
      trace: state.trace,
      outcome: state.outcome!,
      events: state.events,
      signal,
      generation,
      source: "post",
      pollGeneration: null,
      skipAuthoritativeFinalRead: true,
    });
  }

  async function runInvestigation(submission: InvestigationFormSubmission) {
    /**
     * LIVE PREFLIGHT, before a ticket id exists and before any request is sent.
     *
     * The mount-time answer may be minutes old. Without this, a stale AVAILABLE
     * creates an AgentJob and only then discovers the run is refused — leaving a
     * retained partial workflow the user has to recover from, for a run that
     * never had a chance.
     *
     * ADVISORY, NOT ATOMIC. The backend admission path remains authoritative;
     * this cannot close the window between the check and the request. A race can
     * still be rejected server-side, and that is exactly what the retained-job
     * retry state exists to handle. What it does remove is the AVOIDABLE case,
     * where the tab already had the information and ignored it.
     */
    if (submission.providerMode === "LIVE") {
      /**
       * DEFENSIVE CREDENTIAL CHECK, before even the capability request.
       *
       * The form already blocks a credential-less LIVE submission, so this is
       * belt-and-braces — but it is the parent that actually issues requests,
       * and "the child validated it" is not something the request-issuing code
       * should have to assume. Costs one string check and removes a whole class
       * of avoidable rejections and stranded jobs.
       *
       * Issue #39: `turnstileToken`'s presence on the submission is what says
       * this is a PUBLIC trial attempt — the form only ever includes it under
       * a PUBLIC_TRIAL deployment, mutually exclusively with `liveAccessToken`.
       */
      const isPublicSubmission = capabilities?.liveAccess === "PUBLIC_TRIAL";
      const missingCredential = isPublicSubmission
        ? submission.turnstileToken === undefined
        : (submission.liveAccessToken ?? "").trim() === "";
      if (missingCredential) {
        setError(null);
        setNotice(
          isPublicSubmission
            ? "A completed verification challenge is required for a live run."
            : "A live demo access token is required for a live run.",
        );
        return;
      }
    }

    /**
     * Finding 2 (independent review): invalidate the PREVIOUS workflow
     * before any display reset and before the LIVE preflight — never after.
     *
     * The token guard above can still return early WITHOUT reaching this
     * line, which is deliberate: an empty-token submission never became a
     * real attempt, so it must not tear down whatever investigation was
     * already on screen. Every submission that DOES reach this line is
     * genuinely starting a new workflow, so the previous one's main
     * generation, capability request, poll session, and terminal claim are
     * all invalidated here, BEFORE `beginNewSubmissionDisplay` resets
     * display and BEFORE the (possibly slow) LIVE preflight even starts.
     *
     * Without this ordering, a still-active previous poll session's
     * callbacks close over the OLD generation, which stays "current" until
     * `beginWorkflow()` runs — previously that happened only AFTER the
     * preflight resolved. A late poll response for the OLD job, arriving
     * during that window, could repopulate the freshly-reset display; and if
     * the preflight then refused LIVE access, that OLD poll session would
     * never be stopped at all, left polling indefinitely.
     */
    const { signal, generation } = invalidateInFlightWorkflows();

    /**
     * DISPLAY RESET, after the token guard but BEFORE the LIVE preflight.
     *
     * Placed here specifically so that even an availability REFUSAL is
     * visible in a mounted Progress Timeline, next to NOTHING from the prior
     * investigation — capturing it only after a successful preflight would
     * mean the one stage most likely to fail (LIVE availability) rendered
     * next to the previous run's still-visible job/report/approval. An
     * empty-token submission above never reaches this line, so it never
     * mounts a Progress Timeline for a request that was never sent.
     */
    beginNewSubmissionDisplay(submission);

    if (submission.providerMode === "LIVE") {
      // Phase FIRST, then the await — see PHASE_LABELS["checking-availability"].
      setPhase("checking-availability");
      const fresh = await refreshCapabilities();
      // Defensive: a NEWER workflow (another submission, a resume, a
      // navigation) could have started while this preflight was in flight.
      if (isStale(generation)) return;
      if (
        fresh?.liveAgentRuns !== "AVAILABLE" ||
        (fresh.liveAccess !== "TOKEN_REQUIRED" && fresh.liveAccess !== "PUBLIC_TRIAL")
      ) {
        // Nothing is generated and nothing is sent: no ticket id, no
        // createAgentJob, no startAgentRun — and emphatically no silent
        // downgrade to FAKE. The form has already been switched to the
        // fail-closed state by refreshCapabilities. The previous
        // investigation's poll session, invalidated above, stays stopped —
        // there is nothing left for it to repopulate.
        // Admission refusal is NOT a failure: no failed stage, no lifecycle
        // mutation, no elapsed-freeze. The lifecycle surfaces are hidden by the
        // `job !== null` gates (job was never created), and the composer stays
        // visible with the user's Live selection intact — see §11.
        setNotice("Live is temporarily unavailable. No investigation job was created.");
        // Back to idle, completing the busy edge: the form unlocks and the token
        // clears, exactly as it does after any other terminal outcome.
        setPhase("idle");
        return;
      }
      // Issue #39 — a fresh PUBLIC_TRIAL response with visitorRunsRemaining
      // !== 1 means this visitor's trial was consumed between page load and
      // submission (another tab, a concurrent request). Refuse BEFORE creating
      // the job — the submission-time freshness check is what makes this
      // authoritative enough to avoid a stranded job.
      if (fresh.liveAccess === "PUBLIC_TRIAL" && fresh.visitorRunsRemaining !== 1) {
        setNotice(
          "Your live trial run for today has already been used. The deterministic demo remains available.",
        );
        // Same non-failure presentation as the unavailable branch: no failed
        // stage, no lifecycle mutation, composer stays visible.
        setPhase("idle");
        return;
      }
    }

    // A LIVE run never uses the approval-demo ticket: the form clears
    // approvalDemo on switching to LIVE and again at submit, so this can only
    // take the ordinary branch for a live run.
    const nextTicketId = submission.approvalDemo ? APPROVAL_DEMO_TICKET_ID : generateOrdinaryTicketId();
    /**
     * ONE key per LIVE investigation, minted here — before the job exists, so
     * the very first run request already carries it.
     *
     * A local const AND state, and the two roles are different. The local value
     * is what this call sends, because `setLiveRequestKey` does not update
     * `liveRequestKey` in time for the request a few lines below. The state
     * copy is what a later recovery submission reads.
     *
     * `null` for FAKE: a deterministic run spends nothing, so repeating one is
     * harmless and a key would be ceremony.
     */
    const requestKey = submission.providerMode === "LIVE" ? crypto.randomUUID() : null;
    setLiveRequestKey(requestKey);

    // A LOCAL const, never state. It holds the token for the duration of this
    // function and is unreachable the moment the workflow returns — which is the
    // whole mechanism by which "the token is cleared on success and on failure"
    // is guaranteed, rather than being a cleanup step that some path could miss.
    const runRequest = {
      providerMode: submission.providerMode,
      ...(submission.liveAccessToken !== undefined
        ? { liveAccessToken: submission.liveAccessToken }
        : {}),
      // Issue #39 — PUBLIC trial only, mutually exclusive with liveAccessToken.
      ...(submission.turnstileToken !== undefined
        ? { turnstileToken: submission.turnstileToken }
        : {}),
      ...(requestKey !== null ? { idempotencyKey: requestKey } : {}),
    };

    // job/run/approval/error/notice/liveRetryPending/activeProviderMode/
    // liveRequestKey were already reset by beginNewSubmissionDisplay() above,
    // before the LIVE preflight — not here.
    setTicketId(nextTicketId);
    setPhase("creating-job");

    let createdJob: AgentJobResponse;
    try {
      const result = await createAgentJob({ ticketId: nextTicketId, summary: submission.summary }, signal);
      if (isStale(generation)) return;
      createdJob = result.data;
      setJobSynced(createdJob);
      // Write the URL identity so a refresh during execution can resume.
      // replaceState when the URL has no job param (the same view gaining
      // an identity), pushState when replacing a different job.
      const currentJob = readJobParam(window.location.search);
      if (currentJob !== null && currentJob !== createdJob.id && isUuid(currentJob)) {
        window.history.pushState(null, "", `?${withJobParam(createdJob.id, window.location.search)}`);
      } else {
        window.history.replaceState(null, "", `?${withJobParam(createdJob.id, window.location.search)}`);
      }
      // Polling runs CONCURRENTLY with the blocking run POST below — either
      // may observe the terminal outcome first; applyObservedRunOutcome is
      // the one place that decides ownership regardless of which does.
      poll.start(createdJob.id, createPollCallbacks(generation, signal));
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      // Concise, stage-specific — same canonical source as the visual Failed
      // badge, never the raw server/provider message.
      setNotice(stageFailureAnnouncement("job"));
      setFailedStage("job");
      setSubmittedFinishedAt(Date.now());
      setPhase("idle");
      return;
    }

    setPhase("running-agent");
    let createdRun: AgentRunDetail;
    try {
      const result = await startAgentRun({ ...runRequest, jobId: createdJob.id }, signal);
      if (isStale(generation)) return;
      createdRun = result.data;
      // The run body is in hand, so the key has nothing left to protect: there
      // is no ambiguity to resolve and no recovery to make idempotent.
      setLiveRequestKey(null);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      // `liveRequestKey` is deliberately NOT cleared or regenerated here. This
      // failure is exactly the ambiguous case: it may mean nothing was created,
      // or it may mean a run was created and executed and the answer was lost.
      // Recovery has to ask for the SAME thing, so it has to keep the same key.
      // THE transition into recovery, and the only place it can be made: the job
      // committed, this run request was refused, and the token that authorized it
      // is gone. FAKE keeps its Retry Run button and needs no recovery mode.
      //
      // An abort or a superseded generation returns above WITHOUT setting this —
      // a cancelled request is not a refusal.
      if (submission.providerMode === "LIVE") {
        // Issue #39: PUBLIC trial has NO retry mechanism — exactly one
        // attempt, no recovery. `turnstileToken`'s presence is what marks
        // this as a PUBLIC submission (see runRequest above); only the
        // PRIVATE path ever enters recovery mode.
        if (submission.turnstileToken === undefined) {
          setLiveRetryPending(true);
        }
        // The refusal itself is evidence the answer changed. Refreshing keeps
        // the LIVE option and the recovery banner's copy honest — it does NOT
        // gate the recovery, which sends regardless (see retryLiveRunWithToken).
        void refreshCapabilities();
      }
      setNotice(stageFailureAnnouncement("run"));
      setFailedStage("run");
      setSubmittedFinishedAt(Date.now());
      setPhase("idle");
      return;
    }

    // Both the blocking POST's own resolution AND any concurrent poll tick
    // funnel through the SAME terminal-ownership decision point — whichever
    // observes the terminal outcome first becomes "owner"; the other is a
    // harmless "duplicate", or, if they disagree, "inconsistent" (the first
    // accepted state stands, untouched).
    const result = await applyObservedRunOutcome({
      job: createdJob,
      run: createdRun.run,
      trace: createdRun.trace,
      outcome: createdRun.outcome,
      events: eventsRef.current,
      signal,
      generation,
      source: "post",
      pollGeneration: null,
      skipAuthoritativeFinalRead: false,
    });
    if (result.kind === "stale") return;
    // RUNNING/duplicate/inconsistent/owner all unlock the form the same as a
    // direct COMPLETED/FAILED settlement — applyObservedRunOutcome already
    // set whatever notice/clock-freeze applies for its own decision.
    setPhase("idle");

    // A LIVE run just consumed a reservation, so the day's answer has almost
    // certainly moved. Best-effort and last: it cannot overwrite the run, the
    // notice, or the error, all of which are already committed above.
    if (submission.providerMode === "LIVE") void refreshCapabilities();
  }

  async function retryRun() {
    if (job === null) return;
    // A LIVE retry would need the access token, which this component no longer
    // holds — by design. The user re-submits the form instead, which is where the
    // token field lives; the button is not offered for LIVE (see showRetryRun),
    // and this guard makes that a property of the function rather than of the
    // markup that happens to call it.
    if (activeProviderMode === "LIVE") return;

    // A retry resumes the SAME investigation's progress display, so its
    // elapsed clock and stage-failure state restart rather than accumulate
    // from the earlier failed attempt.
    setSubmittedAt(Date.now());
    setSubmittedFinishedAt(null);
    setFailedStage(null);
    setApprovalLoadStatus("idle");
    // docs/16 §8's "prefer a strictly greater attempt": the floor rejects any
    // snapshot for an attempt at or below whatever this job's highest KNOWN
    // attempt was before this retry (0 when none has ever been observed —
    // the reachable case here, since "Retry Run" only appears when no run
    // object has ever been returned for this job).
    setMinAttemptNumberSynced((runRef.current?.run.attemptNumber ?? 0) + 1);

    const { signal, generation } = beginWorkflow();
    setError(null);
    // A RUNNING retry has no terminal result to announce. Clear the previous
    // attempt's failure now so it cannot reappear when phase returns to idle.
    setNotice(null);
    setPhase("running-agent");
    // Restart polling for the SAME job under the new workflow generation —
    // a retry is a fresh attempt, and the poll callbacks must close over
    // THIS call's generation/signal, never a stale one.
    poll.start(job.id, createPollCallbacks(generation, signal));
    let startedRun: AgentRunDetail;
    try {
      // Repeats the SAME provider mode the original submission chose. A retry
      // must never quietly become a different kind of run than the one the user
      // asked for — in either direction.
      const result = await startAgentRun({ providerMode: activeProviderMode, jobId: job.id }, signal);
      if (isStale(generation)) return;
      startedRun = result.data;
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setNotice(stageFailureAnnouncement("run"));
      setFailedStage("run");
      setSubmittedFinishedAt(Date.now());
      setPhase("idle");
      // No capability refresh here: this is the FAKE-only retry, and FAKE
      // availability is not something /v1/capabilities gates. Refreshing would
      // be a request that could not change anything on screen.
      return;
    }

    const result = await applyObservedRunOutcome({
      job,
      run: startedRun.run,
      trace: startedRun.trace,
      outcome: startedRun.outcome,
      events: eventsRef.current,
      signal,
      generation,
      source: "post",
      pollGeneration: null,
      skipAuthoritativeFinalRead: false,
    });
    if (result.kind === "stale") return;
    setPhase("idle");
  }

  /**
   * RECOVERS the retained job with a freshly typed token — it does not
   * necessarily start anything.
   *
   * "Recover", not "retry", and the word is load-bearing. The failure that put
   * the form here is ambiguous: the original request may have created nothing,
   * or it may have created a run, executed the provider, spent real money, and
   * lost the answer. This submission carries the SAME `liveRequestKey`, so the
   * server decides which of those happened:
   *
   *   no run for that key  -> exactly one run is created and executed (201)
   *   a run for that key   -> that run is returned untouched (200), no provider
   *                           call, no reservation, no attempt consumed
   *
   * A RUNNING replay is a normal, correct answer here — it is what a
   * finalization failure leaves behind — and it exits recovery mode like any
   * other. The refresh control then observes its later state.
   *
   * It submits WHATEVER `/v1/capabilities` last said. Availability governs new
   * paid runs; it does not govern recovering one that may already exist. See the
   * block where the preflight used to be.
   *
   * The defect this fixes: after job creation succeeded and the LIVE run request
   * failed, the UI told the user to re-enter their token — but the only submit
   * action was `runInvestigation`, which generates a new ticket ID and POSTs a
   * new AgentJob. So "retrying" silently created a duplicate job, stranded the
   * original, bypassed that job's live attempt history, and consumed a fresh
   * daily reservation under a different job. The instruction on screen was
   * false.
   *
   * This handler is the whole correction, and its most important property is
   * what it does NOT do: there is no `createAgentJob` call here. The retained
   * `job.id` is the only job identifier in scope, so the request cannot be
   * addressed anywhere else.
   */
  async function retryLiveRunWithToken(liveAccessToken: string) {
    if (job === null) return;
    // Mode is fixed by the retained job, not read from the form. A retry must
    // never become a FAKE run because of some intervening UI state.
    if (activeProviderMode !== "LIVE") return;

    // Same defensive check as the creation path. A recovery with no token would
    // be a guaranteed 401 against a job the user is trying to rescue.
    if (liveAccessToken.trim() === "") {
      setError(null);
      setNotice("A live demo access token is required to recover this investigation.");
      return;
    }

    /**
     * NO KEY, NO REQUEST. Refusing here rather than minting a replacement.
     *
     * A fresh key is by definition a different request, so sending one would ask
     * the server to start a SECOND paid run — the exact failure this whole
     * mechanism exists to prevent, reintroduced at the one moment it matters
     * most. Unreachable in practice (the key is set before the request that can
     * fail into this state, and is cleared only alongside the retained job), but
     * "unreachable" is not the same as "impossible", and the safe answer to a
     * missing key is to send nothing at all.
     */
    if (liveRequestKey === null) {
      setError(null);
      setNotice("This investigation can no longer be recovered safely. Start a new investigation.");
      return;
    }

    /**
     * NO CAPABILITY PREFLIGHT HERE — deliberately, and this is the correction.
     *
     * `/v1/capabilities` answers ONE question: may a NEW paid live run be
     * started? It reports UNAVAILABLE when the day's allowance is used up, when
     * an unreconciled reservation has latched the day, when the concurrency slot
     * is taken, and when the kill switch is off.
     *
     * Recovery is not a new paid run, and the first two of those are the states
     * this recovery most often has to work in — because the request being
     * recovered is frequently what produced them. The original attempt consumes
     * the day's final reservation, its answer is lost, and the tab refuses to
     * send the one request that would hand that run back. The browser was
     * enforcing a rule the server does not have, against the exact case the
     * retained key exists for.
     *
     * The server now answers a retained key from an authenticated, locked
     * replay lookup that runs BEFORE any spend gate, so this request is worth
     * sending whatever the last capability read said. If no run exists for the
     * key, the server applies the ordinary new-run rules and may refuse — which
     * is handled below, with the job and the key both kept.
     *
     * The CREATION preflight in runInvestigation stays exactly as it was. There,
     * an unavailable answer prevents an avoidable new AgentJob from being
     * created for a run that never had a chance; here, it would only prevent a
     * recovery from happening at all.
     */

    // Same reset as the FAKE retry path (retryRun): resumes this
    // investigation's progress display rather than accumulating the earlier
    // failed attempt's elapsed time or stage-failure state.
    setSubmittedAt(Date.now());
    setSubmittedFinishedAt(null);
    setFailedStage(null);
    setApprovalLoadStatus("idle");
    // docs/16 §8's "prefer a strictly greater attempt" — see retryRun's
    // identical reasoning: 0 (floor 1) is the reachable case here, since
    // `liveRetryPending` only becomes true when no run object was ever
    // returned to this client for this job.
    setMinAttemptNumberSynced((runRef.current?.run.attemptNumber ?? 0) + 1);

    // The same abort/generation machinery every other workflow uses, so a retry
    // racing a new investigation is discarded on the same rule.
    const { signal, generation } = beginWorkflow();
    setError(null);
    setNotice(null);
    setPhase("running-agent");
    // Restart polling for the SAME job under the new workflow generation.
    poll.start(job.id, createPollCallbacks(generation, signal));

    let startedRun: AgentRunDetail;
    /**
     * Whether the server REPLAYED rather than started — carried out of the try
     * block rather than announced inside it.
     *
     * Announcing it here and letting the approval step announce its own thing
     * afterwards is exactly the bug this replaces: two `setNotice` calls in
     * sequence, so a PENDING approval silently overwrote the one message that
     * explains why no second paid attempt was consumed. The two facts are not
     * competing — they are both true — so the fix is to decide the wording ONCE,
     * downstream, with both in hand.
     */
    let replayed = false;
    try {
      const result = await startAgentRun(
        // `liveAccessToken` is this function's ARGUMENT, never state: it lives
        // for the duration of the call and is unreachable afterwards, exactly as
        // in runInvestigation. `liveRequestKey` is the opposite on purpose — the
        // SAME value the failed attempt sent, read from state.
        { jobId: job.id, providerMode: "LIVE", liveAccessToken, idempotencyKey: liveRequestKey },
        signal,
      );
      if (isStale(generation)) return;
      startedRun = result.data;
      // Recovered. The run exists, so there is nothing left to recover and the
      // key has nothing left to protect.
      setLiveRetryPending(false);
      setLiveRequestKey(null);
      // 200 means the server recognized the key and returned a run an earlier
      // request had already created. 201 means this submission genuinely started
      // it — the first attempt never got that far — and claiming a replay then
      // would be the mirror-image lie.
      replayed = result.status === 200;
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      // The job is deliberately LEFT IN PLACE, and `liveRetryPending` is left
      // TRUE. A second failure — including a per-job attempt-limit rejection —
      // keeps exactly the same retained job on screen and stays retryable,
      // rather than degrading into a state where the only way forward is to
      // create another job.
      setError(toDisplayableError(thrown));
      setNotice(stageFailureAnnouncement("run"));
      setFailedStage("run");
      setSubmittedFinishedAt(Date.now());
      setPhase("idle");
      /**
       * Terminal outcome, so refresh — BEST EFFORT, and strictly AFTER the error
       * is set.
       *
       * The rejection is itself evidence the answer may have moved: an exhausted
       * budget, a latched UTC day, a flipped kill switch. The next retry should
       * start from a current picture rather than the one that just failed.
       *
       * Fire-and-forget by construction: refreshCapabilities never throws and
       * only ever writes `capabilities`, so it cannot replace the error above,
       * discard the retained job, or clear `liveRetryPending`.
       */
      void refreshCapabilities();
      return;
    }

    /**
     * ONE composed message, chosen here with both the replay fact and the
     * ACTUAL outcome known — never assuming success from the run merely
     * existing (outcome-aware, like every other settlement point).
     *
     * `applyObservedRunOutcome` returns `loadedApproval: null` for a failed
     * fetch as well as for a non-pending one, and reports the failure through
     * the error banner on its own. That collapse is deliberate here: the replay
     * confirmation must survive an approval-load failure, because "no second
     * paid attempt was consumed" is a fact about the run that a failed GET
     * cannot unmake. Failing to fetch an approval is not a reason to stop
     * saying it.
     *
     * Still the existing `notice` region — no second live region is
     * introduced, because two polite announcements racing each other is how
     * this went wrong in the first place.
     *
     * `replayed` and the run's OUTCOME are independent facts. "No new run
     * was started" is a statement about IDEMPOTENCY — true the instant the
     * server answers with a 200 — and holds regardless of whether that
     * recovered run has itself finished, failed, or is still RUNNING. A
     * RUNNING replay is a normal, correct answer (exactly what a
     * finalization failure leaves behind), so it still earns the recovery
     * confirmation, just without any claim about completion.
     */
    const RECOVERED = "Recovered the original live run — no new run was started.";
    const result = await applyObservedRunOutcome({
      job,
      run: startedRun.run,
      trace: startedRun.trace,
      outcome: startedRun.outcome,
      events: eventsRef.current,
      signal,
      generation,
      source: "post",
      pollGeneration: null,
      skipAuthoritativeFinalRead: false,
    });
    if (result.kind === "stale") return;
    if (replayed) {
      // Both facts matter: no second paid attempt was made, AND whatever the
      // ACTUAL outcome is. Overrides applyObservedRunOutcome's own generic
      // notice with the composed, replay-aware version — never re-fetching
      // approval or re-freezing the clock a second time; only the ANNOUNCED
      // wording changes.
      if (result.kind === "owner" && result.outcome === "COMPLETED") {
        setNotice(
          result.loadedApproval?.status === "PENDING" ? `${RECOVERED} ${APPROVAL_REQUIRED_ANNOUNCEMENT}` : RECOVERED,
        );
      } else if (result.kind === "owner" && result.outcome === "FAILED") {
        setNotice(`${RECOVERED} ${stageFailureAnnouncement("run")}`);
      } else if (result.kind === "duplicate" || result.kind === "running") {
        setNotice(RECOVERED);
      }
      // "inconsistent": the fixed safety notice already set by the
      // coordinator stands — a replay confirmation is not worth asserting
      // over a result that could not actually be settled.
    }
    // !replayed: the coordinator's own generic notice already applies for
    // owner/duplicate/inconsistent; RUNNING keeps none, matching every other
    // settlement point.
    setPhase("idle");
    void refreshCapabilities();
  }

  /**
   * Abandons a retained partial workflow and returns the form to ordinary
   * creation mode.
   *
   * LOCAL STATE ONLY. It sends no request and deletes nothing: the AgentJob row
   * stays exactly as it is, and an operator can still find it by id. Without
   * this the retained job is a trap — the only submit action retries it, so a
   * user who has changed their mind would have to reload the page.
   *
   * Any in-flight workflow is cancelled first, so a late response cannot
   * repopulate the state this just cleared.
   */
  function startNewInvestigation() {
    invalidateInFlightWorkflows();
    resetToFreshFormState();
    // Strip the ?job= param — this is a fresh investigation.
    window.history.replaceState(null, "", `?${withoutJobParam(window.location.search)}`);
    void refreshCapabilities();
  }

  async function refreshRun() {
    if (run === null) return;
    // Captured BEFORE `setRun` overwrites it. RUNNING may observe its first
    // terminal outcome here; COMPLETED refreshes its existing approval view;
    // FAILED is terminal and permanently approval-ineligible.
    const previousOutcome = run.outcome.type;
    const { signal, generation } = beginWorkflow();
    /**
     * Finding 5 (independent review): `beginWorkflow()` bumps the main
     * generation, but a still-active poll session's callbacks were captured
     * closing over the OLD generation — without this, they never get told
     * to stop, so they keep issuing GETs that `isStale` now rejects forever
     * (a silently disconnected poll loop). Stopping it explicitly here,
     * rather than leaving it to spin, is the fix; if the refreshed run is
     * still RUNNING, polling is restarted below under the NEW generation.
     */
    poll.stop("aborted");
    setError(null);
    setPhase("refreshing-run");
    let refreshedRun: AgentRunDetail;
    try {
      const result = await getAgentRun(run.run.id, signal);
      if (isStale(generation)) return;
      refreshedRun = result.data;
      setRunSynced(refreshedRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      return;
    }

    if (previousOutcome === "RUNNING") {
      if (refreshedRun.outcome.type === "RUNNING") {
        // Finding 5: still running — restart polling under the NEW
        // generation so live canonical progress keeps updating after a
        // manual Refresh, rather than staying silently disconnected.
        poll.start(refreshedRun.job.id, createPollCallbacks(generation, signal));
        setNotice("Run refreshed.");
        setPhase("idle");
        return;
      }
      /**
       * Finding 2 (independent review, Codex review): Refresh's own read
       * above is the LEGACY `getAgentRun` endpoint, which never carries
       * canonical `events[]`. Observing a terminal outcome here for the
       * FIRST time (this run was RUNNING a moment ago) must not settle
       * through `settleRunOutcome` — that would freeze the Timeline's
       * child rows on whatever partial canonical prefix polling last
       * accepted, with no later read able to correct them. Route it
       * through the SAME `applyObservedRunOutcome` coordinator the POST and
       * poll paths use instead: it performs its own authoritative
       * `getInvestigationState` read before permanently freezing canonical
       * detail (Finding 1's mechanism, reused here), applies the SAME
       * cross-attempt monotonicity guards (Finding 4), and preserves the
       * existing approval semantics (COMPLETED loads once, FAILED never)
       * and no-restart-after-terminal rule automatically.
       */
      const result = await applyObservedRunOutcome({
        job: refreshedRun.job,
        run: refreshedRun.run,
        trace: refreshedRun.trace,
        outcome: refreshedRun.outcome,
        events: eventsRef.current,
        signal,
        generation,
        source: "post",
        pollGeneration: null,
        skipAuthoritativeFinalRead: false,
      });
      if (result.kind === "stale" || result.kind === "discarded") return;
      setPhase("idle");
      return;
    }

    if (previousOutcome === "FAILED") {
      // Terminal run outcomes are immutable in the repository, so the only
      // supported transition here is FAILED -> FAILED. Refresh the projection
      // and preserve its failure announcement, but never begin approval
      // settlement for a run that is permanently ineligible.
      setNotice(stageFailureAnnouncement("run"));
      setPhase("idle");
      return;
    }

    // An ordinary refresh of an already-COMPLETED investigation — not part of
    // the tracked workflow (loadApproval must not rewrite a frozen Progress
    // Timeline stage), and worded as a refresh rather than a completion.
    setPhase("loading-approval");
    const loadedApproval = await loadApproval(refreshedRun.run.id, signal, generation, {
      reportError: true,
      trackInvestigationProgress: false,
    });
    if (isStale(generation)) return;
    setNotice(loadedApproval?.status === "PENDING" ? "Run refreshed. Human approval required." : "Run refreshed.");
    setPhase("idle");
  }

  async function recordDecision(input: RecordApprovalDecisionInput) {
    if (run === null) return;
    const runId = run.run.id;
    const { signal, generation } = beginWorkflow();
    setError(null);
    setNotice(null);
    setPhase("submitting-approval");
    try {
      const result = await recordApproval(runId, input, signal);
      if (isStale(generation)) return;
      setApproval(result.data);
      setNotice(
        result.status === 201 ? "Decision recorded." : "This decision was already recorded — nothing changed.",
      );
      setPhase("idle");
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      if (thrown instanceof ApiRequestError && CONFLICT_APPROVAL_ERROR_CODES.has(thrown.code)) {
        setPhase("loading-approval");
        // The 409-convergence reload is a side effect of submitting a
        // decision, not a step of completing the tracked investigation —
        // same reasoning as an ordinary manual Refresh above.
        await loadApproval(runId, signal, generation, { reportError: false, trackInvestigationProgress: false });
        if (isStale(generation)) return;
      }
      setPhase("idle");
    }
  }

  const isBusy = phase !== "idle";
  // A job exists but no run does. NOT sufficient on its own to mean "the run
  // failed" — it is equally true while the first run request is in flight, which
  // is why `liveRetryPending` exists. `!resumedJobOnly` excludes a job resumed
  // from `?job=` with no run: there is no persisted record of that job's
  // ORIGINAL provider selection, so offering Retry Run/Recover Live Run could
  // silently retry a LIVE job as FAKE (or vice versa) — the approved direction
  // for that state is the ordinary fresh-submission form, not a retry button.
  const hasRetainedPartialWorkflow = job !== null && run === null && !resumedJobOnly;
  const canRetryRun = hasRetainedPartialWorkflow && phase === "idle";
  // Offered only for FAKE. A LIVE retry needs the access token this component
  // deliberately no longer keeps, so the honest affordance is the form's retry
  // mode rather than a button that would earn a 401.
  const showRetryRun = canRetryRun && activeProviderMode === "FAKE";
  const showLiveRetryTokenNotice = canRetryRun && liveRetryPending && activeProviderMode === "LIVE";
  /**
   * What the form needs to render "Recover Live Run", or `null` for the ordinary
   * new-investigation form.
   *
   * Gated on `liveRetryPending`, which is set ONLY where a LIVE run request was
   * observed to fail. The nullable fields alone cannot distinguish "the first
   * run is still in flight" from "the first run was refused", and treating the
   * former as the latter told the user their run had failed while it was still
   * running.
   *
   * Deliberately NOT gated on `phase === "idle"`: the form must stay in recovery
   * mode WHILE a recovery is in flight, or it would snap back to the creation
   * form mid-submit and change what the pending submission appears to be. That is
   * safe now precisely because `liveRetryPending` distinguishes the two cases —
   * it is false throughout the first attempt and true throughout a recovery.
   *
   * `summary` comes from the persisted job, not from the form's own field — it
   * is a fact about a committed row, and the recovery cannot change it.
   */
  const liveRetryTarget =
    liveRetryPending && hasRetainedPartialWorkflow && activeProviderMode === "LIVE" && job !== null
      ? { jobId: job.id, ticketId: job.ticketId, summary: job.summary }
      : null;
  const progressText = isBusy ? PHASE_LABELS[phase] : (notice ?? "");
  const showActionRequiredBanner = approval?.status === "PENDING";
  /**
   * Milestone-10 composer collapse (§14 / plan phase 6). The fresh-submission
   * form is the PRIMARY surface until a real job exists, and reappears for the
   * two job-resident recovery modes (a LIVE run refused mid-run, and a job-only
   * resume). Deliberately NOT gated on `isBusy`: preflight/job-creation are
   * busy before any job exists and must keep the composer visible.
   */
  const showComposer = job === null || liveRetryTarget !== null || resumedJobOnly;
  /**
   * Both lifecycle surfaces (Current investigation, Progress Timeline) require
   * grounded evidence of a real job — never `isBusy` (true during preflight/
   * job-creation before any job exists) and never `submittedSummary !== null`
   * (set before the job, so a refused admission would paint a fake Submitted
   * issue / Progress Timeline). §11, plan phase 6.
   */
  const showCurrentInvestigation = job !== null;
  const showProgressTimeline = job !== null;

  // The stage the CURRENT phase maps to for the Progress Timeline — "approval"
  // is deliberately excluded here (see investigation-progress-stages.ts):
  // `loading-approval` is also reused by refreshRun and the 409-convergence
  // path, neither of which is part of THIS investigation's tracked progress.
  const activeProgressStageKey: "availability" | "job" | "run" | null =
    phase === "checking-availability" ? "availability" : phase === "creating-job" ? "job" : phase === "running-agent" ? "run" : null;
  const progressStagesResult =
    job !== null
      ? deriveInvestigationProgressStages({
          providerMode: activeProviderMode,
          activeStageKey: activeProgressStageKey,
          failedStage,
          jobCreated: job !== null,
          // The run stage's status is a function of the AGENT's own outcome,
          // never of `run !== null` alone — see investigation-progress-stages.ts.
          runOutcomeType: run?.outcome.type ?? null,
          approvalLoadStatus,
          executionStageDerivation,
          // A VIEW of the observed event stream, nested under execution-stage
          // rows — never a driver of stage state (see investigation-progress-stages.ts).
          events,
        })
      : null;
  const progressStages = progressStagesResult?.stages ?? [];
  const executionDetailNote = progressStagesResult?.executionDetailNote ?? null;
  // Grounds ReportPanel's FAILED summary in the same canonical stage rows
  // the Progress Timeline renders — never a separately-invented mapping
  // (HQ review §3).
  const failedStageLabel = findFailedExecutionStageLabel(progressStages.find((s) => s.key === "run")?.children);
  // Elapsed-time bugfix: a real run object with a non-RUNNING outcome is
  // terminal — `useElapsedTime` must never tick (via `Date.now()`) once
  // this is true, even in the rare case `submittedFinishedAt` itself ends
  // up null (see its own `isTerminal` fail-safe contract).
  const isTerminalRun = run !== null && run.outcome.type !== "RUNNING";
  const elapsedMs = useElapsedTime(submittedAt, submittedFinishedAt, isTerminalRun);
  const elapsedLabel = formatElapsed(elapsedMs);
  // HQ item 4 — the overall lifecycle status shown in the Progress card
  // header, top-right. `null` before any run exists yet (job created, run
  // not yet returned).
  const overallStatus = run !== null ? runStatusBadge(run.outcome.type) : null;
  // "Check again" is offered ONLY for the three pausable poll reasons —
  // never for terminal/not-found/permanent-invalid/aborted, none of which
  // ever set `pausedReason` (see createPollCallbacks's onStop).
  const showCheckAgain = pausedReason !== null;
  // Flat-flow derived gates (§15 / plan phase 7). Same `job !== null` stance
  // as the other lifecycle surfaces — no `isBusy`, no `submittedSummary`.
  // "Resolution" (ReportPanel) only ever mounts for a non-RUNNING outcome; a
  // RUNNING outcome renders nothing, not a placeholder (Phase A has no
  // polling). Suggested actions is separately gated and never mounts empty.
  const showResolution = run !== null && run.outcome.type !== "RUNNING";
  const suggestedActionCount =
    run?.outcome.type === "COMPLETED" ? run.outcome.report.suggestedActions.length : 0;
  // Issue #41 polish §8 — the page-level terminal "Start new investigation"
  // CTA (after Run Details, above the footer). Shown only once the run is
  // terminal AND any required human approval has reached a decided state (or
  // never applied, e.g. FAILED / NOT_ELIGIBLE). Never during preflight,
  // creation, running, or an unresolved/pending approval. Reuses the existing
  // reset/new-submission path (startNewInvestigation) — no job is created
  // until the user submits again.
  const showNewInvestigation =
    run !== null &&
    run.outcome.type !== "RUNNING" &&
    (run.outcome.type === "FAILED" || (approval !== null && approval.status !== "PENDING"));
  // Final UX Pilot fidelity pass — Current Investigation/Progress already show
  // completion via badges, so the redundant visible "Investigation complete."
  // sentence is visually suppressed (kept in the DOM/aria-live tree for
  // screen readers). Derived, not a second piece of tracked state: the
  // completion announcement has a small fixed textual domain
  // (`INVESTIGATION_COMPLETE_ANNOUNCEMENT`, optionally suffixed with the
  // approval-required sentence), so comparing `notice` against it can't drift
  // out of sync the way a manually-set companion flag at 20+ setNotice call
  // sites could.
  const noticeIsCompletionAnnouncement = notice !== null && notice.startsWith(INVESTIGATION_COMPLETE_ANNOUNCEMENT);
  // Running desktop composition (HQ item 5) — while RUNNING, the resolution
  // row pairs Progress with Agent Activity (Resolution has nothing to show
  // yet); once terminal, it reverts to Progress+Resolution and Agent Activity
  // returns to its normal item-6 position. Never both at once.
  const isRunningOutcome = run !== null && run.outcome.type === "RUNNING";
  // Single definition reused in whichever of the two mutually-exclusive slots
  // applies (the running-composition pairing inside `.resolution-row`, or the
  // normal item-6 position) — never rendered in both at once.
  const agentActivitySection =
    run !== null ? (
      <section className="trace-section" aria-labelledby="timeline-heading">
        <div className="trace-section-header">
          <h2 id="timeline-heading" tabIndex={-1}>
            Agent activity
          </h2>
        </div>
        <TraceTimeline trace={run.trace} />
      </section>
    ) : null;

  return (
    <div className="app-shell">
      <ProductHeader />

      {error !== null ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <p className={`notice-region${noticeIsCompletionAnnouncement ? " sr-only" : ""}`} role="status" aria-live="polite">
        {progressText}
      </p>

      {showComposer ? (
        <section className="composer" aria-label="Start an investigation">
          <InvestigationForm
            key={formResetKey}
            disabled={isBusy}
            submitLabel={PHASE_LABELS[phase]}
            capabilities={capabilities}
            onSubmit={runInvestigation}
            liveRetryTarget={liveRetryTarget}
            onRetryLiveRun={retryLiveRunWithToken}
            onStartNewInvestigation={startNewInvestigation}
            defaultApprovalDemo={defaultApprovalDemo}
          />
        </section>
      ) : null}

      {showCurrentInvestigation ? (
        <CurrentInvestigation
          summary={job !== null ? job.summary : ""}
          providerMode={activeProviderMode}
          run={run?.run ?? null}
          outcome={run?.outcome ?? null}
        />
      ) : null}

      {/* 2. Human approval required banner when applicable. Informational jump
          to the item-5 decision surface — the panel, not the banner, decides. */}
      {showActionRequiredBanner ? <ActionRequiredBanner suggestedActionCount={suggestedActionCount} /> : null}

      {/* 3. Progress + Resolution — share a row on desktop; Resolution gets the
          wider column (§15). Both stay gated on grounded truth; a RUNNING
          outcome renders no report placeholder.
          HQ item 5 (Running desktop composition): while RUNNING, Agent
          Activity takes the row's second slot instead of Resolution — wide
          Progress + narrow Activity, the operations-console pairing the
          reference uses for the running screen — via `.resolution-row--running`.
          Terminal-state DOM order/CSS is unchanged from before this pass. */}
      {showProgressTimeline || showResolution ? (
        <div className={`resolution-row${isRunningOutcome ? " resolution-row--running" : ""}`}>
          {showProgressTimeline ? (
            <InvestigationProgressTimeline
              stages={progressStages}
              elapsedLabel={elapsedLabel}
              executionDetailNote={executionDetailNote}
              overallStatus={overallStatus}
            />
          ) : null}
          {isRunningOutcome ? (
            agentActivitySection
          ) : run !== null && run.outcome.type !== "RUNNING" ? (
            <ReportPanel outcome={run.outcome} failedStageLabel={failedStageLabel} />
          ) : null}
        </div>
      ) : null}

      {showCheckAgain ? (
        <p className="investigation-poll-paused">
          Live progress updates are paused.{" "}
          <button type="button" onClick={() => poll.resume()}>
            Check again
          </button>
        </p>
      ) : null}

      {/* 4. Suggested Actions — separately gated, never mounted empty. */}
      {run !== null && run.outcome.type === "COMPLETED" && run.outcome.report.suggestedActions.length > 0 ? (
        <SuggestedActionsPanel actions={run.outcome.report.suggestedActions} />
      ) : null}

      {/* 5. Human Approval — rendered DIRECTLY for all four statuses including
          NOT_ELIGIBLE (§18). When `approval === null` (still loading, or the
          fetch failed) no decision surface mounts — the Progress Timeline's
          approval stage already states that truthfully. */}
      {approval !== null ? (
        <ApprovalPanel
          approval={approval}
          suggestedActionCount={suggestedActionCount}
          decisionDisabled={isBusy}
          submittingDecision={phase === "submitting-approval"}
          onDecide={recordDecision}
        />
      ) : null}

      {/* 6. Agent Activity — product-language labels, raw identifiers behind
          Technical details (§14). While RUNNING, this section renders inside
          the resolution row instead (HQ item 5) — never in both places. */}
      {!isRunningOutcome ? agentActivitySection : null}

      {/* 7. Run Details — compact primary fields + Technical details
          disclosure (§12); absorbed RunOverviewPanel's unique facts. */}
      {job !== null ? (
        <InvestigationSummary
          ticketId={ticketId ?? ""}
          job={job}
          run={run?.run ?? null}
          traceEventCount={run?.trace.length ?? 0}
          suggestedActionCount={suggestedActionCount}
          showRetryRun={showRetryRun}
          showLiveRetryTokenNotice={showLiveRetryTokenNotice}
          retryDisabled={isBusy}
          onRetryRun={retryRun}
          refreshDisabled={isBusy}
          onRefresh={refreshRun}
        />
      ) : null}

      {/* 8. Page-level terminal CTA (§8) — AFTER Run Details, BEFORE the
          footer. Reuses the existing reset path: returns to the Fresh
          composer, never creates a backend job. Desktop: right-aligned
          secondary action with a low-emphasis cue. Mobile: full-width above
          the footer. Never mounts during running or unresolved approval. */}
      {showNewInvestigation ? (
        <section className="terminal-new-investigation" aria-label="Start another investigation">
          <p className="terminal-new-investigation-cue">Ready to investigate another issue?</p>
          <button
            type="button"
            className="form-secondary-action terminal-new-investigation-action"
            onClick={startNewInvestigation}
          >
            Start new investigation
          </button>
        </section>
      ) : null}

      <AppFooter />
    </div>
  );
}
