import { useEffect, useRef, useState } from "react";

import {
  createAgentJob,
  getAgentRun,
  getApproval,
  getCapabilities,
  recordApproval,
  startAgentRun,
} from "./api/endpoints";
import { ApiRequestError } from "./api/http-client";
import type {
  AgentJobResponse,
  AgentRunDetail,
  ApprovalView,
  CapabilitiesView,
  RecordApprovalDecisionInput,
} from "./api/types";
import { ActionRequiredBanner } from "./components/ActionRequiredBanner";
import { ErrorBanner, type DisplayableError } from "./components/ErrorBanner";
import { InvestigationForm, type InvestigationFormSubmission } from "./components/InvestigationForm";
import { InvestigationSummary } from "./components/InvestigationSummary";
import { ReportPanel } from "./components/ReportPanel";
import { RunContextPanel } from "./components/RunContextPanel";
import { TraceTimeline } from "./components/TraceTimeline";

type Phase =
  | "idle"
  | "checking-availability"
  | "creating-job"
  | "running-agent"
  | "loading-approval"
  | "refreshing-run"
  | "submitting-approval";

const PHASE_LABELS: Record<Phase, string> = {
  idle: "Run Investigation",
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
  "checking-availability": "Checking availability…",
  "creating-job": "Creating investigation…",
  "running-agent": "Running agent…",
  "loading-approval": "Loading approval…",
  "refreshing-run": "Refreshing…",
  "submitting-approval": "Recording decision…",
};

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
   * "Retry Live Run" — announcing "the live run could not be started" — while
   * that very run was still in flight, and the token-clearing effect would wipe
   * the field mid-request.
   *
   * A pending request and a failed one are genuinely different facts, and no
   * combination of nullable resource fields can tell them apart. Only the code
   * that observes the rejection knows, so only it sets this.
   */
  const [liveRetryPending, setLiveRetryPending] = useState(false);
  /**
   * Bumped to remount InvestigationForm, discarding the state it owns.
   *
   * The form owns `summary`, `providerMode`, `approvalDemo`, `liveAccessToken`,
   * and `submittingRef`; the parent cannot reach any of them. Remounting on a
   * changed `key` is the one reset that cannot miss a field — including a ref,
   * which no prop-driven effect would clear.
   */
  const [formResetKey, setFormResetKey] = useState(0);

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  // A SECOND, independent pair for capability reads — see refreshCapabilities.
  // Sharing the investigation's would let a background focus refresh abort a run.
  const capabilityControllerRef = useRef<AbortController | null>(null);
  const capabilityGenerationRef = useRef(0);

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

  // Never throws — a failed approval fetch must not unwind the run that was
  // already committed to the page. Reuses the caller's signal/generation
  // rather than calling beginWorkflow() again, since it is a continuation of
  // the caller's workflow, not a new one. Returns the fetched ApprovalView (or
  // null on a stale/aborted/reported-error result) so callers can decide the
  // right accessible-notice wording for their own flow (see runInvestigation/
  // retryRun/refreshRun) without this function needing to know which flow
  // called it.
  async function loadApproval(
    runId: string,
    signal: AbortSignal,
    generation: number,
    options: { readonly reportError: boolean },
  ): Promise<ApprovalView | null> {
    try {
      const result = await getApproval(runId, signal);
      if (isStale(generation)) return null;
      setApproval(result.data);
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
      return null;
    }
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
       * DEFENSIVE TOKEN CHECK, before even the capability request.
       *
       * The form already blocks a tokenless LIVE submission, so this is
       * belt-and-braces — but it is the parent that actually issues requests,
       * and "the child validated it" is not something the request-issuing code
       * should have to assume. Costs one string check and removes a whole class
       * of avoidable 401s and stranded jobs.
       */
      if ((submission.liveAccessToken ?? "").trim() === "") {
        setError(null);
        setNotice("A live demo access token is required for a live run.");
        return;
      }

      // Phase FIRST, then the await — see PHASE_LABELS["checking-availability"].
      setPhase("checking-availability");
      const fresh = await refreshCapabilities();
      if (fresh?.liveAgentRuns !== "AVAILABLE" || fresh.liveAccess !== "TOKEN_REQUIRED") {
        // Nothing is generated and nothing is sent: no ticket id, no
        // createAgentJob, no startAgentRun — and emphatically no silent
        // downgrade to FAKE. The form has already been switched to the
        // fail-closed state by refreshCapabilities.
        setError(null);
        setNotice("Live Claude is temporarily unavailable. No investigation job was created.");
        // Back to idle, completing the busy edge: the form unlocks and the token
        // clears, exactly as it does after any other terminal outcome.
        setPhase("idle");
        return;
      }
    }

    const { signal, generation } = beginWorkflow();
    // A LIVE run never uses the approval-demo ticket: the form clears
    // approvalDemo on switching to LIVE and again at submit, so this can only
    // take the ordinary branch for a live run.
    const nextTicketId = submission.approvalDemo ? APPROVAL_DEMO_TICKET_ID : generateOrdinaryTicketId();
    // A LOCAL const, never state. It holds the token for the duration of this
    // function and is unreachable the moment the workflow returns — which is the
    // whole mechanism by which "the token is cleared on success and on failure"
    // is guaranteed, rather than being a cleanup step that some path could miss.
    const runRequest = {
      providerMode: submission.providerMode,
      ...(submission.liveAccessToken !== undefined
        ? { liveAccessToken: submission.liveAccessToken }
        : {}),
    };
    // Only the mode is remembered, so a later retry repeats the user's choice
    // without the credential that authorized the original.
    setActiveProviderMode(submission.providerMode);

    setTicketId(nextTicketId);
    setJob(null);
    setRun(null);
    setApproval(null);
    setError(null);
    setNotice(null);
    // A fresh investigation is never a recovery. Cleared up front so the window
    // between job creation and the run resolving shows the ORDINARY busy UI.
    setLiveRetryPending(false);
    setPhase("creating-job");

    let createdJob: AgentJobResponse;
    try {
      const result = await createAgentJob({ ticketId: nextTicketId, summary: submission.summary }, signal);
      if (isStale(generation)) return;
      createdJob = result.data;
      setJob(createdJob);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      return;
    }

    setPhase("running-agent");
    let createdRun: AgentRunDetail;
    try {
      const result = await startAgentRun({ ...runRequest, jobId: createdJob.id }, signal);
      if (isStale(generation)) return;
      createdRun = result.data;
      setRun(createdRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      // THE transition into recovery, and the only place it can be made: the job
      // committed, this run request was refused, and the token that authorized it
      // is gone. FAKE keeps its Retry Run button and needs no recovery mode.
      //
      // An abort or a superseded generation returns above WITHOUT setting this —
      // a cancelled request is not a refusal.
      if (submission.providerMode === "LIVE") {
        setLiveRetryPending(true);
        // The refusal itself is evidence the answer changed. Refreshing here is
        // what lets the retry preflight below start from a current picture.
        void refreshCapabilities();
      }
      setPhase("idle");
      return;
    }

    setPhase("loading-approval");
    const loadedApproval = await loadApproval(createdRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    if (loadedApproval?.status === "PENDING") {
      setNotice("Investigation completed. Human approval required.");
    }
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

    const { signal, generation } = beginWorkflow();
    setError(null);
    setPhase("running-agent");
    let startedRun: AgentRunDetail;
    try {
      // Repeats the SAME provider mode the original submission chose. A retry
      // must never quietly become a different kind of run than the one the user
      // asked for — in either direction.
      const result = await startAgentRun({ providerMode: activeProviderMode, jobId: job.id }, signal);
      if (isStale(generation)) return;
      startedRun = result.data;
      setRun(startedRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      // No capability refresh here: this is the FAKE-only retry, and FAKE
      // availability is not something /v1/capabilities gates. Refreshing would
      // be a request that could not change anything on screen.
      return;
    }

    setPhase("loading-approval");
    const loadedApproval = await loadApproval(startedRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    if (loadedApproval?.status === "PENDING") {
      setNotice("Investigation completed. Human approval required.");
    }
    setPhase("idle");
  }

  /**
   * Retries the RETAINED job with a freshly typed token.
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

    // Same defensive check as the creation path. A retry with no token would be
    // a guaranteed 401 against a job the user is trying to rescue.
    if (liveAccessToken.trim() === "") {
      setError(null);
      setNotice("A live demo access token is required to retry this investigation.");
      return;
    }

    /**
     * RETRY PREFLIGHT. Same reasoning as the creation preflight, with a stricter
     * failure mode: on unavailable the retained job and `liveRetryPending` are
     * both KEPT, no request is sent, and the form stays in retry mode. A stale
     * answer must never cost the user their recovery path.
     */
    setPhase("checking-availability");
    const fresh = await refreshCapabilities();
    if (fresh?.liveAgentRuns !== "AVAILABLE" || fresh.liveAccess !== "TOKEN_REQUIRED") {
      setError(null);
      setNotice("Live Claude is temporarily unavailable. The investigation is still here to retry.");
      // Retry mode is KEPT — only the busy state ends.
      setPhase("idle");
      return;
    }

    // The same abort/generation machinery every other workflow uses, so a retry
    // racing a new investigation is discarded on the same rule.
    const { signal, generation } = beginWorkflow();
    setError(null);
    setNotice(null);
    setPhase("running-agent");

    let startedRun: AgentRunDetail;
    try {
      const result = await startAgentRun(
        // `liveAccessToken` is this function's ARGUMENT, never state: it lives
        // for the duration of the call and is unreachable afterwards, exactly as
        // in runInvestigation.
        { jobId: job.id, providerMode: "LIVE", liveAccessToken },
        signal,
      );
      if (isStale(generation)) return;
      startedRun = result.data;
      setRun(startedRun);
      // Recovered. The run exists, so there is nothing left to retry.
      setLiveRetryPending(false);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      // The job is deliberately LEFT IN PLACE, and `liveRetryPending` is left
      // TRUE. A second failure — including a per-job attempt-limit rejection —
      // keeps exactly the same retained job on screen and stays retryable,
      // rather than degrading into a state where the only way forward is to
      // create another job.
      setError(toDisplayableError(thrown));
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

    setPhase("loading-approval");
    const loadedApproval = await loadApproval(startedRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    if (loadedApproval?.status === "PENDING") {
      setNotice("Investigation completed. Human approval required.");
    }
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
    beginWorkflow();
    setTicketId(null);
    setJob(null);
    setRun(null);
    setApproval(null);
    setError(null);
    setNotice(null);
    setLiveRetryPending(false);
    // Discards the abandoned summary, provider choice, approval-demo checkbox,
    // and token the form still holds. Without this the user asks for a NEW
    // investigation and gets the old one's inputs staring back at them.
    setFormResetKey((key) => key + 1);
    setPhase("idle");
    // Back at the start, so the form should reflect what the server can serve
    // NOW rather than what it could when the abandoned attempt began.
    void refreshCapabilities();
  }

  async function refreshRun() {
    if (run === null) return;
    const { signal, generation } = beginWorkflow();
    setError(null);
    setPhase("refreshing-run");
    let refreshedRun: AgentRunDetail;
    try {
      const result = await getAgentRun(run.run.id, signal);
      if (isStale(generation)) return;
      refreshedRun = result.data;
      setRun(refreshedRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      return;
    }

    setPhase("loading-approval");
    const loadedApproval = await loadApproval(refreshedRun.run.id, signal, generation, { reportError: true });
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
        await loadApproval(runId, signal, generation, { reportError: false });
        if (isStale(generation)) return;
      }
      setPhase("idle");
    }
  }

  const isBusy = phase !== "idle";
  // A job exists but no run does. NOT sufficient on its own to mean "the run
  // failed" — it is equally true while the first run request is in flight, which
  // is why `liveRetryPending` exists.
  const hasRetainedPartialWorkflow = job !== null && run === null;
  const canRetryRun = hasRetainedPartialWorkflow && phase === "idle";
  // Offered only for FAKE. A LIVE retry needs the access token this component
  // deliberately no longer keeps, so the honest affordance is the form's retry
  // mode rather than a button that would earn a 401.
  const showRetryRun = canRetryRun && activeProviderMode === "FAKE";
  const showLiveRetryTokenNotice = canRetryRun && liveRetryPending && activeProviderMode === "LIVE";
  /**
   * What the form needs to render "Retry Live Run", or `null` for the ordinary
   * new-investigation form.
   *
   * Gated on `liveRetryPending`, which is set ONLY where a LIVE run request was
   * observed to fail. The nullable fields alone cannot distinguish "the first
   * run is still in flight" from "the first run was refused", and treating the
   * former as the latter told the user their run had failed while it was still
   * running.
   *
   * Deliberately NOT gated on `phase === "idle"`: the form must stay in retry
   * mode WHILE a retry is in flight, or it would snap back to the creation form
   * mid-submit and change what the pending submission appears to be. That is
   * safe now precisely because `liveRetryPending` distinguishes the two cases —
   * it is false throughout the first attempt and true throughout a retry.
   *
   * `summary` comes from the persisted job, not from the form's own field — it
   * is a fact about a committed row, and the retry cannot change it.
   */
  const liveRetryTarget =
    liveRetryPending && hasRetainedPartialWorkflow && activeProviderMode === "LIVE" && job !== null
      ? { jobId: job.id, ticketId: job.ticketId, summary: job.summary }
      : null;
  const progressText = isBusy ? PHASE_LABELS[phase] : (notice ?? "");
  const showActionRequiredBanner = approval?.status === "PENDING";

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>OpsPilot — Agent Investigation Console</h1>
        <p className="app-header-note">Local-only, deterministic provider — no live model calls.</p>
      </header>

      {error !== null ? <ErrorBanner error={error} onDismiss={() => setError(null)} /> : null}
      <p className="notice-region" role="status" aria-live="polite">
        {progressText}
      </p>

      <InvestigationForm
        key={formResetKey}
        disabled={isBusy}
        submitLabel={PHASE_LABELS[phase]}
        capabilities={capabilities}
        onSubmit={runInvestigation}
        liveRetryTarget={liveRetryTarget}
        onRetryLiveRun={retryLiveRunWithToken}
        onStartNewInvestigation={startNewInvestigation}
      />

      {job !== null ? (
        <InvestigationSummary
          ticketId={ticketId ?? ""}
          job={job}
          run={run?.run ?? null}
          showRetryRun={showRetryRun}
          showLiveRetryTokenNotice={showLiveRetryTokenNotice}
          retryDisabled={isBusy}
          onRetryRun={retryRun}
          refreshDisabled={isBusy}
          onRefresh={refreshRun}
        />
      ) : null}

      {showActionRequiredBanner ? <ActionRequiredBanner /> : null}

      {run !== null ? (
        <div className="investigation-content">
          <div role="region" aria-label="Run detail" className="investigation-main-column">
            <section aria-labelledby="timeline-heading">
              <h2 id="timeline-heading" tabIndex={-1}>
                Investigation timeline
              </h2>
              <TraceTimeline trace={run.trace} />
            </section>
            <ReportPanel outcome={run.outcome} onRefresh={refreshRun} refreshDisabled={isBusy} />
          </div>
          <aside className="run-context-column" aria-label="Run context">
            <RunContextPanel
              run={run.run}
              trace={run.trace}
              approval={approval}
              suggestedActionCount={run.outcome.type === "COMPLETED" ? run.outcome.report.suggestedActions.length : 0}
              decisionDisabled={isBusy}
              submittingDecision={phase === "submitting-approval"}
              onDecide={recordDecision}
            />
          </aside>
        </div>
      ) : null}
    </div>
  );
}
