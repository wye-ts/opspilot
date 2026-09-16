import {
  EvidenceAssessmentSchema,
  EvidenceLocatorSchema,
  MAX_DIAGNOSTIC_TOOL_CALLS,
  MAX_PROVIDER_TURNS,
  ResolutionReportSchema,
  classifyReportInvariants,
  summarizeReportValidationIssues,
  type AgentOrchestratorErrorCode,
  type AgentTraceEvent,
  type AgentTurnResult,
  type EvidenceLocator,
  type InvestigationEventPayload,
  type InvestigationExecutionStage,
  type ReportValidationIssue,
  type ResolutionReport,
  type RetrievalSummaryEntry,
} from "@opspilot/contracts";

import { z } from "zod";

import { LlmProviderError } from "../providers/llm-provider";
import type {
  AgentConversationMessage,
  AgentTurnPhase,
  LlmProvider,
  LlmProviderErrorCategory,
} from "../providers/llm-provider";
import { formatRagContext } from "../rag/rag-context-formatting";
import { validateRetrievalInput, validateRetrievedChunks } from "../rag/retrieval-validation";
import {
  RetrieverError,
  type RetrievalInput,
  type RetrievedRunbookChunk,
  type RunbookRetriever,
} from "../rag/runbook-retriever";
import type { ToolRegistry } from "../tools/diagnostic-tool";

// Issue #57 Checkpoint B: the orchestrator adopts the reviewed, shared source
// bounds from packages/contracts/src/agent-run-bounds.ts — 5 provider turns /
// 3 diagnostic tool calls, with MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1
// asserted by a contracts unit test. Since issue #107 that bound holds with
// SLACK rather than at equality: turns 0..2 each accept at most one diagnostic
// tool request, turn 3 is headroom (an INVESTIGATION turn by position that the
// diagnostic budget can no longer fund), and turn 4 is the reserved forced
// FINALIZATION turn.
//
// The slack is what makes a corrective retry reachable for a run that spent
// every diagnostic call — and it also separates two conditions that used to
// coincide, "budget exhausted" and "last turn". See reportStageBegun below:
// anything meaning "the report stage has begun" must derive from that
// condition, never from turn position. The aspirational AGENT_MAX_* env budgets in
// docs/04-agent-design.md §7 remain unwired (Decision 1); there is no
// same-tool-name limit (Decision 3).

// A provider must not infer this from turnIndex itself (see
// docs/04-agent-design.md §9's phase concept) — only the orchestrator's own
// bounded-loop policy maps turn positions to a phase, and only the
// orchestrator resolves the report-safe output ceiling (below). Every
// report-capable turn uses finalizationMaxOutputTokens (issue #61 Codex
// MAJOR 1).
const DEFAULT_OUTPUT_BUDGET: AgentOutputBudget = {
  investigationMaxOutputTokens: 4096,
  finalizationMaxOutputTokens: 4096,
};

/**
 * Per-turn output ceilings, mirrored from apps/api's LiveRunOutputBudget
 * (run-execution-config.ts) so a LIVE caller's config maps onto this param
 * without translation. Defined here rather than imported: agent-runtime has no
 * dependency on apps/api, and this shape is a provider-turn concept independent
 * of how any one caller configures it.
 *
 * The orchestrator resolves `finalizationMaxOutputTokens` as the report-safe
 * ceiling for EVERY provider turn (issue #61 Codex MAJOR 1), because
 * submit_resolution_report is available on investigation turns too.
 * `investigationMaxOutputTokens` is carried for shape parity with apps/api's
 * LiveRunOutputBudget but is not used for ceiling selection — an
 * investigation-phase provider call can legitimately produce the final report.
 */
export interface AgentOutputBudget {
  readonly investigationMaxOutputTokens: number;
  readonly finalizationMaxOutputTokens: number;
}

// RetrievalSummaryEntry and AgentTraceEvent now live in @opspilot/contracts
// (Zod-backed — see docs/11-agent-run-persistence.md) so packages/database
// can type its repository functions against the real trace-event shape
// without depending on apps/worker. Re-exported here so every existing
// import site keeps working unchanged — a type relocation, not a behavior
// change. docs/04-agent-design.md §16.1: only these trace event kinds are
// wired in this slice; RETRIEVAL_COMPLETED is pushed at most once, only
// after both retrieval-input and retrieval-output validation succeed.
export type { AgentTraceEvent, RetrievalSummaryEntry };

export interface AgentOrchestratorParams {
  readonly provider: LlmProvider;
  readonly toolRegistry: ToolRegistry;
  readonly initialConversation: readonly AgentConversationMessage[];
  readonly allowedRagChunkIds?: ReadonlySet<string>;
  readonly retriever?: RunbookRetriever;
  readonly retrievalInput?: RetrievalInput;
  readonly outputBudget?: AgentOutputBudget;
  // Forwarded verbatim to every provider turn. The orchestrator neither
  // creates nor inspects it: it owns no deadline of its own (see
  // MAX_PROVIDER_TURNS above — the loop is bounded by turn count, not by
  // wall clock). Scope: this covers the provider calls only. Tool execution,
  // retrieval, and persistence are NOT cancelled by it, so it is not a strict
  // deadline for the whole run. Retries remain the provider transport's concern.
  readonly signal?: AbortSignal;
  /**
   * The CANONICAL persistence channel (issue #37).
   *
   * Optional, and absent for every direct caller — evals, demos, the
   * orchestrator's own unit tests — which is why the legacy in-memory
   * `trace` channel below is kept entirely independent of it rather than
   * derived from it. When omitted this is a no-op and the returned
   * `AgentTraceEvent[]` is byte-for-byte what it has always been.
   *
   * AWAITED, because the ordering claim has to be real: if TOOL_REQUESTED is
   * not durable before the registry lookup runs, the ledger is not
   * describing what actually happened. A rejection aborts the run
   * immediately — see the two-channel note on `trace` below.
   */
  readonly emitLifecycleEvent?: (payload: InvestigationEventPayload) => Promise<void>;
}

export type AgentOrchestratorResult =
  | {
      readonly status: "completed";
      readonly report: ResolutionReport;
      readonly trace: readonly AgentTraceEvent[];
      /**
       * Issue #114: the exact locators the harness synthesized into
       * `report.evidence` this run, when the accepted report's ONLY schema
       * violation was GROUNDED_BY_NOT_IN_EVIDENCE (F5) and every omitted
       * groundedBy locator was independently confirmed real against run
       * state. Empty (not omitted) when auto-completion did not fire — every
       * accepted report has this field, so a caller never needs to
       * distinguish "not present" from "empty."
       *
       * BEST-EFFORT OBSERVABILITY ONLY, not a durable audit trail (Issue
       * #114 plan §2.6/§0.6): this field lives only in this in-process
       * result. Nothing in this issue persists it to the database alongside
       * the report — see agent-run-service.ts's onEvidenceAutoCompleted hook
       * for how a caller may observe it, and that hook's own doc comment for
       * the same limit restated at the point a caller would rely on it.
       */
      readonly autoCompletedEvidence: readonly EvidenceLocator[];
    }
  | {
      readonly status: "failed";
      readonly code: AgentOrchestratorErrorCode;
      readonly message: string;
      readonly trace: readonly AgentTraceEvent[];
      /**
       * The execution stage that was actually running when this failure
       * occurred, stated by the site that produced it rather than inferred
       * downstream. Persistence must never guess: RUN_FAILED.failedStage is
       * required to name the stage the reducer sees as active, and a wrong
       * guess is rejected (FAILED_STAGE_NOT_TRUTHFUL).
       */
      readonly failedStage: InvestigationExecutionStage;
      /**
       * Populated only for REPORT_SCHEMA_INVALID, from
       * summarizeReportValidationIssues — safe to log (paths, codes,
       * expected/received type names, our own schema's static bounds), never
       * the raw report Claude submitted. Absent for every other failure code.
       */
      readonly reportValidationIssues?: readonly ReportValidationIssue[];
    };

function failed(
  code: AgentOrchestratorErrorCode,
  message: string,
  trace: readonly AgentTraceEvent[],
  failedStage: InvestigationExecutionStage,
  reportValidationIssues?: readonly ReportValidationIssue[],
): AgentOrchestratorResult {
  return {
    status: "failed",
    code,
    message,
    trace,
    failedStage,
    ...(reportValidationIssues !== undefined ? { reportValidationIssues } : {}),
  };
}

/**
 * Maps a transport-level provider failure onto the persisted failure code.
 *
 * Grouped by what an operator would do about it, not by vendor error class.
 * TIMEOUT and CANCELLED are kept separate from everything else because they
 * are not provider faults: one means the run outlived its budget, the other
 * means the caller went away. Collapsing either into PROVIDER_UNAVAILABLE
 * would send an operator looking for an outage that never happened.
 *
 * An exhaustive switch, deliberately: adding a category to
 * LlmProviderErrorCategory should fail the build here rather than silently
 * fall through to a default.
 */
function providerFailureCode(category: LlmProviderErrorCategory): AgentOrchestratorErrorCode {
  switch (category) {
    case "TIMEOUT":
      return "PROVIDER_TIMEOUT";
    case "CANCELLED":
      return "PROVIDER_CANCELLED";
    case "AUTHENTICATION":
    case "BILLING":
    case "RATE_LIMIT":
    case "CONNECTION":
    case "SERVER_ERROR":
    case "REQUEST_INVALID":
    case "UNKNOWN":
      return "PROVIDER_UNAVAILABLE";
  }
}

// The run's single source-aware grounding predicate, shared by
// findInvalidEvidence below and, since Issue #114, the groundedBy-omission
// auto-completion gate (agent-orchestrator.ts's report_submission branch). A
// locator is a KNOWN RUN OBSERVATION only if a RAG_CHUNK id is among the
// retrieved chunks or a TOOL_EXECUTION id belongs to a successfully completed
// tool call — a failed, merely-requested, or never-attempted tool id is never
// known, and a RAG id is never treated as TOOL_EXECUTION merely because the
// strings match. Factored out of findInvalidEvidence (pure refactor; that
// function's own behavior and tests are unchanged) so both this check and the
// new #114 confirmation gate share exactly one source-aware definition of
// "real" rather than risking two definitions drifting apart.
export function isKnownRunObservation(
  locator: Pick<EvidenceLocator, "evidenceId" | "sourceType">,
  allowedRagChunkIds: ReadonlySet<string>,
  successfulToolExecutionIds: ReadonlySet<string>,
): boolean {
  return locator.sourceType === "RAG_CHUNK"
    ? allowedRagChunkIds.has(locator.evidenceId)
    : successfulToolExecutionIds.has(locator.evidenceId);
}

// The run's single source-aware grounding helper, shared by the report path
// (report evidence) and, since Issue #58 Checkpoint B (§9.2), the diagnostic
// assessment path (supportedBy locators). A locator is grounded only if a
// RAG_CHUNK id is among the retrieved chunks or a TOOL_EXECUTION id belongs
// to a successfully completed tool call — a failed, merely-requested, or
// never-attempted tool id is never grounded, a RAG id is never treated as
// TOOL_EXECUTION merely because the strings match, and a hypothesis is never
// evidence. The parameter is the locator projection both paths actually read,
// so EvidenceReference[] (report) and EvidenceLocator[] (assessment
// supportedBy) both flow through without reshaping.
export function findInvalidEvidence(
  evidence: readonly Pick<EvidenceLocator, "evidenceId" | "sourceType">[],
  allowedRagChunkIds: ReadonlySet<string>,
  successfulToolExecutionIds: ReadonlySet<string>,
): boolean {
  return evidence.some(
    (entry) => !isKnownRunObservation(entry, allowedRagChunkIds, successfulToolExecutionIds),
  );
}

// ── Issue #114: auto-complete evidence for a real observation the model ──
// already cited via groundedBy but never independently listed in evidence.
// See docs/reviews/44-issue-114-conditional-evidence-nonempty-plan.md for
// the full design and six rounds of review that shaped it; comments below
// cite that plan's section numbers rather than restating the reasoning.

// §2.3: a permissive probe used ONLY on a payload that has already failed
// the strict ResolutionReportSchema, to extract the two locator sets needed
// to decide whether GROUNDED_BY_NOT_IN_EVIDENCE can be auto-healed. Built
// from the same EvidenceLocatorSchema both strict schemas use, so it cannot
// itself drift from the locator shape. `.passthrough()` on the partial
// locator is required (not optional): a real EvidenceReference always
// carries `finding`/`supports` on top of the strict locator (via `.extend()`
// in resolution-report.ts), and without passthrough those fields would read
// as unrecognized keys, incorrectly rejecting the exact non-empty-evidence
// shape this probe exists to handle (caught by round-2 review).
const GroundedByProbeSchema = z
  .object({
    evidence: z.array(EvidenceLocatorSchema.partial().passthrough()).optional(),
    suggestedActions: z
      .array(z.object({ groundedBy: z.array(EvidenceLocatorSchema).optional() }).passthrough())
      .optional(),
  })
  .passthrough();

// §2.5: fixed, harness-authored, never derived from anything model-authored
// — same no-echo convention as A3_CORRECTIVE_GUIDANCE_TEXT and
// REPORT_INVARIANT_REMEDIES below. PRESENTATION TEXT ONLY, not a reliable
// provenance discriminator: `finding` is model-controllable free text
// (`.min(1).max(500)`, no other constraint — resolution-report.ts), so a
// report built from untrusted ticket/runbook content could in principle
// produce its own entry whose `finding` collides with this exact literal.
// The authoritative-for-this-run provenance record is
// AgentOrchestratorResult.autoCompletedEvidence (the exact locator list),
// never this string — see that field's own doc comment for the "best-effort
// observability, not a durable audit trail" limit (plan §0.6).
export const EVIDENCE_AUTO_COMPLETION_FINDING =
  "Cited by a suggested action's grounding; not independently described by the model this run.";

/**
 * Issue #114 §2.2–2.5: attempts to auto-heal a report whose ONLY schema
 * violation is GROUNDED_BY_NOT_IN_EVIDENCE (F5), by synthesizing the missing
 * evidence entries for every omitted `groundedBy` locator that is
 * independently confirmed real against this run's own observation sets.
 *
 * Returns the augmented, successfully-reparsed report plus the exact
 * locators synthesized when auto-completion applies; returns `null` on ANY
 * doubt (single-invariant eligibility fails, the probe itself cannot parse
 * the payload, a missing or pre-existing locator is not confirmed real, or
 * the re-parse still fails for any reason including the evidence-capacity
 * bound) — the caller then falls through to the existing, byte-for-byte
 * unchanged failure/retry path. This function never has a second way to
 * fail loudly; every non-success path is exactly "not eligible."
 */
function tryAutoCompleteGroundedByOmission(
  rawInput: unknown,
  violatedInvariants: readonly string[],
  allowedRagChunkIds: ReadonlySet<string>,
  successfulToolExecutionIds: ReadonlySet<string>,
): { readonly report: ResolutionReport; readonly autoCompletedEvidence: readonly EvidenceLocator[] } | null {
  // §2.2: eligible only when GROUNDED_BY_NOT_IN_EVIDENCE is the SOLE
  // violated invariant — any co-occurring invariant bails out entirely, so
  // this mechanism never has to reason about an invariant it wasn't built
  // to handle (round-2 review confirmed ACTIONABLE_REQUIRES_ACTION cannot
  // co-occur with F5, but e.g. ADVISORY_FORBIDS_ACTIONS can).
  if (violatedInvariants.length !== 1 || violatedInvariants[0] !== "GROUNDED_BY_NOT_IN_EVIDENCE") {
    return null;
  }

  const probe = GroundedByProbeSchema.safeParse(rawInput);
  if (!probe.success) {
    return null;
  }

  const existingEvidence = probe.data.evidence ?? [];
  const presentKeys = new Set(
    existingEvidence
      .filter((e): e is { evidenceId: string; sourceType: "RAG_CHUNK" | "TOOL_EXECUTION" } =>
        e.evidenceId !== undefined && e.sourceType !== undefined,
      )
      .map((e) => `${e.sourceType}:${e.evidenceId}`),
  );

  const citedKeys = new Map<string, EvidenceLocator>();
  for (const action of probe.data.suggestedActions ?? []) {
    for (const locator of action.groundedBy ?? []) {
      citedKeys.set(`${locator.sourceType}:${locator.evidenceId}`, locator);
    }
  }

  const missing = [...citedKeys.entries()]
    .filter(([key]) => !presentKeys.has(key))
    .map(([, locator]) => locator);

  // §2.3: if GROUNDED_BY_NOT_IN_EVIDENCE fired but nothing is actually
  // missing relative to this extraction, the eligibility check above was a
  // false positive relative to what the probe could see — bail out
  // defensively rather than assume anything.
  if (missing.length === 0) {
    return null;
  }

  // §2.4 (round-3 fix): confirm realness of `missing` AND every
  // PRE-EXISTING evidence entry — not `missing` alone. A report can be
  // F5-only at Zod while its EXISTING evidence array separately contains a
  // fabricated locator Zod cannot see (Zod has no run-state visibility).
  // Auto-completing anyway would re-parse successfully and only then hit
  // findInvalidEvidence, converting today's F5 retry into an unannounced
  // terminal REPORT_EVIDENCE_INVALID — the opposite of "strictly additive."
  const allCandidates = [
    ...missing,
    ...existingEvidence.filter(
      (e): e is { evidenceId: string; sourceType: "RAG_CHUNK" | "TOOL_EXECUTION" } =>
        e.evidenceId !== undefined && e.sourceType !== undefined,
    ),
  ];
  const allReal = allCandidates.every((locator) =>
    isKnownRunObservation(locator, allowedRagChunkIds, successfulToolExecutionIds),
  );
  if (!allReal) {
    return null;
  }

  // §2.5: append harness-authored entries for the missing (confirmed-real)
  // locators to the ORIGINAL raw evidence array, then re-parse the WHOLE
  // payload through the real strict schema — never assemble the accepted
  // report by hand. This is what makes the evidence-capacity bound (.max(10)
  // — round-5 finding) and any other refinement apply exactly as they would
  // to a model-submitted report; the mechanism gets no special exemption.
  const rawObject = rawInput as Record<string, unknown>;
  const augmentedRawInput = {
    ...rawObject,
    evidence: [
      ...(Array.isArray(rawObject["evidence"]) ? rawObject["evidence"] : []),
      ...missing.map((locator) => ({
        evidenceId: locator.evidenceId,
        sourceType: locator.sourceType,
        finding: EVIDENCE_AUTO_COMPLETION_FINDING,
        supports: [],
      })),
    ],
  };

  const reparsed = ResolutionReportSchema.safeParse(augmentedRawInput, { reportInput: true });
  if (!reparsed.success) {
    // Includes the evidence-capacity boundary (round-5 MINOR): appending
    // pushed the array past .max(10), or some other refinement not visible
    // at the original single-invariant classification now trips. Either
    // way, discard the attempt entirely — the caller re-validates the
    // ORIGINAL rawInput and falls through to the existing path unchanged.
    return null;
  }

  return { report: reparsed.data, autoCompletedEvidence: missing };
}

// Caller-contract-level validity: retriever and retrievalInput must both be
// present or both absent, and a retriever's allowedRagChunkIds must never be
// supplied by the caller — it is derived exclusively from that retriever's
// own results (see the "no merge" comment below). Both violations are
// RETRIEVAL_PARAMS_INVALID, matching invalid-topK/empty-query (also a
// caller-contract violation) rather than RETRIEVAL_RESPONSE_INVALID, which is
// reserved for a retriever that ran and returned structurally invalid data.
function validateOrchestratorParams(params: AgentOrchestratorParams): string | null {
  const hasRetriever = params.retriever !== undefined;
  const hasRetrievalInput = params.retrievalInput !== undefined;

  if (hasRetriever !== hasRetrievalInput) {
    return "retriever and retrievalInput must both be provided or both omitted.";
  }

  if (hasRetriever && (params.allowedRagChunkIds?.size ?? 0) > 0) {
    return (
      "allowedRagChunkIds must not be supplied together with a retriever; " +
      "it is derived exclusively from that retriever's results."
    );
  }

  return null;
}

// Issue #99 (docs/reviews/38-issue-99-...-plan.md §2.1/§2.2): the closed,
// application-authored text appended to the conversation when a tripped A3
// guard is given one corrective retry instead of failing the run outright.
// Deliberately generic and never derived from the rejected assessment: no
// provider-controlled identifier, no echoed value, nothing the model wrote.
// Naming the violated invariant in the harness's own vocabulary is what lets
// the model self-correct without exposing anything it could exploit.
export const A3_CORRECTIVE_GUIDANCE_TEXT =
  "Your diagnostic tool request was rejected: it declared continuationReason " +
  '"NO_EVIDENCE_YET", but this run already has retrieved runbook evidence and/or ' +
  "a completed diagnostic tool result. NO_EVIDENCE_YET is only valid when no " +
  "evidence of any kind — no tool result, no retrieved runbook chunk — exists " +
  "anywhere yet in this conversation. That request was not executed; no tool ran " +
  "and nothing was recorded. Reassess the evidence already present in this " +
  "conversation and submit a corrected diagnostic tool call with an " +
  "evidenceAssessment consistent with what has actually been gathered so far " +
  "(or submit_resolution_report, if that evidence is now sufficient).";

// Issue #101 (docs/reviews/39-issue-101-...-plan.md §2.2): the closed,
// application-authored remedies offered when a submitted resolution report
// fails schema validation and is given one corrective retry.
//
// Keyed on the invariant's own `custom` message literal from
// resolution-report.ts. That coupling is deliberate and safe in one direction
// only: an unrecognized key falls through to the generic remedy below, so a
// future schema-message edit degrades this to a less specific (but still
// true) corrective message rather than to a wrong one. It can never invent a
// remedy for an invariant it does not know.
//
// Why a closed set rather than forwarding the schema's own messages: NOT
// safety — resolution-report-validation.ts records that every `custom` issue
// on this schema is a fixed hand-written literal with no interpolated report
// data, so forwarding would leak nothing. The reason is PROMPT GOVERNANCE.
// Those literals are validation-engine output; routing them to the provider
// would make every future schema-message edit a silent change to model-facing
// text with no §20.4 version bump and no eval comparison. Authoring the
// model-facing half here keeps prompt text where §20.4 can see it.
const REPORT_INVARIANT_REMEDIES: ReadonlyMap<string, string> = new Map([
  [
    "suggestedActions[].groundedBy entries must each appear in report.evidence.",
    "Every groundedBy locator on a suggested action must also appear as its own " +
      "entry in this report's evidence array, matched on both evidenceId and " +
      "sourceType. If you grounded an action in a tool result or runbook chunk " +
      "that you did not list under evidence, add that entry to evidence (with " +
      'supports: [] if it does not support the root cause) rather than removing ' +
      "the grounding.",
  ],
  [
    "ACTIONABLE requires at least one suggested action.",
    "A report whose recommendationDisposition is ACTIONABLE must contain at " +
      "least one entry in suggestedActions. Either supply the action you are " +
      "recommending, or set recommendationDisposition to ADVISORY (which " +
      "requires exactly zero suggested actions) if no concrete action is " +
      "warranted by the evidence.",
  ],
  [
    "ADVISORY requires exactly zero suggested actions.",
    "A report whose recommendationDisposition is ADVISORY must leave " +
      "suggestedActions empty. Either remove the suggested actions, or set " +
      "recommendationDisposition to ACTIONABLE if you intend to recommend them.",
  ],
  [
    "groundedBy must not repeat the same (sourceType, evidenceId) locator.",
    "Each suggested action's groundedBy array must not list the same " +
      "(sourceType, evidenceId) pair twice. Cite each distinct piece of " +
      "evidence once.",
  ],
]);

// Used when a report is rejected by an invariant with no authored remedy
// above. The retry still happens — the run is no less recoverable — but the
// message claims nothing specific rather than guessing at the cause.
const GENERIC_REPORT_CORRECTIVE_REMEDY =
  "The report did not satisfy the resolution-report contract.";

/**
 * Builds the corrective guidance for a rejected report.
 *
 * Reads ONLY the sanitized issue summaries (path/code/message), never the
 * submitted report, so nothing the model wrote — no invented evidenceId, no
 * payload field, no rootCause text — can reach the next prompt. Remedies are
 * de-duplicated and ordered deterministically by first appearance, because a
 * single malformed report routinely trips the same invariant on several
 * actions at once (two of the four real LIVE runs produced two identical F5
 * issues), and repeating the same paragraph twice teaches nothing.
 */
export function buildReportCorrectiveGuidanceText(
  issues: readonly ReportValidationIssue[],
): string {
  const remedies: string[] = [];
  for (const issue of issues) {
    const remedy =
      (issue.message !== undefined ? REPORT_INVARIANT_REMEDIES.get(issue.message) : undefined) ??
      GENERIC_REPORT_CORRECTIVE_REMEDY;
    if (!remedies.includes(remedy)) {
      remedies.push(remedy);
    }
  }

  return (
    "Your submitted resolution report was rejected: it did not satisfy the " +
    "report contract, so it was NOT recorded and this investigation has no " +
    "report yet. " +
    remedies.join(" ") +
    " Submit a corrected resolution report. Do not restate the rejected " +
    "report unchanged, and do not invent evidence to satisfy the contract — " +
    "report only what this conversation actually established."
  );
}

export async function runAgentOrchestrator(
  params: AgentOrchestratorParams,
): Promise<AgentOrchestratorResult> {
  const paramsError = validateOrchestratorParams(params);
  if (paramsError) {
    // The ONE failure reachable before anything is traced or emitted, and
    // the reason AGENT_STARTED is emitted just below rather than at function
    // entry: the contract's single pre-agent exception requires the stream to
    // be exactly RUN_CREATED -> RUN_FAILED. Emitting AGENT_STARTED first would
    // not fail loudly — it would quietly make that hand-written exception
    // unreachable. See docs/16-investigation-event-contract.md §5.
    return failed("RETRIEVAL_PARAMS_INVALID", paramsError, [], "AGENT_ANALYSIS");
  }

  const { provider, toolRegistry, outputBudget = DEFAULT_OUTPUT_BUDGET } = params;

  // TWO INDEPENDENT OUTPUT CHANNELS, deliberately not derived from one
  // another (issue #37, docs/reviews/21-...md §5):
  //
  //   canonical persistence -> await params.emitLifecycleEvent?.(payload)
  //   legacy in-memory      -> trace.push(legacyAgentTraceEvent)
  //
  // Their timing is NOT identical for every path: canonical TOOL_REQUESTED is
  // emitted before registry lookup/input validation, while the legacy push
  // stays at its old post-validation point. Keeping them separate is what
  // lets direct callers (evals, demos, unit tests) see exactly the trace they
  // always have, while the ledger truthfully records that the provider did
  // request a tool even when that tool turned out not to exist.
  //
  // ORDERING RULE for any event with both channels: canonical first, legacy
  // second. If canonical persistence fails, the await throws before the push
  // runs, so the in-memory trace never claims a transition whose durable
  // record does not exist.
  const emit = async (payload: InvestigationEventPayload): Promise<void> => {
    await params.emitLifecycleEvent?.(payload);
  };

  const trace: AgentTraceEvent[] = [];
  let conversation = [...params.initialConversation];

  // Manual mode (no retriever): allowedRagChunkIds is exactly what the
  // caller passed, unchanged from today's behavior — the preserved baseline.
  // Retrieval mode (retriever present): allowedRagChunkIds is entirely
  // overwritten below by the Set built from validated retrieval results.
  // params.allowedRagChunkIds is never read in that branch — no merge.
  let allowedRagChunkIds: ReadonlySet<string> = params.allowedRagChunkIds ?? new Set<string>();

  await emit({ type: "AGENT_STARTED" });

  if (params.retriever) {
    const retrievalInput = params.retrievalInput as RetrievalInput;

    const inputError = validateRetrievalInput(retrievalInput);
    if (inputError) {
      return failed("RETRIEVAL_PARAMS_INVALID", inputError, trace, "AGENT_ANALYSIS");
    }

    let chunks: readonly RetrievedRunbookChunk[];
    try {
      chunks = await params.retriever.retrieve(retrievalInput);
    } catch (error) {
      const category = error instanceof RetrieverError ? error.category : "UNKNOWN";
      return failed("RETRIEVAL_FAILED", `Runbook retrieval failed (${category}).`, trace, "AGENT_ANALYSIS");
    }

    const outputError = validateRetrievedChunks(chunks, retrievalInput.topK);
    if (outputError) {
      return failed("RETRIEVAL_RESPONSE_INVALID", outputError, trace, "AGENT_ANALYSIS");
    }

    // Only now — after both validations pass — build the Set, trace event,
    // and rag_context message. Chunks are already order-validated
    // (chunks[i].rank === i + 1), so the array order, the model-visible
    // context order, and the trace order all agree by construction.
    allowedRagChunkIds = new Set(chunks.map((chunk) => chunk.chunkId));

    const retrievalSummary = chunks.map((chunk) => ({
      chunkId: chunk.chunkId,
      rank: chunk.rank,
      score: chunk.score,
    }));

    // Canonical first, legacy second — a failed canonical append must not
    // leave the in-memory trace claiming retrieval completed.
    await emit({ type: "RETRIEVAL_COMPLETED", chunks: retrievalSummary });
    trace.push({ type: "RETRIEVAL_COMPLETED", chunks: retrievalSummary });

    if (chunks.length > 0) {
      conversation = [
        ...conversation,
        { role: "rag_context", entries: formatRagContext(chunks) },
      ];
    }
  }

  const successfulToolExecutionIds = new Set<string>();
  // Provider-requested diagnostic tool-call identities for this run, used to
  // reject a reused identity before any side effect (P1 final correction).
  // Distinct from successfulToolExecutionIds: a provider may try to reuse an
  // identity whether or not its earlier request executed, and must be rejected
  // either way.
  const requestedToolCallIds = new Set<string>();
  // Accepted diagnostic tool requests this run, incremented per emitted
  // TOOL_REQUESTED (mirroring the reducer's own per-request count). Drives
  // the state-derived active-stage attribution and the defense-in-depth bound
  // check below; the canonical ledger reconstructs the same count from the
  // persisted stream.
  let toolCallCount = 0;
  // Issue #99 §2.1: whether this run has already spent its one allowed A3
  // corrective retry. A second A3 trip in the same run fails closed exactly
  // as before this issue — the once-per-run limit, not the turn budget, is
  // what bounds the retry loop (an unbounded retry would let a
  // never-complying model spend providerTurns indefinitely).
  let a3RetryUsed = false;
  // Issue #101 §2.1: whether this run has already spent its one allowed
  // corrective retry on a schema-rejected report. Tracked separately from
  // a3RetryUsed on purpose — the two guards reject different things at
  // different points in the turn, and a shared flag would let an early A3
  // trip silently consume the report path's only correction (or vice versa),
  // making a run's recoverability depend on which mistake the model happened
  // to make first.
  let reportRetryUsed = false;
  // Issue #107: whether REPORT_GENERATION_STARTED has already been emitted this
  // run. The canonical ledger treats it as a singleton, and with slack in the
  // bounds the report-stage condition can hold on several consecutive turns —
  // so the flag, not the condition, is what makes the emission once-per-run.
  let reportGenerationAnnounced = false;

  for (let turnIndex = 0; turnIndex < MAX_PROVIDER_TURNS; turnIndex++) {
    const phase: AgentTurnPhase =
      turnIndex === MAX_PROVIDER_TURNS - 1 ? "FINALIZATION" : "INVESTIGATION";

    // Issue #107. THE condition that means "this run's report stage has begun",
    // and the single source for both the REPORT_GENERATION_STARTED emission and
    // the active-stage derivation below.
    //
    // It is deliberately NOT `phase === "FINALIZATION"`. The canonical reducer
    // requires the report-start fact once `toolCallCount >=
    // MAX_DIAGNOSTIC_TOOL_CALLS` (investigation-stage-progress-reducer.ts),
    // reasoning that an exhausted diagnostic budget leaves nothing but the
    // report to produce. Those two conditions coincided only while
    // MAX_DIAGNOSTIC_TOOL_CALLS === MAX_PROVIDER_TURNS - 1; #107 introduced
    // slack and split them apart, so a run that spent every diagnostic call now
    // reaches a turn that is still INVESTIGATION by position yet has no
    // diagnostic budget left.
    //
    // Deriving this from position instead produced streams the real reducer
    // REJECTS — MISSING_LIFECYCLE_FACT for a perfectly valid report, and
    // FAILED_STAGE_NOT_TRUTHFUL for an ordinary provider failure on that turn —
    // which leaves the run stuck RUNNING rather than failing cleanly. Neither
    // was visible to the orchestrator's own tests, whose collecting emitter
    // never runs the reducer; see report-stage-ledger.test.ts, which does.
    const reportStageBegun =
      phase === "FINALIZATION" || toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS;

    // The stage a provider/protocol failure on THIS turn belongs to (issue #57
    // §4.2), derived from run state rather than phase alone. Once the report
    // stage has begun — announced below — REPORT_GENERATION is what the reducer
    // sees as active, so a failure here must name it or be rejected as
    // untruthful. On an investigation turn that still has diagnostic budget and
    // at least one completed diagnostic, the agent is awaiting the provider's
    // next diagnostic decision — a provider failure there is a
    // DIAGNOSTIC_EXECUTION failure, which the reducer admits (as
    // diagnosticLoopActive) only while the loop is genuinely mid-flight and
    // below its bound. Before any tool, an investigation failure is still
    // AGENT_ANALYSIS.
    const activeStage: InvestigationExecutionStage = reportStageBegun
      ? "REPORT_GENERATION"
      : toolCallCount > 0
        ? "DIAGNOSTIC_EXECUTION"
        : "AGENT_ANALYSIS";

    // Announced immediately before the first provider call of the report stage,
    // and only once per run. REPORT_GENERATION_STARTED is a canonical SINGLETON:
    // the reducer rejects a second one with DUPLICATE_LIFECYCLE_FACT, and with
    // slack in the bounds several consecutive turns can satisfy
    // `reportStageBegun` (the exhausted-budget turn, then the forced
    // finalization turn a corrected report lands on). Guarding on the flag
    // rather than re-testing the condition per turn is what keeps the correction
    // path — the very path #107 exists to enable — persistable.
    //
    // Emitted OUTSIDE the try below so an emission failure is never mistaken for
    // a provider error.
    if (reportStageBegun && !reportGenerationAnnounced) {
      reportGenerationAnnounced = true;
      await emit({ type: "REPORT_GENERATION_STARTED" });
    }

    let result: AgentTurnResult;
    try {
      result = await provider.runAgentTurn({
        turnIndex,
        phase,
        // The report-safe ceiling on EVERY provider turn (issue #61 Codex
        // MAJOR 1): submit_resolution_report is available on every investigation
        // turn too, so an investigation-phase provider call can legitimately
        // produce the final report. Selecting a smaller ceiling by phase name
        // alone is therefore insufficient — all report-capable turns get
        // finalizationMaxOutputTokens. The provider still receives one plain
        // number per turn (AgentTurnInput.maxOutputTokens) and stays the single
        // output-budget authority for the turn it runs; only the orchestrator
        // resolves the report-safe ceiling.
        maxOutputTokens: outputBudget.finalizationMaxOutputTokens,
        conversation,
        // Issue #58 Checkpoint B (§10): the remaining diagnostic budget for
        // THIS turn. Constraint visibility only: it tells the provider how
        // much headroom the model has, while the #57 bounded-loop harness
        // remains authoritative for actually enforcing the bound.
        //
        // Two independent ceilings, whichever is smaller:
        //
        //   1. the unused diagnostic-call budget (MAX_DIAGNOSTIC_TOOL_CALLS
        //      minus accepted requests so far), and
        //   2. the number of turns that could still CARRY a diagnostic
        //      request — every turn before the forced FINALIZATION one.
        //
        // Before issue #99 the second ceiling was implicit and never binding:
        // each investigation turn accepted exactly one diagnostic request, so
        // budget and turns fell together and (1) alone yielded 0 on the
        // finalization turn, exactly as this contract promises (see also
        // AgentTurnInput.diagnosticCallsRemaining in llm-provider.ts).
        //
        // The A3 corrective retry breaks that coupling: it consumes a turn
        // WITHOUT accepting a diagnostic request, so toolCallCount no longer
        // tracks turns consumed. With (1) alone, a retried run would tell the
        // corrected turn it has 3 calls available when only 2 investigation
        // turns remain, and would hand the forced finalization turn a nonzero
        // budget — violating the documented contract and inviting the model to
        // defer work to a turn that does not exist, then be forced to submit an
        // incomplete report. Independent review raised this as a MAJOR against
        // the first implementation; confirmed against source and fixed here by
        // making the turn-based ceiling explicit rather than incidental.
        diagnosticCallsRemaining: Math.min(
          MAX_DIAGNOSTIC_TOOL_CALLS - toolCallCount,
          MAX_PROVIDER_TURNS - 1 - turnIndex,
        ),
        // Conditional spread: exactOptionalPropertyTypes is on, so an optional
        // property must be absent or a real value, never an explicit undefined.
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
    } catch (error) {
      // An LlmProviderError is an EXPECTED outcome of a live provider call —
      // auth, billing, rate limit, connectivity, timeout, cancellation — and
      // is converted into an ordinary failed result so the caller can finalize
      // the run. Letting it propagate would leave the persisted run RUNNING
      // forever, because AgentRunService's catch turns any throw into
      // AGENT_EXECUTION_CRASHED without finalizing.
      //
      // Its message is already the adapter's sanitized, category-keyed string,
      // so nothing vendor-specific — no response body, header, prompt, request
      // ID, or credential — reaches the trace or the database.
      //
      // Anything else is a genuine defect and still propagates unchanged: the
      // crash path exists precisely to make those loud.
      if (error instanceof LlmProviderError) {
        return failed(providerFailureCode(error.category), error.message, trace, activeStage);
      }
      // Anything else — including InvestigationEventEmissionError raised by
      // the canonical channel — propagates unchanged. The crash path exists
      // precisely to make those loud.
      throw error;
    }

    if (result.type === "protocol_error") {
      return failed(result.code, result.message, trace, activeStage);
    }

    if (result.type === "report_submission") {
      // Issue #101 §2.3: REPORT_SUBMITTED is NOT emitted here, before
      // validation, as it was before this issue. A corrected-away attempt must
      // leave no ledger trace at all — the canonical lifecycle treats report
      // events as singletons and rejects a stream carrying two of them — so the
      // event is emitted at each DECISION point below instead: once on a
      // terminal rejection, once on acceptance. For every run whose outcome is
      // decided by the first submission (the only shape possible before this
      // issue) the resulting stream is byte-identical to the old behaviour.
      //
      // reportInput: true is required for summarizeReportValidationIssues to
      // derive a real receivedType (zod v4 omits `.input` from issues by
      // default). The raw value was already fully in memory as
      // result.rawInput regardless — this doesn't expose anything new, and
      // the summarizer only ever reads `typeof`/Array.isArray off it, never
      // the value itself.
      const parsedReport = ResolutionReportSchema.safeParse(result.rawInput, {
        reportInput: true,
      });

      if (!parsedReport.success) {
        const issues = summarizeReportValidationIssues(parsedReport.error);

        // Issue #114 §2.1: attempt auto-completion BEFORE the existing
        // retry decision. On success this returns { status: "completed" }
        // directly, using the AUGMENTED parsed report as the run's result —
        // never touching reportRetryUsed or emitting REPORT_SUBMITTED for a
        // rejected attempt, since this attempt was never terminal.
        const autoCompleted = tryAutoCompleteGroundedByOmission(
          result.rawInput,
          classifyReportInvariants(issues),
          allowedRagChunkIds,
          successfulToolExecutionIds,
        );
        if (autoCompleted !== null) {
          // Defense-in-depth parity with the ordinary accepted path below:
          // §2.4's confirmation gate already guarantees every entry in
          // autoCompleted.report.evidence is a known run observation, so
          // this can never actually trip — but running the exact same check
          // here rather than assuming the gate is airtight matches how the
          // ordinary accepted path treats this invariant.
          if (
            findInvalidEvidence(
              autoCompleted.report.evidence,
              allowedRagChunkIds,
              successfulToolExecutionIds,
            )
          ) {
            // Unreachable in practice (see comment above); if it ever did
            // trip, fall through to the existing failure/retry path on the
            // ORIGINAL rejection rather than inventing a new failure shape.
          } else {
            await emit({ type: "REPORT_SUBMITTED" });
            await emit({ type: "REPORT_VALIDATED" });
            trace.push({ type: "REPORT_GENERATED" });
            return {
              status: "completed",
              report: autoCompleted.report,
              trace,
              autoCompletedEvidence: autoCompleted.autoCompletedEvidence,
            };
          }
        }

        // Issue #101 (docs/reviews/39-issue-101-...-plan.md §2.1): one bounded
        // corrective re-prompt instead of discarding the whole run, when this
        // is BOTH the first rejected report this run AND a later turn remains
        // to submit a corrected one into. ResolutionReportSchema is untouched
        // and the report is still rejected; only the run's fate on a first
        // rejection changes.
        //
        // Eligibility is `turnIndex < MAX_PROVIDER_TURNS - 1` — WIDER than the
        // A3 retry's window above, and deliberately so. A3's retry needs a slot
        // that can carry a corrected DIAGNOSTIC request, which the forced
        // FINALIZATION turn structurally cannot (it pins tool_choice to
        // submit_resolution_report). A corrected REPORT needs exactly that
        // slot, so the finalization turn is a valid retry target here rather
        // than an excluded one. Only a rejection ON the final turn is
        // unrecoverable — which is where real run b5fb71ae died, and failing
        // it is honest.
        const canRetryReport = !reportRetryUsed && turnIndex < MAX_PROVIDER_TURNS - 1;
        if (canRetryReport) {
          // NOTHING is emitted for a corrected-away attempt — no
          // REPORT_SUBMITTED above, no REPORT_VALIDATION_FAILED here (§2.3,
          // retracted-and-corrected). This is NOT a convenience: the canonical
          // lifecycle treats report events as singletons, so a stream carrying
          // two REPORT_SUBMITTED events (or a report outcome followed by
          // another submission) is REJECTED by
          // investigation-stage-progress-reducer.ts, and the run would end up
          // stuck RUNNING with a persistence error instead of completing. An
          // earlier implementation of this issue emitted both and passed every
          // deterministic test here, because these tests use a collecting
          // emitter that never runs the reducer; independent review caught it
          // as a BLOCKER.
          //
          // It is also the CONSISTENT choice, not a workaround: #99 emits
          // nothing for a rejected diagnostic request either — TOOL_REQUESTED
          // records only accepted ones. The ledger records a run's accepted
          // trajectory, not every attempt within it.
          //
          // What this narrows: REPORT_SUBMITTED is emitted before validation
          // precisely so the ledger can distinguish "submitted then rejected"
          // from "never submitted". That still holds whenever a rejection
          // decides the run's outcome. It does NOT hold for an attempt that was
          // corrected away — such an attempt leaves no ledger trace at all, and
          // only providerCallsObserved reveals that an extra invocation
          // happened. Whether the ledger should record attempts rather than
          // outcomes is deliberately out of scope here and owed its own issue
          // (§5).
          //
          // Charged a turn slot like every other provider invocation, for the
          // same reason as the A3 retry: providerTurnsUsed counts ATTEMPTS
          // (recording-provider.ts). The once-per-run flag, not the turn
          // budget, is what bounds the loop.
          reportRetryUsed = true;
          conversation = [
            ...conversation,
            {
              role: "corrective_guidance",
              // Derived from the SANITIZED issue summaries only — never from
              // result.rawInput — so nothing the model wrote can ride back
              // into the next prompt.
              text: buildReportCorrectiveGuidanceText(issues),
            },
          ];
          continue;
        }

        // Terminal rejection: this attempt decides the run, so it IS recorded.
        await emit({ type: "REPORT_SUBMITTED" });
        await emit({
          type: "REPORT_VALIDATION_FAILED",
          failureCode: "REPORT_SCHEMA_INVALID",
          // Issue #105: classified from the SANITIZED issue summaries only —
          // the same input the corrective guidance reads, never
          // result.rawInput — so no model-produced text reaches the ledger.
          violatedInvariants: classifyReportInvariants(issues),
        });
        return failed(
          "REPORT_SCHEMA_INVALID",
          "The submitted resolution report failed schema validation.",
          trace,
          "REPORT_GENERATION",
          issues,
        );
      }

      // Accepted: this attempt decides the run, so it is recorded.
      await emit({ type: "REPORT_SUBMITTED" });

      if (
        findInvalidEvidence(
          parsedReport.data.evidence,
          allowedRagChunkIds,
          successfulToolExecutionIds,
        )
      ) {
        await emit({
          type: "REPORT_VALIDATION_FAILED",
          failureCode: "REPORT_EVIDENCE_INVALID",
          // Issue #105: this rejection comes from the orchestrator's own
          // run-scoped availability check, not from Zod — there are no schema
          // issues to classify, and the cause is always the same one.
          violatedInvariants: ["EVIDENCE_NOT_AVAILABLE_IN_RUN"],
        });
        return failed(
          "REPORT_EVIDENCE_INVALID",
          "The submitted report referenced evidence that was not available in the current agent execution.",
          trace,
          "REPORT_GENERATION",
        );
      }

      // Canonical REPORT_VALIDATED, then the legacy REPORT_GENERATED push.
      // The legacy type name is unchanged: REPORT_GENERATED has always meant
      // "validated and accepted", which is exactly what REPORT_VALIDATED
      // records — two names for one fact, neither derived from the other.
      await emit({ type: "REPORT_VALIDATED" });
      trace.push({ type: "REPORT_GENERATED" });
      return { status: "completed", report: parsedReport.data, trace, autoCompletedEvidence: [] };
    }

    // result.type === "diagnostic_tool_request"
    if (turnIndex === MAX_PROVIDER_TURNS - 1) {
      // Deliberately BEFORE the canonical TOOL_REQUESTED emission below: a
      // diagnostic tool request on the forced finalization turn must not
      // produce a TOOL_REQUESTED in the ledger at all — the turn requires a
      // report submission, and a rejected request is a provider protocol
      // failure. By this point REPORT_GENERATION_STARTED has been emitted, so
      // REPORT_GENERATION is the truthful active stage.
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "A report submission was required on the final provider turn, but another diagnostic tool request was received.",
        trace,
        "REPORT_GENERATION",
      );
    }

    // P1 final-correction guard: a provider must never reuse a diagnostic
    // tool-call identity within a single run. Persistence cannot enforce this
    // — Checkpoint A's exact-replay semantics deliberately re-append an
    // identical (runId, eventType, toolCallId) row (ambiguous-commit retry),
    // so a repeated identity would execute the tool a second time while the
    // ledger records only one request/completion pair. Reject here, before
    // the canonical TOOL_REQUESTED emit and before any side effect, at the
    // already-derived truthful active stage. The message is deliberately
    // closed: it must never echo the provider-controlled identifier.
    if (requestedToolCallIds.has(result.request.toolCallId)) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "A diagnostic request reused a prior tool-call identity.",
        trace,
        activeStage,
      );
    }
    requestedToolCallIds.add(result.request.toolCallId);

    // Defense-in-depth (issue #57 §4.1): never accept more diagnostic tool
    // requests than the shared bound, even if future constants drift so that
    // the investigation turns outnumber MAX_DIAGNOSTIC_TOOL_CALLS. With the
    // current equality (MAX_DIAGNOSTIC_TOOL_CALLS === MAX_PROVIDER_TURNS - 1)
    // this coincides with the finalization-turn guard above and is
    // unreachable; it exists so a future constant change fails closed instead
    // of executing a call past the reviewed ceiling.
    if (toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "The diagnostic tool bound was reached, but another diagnostic tool request was received.",
        trace,
        "REPORT_GENERATION",
      );
    }

    // Issue #58 Checkpoint B (§9.1): authoritative, provider-uniform
    // assessment validation. The provider adapter extracts rawAssessment from
    // the model output structurally (mirroring rawInput on report_submission);
    // this central safeParse is the ONE site that validates it, for live and
    // fake providers alike. EvidenceAssessmentSchema's own superRefine
    // invariants enforce that SUFFICIENT cannot accompany a diagnostic
    // request, so a raw SUFFICIENT assessment is rejected right here,
    // centrally — deliberately no second, logically-unreachable re-check that
    // could drift.
    const parsedAssessment = EvidenceAssessmentSchema.safeParse(
      result.request.rawAssessment,
    );
    if (!parsedAssessment.success) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "The diagnostic tool request carried an invalid evidence assessment.",
        trace,
        activeStage,
      );
    }

    // Issue #58 Checkpoint B (§9.2): every supportedBy locator must be
    // grounded in evidence actually available in this run, using the same
    // source-aware helper the report path uses. Ungrounded or
    // source-mismatched locators are a provider protocol violation; the
    // message is deliberately closed and never echoes a provider-controlled
    // id or value.
    if (
      findInvalidEvidence(
        parsedAssessment.data.supportedBy,
        allowedRagChunkIds,
        successfulToolExecutionIds,
      )
    ) {
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "The diagnostic tool request cited evidence that was not available in the current agent execution.",
        trace,
        activeStage,
      );
    }

    // Issue #58 Checkpoint B (§9.3): the run-state consistency of
    // NO_EVIDENCE_YET. The reason may be claimed if and only if no tool or
    // RAG evidence exists in the run yet — once either set is non-empty the
    // model must cite it, and with nothing available NO_EVIDENCE_YET is the
    // only reason it may claim.
    const hasRunEvidence =
      successfulToolExecutionIds.size > 0 || allowedRagChunkIds.size > 0;
    const claimsNoEvidenceYet =
      parsedAssessment.data.continuationReason === "NO_EVIDENCE_YET";
    if (claimsNoEvidenceYet === hasRunEvidence) {
      // Issue #99 (docs/reviews/38-issue-99-...-plan.md §2.1): one bounded
      // corrective re-prompt instead of failing the run outright, when this
      // is BOTH the first A3 trip this run AND another investigation slot
      // would remain after it. The request is still rejected exactly as
      // before — no TOOL_REQUESTED is emitted and nothing executes — only
      // the run's fate on a tripped guard changes.
      //
      // Retry eligibility is positional, not merely "not yet used": phase is
      // derived purely from turnIndex (FINALIZATION iff
      // turnIndex === MAX_PROVIDER_TURNS - 1, above), and a FINALIZATION turn
      // forces tool_choice to submit_resolution_report, so it structurally
      // cannot carry a corrected diagnostic request. A trip on the LAST
      // investigation turn (turnIndex === MAX_PROVIDER_TURNS - 2) therefore
      // has nowhere to retry to — the only turn left is the forced
      // finalization turn — and must fail exactly as today. The retry is
      // available only on investigation turns 0 .. MAX_PROVIDER_TURNS - 3
      // (turns 0 and 1 at current constants).
      const canRetry = !a3RetryUsed && turnIndex <= MAX_PROVIDER_TURNS - 3;
      if (canRetry) {
        // The retry is NOT free: it consumes this loop iteration's
        // MAX_PROVIDER_TURNS slot exactly like any other provider
        // invocation (the next provider.runAgentTurn call happens at
        // turnIndex + 1, via the for-loop's own increment on `continue`
        // below). providerTurnsUsed counts invocation ATTEMPTS
        // (recording-provider.ts), so a free retry would let 5 real
        // invocations run under a documented bound of 4 — failing the
        // evaluator's bounds-respected metric and exceeding every spend
        // figure derived from MAX_PROVIDER_TURNS. Charging the slot keeps
        // the bound honest; the once-per-run limit above is what prevents an
        // unbounded loop, not the turn budget.
        a3RetryUsed = true;
        conversation = [
          ...conversation,
          { role: "corrective_guidance", text: A3_CORRECTIVE_GUIDANCE_TEXT },
        ];
        continue;
      }
      return failed(
        "PROVIDER_PROTOCOL_INVALID",
        "The diagnostic tool request declared evidence status inconsistently with the run's evidence state.",
        trace,
        activeStage,
      );
    }

    const { toolCallId, toolName, input } = result.request;

    // CANONICAL TOOL_REQUESTED, emitted here — before registry lookup and
    // before input validation — because the provider genuinely did request
    // the tool, and TOOL_NOT_FOUND / TOOL_INPUT_INVALID must be able to
    // record TOOL_REQUESTED -> TOOL_FAILED. The LEGACY push stays at its
    // original post-validation position further below, unmoved, so a direct
    // caller's in-memory trace is unchanged for those two failures.
    // Issue #58 Checkpoint B (§9.4): only the VALIDATED assessment rides the
    // canonical event and the conversation replay — never the raw form the
    // provider returned. §9's guards above (V0 schema / A2 grounding / A3
    // run-state consistency) have all passed by this point.
    await emit({
      type: "TOOL_REQUESTED",
      toolCallId,
      toolName,
      assessment: parsedAssessment.data,
    });
    toolCallCount += 1;

    const tool = toolRegistry.find(toolName);
    if (!tool) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_NOT_FOUND" });
      return failed(
        "TOOL_NOT_FOUND",
        `Unknown diagnostic tool "${toolName}".`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    const parsedInput = tool.inputSchema.safeParse(input);
    if (!parsedInput.success) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_INPUT_INVALID" });
      return failed(
        "TOOL_INPUT_INVALID",
        `Invalid input for diagnostic tool "${toolName}".`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    // The LEGACY TOOL_REQUESTED push, unmoved from its original position:
    // reached only after lookup AND input validation both succeed. This is
    // why the two early tool failures above still produce no legacy
    // TOOL_REQUESTED, exactly as before #37.
    trace.push({ type: "TOOL_REQUESTED", toolCallId, toolName });

    let rawOutput: unknown;
    try {
      rawOutput = await tool.execute(parsedInput.data);
    } catch {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_EXECUTION_FAILED" });
      return failed(
        "TOOL_EXECUTION_FAILED",
        `Diagnostic tool "${toolName}" failed during execution.`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    const parsedOutput = tool.outputSchema.safeParse(rawOutput);
    if (!parsedOutput.success) {
      await emit({ type: "TOOL_FAILED", toolCallId, toolName, failureCode: "TOOL_OUTPUT_INVALID" });
      return failed(
        "TOOL_OUTPUT_INVALID",
        `Diagnostic tool "${toolName}" returned an invalid result.`,
        trace,
        "DIAGNOSTIC_EXECUTION",
      );
    }

    await emit({ type: "TOOL_COMPLETED", toolCallId, toolName });
    trace.push({ type: "TOOL_COMPLETED", toolCallId, toolName });
    successfulToolExecutionIds.add(toolCallId);

    conversation = [
      ...conversation,
      {
        role: "diagnostic_tool_request",
        toolCallId,
        toolName,
        input: parsedInput.data,
        // Issue #58 Checkpoint B (§3.3/§9.4): the VALIDATED assessment only —
        // the raw form, free-form rationale, chain-of-thought, and hypotheses
        // never reach the conversation.
        assessment: parsedAssessment.data,
      },
      {
        role: "diagnostic_tool_result",
        toolCallId,
        toolName,
        output: parsedOutput.data,
      },
    ];
  }

  // Unreachable: the finalization turn always returns before the loop can fall
  // through — a diagnostic tool request is rejected by the finalization-turn
  // guard, a report submission returns immediately, and a provider/protocol
  // failure fails closed.
  return failed(
    "PROVIDER_PROTOCOL_INVALID",
    "Bounded provider-turn loop exhausted without a report submission.",
    trace,
    "REPORT_GENERATION",
  );
}
