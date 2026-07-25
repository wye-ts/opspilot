import { useEffect, useRef, useState } from "react";

import { createAgentJob, getAgentRun, getApproval, recordApproval, startAgentRun } from "./api/endpoints";
import { ApiRequestError } from "./api/http-client";
import type { AgentJobResponse, AgentRunDetail, ApprovalView, RecordApprovalDecisionInput } from "./api/types";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { ErrorBanner, type DisplayableError } from "./components/ErrorBanner";
import { InvestigationForm, type InvestigationFormSubmission } from "./components/InvestigationForm";
import { InvestigationSummary } from "./components/InvestigationSummary";
import { ReportPanel } from "./components/ReportPanel";
import { TraceTimeline } from "./components/TraceTimeline";

type Phase = "idle" | "creating-job" | "running-agent" | "loading-approval" | "refreshing-run" | "submitting-approval";

const PHASE_LABELS: Record<Phase, string> = {
  idle: "Run Investigation",
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

  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
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
  // the caller's workflow, not a new one.
  async function loadApproval(
    runId: string,
    signal: AbortSignal,
    generation: number,
    options: { readonly reportError: boolean },
  ) {
    try {
      const result = await getApproval(runId, signal);
      if (isStale(generation)) return;
      setApproval(result.data);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      if (options.reportError) {
        setError(toDisplayableError(thrown));
        setApproval(null);
      }
      // reportError: false is the 409-convergence path — the server's 409
      // message stays on screen instead of being overwritten by this GET's
      // error, and `approval` is left untouched rather than inventing state.
    }
  }

  async function runInvestigation(submission: InvestigationFormSubmission) {
    const { signal, generation } = beginWorkflow();
    const nextTicketId = submission.approvalDemo ? APPROVAL_DEMO_TICKET_ID : generateOrdinaryTicketId();

    setTicketId(nextTicketId);
    setJob(null);
    setRun(null);
    setApproval(null);
    setError(null);
    setNotice(null);
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
      const result = await startAgentRun(createdJob.id, signal);
      if (isStale(generation)) return;
      createdRun = result.data;
      setRun(createdRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      return;
    }

    setPhase("loading-approval");
    await loadApproval(createdRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    setPhase("idle");
  }

  async function retryRun() {
    if (job === null) return;
    const { signal, generation } = beginWorkflow();
    setError(null);
    setPhase("running-agent");
    let startedRun: AgentRunDetail;
    try {
      const result = await startAgentRun(job.id, signal);
      if (isStale(generation)) return;
      startedRun = result.data;
      setRun(startedRun);
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
      return;
    }

    setPhase("loading-approval");
    await loadApproval(startedRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    setPhase("idle");
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
    await loadApproval(refreshedRun.run.id, signal, generation, { reportError: true });
    if (isStale(generation)) return;
    setNotice("Run refreshed.");
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
  const showRetryRun = job !== null && run === null && phase === "idle";
  const progressText = isBusy ? PHASE_LABELS[phase] : (notice ?? "");

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

      <InvestigationForm disabled={isBusy} submitLabel={PHASE_LABELS[phase]} onSubmit={runInvestigation} />

      {job !== null ? (
        <InvestigationSummary
          ticketId={ticketId ?? ""}
          job={job}
          run={run?.run ?? null}
          showRetryRun={showRetryRun}
          retryDisabled={isBusy}
          onRetryRun={retryRun}
          refreshDisabled={isBusy}
          onRefresh={refreshRun}
        />
      ) : null}

      {run !== null ? (
        <div className="investigation-content">
          <section aria-labelledby="timeline-heading">
            <h2 id="timeline-heading">Investigation timeline</h2>
            <TraceTimeline trace={run.trace} />
          </section>
          <div className="investigation-report-column">
            <ReportPanel outcome={run.outcome} onRefresh={refreshRun} refreshDisabled={isBusy} />
            {approval !== null ? (
              <ApprovalPanel
                approval={approval}
                suggestedActionCount={run.outcome.type === "COMPLETED" ? run.outcome.report.suggestedActions.length : 0}
                decisionDisabled={isBusy}
                submittingDecision={phase === "submitting-approval"}
                onDecide={recordDecision}
              />
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
