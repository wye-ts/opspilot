import type { FakeAgentScenario } from "@opspilot/agent-runtime";
import type { ResolutionReport } from "@opspilot/contracts";
import type { AgentJobRecord } from "@opspilot/database";

// Bounded, deterministic keyword -> service slug mapping (§12.2). Checked in
// order; the first keyword whose (lowercased) form appears anywhere in the
// ticket summary wins. A summary matching none of these falls back to
// FALLBACK_SERVICE_SLUG — it is genuinely unspecified, not a guess.
const SERVICE_SLUG_KEYWORDS: ReadonlyArray<{ readonly keyword: string; readonly slug: string }> = [
  { keyword: "billing", slug: "billing-service" },
  { keyword: "notification", slug: "notification-service" },
  { keyword: "auth", slug: "auth-service" },
];
const FALLBACK_SERVICE_SLUG = "unspecified-service";

// Bounded constant (§12.2) — prevents an arbitrarily long ticket summary
// from being interpolated wholesale into report fields that have their own
// contract-level max lengths (ResolutionReportSchema).
const SUMMARY_TRUNCATE_LENGTH = 200;

// Opt-in approval-workflow demo ticket (docs/13-approval-workflow.md §14).
// An exact, case-sensitive equality match only — never a substring match —
// so this scenario cannot be triggered by accident. Every other ticketId
// keeps the unconditional suggestedActions: [] behavior shipped in
// Milestone 6B, unchanged.
const APPROVAL_DEMO_TICKET_ID = "TICKET-APPROVAL-DEMO";

const FIXED_TOKEN_USAGE = { inputTokens: 120, outputTokens: 40 };

function deriveServiceSlug(summary: string): string {
  const lowered = summary.toLowerCase();
  const match = SERVICE_SLUG_KEYWORDS.find(({ keyword }) => lowered.includes(keyword));
  return match ? match.slug : FALLBACK_SERVICE_SLUG;
}

function truncateSummary(summary: string): string {
  return summary.length > SUMMARY_TRUNCATE_LENGTH ? summary.slice(0, SUMMARY_TRUNCATE_LENGTH) : summary;
}

// A pure function of job.id / job.ticketContext.ticketId / job.ticketContext.summary
// only (§12.1) — no clock, randomness, network, environment-derived report
// content, or external provider. toolCallId is scoped to the job, not the
// run (§12.3): the same job may execute multiple runs and each may reuse
// this same toolCallId, because tool-call identity/evidence grounding is
// checked per-run (agent-orchestrator.ts), not globally unique across runs.
//
// The report content is deliberately status-agnostic: this scenario's two
// turns are scripted entirely upfront, before the orchestrator has actually
// invoked get_service_status, so this function cannot see what status the
// tool will really return for `serviceSlug` (get_service_status's seeded
// status table — get-service-status.ts — is not duplicated here). Claiming
// a specific finding such as "SERVICE_DEGRADATION" or "did not report an
// OPERATIONAL status" would be false whenever the seeded status actually is
// OPERATIONAL (e.g. auth-service) — see
// deterministic-scenario.test.ts's auth-service regression test.
//
// The report also must not claim the actual status value can be recovered
// from the persisted trace/evidence — it cannot. AgentTraceEventSchema's
// TOOL_COMPLETED variant (packages/contracts/src/agent-trace-event.ts)
// persists only `type`, `toolCallId`, and `toolName`; it never persists the
// tool's return value. The report instead states plainly that the tool call
// completed, that no root cause or customer impact could be established
// from that alone, and that the returned status value is not persisted by
// this milestone — evaluating it would require a diagnostic workflow this
// milestone does not implement.
export function createDeterministicScenario(job: AgentJobRecord): FakeAgentScenario {
  const toolCallId = `${job.id}-call-1`;
  const serviceSlug = deriveServiceSlug(job.ticketContext.summary);
  const truncatedSummary = truncateSummary(job.ticketContext.summary);

  const report: ResolutionReport = {
    category: "UNKNOWN",
    summary: `A diagnostic check of ${serviceSlug} was performed for ticket ${job.ticketContext.ticketId}: ${truncatedSummary}`,
    // Issue #58 (P1-1): non-sufficient evidence must carry no root cause. This
    // scenario never evaluates the tool's returned status, so its evidence is
    // truthfully INSUFFICIENT and rootCause is null — the old sentinel prose
    // was a statement about what the report could NOT establish, which is the
    // new schema's job to convey structurally.
    rootCause: null,
    customerImpact: "No customer impact could be established: the tool's returned status value is not persisted by this milestone.",
    // Issue #60 Checkpoint B: the recommendation prose is aligned with the
    // structured suggested actions. Ordinary tickets keep the advisory,
    // status-agnostic wording — no Suggested Action exists, so the
    // recommendation must not read like a concrete approvable operation.
    // TICKET-APPROVAL-DEMO aligns with its DRAFT_CUSTOMER_REPLY action / human
    // follow-up, while staying status-agnostic (it never asserts a specific
    // status value this scripted scenario cannot know).
    recommendedResolution:
      job.ticketContext.ticketId === APPROVAL_DEMO_TICKET_ID
        ? `A customer-facing reply should be drafted to acknowledge the diagnostic check for ${serviceSlug} and to set the expectation that a human will review this run and follow up; the DRAFT_CUSTOMER_REPLY suggested action provides that draft for review.`
        : `Further operational action requires a diagnostic workflow that records and evaluates the returned status for ${serviceSlug}; this milestone does not implement one.`,
    confidence: 0.5,
    evidence: [
      {
        evidenceId: toolCallId,
        sourceType: "TOOL_EXECUTION",
        finding: `get_service_status completed successfully for ${serviceSlug}. Its returned status value is not persisted by this milestone.`,
        // Issue #55 (narrow scope): rootCause is always null in this
        // deterministic scenario (see above), so 2.2a/2.2b never apply —
        // this entry never claims to back a specific report claim.
        supports: [],
      },
    ],
    // Opt-in only (docs/13-approval-workflow.md §14): an exact, case-sensitive
    // match on APPROVAL_DEMO_TICKET_ID produces one DRAFT_CUSTOMER_REPLY
    // suggested action so the approval workflow can be exercised end to end
    // against a real deterministic run. DRAFT_CUSTOMER_REPLY (not
    // CREATE_ESCALATION) is deliberate — it makes no operational claim based
    // on the tool's returned status, which this scenario never evaluates
    // (see the report fields above). Every other ticketId keeps
    // suggestedActions: [] exactly as shipped in Milestone 6B.
    //
    // Issue #60 Checkpoint B: the demo is intentionally the positive Human
    // Approval path — INSUFFICIENT evidence does not imply ADVISORY / no
    // action. A grounded customer communication is still ACTIONABLE under the
    // owner-approved grounding-only gate, so this ticket declares
    // recommendationDisposition ACTIONABLE and grounds the action on the
    // already-completed deterministic tool call (the locator is present in
    // this same report's evidence). Ordinary tickets declare ADVISORY.
    evidenceState: "INSUFFICIENT",
    recommendationDisposition:
      job.ticketContext.ticketId === APPROVAL_DEMO_TICKET_ID ? "ACTIONABLE" : "ADVISORY",
    suggestedActions:
      job.ticketContext.ticketId === APPROVAL_DEMO_TICKET_ID
        ? [
            {
              type: "DRAFT_CUSTOMER_REPLY",
              payload: {
                subject: `Update on your report — ${truncatedSummary}`,
                body: `Thanks for reaching out about ${serviceSlug}. A diagnostic check ran, but this milestone does not evaluate or persist the tool's returned status, so no specific finding can be shared yet. A human will follow up after reviewing this run.`,
              },
              groundedBy: [{ evidenceId: toolCallId, sourceType: "TOOL_EXECUTION" }],
            },
          ]
        : [],
  };

  return {
    id: `deterministic-${job.id}`,
    turns: [
      {
        kind: "diagnostic_tool_requests",
        usage: FIXED_TOKEN_USAGE,
        requests: [
          {
            toolCallId,
            toolName: "get_service_status",
            input: { serviceSlug },
            // Issue #58 Checkpoint B: the single diagnostic request runs before
            // any evidence exists, so its assessment is the run-state-consistent
            // NO_EVIDENCE_YET claim the orchestrator's V0 + A3 guards require.
            rawAssessment: {
              evidenceState: "INSUFFICIENT",
              continuationReason: "NO_EVIDENCE_YET",
              supportedBy: [],
            },
          },
        ],
      },
      { kind: "report_submission", usage: FIXED_TOKEN_USAGE, rawInput: report },
    ],
  };
}
