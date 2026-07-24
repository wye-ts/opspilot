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
      | { readonly type: "COMPLETED"; readonly report: { readonly category: string; readonly summary: string; readonly confidence: number } }
      | { readonly type: "FAILED"; readonly code: string; readonly message: string };
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
  console.log("Demo complete.");
}

main().catch((error) => {
  if (error instanceof Error && error.message === "demo-aborted") return;
  console.error("Demo failed unexpectedly.");
  process.exitCode = 1;
});
