// Pure HTTP client demo — talks to a running `pnpm --filter @opspilot/api
// run start` instance over plain fetch. Deliberately imports no workspace
// source package (see docs/12-agent-run-api.md): it only ever sees what the
// API itself already returns over HTTP, and only ever prints a curated,
// known-safe subset of that — never a raw response body or error detail.

const BASE_URL = process.env.API_BASE_URL ?? "http://127.0.0.1:3000";

interface ErrorEnvelope {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

interface JobResponse {
  readonly data: { readonly id: string; readonly ticketId: string; readonly summary: string; readonly createdAt: string };
}

interface RunResponse {
  readonly data: {
    readonly run: { readonly id: string; readonly status: string; readonly attemptNumber: number };
    readonly trace: ReadonlyArray<{ readonly type: string }>;
    readonly outcome:
      | { readonly type: "RUNNING" }
      | {
          readonly type: "COMPLETED";
          readonly report: {
            readonly category: string;
            readonly summary: string;
            readonly confidence: number;
            readonly suggestedActions: ReadonlyArray<{ readonly type: string }>;
          };
        }
      | { readonly type: "FAILED"; readonly code: string; readonly message: string };
  };
}

interface ApprovalResponse {
  readonly data: {
    readonly runId: string;
    readonly status: "NOT_ELIGIBLE" | "PENDING" | "APPROVED" | "REJECTED";
    readonly reviewerName: string | null;
    readonly note: string | null;
    readonly decidedAt: string | null;
  };
}

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

async function failFast(response: Response, action: string): Promise<never> {
  const body = await readJson<ErrorEnvelope>(response).catch(() => undefined);
  console.error(`Failed to ${action} (HTTP ${response.status}${body ? `, code ${body.error.code}` : ""}).`);
  process.exitCode = 1;
  throw new Error("demo-aborted");
}

// Every success-path step's exact invariants are checked with this before
// its success label is ever printed — a bare `response.ok` check alone
// would let the demo print "Demo complete." even if approval semantics
// (status transitions, Location header, decidedAt stability) silently
// regressed. The message is always a curated, fixed string written by this
// script — never raw response content.
function assertDemo(condition: unknown, message: string): asserts condition {
  if (!condition) {
    console.error(`Demo verification failed: ${message}`);
    process.exitCode = 1;
    throw new Error("demo-aborted");
  }
}

// Success-only failFast cannot be reused for a step that is *supposed* to
// fail (the deliberate conflict below) — it would abort the demo on the one
// step designed to return an error. This helper parses the stable JSON
// error envelope, verifies status + public code, and prints only a curated
// confirmation line — never the raw body, cause, or stack.
async function expectApiError(response: Response, expectedStatus: number, expectedCode: string): Promise<void> {
  if (response.status !== expectedStatus) {
    console.error(
      `Expected HTTP ${expectedStatus} but got ${response.status} for the deliberate-conflict demo step.`,
    );
    process.exitCode = 1;
    throw new Error("demo-aborted");
  }
  const body = await readJson<ErrorEnvelope>(response);
  if (body.error.code !== expectedCode) {
    console.error(`Expected error code ${expectedCode} but got ${body.error.code}.`);
    process.exitCode = 1;
    throw new Error("demo-aborted");
  }
  console.log(`Expected conflict confirmed: ${response.status} ${body.error.code}`);
}

function printTrace(trace: RunResponse["data"]["trace"]): void {
  console.log("Trace event types:");
  trace.forEach((event, index) => console.log(`  ${index + 1}. ${event.type}`));
}

function printOutcome(outcome: RunResponse["data"]["outcome"]): void {
  console.log(`Outcome: ${outcome.type}`);
  if (outcome.type === "COMPLETED") {
    console.log(`  Report category: ${outcome.report.category}`);
    console.log(`  Report summary: ${outcome.report.summary}`);
    console.log(`  Report confidence: ${outcome.report.confidence.toFixed(2)}`);
    console.log(`  Suggested actions: ${outcome.report.suggestedActions.length}`);
  } else if (outcome.type === "FAILED") {
    console.log(`  Failure code: ${outcome.code}`);
  }
}

async function main(): Promise<void> {
  console.log("OpsPilot Agent Run API Demo");
  console.log(`Base URL: ${BASE_URL}`);
  console.log("");

  const jobResponse = await fetch(`${BASE_URL}/v1/agent-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId: "TICKET-2001", summary: "Elevated API error rate on billing-service" }),
  });
  if (!jobResponse.ok) await failFast(jobResponse, "create the agent job");
  const job = await readJson<JobResponse>(jobResponse);
  console.log(`Job id:       ${job.data.id}`);
  console.log(`Ticket id:    ${job.data.ticketId}`);
  console.log("");

  const runResponse = await fetch(`${BASE_URL}/v1/agent-jobs/${job.data.id}/runs`, { method: "POST" });
  if (!runResponse.ok) await failFast(runResponse, "create the agent run");
  const run = await readJson<RunResponse>(runResponse);
  console.log(`Run id:       ${run.data.run.id}`);
  console.log(`Run status:   ${run.data.run.status}`);
  console.log(`Attempt:      ${run.data.run.attemptNumber}`);
  console.log("");
  printTrace(run.data.trace);
  console.log("");
  printOutcome(run.data.outcome);
  console.log("");

  const jobReadback = await fetch(`${BASE_URL}/v1/agent-jobs/${job.data.id}`);
  if (!jobReadback.ok) await failFast(jobReadback, "read back the agent job");
  console.log("GET /v1/agent-jobs/:jobId — ok");

  const runReadback = await fetch(`${BASE_URL}/v1/agent-runs/${run.data.run.id}`);
  if (!runReadback.ok) await failFast(runReadback, "read back the agent run");
  console.log("GET /v1/agent-runs/:runId — ok");
  console.log("");

  const notEligible = await fetch(`${BASE_URL}/v1/agent-runs/${run.data.run.id}/approval`);
  if (!notEligible.ok) await failFast(notEligible, "read approval status for the ordinary run");
  const notEligibleBody = await readJson<ApprovalResponse>(notEligible);
  assertDemo(notEligible.status === 200, "ordinary-run GET .../approval did not return HTTP 200");
  assertDemo(notEligibleBody.data.status === "NOT_ELIGIBLE", "ordinary run's approval status was not NOT_ELIGIBLE");
  console.log(`GET .../approval (ordinary run) — status: ${notEligibleBody.data.status}`);
  console.log("");

  console.log("--- Approval workflow demo (TICKET-APPROVAL-DEMO) ---");
  console.log("");

  const demoJobResponse = await fetch(`${BASE_URL}/v1/agent-jobs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticketId: "TICKET-APPROVAL-DEMO", summary: "Approval workflow demo" }),
  });
  if (!demoJobResponse.ok) await failFast(demoJobResponse, "create the approval-demo agent job");
  const demoJob = await readJson<JobResponse>(demoJobResponse);
  console.log(`Demo job id:  ${demoJob.data.id}`);

  const demoRunResponse = await fetch(`${BASE_URL}/v1/agent-jobs/${demoJob.data.id}/runs`, { method: "POST" });
  if (!demoRunResponse.ok) await failFast(demoRunResponse, "create the approval-demo agent run");
  const demoRun = await readJson<RunResponse>(demoRunResponse);
  const demoOutcome = demoRun.data.outcome;
  assertDemo(demoRunResponse.status === 201, "approval-demo run creation did not return HTTP 201");
  assertDemo(demoOutcome.type === "COMPLETED", "approval-demo run did not complete");
  const demoSuggestedActions = demoOutcome.type === "COMPLETED" ? demoOutcome.report.suggestedActions : [];
  assertDemo(demoSuggestedActions.length === 1, "approval-demo run did not produce exactly one suggested action");
  assertDemo(
    demoSuggestedActions[0]?.type === "DRAFT_CUSTOMER_REPLY",
    "approval-demo run's suggested action was not DRAFT_CUSTOMER_REPLY",
  );
  console.log(`Demo run id:  ${demoRun.data.run.id}`);
  printOutcome(demoRun.data.outcome);
  console.log("");

  const demoRunId = demoRun.data.run.id;

  const pendingRes = await fetch(`${BASE_URL}/v1/agent-runs/${demoRunId}/approval`);
  if (!pendingRes.ok) await failFast(pendingRes, "read pending approval status for the demo run");
  const pendingBody = await readJson<ApprovalResponse>(pendingRes);
  assertDemo(pendingRes.status === 200, "demo-run GET .../approval did not return HTTP 200 before a decision");
  assertDemo(pendingBody.data.status === "PENDING", "demo run's approval status was not PENDING before a decision");
  console.log(`GET .../approval (demo run) — status: ${pendingBody.data.status}`);

  const approveRes = await fetch(`${BASE_URL}/v1/agent-runs/${demoRunId}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "APPROVED", reviewerName: "demo-reviewer", note: "Approved via demo script." }),
  });
  if (!approveRes.ok) await failFast(approveRes, "record the APPROVED decision for the demo run");
  const approveBody = await readJson<ApprovalResponse>(approveRes);
  assertDemo(approveRes.status === 201, "first approval POST did not return HTTP 201");
  assertDemo(
    approveRes.headers.get("location") === `/v1/agent-runs/${demoRunId}/approval`,
    "first approval POST did not return the expected Location header",
  );
  assertDemo(approveBody.data.status === "APPROVED", "first approval POST did not record status APPROVED");
  assertDemo(
    typeof approveBody.data.decidedAt === "string" && approveBody.data.decidedAt.length > 0,
    "first approval POST did not return a non-empty decidedAt",
  );
  console.log(`POST .../approval — 201 Created, status: ${approveBody.data.status}, decidedAt: ${approveBody.data.decidedAt}`);

  const replayRes = await fetch(`${BASE_URL}/v1/agent-runs/${demoRunId}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "APPROVED", reviewerName: "demo-reviewer", note: "Approved via demo script." }),
  });
  if (!replayRes.ok) await failFast(replayRes, "replay the identical APPROVED decision for the demo run");
  const replayBody = await readJson<ApprovalResponse>(replayRes);
  assertDemo(replayRes.status === 200, "identical-replay POST did not return HTTP 200");
  assertDemo(replayRes.headers.get("location") === null, "identical-replay POST unexpectedly returned a Location header");
  assertDemo(replayBody.data.status === "APPROVED", "identical-replay POST did not report status APPROVED");
  assertDemo(
    replayBody.data.decidedAt === approveBody.data.decidedAt,
    "identical-replay POST's decidedAt did not exactly match the first write's decidedAt",
  );
  console.log(
    `POST .../approval (identical replay) — 200 OK, decidedAt unchanged: ${replayBody.data.decidedAt === approveBody.data.decidedAt}`,
  );

  const conflictRes = await fetch(`${BASE_URL}/v1/agent-runs/${demoRunId}/approval`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ decision: "REJECTED", reviewerName: "demo-reviewer" }),
  });
  await expectApiError(conflictRes, 409, "AGENT_RUN_APPROVAL_ALREADY_DECIDED");

  const finalRes = await fetch(`${BASE_URL}/v1/agent-runs/${demoRunId}/approval`);
  if (!finalRes.ok) await failFast(finalRes, "read the final approval status for the demo run");
  const finalBody = await readJson<ApprovalResponse>(finalRes);
  assertDemo(finalRes.status === 200, "final GET .../approval did not return HTTP 200");
  assertDemo(finalBody.data.status === "APPROVED", "final approval status was not APPROVED");
  assertDemo(finalBody.data.reviewerName === "demo-reviewer", "final approval reviewerName did not match demo-reviewer");
  assertDemo(
    finalBody.data.note === "Approved via demo script.",
    "final approval note did not match the expected demo note",
  );
  assertDemo(
    finalBody.data.decidedAt === approveBody.data.decidedAt,
    "final approval decidedAt did not exactly match the first write's decidedAt",
  );
  console.log(`GET .../approval (final) — status: ${finalBody.data.status}, note: ${finalBody.data.note}`);
  console.log("");
  console.log("Demo complete.");
}

main().catch((error) => {
  if (error instanceof Error && error.message === "demo-aborted") return;
  console.error("Demo failed unexpectedly.");
  process.exitCode = 1;
});
