import { useEffect, useRef, useState } from "react";

import { createAgentJob, getAgentRun, startAgentRun } from "./api/endpoints";
import { ApiRequestError } from "./api/http-client";
import type { AgentJobResponse, AgentRunDetail } from "./api/types";
import { ErrorBanner, type DisplayableError } from "./components/ErrorBanner";
import { InvestigationForm, type InvestigationFormSubmission } from "./components/InvestigationForm";
import { InvestigationSummary } from "./components/InvestigationSummary";
import { ReportPanel } from "./components/ReportPanel";
import { TraceTimeline } from "./components/TraceTimeline";

type Phase = "idle" | "creating-job" | "running-agent" | "refreshing-run";

const PHASE_LABELS: Record<Phase, string> = {
  idle: "Run Investigation",
  "creating-job": "Creating investigation…",
  "running-agent": "Running agent…",
  "refreshing-run": "Refreshing…",
};

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

  async function runInvestigation(submission: InvestigationFormSubmission) {
    const { signal, generation } = beginWorkflow();
    const nextTicketId = submission.approvalDemo ? APPROVAL_DEMO_TICKET_ID : generateOrdinaryTicketId();

    setTicketId(nextTicketId);
    setJob(null);
    setRun(null);
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
    try {
      const result = await startAgentRun(createdJob.id, signal);
      if (isStale(generation)) return;
      setRun(result.data);
      setPhase("idle");
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
    }
  }

  async function retryRun() {
    if (job === null) return;
    const { signal, generation } = beginWorkflow();
    setError(null);
    setPhase("running-agent");
    try {
      const result = await startAgentRun(job.id, signal);
      if (isStale(generation)) return;
      setRun(result.data);
      setPhase("idle");
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
      setPhase("idle");
    }
  }

  async function refreshRun() {
    if (run === null) return;
    const { signal, generation } = beginWorkflow();
    setError(null);
    setPhase("refreshing-run");
    try {
      const result = await getAgentRun(run.run.id, signal);
      if (isStale(generation)) return;
      setRun(result.data);
      setNotice("Run refreshed.");
      setPhase("idle");
    } catch (thrown) {
      if (isAbortError(thrown) || isStale(generation)) return;
      setError(toDisplayableError(thrown));
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
          <ReportPanel outcome={run.outcome} onRefresh={refreshRun} refreshDisabled={isBusy} />
        </div>
      ) : null}
    </div>
  );
}
