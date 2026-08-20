import { z } from "zod";

import { MAX_DIAGNOSTIC_TOOL_CALLS } from "./agent-run-bounds";
import type { AgentOrchestratorErrorCode } from "./agent-orchestrator";
import {
  ExecutionStageProgressListSchema,
  INVESTIGATION_EXECUTION_STAGE_ORDER,
  InvestigationRunStatusSchema,
  type ExecutionStageProgress,
  type ExecutionStageProgressStatus,
  type InvestigationExecutionStage,
  type InvestigationRunStatus,
} from "./investigation-execution-stage";
import {
  InvestigationEventRecordSchema,
  type InvestigationEventRecord,
} from "./investigation-event";

/**
 * Every code below is thrown somewhere in this file. There are no
 * declared-but-unreachable members: a code that cannot occur is a false
 * claim about what the contract enforces, so the set is kept honest rather
 * than aspirational.
 */
export type InvestigationEventContractErrorCode =
  // ── Runtime input validation (TypeScript types may be bypassed at a
  // package boundary, so the reducer re-checks what it was handed).
  | "INVALID_NOW"
  | "INVALID_RUN_STATUS"
  | "INVALID_EVENT_RECORD"
  | "MIXED_RUN_IDS"
  | "SEQUENCE_NOT_CONTIGUOUS"
  // ── Lifecycle structure
  | "RUN_CREATED_NOT_FIRST"
  | "DUPLICATE_LIFECYCLE_FACT"
  | "LEGACY_EVENT_IN_CANONICAL_STREAM"
  | "REPORT_OUTCOME_WITHOUT_SUBMISSION"
  | "MISSING_LIFECYCLE_FACT"
  // ── Forward-only phase ordering
  | "PHASE_ORDER_VIOLATION"
  // ── Tool-call identity and state
  | "TOOL_OUTCOME_WITHOUT_REQUEST"
  | "DUPLICATE_TOOL_OUTCOME"
  | "TOOL_NAME_MISMATCH"
  | "OPEN_TOOL_CALL"
  | "TOOL_LIMIT_EXCEEDED"
  | "DUPLICATE_TOOL_CALL_ID"
  | "TOOL_REQUEST_WHILE_OPEN"
  | "TOOL_REQUEST_AFTER_REPORT_PHASE"
  // ── Terminal and failure consistency
  | "EVENT_AFTER_TERMINAL"
  | "MULTIPLE_TERMINAL_EVENTS"
  | "EVENT_AFTER_FAILURE"
  | "RUN_STATUS_MISMATCH"
  | "CONTRADICTORY_COMPLETION"
  | "FAILURE_FACT_MISMATCH"
  | "FAILED_STAGE_NOT_TRUTHFUL"
  | "FAILURE_CODE_STAGE_MISMATCH"
  | "UNRESOLVED_TERMINAL_STAGE"
  // ── Output self-check
  | "INVALID_PROGRESS_OUTPUT";

/**
 * Mirrors packages/database/src/errors.ts's PersistenceError shape
 * (readonly `code` + sanitized message) — the repository's existing
 * convention for a typed, deterministic validation failure.
 *
 * Messages contain only closed enum values (event types, error codes,
 * stage names), numeric sequence positions, and safe structural
 * descriptions. They never embed a failure message, provider text,
 * toolCallId, toolName, or any other provider-controlled or free-form
 * value, because these strings may reach a log.
 */
export class InvestigationEventContractError extends Error {
  readonly code: InvestigationEventContractErrorCode;

  constructor(
    code: InvestigationEventContractErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "InvestigationEventContractError";
    this.code = code;
  }
}

function fail(
  code: InvestigationEventContractErrorCode,
  message: string,
  options?: { cause?: unknown },
): never {
  throw new InvestigationEventContractError(code, message, options);
}

export interface DeriveExecutionStageProgressInput {
  readonly events: readonly InvestigationEventRecord[];
  readonly runStatus: InvestigationRunStatus;
  readonly now: string;
}

// ── Failure-code / stage compatibility ─────────────────────────────────
//
// Built from the ACTUAL production sites in
// packages/agent-runtime/src/agent/agent-orchestrator.ts, not from guesses:
//
//   RETRIEVAL_PARAMS_INVALID   validateOrchestratorParams (empty trace) and
//                              the retriever branch's input validation
//   RETRIEVAL_FAILED           retriever.retrieve() threw
//   RETRIEVAL_RESPONSE_INVALID retrieved-chunk validation failed
//   TOOL_NOT_FOUND             registry lookup miss   (before TOOL_REQUESTED is traced)
//   TOOL_INPUT_INVALID         tool input validation  (before TOOL_REQUESTED is traced)
//   TOOL_EXECUTION_FAILED      tool.execute() threw   (after  TOOL_REQUESTED is traced)
//   TOOL_OUTPUT_INVALID        tool output validation (after  TOOL_REQUESTED is traced)
//   REPORT_SCHEMA_INVALID      ResolutionReportSchema parse failed
//   REPORT_EVIDENCE_INVALID    findInvalidEvidence rejected the report
//   PROVIDER_PROTOCOL_INVALID  tool request on the finalization turn; loop exhausted
//   PROVIDER_OUTPUT_TRUNCATED  stop_reason === "max_tokens" on any provider turn
//   PROVIDER_TIMEOUT/          providerFailureCode(...) from an LlmProviderError on
//   PROVIDER_CANCELLED/        any provider turn
//   PROVIDER_UNAVAILABLE
//
// Note for #37 (documented in docs/16 §9): TOOL_NOT_FOUND and
// TOOL_INPUT_INVALID are currently produced *before* the orchestrator
// traces TOOL_REQUESTED. An emitter that wants to report them at run level
// must therefore also record the TOOL_REQUESTED/TOOL_FAILED pair, because
// this contract does not let a terminal-only tool code invent a tool
// failure that no event witnessed.
interface FailurePolicy {
  /** Stages this code can truthfully be attributed to. */
  readonly legalStages: readonly InvestigationExecutionStage[];
  /** A prior stage-specific failure event this code requires. */
  readonly requiresSpecificFact: "none" | "tool" | "report";
  /** Usable by the narrow pre-agent exception (stream is RUN_CREATED → RUN_FAILED). */
  readonly allowedBeforeAgentStarted: boolean;
  /**
   * Usable once REPORT_SUBMITTED has occurred. After submission the provider
   * has already returned a report payload, so a provider/protocol failure
   * can no longer be what ended the run — only report validation can.
   */
  readonly allowedAfterReportSubmitted: boolean;
  /**
   * The precisely-scoped issue #57 mid-loop exception: a provider/protocol
   * code may be attributed to DIAGNOSTIC_EXECUTION ONLY while a diagnostic
   * loop is genuinely active (at least one request begun, the bound not yet
   * exhausted, no open call, no tool-specific failure fact, report phase not
   * begun — see `diagnosticLoopActive` in the RUN_FAILED branch). It is never
   * a blanket permission: a no-tool stream claiming a provider failure at
   * DIAGNOSTIC_EXECUTION, an open-tool stream claiming one, or a stream at
   * the exhausted bound claiming one, all stay rejected.
   */
  readonly allowedInDiagnosticLoop?: boolean;
}

const ANALYSIS_ONLY = ["AGENT_ANALYSIS"] as const;
const DIAGNOSTIC_ONLY = ["DIAGNOSTIC_EXECUTION"] as const;
const REPORT_ONLY = ["REPORT_GENERATION"] as const;
const ANALYSIS_OR_REPORT = ["AGENT_ANALYSIS", "REPORT_GENERATION"] as const;

/**
 * The v1 failure policy, one entry per orchestrator error code.
 *
 * `satisfies Record<AgentOrchestratorErrorCode, FailurePolicy>` is the point:
 * adding a member to AgentOrchestratorErrorCode fails compilation here until
 * an explicit policy is written for it. A `Set`-based classification would
 * have silently treated an unknown future code as unconstrained.
 *
 * Derived from the actual `failed(...)` sites in
 * packages/agent-runtime/src/agent/agent-orchestrator.ts.
 */
const FAILURE_POLICY = {
  // Retrieval — raised while analysis is running. RETRIEVAL_PARAMS_INVALID
  // is additionally the only code validateOrchestratorParams can produce
  // before anything is traced, which is what makes it the sole pre-agent code.
  RETRIEVAL_PARAMS_INVALID: {
    legalStages: ANALYSIS_ONLY,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: true,
    allowedAfterReportSubmitted: false,
  },
  RETRIEVAL_FAILED: {
    legalStages: ANALYSIS_ONLY,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },
  RETRIEVAL_RESPONSE_INVALID: {
    legalStages: ANALYSIS_ONLY,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },

  // Tool — a terminal event may not invent a tool failure no event witnessed.
  TOOL_NOT_FOUND: {
    legalStages: DIAGNOSTIC_ONLY,
    requiresSpecificFact: "tool",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },
  TOOL_INPUT_INVALID: {
    legalStages: DIAGNOSTIC_ONLY,
    requiresSpecificFact: "tool",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },
  TOOL_EXECUTION_FAILED: {
    legalStages: DIAGNOSTIC_ONLY,
    requiresSpecificFact: "tool",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },
  TOOL_OUTPUT_INVALID: {
    legalStages: DIAGNOSTIC_ONLY,
    requiresSpecificFact: "tool",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
  },

  // Report validation — the only failures that can legally follow a
  // submitted report, because validation is what happens to it next.
  REPORT_SCHEMA_INVALID: {
    legalStages: REPORT_ONLY,
    requiresSpecificFact: "report",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: true,
  },
  REPORT_EVIDENCE_INVALID: {
    legalStages: REPORT_ONLY,
    requiresSpecificFact: "report",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: true,
  },

  // Provider / protocol — attributable to whichever stage was awaiting the
  // provider, never to diagnostics except the one precisely-scoped mid-loop
  // case (issue #57 §7), and never after the provider has already returned a
  // report payload.
  PROVIDER_PROTOCOL_INVALID: {
    legalStages: ANALYSIS_OR_REPORT,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
    allowedInDiagnosticLoop: true,
  },
  // stop_reason === "max_tokens", normalized before the report_submission
  // branch — see claude-response-normalization.ts. REPORT_SUBMITTED is never
  // emitted for a truncated turn, so allowedAfterReportSubmitted: false is
  // correct on exactly the same grounds as PROVIDER_PROTOCOL_INVALID.
  PROVIDER_OUTPUT_TRUNCATED: {
    legalStages: ANALYSIS_OR_REPORT,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
    allowedInDiagnosticLoop: true,
  },
  PROVIDER_UNAVAILABLE: {
    legalStages: ANALYSIS_OR_REPORT,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
    allowedInDiagnosticLoop: true,
  },
  PROVIDER_TIMEOUT: {
    legalStages: ANALYSIS_OR_REPORT,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
    allowedInDiagnosticLoop: true,
  },
  PROVIDER_CANCELLED: {
    legalStages: ANALYSIS_OR_REPORT,
    requiresSpecificFact: "none",
    allowedBeforeAgentStarted: false,
    allowedAfterReportSubmitted: false,
    allowedInDiagnosticLoop: true,
  },
} satisfies Record<AgentOrchestratorErrorCode, FailurePolicy>;

interface FailureCompatibilityContext {
  readonly failureCode: AgentOrchestratorErrorCode;
  readonly failedStage: InvestigationExecutionStage;
  readonly specificFailure: {
    readonly stage: InvestigationExecutionStage;
    readonly code: AgentOrchestratorErrorCode;
  } | null;
  readonly preAgentException: boolean;
  readonly reportSubmitted: boolean;
  readonly sequence: number;
  /** True while a diagnostic loop is genuinely mid-flight (issue #57 §7). */
  readonly diagnosticLoopActive: boolean;
}

/**
 * Rejects a terminal failure whose code could not causally have been
 * produced in the stage and phase it names.
 *
 * This cannot live in the payload schema: the same provider code is legal
 * in different stages depending on lifecycle context (a PROVIDER_TIMEOUT is
 * an analysis failure before the report phase and a report-generation
 * failure after report-start but before submission), so the decision needs
 * the reducer's accumulated state.
 */
function assertFailureCodeCompatibleWithContext(context: FailureCompatibilityContext): void {
  const {
    failureCode,
    failedStage,
    specificFailure,
    preAgentException,
    reportSubmitted,
    sequence,
    diagnosticLoopActive,
  } = context;
  const policy: FailurePolicy = FAILURE_POLICY[failureCode];
  // Messages name codes and stages only — both are closed enums defined in
  // this repository, never provider-controlled text.
  const reject = (reason: string): never =>
    fail(
      "FAILURE_CODE_STAGE_MISMATCH",
      `RUN_FAILED at sequence ${sequence} pairs failure code "${failureCode}" with stage "${failedStage}": ${reason}`,
    );

  if (preAgentException && !policy.allowedBeforeAgentStarted) {
    reject(
      "only a pre-agent parameter-validation failure can occur before AGENT_STARTED; every other code requires the analysis stage to have begun",
    );
  }

  if (reportSubmitted && !policy.allowedAfterReportSubmitted) {
    reject(
      "the provider had already returned a report payload, so only report validation can end the run after REPORT_SUBMITTED",
    );
  }

  // The one precisely-scoped #57 exception: provider/protocol codes may name
  // DIAGNOSTIC_EXECUTION only while a diagnostic loop is genuinely active.
  // This is not a broad relaxation — the four codes keep their ordinary
  // legal stages, and the reducer still rejects a no-tool stream claiming a
  // provider failure at DIAGNOSTIC_EXECUTION.
  const stageLegal =
    policy.legalStages.includes(failedStage) ||
    (policy.allowedInDiagnosticLoop === true &&
      failedStage === "DIAGNOSTIC_EXECUTION" &&
      diagnosticLoopActive);
  if (!stageLegal) {
    reject(
      `this code is only attributable to ${policy.legalStages.join(" or ")}${policy.allowedInDiagnosticLoop === true ? " plus DIAGNOSTIC_EXECUTION while a diagnostic loop is active" : ""}`,
    );
  }

  if (policy.requiresSpecificFact === "tool" && specificFailure === null) {
    reject(
      "a tool failure code requires a preceding TOOL_FAILED fact; a terminal event cannot invent a tool failure no event witnessed",
    );
  }

  if (policy.requiresSpecificFact === "report" && specificFailure === null) {
    reject("a report-validation failure code requires a preceding REPORT_VALIDATION_FAILED fact");
  }
}

interface MutableStageState {
  status: ExecutionStageProgressStatus;
  startedAt: string | null;
  completedAt: string | null;
  failureCode?: AgentOrchestratorErrorCode;
}

interface ToolCallState {
  readonly toolName: string;
  state: "open" | "completed" | "failed";
}

const NowSchema = z.string().datetime();

const TERMINAL_TYPES = new Set(["RUN_COMPLETED", "RUN_FAILED"]);

/**
 * The shared, pure execution-stage reducer for issue #36.
 *
 * It is the SINGLE place where a canonical investigation event stream is
 * fully validated. `hasCanonicalInvestigationLifecycleMarker` is only a
 * cheap canonical-vs-legacy marker check and deliberately does not repeat
 * any of the rules below.
 *
 * It does not repair. There is no sanity-closing of active stages, no
 * omitting of stages to paper over a missing fact, and no path by which a
 * stream containing a failure fact yields a successful completion. A
 * malformed canonical history is rejected with a typed
 * `InvestigationEventContractError`, because a progress view that silently
 * "fixes" a corrupt history is indistinguishable, to the person reading it
 * during an incident, from one describing what actually happened.
 *
 * Valid partial RUNNING streams (mid-tool, mid-report) are preserved and
 * reduced normally — incompleteness is only an error when the stream claims
 * to be terminal.
 */
export function deriveExecutionStageProgress(
  input: DeriveExecutionStageProgressInput,
): readonly ExecutionStageProgress[] {
  const { events } = input;

  // ── Validate runtime inputs before touching them ───────────────────────
  const parsedNow = NowSchema.safeParse(input.now);
  if (!parsedNow.success) {
    fail("INVALID_NOW", "`now` must be an ISO-8601 datetime string.", { cause: parsedNow.error });
  }
  // runStatus drives terminal agreement and the RUNNING exemptions, so a
  // bogus value would silently skip those checks. The TypeScript union is
  // not enough at a package boundary.
  const parsedRunStatus = InvestigationRunStatusSchema.safeParse(input.runStatus);
  if (!parsedRunStatus.success) {
    fail("INVALID_RUN_STATUS", "`runStatus` must be RUNNING, COMPLETED, or FAILED.", {
      cause: parsedRunStatus.error,
    });
  }
  const runStatus: InvestigationRunStatus = parsedRunStatus.data;
  const nowMs = Date.parse(parsedNow.data);
  if (Number.isNaN(nowMs)) {
    fail("INVALID_NOW", "`now` must be a parseable ISO-8601 datetime string.");
  }

  events.forEach((event, index) => {
    const parsed = InvestigationEventRecordSchema.safeParse(event);
    if (!parsed.success) {
      fail(
        "INVALID_EVENT_RECORD",
        `Event at array index ${index} is not a valid InvestigationEventRecord.`,
        { cause: parsed.error },
      );
    }
    if (event.sequence !== index + 1) {
      fail(
        "SEQUENCE_NOT_CONTIGUOUS",
        `Event at array index ${index} has sequence ${event.sequence}, expected ${index + 1}. Events must be sequence-ordered and contiguous from 1 (this also rejects gaps, duplicates, and out-of-order input).`,
      );
    }
    if (index > 0 && event.runId !== events[0]!.runId) {
      fail(
        "MIXED_RUN_IDS",
        `Event at array index ${index} belongs to a different runId than the first event. One reduction covers exactly one run.`,
      );
    }
  });

  // ── Stream-level shape ─────────────────────────────────────────────────
  //
  // Only the checks that must precede reduction live here. runStatus
  // agreement is deliberately deferred until AFTER the event loop, so that a
  // structurally broken stream reports the specific structural fault
  // (EVENT_AFTER_TERMINAL, MULTIPLE_TERMINAL_EVENTS, ...) rather than the
  // vaguer RUN_STATUS_MISMATCH that such a stream also happens to exhibit.
  if (events.length === 0) {
    if (runStatus !== "RUNNING") {
      fail(
        "RUN_STATUS_MISMATCH",
        `runStatus is "${runStatus}" but the event stream is empty; a terminal run always records at least RUN_CREATED and its terminal event.`,
      );
    }
  } else if (events[0]!.payload.type !== "RUN_CREATED") {
    fail(
      "RUN_CREATED_NOT_FIRST",
      `A canonical stream must begin with RUN_CREATED at sequence 1; found "${events[0]!.payload.type}". A pre-#37 legacy trace is expected to fail here — check hasCanonicalInvestigationLifecycleMarker first and use the legacy fallback.`,
    );
  }

  // ── Reduction state ────────────────────────────────────────────────────
  const stages: Record<InvestigationExecutionStage, MutableStageState> = {
    INVESTIGATION_CREATED: { status: "pending", startedAt: null, completedAt: null },
    AGENT_ANALYSIS: { status: "pending", startedAt: null, completedAt: null },
    DIAGNOSTIC_EXECUTION: { status: "pending", startedAt: null, completedAt: null },
    REPORT_GENERATION: { status: "pending", startedAt: null, completedAt: null },
  };

  const toolCalls = new Map<string, ToolCallState>();
  // Counted tool bound (issue #57 §5): at most MAX_DIAGNOSTIC_TOOL_CALLS
  // requests may be issued per run. The invariant
  // MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1 is asserted by the
  // agent-run-bounds tests, guaranteeing a turn is always left for the
  // forced finalization call.
  let toolCallCount = 0;
  const seen = {
    runCreated: false,
    agentStarted: false,
    retrievalCompleted: false,
    toolPhaseStarted: false,
    reportGenerationStarted: false,
    reportSubmitted: false,
    reportOutcome: false,
  };
  let terminalSeen = false;
  let diagnosticExecutionEverActive = false;
  let specificFailure: {
    stage: InvestigationExecutionStage;
    code: AgentOrchestratorErrorCode;
  } | null = null;

  const activate = (stage: InvestigationExecutionStage, at: string) => {
    stages[stage].status = "active";
    stages[stage].startedAt = at;
  };
  const complete = (stage: InvestigationExecutionStage, at: string) => {
    stages[stage].status = "completed";
    if (stages[stage].startedAt === null) stages[stage].startedAt = at;
    stages[stage].completedAt = at;
  };
  const failStage = (
    stage: InvestigationExecutionStage,
    at: string,
    code: AgentOrchestratorErrorCode,
  ) => {
    if (stages[stage].startedAt === null) stages[stage].startedAt = at;
    stages[stage].status = "failed";
    stages[stage].completedAt = at;
    stages[stage].failureCode = code;
  };
  const openToolCallIds = () =>
    [...toolCalls.entries()].filter(([, call]) => call.state === "open").map(([id]) => id);
  const reportPhaseBegun = () => seen.reportGenerationStarted || seen.reportSubmitted;
  /** Closes the analysis/diagnostic stages at the moment the report phase begins. */
  const enterReportPhase = (at: string) => {
    if (stages.AGENT_ANALYSIS.status === "active") complete("AGENT_ANALYSIS", at);
    if (stages.DIAGNOSTIC_EXECUTION.status === "active") {
      complete("DIAGNOSTIC_EXECUTION", at);
    } else if (!diagnosticExecutionEverActive) {
      // Truthful, not repair: no tool was ever requested on this run, so the
      // diagnostic stage did not merely fail to finish — it never applied.
      stages.DIAGNOSTIC_EXECUTION.status = "omitted";
    }
    activate("REPORT_GENERATION", at);
  };

  for (const event of events) {
    const at = event.recordedAt;
    const type = event.payload.type;

    if (terminalSeen) {
      if (TERMINAL_TYPES.has(type)) {
        fail(
          "MULTIPLE_TERMINAL_EVENTS",
          `Event at sequence ${event.sequence} ("${type}") is a second terminal event; exactly one terminal event is allowed per run.`,
        );
      }
      fail(
        "EVENT_AFTER_TERMINAL",
        `Event at sequence ${event.sequence} ("${type}") occurs after a terminal event.`,
      );
    }

    // Once a specific failure fact exists, the only legal continuation is
    // the run-level terminal failure that confirms it.
    if (specificFailure !== null && !TERMINAL_TYPES.has(type)) {
      fail(
        "EVENT_AFTER_FAILURE",
        `Event at sequence ${event.sequence} ("${type}") follows a stage failure; only RUN_FAILED may follow a failure fact.`,
      );
    }

    switch (event.payload.type) {
      case "RUN_CREATED": {
        if (seen.runCreated) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `RUN_CREATED occurs more than once (sequence ${event.sequence}).`,
          );
        }
        if (event.sequence !== 1) {
          fail(
            "RUN_CREATED_NOT_FIRST",
            `RUN_CREATED must be the first event; found it at sequence ${event.sequence}.`,
          );
        }
        seen.runCreated = true;
        complete("INVESTIGATION_CREATED", at);
        break;
      }

      case "AGENT_STARTED": {
        if (seen.agentStarted) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `AGENT_STARTED occurs more than once (sequence ${event.sequence}).`,
          );
        }
        // Forward-only: analysis cannot begin after work that presupposes it.
        if (seen.retrievalCompleted || seen.toolPhaseStarted || reportPhaseBegun()) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `AGENT_STARTED at sequence ${event.sequence} occurs after a later phase (retrieval, tool, or report) already began; execution phases move forward only.`,
          );
        }
        seen.agentStarted = true;
        activate("AGENT_ANALYSIS", at);
        break;
      }

      case "RETRIEVAL_COMPLETED": {
        // Informational within AGENT_ANALYSIS — but only meaningful while
        // that stage is the one actually running.
        if (!seen.agentStarted) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `RETRIEVAL_COMPLETED at sequence ${event.sequence} occurs before AGENT_STARTED.`,
          );
        }
        if (seen.retrievalCompleted) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `RETRIEVAL_COMPLETED occurs more than once (sequence ${event.sequence}); v1 permits at most one.`,
          );
        }
        if (seen.toolPhaseStarted || reportPhaseBegun()) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `RETRIEVAL_COMPLETED at sequence ${event.sequence} occurs after the tool or report phase began; retrieval belongs to AGENT_ANALYSIS.`,
          );
        }
        if (stages.AGENT_ANALYSIS.status !== "active") {
          fail(
            "PHASE_ORDER_VIOLATION",
            `RETRIEVAL_COMPLETED at sequence ${event.sequence} requires AGENT_ANALYSIS to be active; it is "${stages.AGENT_ANALYSIS.status}".`,
          );
        }
        seen.retrievalCompleted = true;
        break;
      }

      case "TOOL_REQUESTED": {
        const { toolCallId, toolName } = event.payload;
        if (reportPhaseBegun()) {
          fail(
            "TOOL_REQUEST_AFTER_REPORT_PHASE",
            `TOOL_REQUESTED at sequence ${event.sequence} occurs after the report phase began.`,
          );
        }
        if (!seen.agentStarted) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `TOOL_REQUESTED at sequence ${event.sequence} occurs before AGENT_STARTED.`,
          );
        }
        // Counted tool bound (issue #57 §5). MAX_PROVIDER_TURNS reserves one
        // turn for forced finalization, so a request past the bound has no
        // turn left to be issued in.
        if (toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS) {
          fail(
            "TOOL_LIMIT_EXCEEDED",
            `The tool request at sequence ${event.sequence} exceeds the ${MAX_DIAGNOSTIC_TOOL_CALLS}-call bound for a single investigation run.`,
          );
        }
        // A repeated id is either an exact-replay duplicate (already resolved
        // to the original row at the repository layer) or a double issue
        // within the same run; the reducer rejects it as a contract
        // violation rather than attempting to distinguish the two.
        //
        // The message deliberately does not echo the raw toolCallId: that id is
        // provider-controlled, and reducer errors may reach a log (same rule as
        // every other message in this file — closed codes, sequence numbers,
        // and numeric counts only).
        if (toolCalls.has(toolCallId)) {
          fail(
            "DUPLICATE_TOOL_CALL_ID",
            `A second tool request at sequence ${event.sequence} reused a prior tool-call identity; every request in a run must carry a fresh id.`,
          );
        }
        if (openToolCallIds().length > 0) {
          fail(
            "TOOL_REQUEST_WHILE_OPEN",
            `A tool request at sequence ${event.sequence} was issued while ${openToolCallIds().length} tool call(s) are still open; the loop may not overlap calls.`,
          );
        }
        if (toolCallCount === 0) {
          // First request: analysis hands over to diagnostics.
          if (stages.AGENT_ANALYSIS.status !== "active") {
            fail(
              "PHASE_ORDER_VIOLATION",
              `The tool request at sequence ${event.sequence} requires AGENT_ANALYSIS to be active; it is "${stages.AGENT_ANALYSIS.status}".`,
            );
          }
          complete("AGENT_ANALYSIS", at);
          activate("DIAGNOSTIC_EXECUTION", at);
          diagnosticExecutionEverActive = true;
        } else if (stages.DIAGNOSTIC_EXECUTION.status !== "active") {
          // Subsequent request: the loop must still be executing diagnostics.
          fail(
            "PHASE_ORDER_VIOLATION",
            `The tool request at sequence ${event.sequence} requires DIAGNOSTIC_EXECUTION to be active; it is "${stages.DIAGNOSTIC_EXECUTION.status}".`,
          );
        }
        toolCalls.set(toolCallId, { toolName, state: "open" });
        seen.toolPhaseStarted = true;
        toolCallCount += 1;
        break;
      }

      case "TOOL_COMPLETED":
      case "TOOL_FAILED": {
        const { toolCallId, toolName } = event.payload;
        const call = toolCalls.get(toolCallId);
        if (!call) {
          fail(
            "TOOL_OUTCOME_WITHOUT_REQUEST",
            `A tool outcome had no matching request at sequence ${event.sequence}.`,
          );
        }
        if (call.state !== "open") {
          fail(
            "DUPLICATE_TOOL_OUTCOME",
            `A tool call already reached state "${call.state}" and received a second outcome at sequence ${event.sequence}.`,
          );
        }
        if (call.toolName !== toolName) {
          fail(
            "TOOL_NAME_MISMATCH",
            `A tool outcome name did not match its request at sequence ${event.sequence}.`,
          );
        }
        if (event.payload.type === "TOOL_COMPLETED") {
          call.state = "completed";
        } else {
          call.state = "failed";
          // Step 4: the failure is immediate and carries the exact tool code.
          failStage("DIAGNOSTIC_EXECUTION", at, event.payload.failureCode);
          specificFailure = {
            stage: "DIAGNOSTIC_EXECUTION",
            code: event.payload.failureCode,
          };
        }
        break;
      }

      case "REPORT_GENERATION_STARTED": {
        if (seen.reportGenerationStarted) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `REPORT_GENERATION_STARTED occurs more than once (sequence ${event.sequence}).`,
          );
        }
        if (seen.reportSubmitted) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `REPORT_GENERATION_STARTED at sequence ${event.sequence} occurs after REPORT_SUBMITTED.`,
          );
        }
        if (!seen.agentStarted) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `REPORT_GENERATION_STARTED at sequence ${event.sequence} occurs before AGENT_STARTED.`,
          );
        }
        // The orchestrator emits this only immediately before a FINALIZATION
        // provider call, and reaching the finalization turn requires that the
        // investigation turn produced a diagnostic tool call. A no-tool run
        // therefore cannot produce this event: its single turn returns the
        // report directly, and report generation begins at REPORT_SUBMITTED.
        if (!seen.toolPhaseStarted) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `REPORT_GENERATION_STARTED at sequence ${event.sequence} occurs with no preceding tool call; the finalization turn is only reached after diagnostic execution, so a no-tool run cannot emit this event.`,
          );
        }
        const open = openToolCallIds();
        if (open.length > 0) {
          fail(
            "OPEN_TOOL_CALL",
            `REPORT_GENERATION_STARTED at sequence ${event.sequence} occurs while ${open.length} tool call(s) are still open.`,
          );
        }
        seen.reportGenerationStarted = true;
        enterReportPhase(at);
        break;
      }

      case "REPORT_SUBMITTED": {
        if (seen.reportSubmitted) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `REPORT_SUBMITTED occurs more than once (sequence ${event.sequence}).`,
          );
        }
        if (!seen.agentStarted) {
          fail(
            "PHASE_ORDER_VIOLATION",
            `REPORT_SUBMITTED at sequence ${event.sequence} occurs before AGENT_STARTED.`,
          );
        }
        // An unfinished tool call is the more specific fault, so it is
        // reported ahead of the report-start fact below.
        const open = openToolCallIds();
        if (open.length > 0) {
          fail(
            "OPEN_TOOL_CALL",
            `REPORT_SUBMITTED at sequence ${event.sequence} occurs while ${open.length} tool call(s) are still open.`,
          );
        }
        // REPORT_GENERATION_STARTED is optional on a tool path ONLY while the
        // loop still has an investigation turn available (toolCallCount below
        // MAX_DIAGNOSTIC_TOOL_CALLS): a voluntary early report submitted on a
        // still-available turn needs no announcement. Once the diagnostic
        // bound is exhausted, the next provider call is necessarily the forced
        // FINALIZATION turn, and the runtime contract requires the report-start
        // fact to be recorded BEFORE that call — so a submission at the bound
        // without it is a missing lifecycle fact, not a voluntary early report.
        // (A no-tool run has toolCallCount 0, so the direct no-tool submission
        // stays valid.)
        if (
          toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS &&
          !seen.reportGenerationStarted
        ) {
          fail(
            "MISSING_LIFECYCLE_FACT",
            `REPORT_SUBMITTED at sequence ${event.sequence} without a preceding REPORT_GENERATION_STARTED after the ${MAX_DIAGNOSTIC_TOOL_CALLS}-call diagnostic bound; the forced finalization turn that returned the report must be recorded with REPORT_GENERATION_STARTED first.`,
          );
        }
        seen.reportSubmitted = true;
        // On the no-REPORT_GENERATION_STARTED path this is what opens the
        // report stage; otherwise the stage is already active.
        if (stages.REPORT_GENERATION.status === "pending") enterReportPhase(at);
        break;
      }

      case "REPORT_VALIDATED":
      case "REPORT_VALIDATION_FAILED": {
        if (!seen.reportSubmitted) {
          fail(
            "REPORT_OUTCOME_WITHOUT_SUBMISSION",
            `${event.payload.type} at sequence ${event.sequence} has no preceding REPORT_SUBMITTED.`,
          );
        }
        if (seen.reportOutcome) {
          fail(
            "DUPLICATE_LIFECYCLE_FACT",
            `A report outcome already occurred; ${event.payload.type} at sequence ${event.sequence} is a second one.`,
          );
        }
        seen.reportOutcome = true;
        if (event.payload.type === "REPORT_VALIDATED") {
          complete("REPORT_GENERATION", at);
        } else {
          failStage("REPORT_GENERATION", at, event.payload.failureCode);
          specificFailure = { stage: "REPORT_GENERATION", code: event.payload.failureCode };
        }
        break;
      }

      case "RUN_COMPLETED": {
        terminalSeen = true;

        // Step 1: strict completion. No repair of any kind.
        if (specificFailure !== null) {
          fail(
            "CONTRADICTORY_COMPLETION",
            `RUN_COMPLETED at sequence ${event.sequence} follows a "${specificFailure.stage}" failure; a failed run cannot complete successfully.`,
          );
        }
        const open = openToolCallIds();
        if (open.length > 0) {
          fail(
            "OPEN_TOOL_CALL",
            `RUN_COMPLETED at sequence ${event.sequence} occurs while ${open.length} tool call(s) are still open.`,
          );
        }
        if (!seen.agentStarted) {
          fail(
            "MISSING_LIFECYCLE_FACT",
            `RUN_COMPLETED at sequence ${event.sequence} without a preceding AGENT_STARTED.`,
          );
        }
        if (!seen.reportSubmitted) {
          fail(
            "MISSING_LIFECYCLE_FACT",
            `RUN_COMPLETED at sequence ${event.sequence} without a preceding REPORT_SUBMITTED.`,
          );
        }
        if (stages.REPORT_GENERATION.status !== "completed") {
          fail(
            "MISSING_LIFECYCLE_FACT",
            `RUN_COMPLETED at sequence ${event.sequence} without a preceding REPORT_VALIDATED; the report stage is "${stages.REPORT_GENERATION.status}".`,
          );
        }
        // Final invariant: every stage must already be resolved truthfully
        // by its own events. Nothing is closed or omitted here.
        for (const stage of INVESTIGATION_EXECUTION_STAGE_ORDER) {
          const status = stages[stage].status;
          const resolved =
            status === "completed" || (stage === "DIAGNOSTIC_EXECUTION" && status === "omitted");
          if (!resolved) {
            fail(
              "MISSING_LIFECYCLE_FACT",
              `RUN_COMPLETED at sequence ${event.sequence} leaves stage "${stage}" in status "${status}"; a completed run resolves every stage through its own events.`,
            );
          }
        }
        break;
      }

      case "RUN_FAILED": {
        terminalSeen = true;
        const { failedStage, failureCode } = event.payload;

        const open = openToolCallIds();
        if (open.length > 0) {
          fail(
            "OPEN_TOOL_CALL",
            `RUN_FAILED at sequence ${event.sequence} occurs while ${open.length} tool call(s) are still open.`,
          );
        }

        // Finding 3, narrowed by #57 §7. Once every requested tool closed
        // successfully and no TOOL_FAILED occurred, the loop's next act is
        // the FINALIZATION provider call — either a voluntary early report
        // (submitted directly on a still-available turn, so no report-start)
        // or, once the diagnostic bound is exhausted, the forced finalization
        // turn (which MUST be announced with REPORT_GENERATION_STARTED). A
        // provider/protocol failure attributed to REPORT_GENERATION must
        // therefore still be preceded by REPORT_GENERATION_STARTED, so it is
        // not misattributed to a report stage that never announced itself. A
        // failure attributed to DIAGNOSTIC_EXECUTION is governed instead by
        // assertFailureCodeCompatibleWithContext below, which admits
        // provider/protocol codes there only while the loop is genuinely
        // active — and, since a voluntary early report carries no report-start,
        // only a RUN_FAILED naming REPORT_GENERATION is constrained by this
        // check.
        if (
          seen.toolPhaseStarted &&
          specificFailure === null &&
          !seen.reportGenerationStarted &&
          failedStage === "REPORT_GENERATION"
        ) {
          fail(
            "MISSING_LIFECYCLE_FACT",
            `RUN_FAILED at sequence ${event.sequence} attributes the failure to REPORT_GENERATION but no REPORT_GENERATION_STARTED was recorded; the finalization call that failed must be recorded before attributing the failure.`,
          );
        }

        let preAgentException = false;

        if (specificFailure !== null) {
          // A run-level failure may only confirm the specific one.
          if (
            failedStage !== specificFailure.stage ||
            failureCode !== specificFailure.code
          ) {
            fail(
              "FAILURE_FACT_MISMATCH",
              `RUN_FAILED at sequence ${event.sequence} claims stage "${failedStage}" / code "${failureCode}", contradicting the earlier specific failure on stage "${specificFailure.stage}" / code "${specificFailure.code}".`,
            );
          }
          // The stage failure itself was already recorded by the specific,
          // more precise fact — its timestamp and code are kept.
        } else {
          // No specific failure yet: the run-level failure establishes it.
          // It must name the stage that was ACTUALLY RUNNING — naming a
          // future stage that never started would invent a phase the run
          // never reached.
          const activeStage = INVESTIGATION_EXECUTION_STAGE_ORDER.find(
            (stage) => stages[stage].status === "active",
          );

          if (activeStage !== undefined) {
            if (failedStage !== activeStage) {
              fail(
                "FAILED_STAGE_NOT_TRUTHFUL",
                `RUN_FAILED at sequence ${event.sequence} names stage "${failedStage}", but the currently active stage is "${activeStage}"; a run fails in the stage it was executing.`,
              );
            }
          } else {
            // No stage is active. The single permitted case is a failure
            // after the run row was created but before AGENT_STARTED — the
            // stream is exactly [RUN_CREATED], and the run died on its way
            // into analysis. Any other shape names a stage that never ran.
            const preAgentOnly =
              events.length === 2 && seen.runCreated && !seen.agentStarted;
            if (!preAgentOnly || failedStage !== "AGENT_ANALYSIS") {
              fail(
                "FAILED_STAGE_NOT_TRUTHFUL",
                `RUN_FAILED at sequence ${event.sequence} names stage "${failedStage}" while no stage is active; only a pre-agent failure (RUN_CREATED followed directly by RUN_FAILED) may name AGENT_ANALYSIS.`,
              );
            }
            preAgentException = true;
          }
        }

        // #57 §7: a diagnostic loop is genuinely mid-flight only when at
        // least one request was issued, the bound is NOT yet exhausted (at the
        // exact bound the next provider call is forced finalization, so a
        // provider failure there belongs to REPORT_GENERATION, not to the
        // loop), no call is still open, no tool-specific failure already
        // occurred, and the report phase has not begun. Only then may a
        // provider/protocol code name DIAGNOSTIC_EXECUTION.
        const diagnosticLoopActive =
          toolCallCount > 0 &&
          toolCallCount < MAX_DIAGNOSTIC_TOOL_CALLS &&
          openToolCallIds().length === 0 &&
          specificFailure === null &&
          !reportPhaseBegun();

        // Causal compatibility of the code with the stage it is attributed
        // to, applied to both branches: confirming a specific fact does not
        // exempt the pair from being possible in the first place.
        assertFailureCodeCompatibleWithContext({
          failureCode,
          failedStage,
          specificFailure,
          preAgentException,
          reportSubmitted: seen.reportSubmitted,
          sequence: event.sequence,
          diagnosticLoopActive,
        });

        if (specificFailure === null) {
          failStage(failedStage, at, failureCode);
        }

        // Either way, stages after the failed one never ran and never will.
        // Marking them omitted is a truthful statement about a terminated
        // run, not a repair of a missing fact.
        for (
          let i = INVESTIGATION_EXECUTION_STAGE_ORDER.indexOf(failedStage) + 1;
          i < INVESTIGATION_EXECUTION_STAGE_ORDER.length;
          i++
        ) {
          const later = INVESTIGATION_EXECUTION_STAGE_ORDER[i]!;
          if (stages[later].status === "pending") stages[later].status = "omitted";
        }
        break;
      }

      case "REPORT_GENERATED": {
        // Legacy read-compat type. It is valid in a historical trace, but a
        // canonical stream (one that began with RUN_CREATED) must use
        // REPORT_VALIDATED — accepting both here would give one persisted
        // type two meanings inside the same contract.
        fail(
          "LEGACY_EVENT_IN_CANONICAL_STREAM",
          `Legacy REPORT_GENERATED at sequence ${event.sequence} is not writable in a canonical stream; canonical streams record REPORT_VALIDATED.`,
        );
      }
    }
  }

  // ── runStatus agreement, checked last (see the note above) ─────────────
  if (events.length > 0) {
    const lastType = events[events.length - 1]!.payload.type;
    if (runStatus === "RUNNING" && terminalSeen) {
      fail("RUN_STATUS_MISMATCH", `runStatus is "RUNNING" but the stream contains a terminal event.`);
    }
    if (runStatus === "COMPLETED" && lastType !== "RUN_COMPLETED") {
      fail(
        "RUN_STATUS_MISMATCH",
        `runStatus is "COMPLETED" but the stream's last event is "${lastType}".`,
      );
    }
    if (runStatus === "FAILED" && lastType !== "RUN_FAILED") {
      fail(
        "RUN_STATUS_MISMATCH",
        `runStatus is "FAILED" but the stream's last event is "${lastType}".`,
      );
    }
  }

  // ── Terminal-output invariant ──────────────────────────────────────────
  //
  // A terminal run has, by definition, stopped executing: nothing can still
  // be in progress and nothing can still be waiting to start. Every stage
  // must have reached completed, failed, or omitted through its own events.
  // A RUNNING run is legitimately partial and is exempt.
  if (terminalSeen) {
    for (const key of INVESTIGATION_EXECUTION_STAGE_ORDER) {
      const status = stages[key].status;
      if (status === "active" || status === "pending") {
        fail(
          "UNRESOLVED_TERMINAL_STAGE",
          `Terminal run leaves stage "${key}" in status "${status}"; a terminal result contains no active or pending stages.`,
        );
      }
    }
  }

  const progress = INVESTIGATION_EXECUTION_STAGE_ORDER.map((key): ExecutionStageProgress => {
    const stage = stages[key];

    if (stage.status === "pending" || stage.status === "omitted") {
      return { key, status: stage.status, startedAt: null, completedAt: null, elapsedMs: null };
    }

    const startedAt = stage.startedAt!;
    if (stage.status === "active") {
      // Clock skew is clamped to zero rather than reported negative: a
      // caller-supplied `now` earlier than a recorded timestamp is a clock
      // artifact, and a negative duration is never a truthful reading.
      return {
        key,
        status: "active",
        startedAt,
        completedAt: null,
        elapsedMs: Math.max(0, nowMs - Date.parse(startedAt)),
      };
    }

    const completedAt = stage.completedAt!;
    const elapsedMs = Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
    return stage.status === "failed"
      ? { key, status: "failed", startedAt, completedAt, elapsedMs, failureCode: stage.failureCode }
      : { key, status: "completed", startedAt, completedAt, elapsedMs };
  });

  // ── Step 6: the reducer validates its own output ───────────────────────
  const validated = ExecutionStageProgressListSchema.safeParse(progress);
  if (!validated.success) {
    fail(
      "INVALID_PROGRESS_OUTPUT",
      "Derived stage progress violates ExecutionStageProgressSchema; this is a reducer defect, not a caller error.",
      { cause: validated.error },
    );
  }

  return progress;
}
