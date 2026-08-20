import type Anthropic from "@anthropic-ai/sdk";
import { normalizeDiagnosticToolRequests } from "@opspilot/agent-runtime";
import type { RawProviderTurnContext } from "@opspilot/agent-runtime";
import type { AgentTurnResult, DiagnosticToolRequest } from "@opspilot/contracts";

import { SUBMIT_RESOLUTION_REPORT_TOOL_NAME } from "./claude-tool-schemas";


function isToolUseBlock(block: Anthropic.ContentBlock): block is Anthropic.ToolUseBlock {
  return block.type === "tool_use";
}

// Issue #58 Checkpoint B (§6): the diagnostic tool_use input arrives as a
// STRUCTURAL wrapper { evidenceAssessment: <unknown>, toolInput: <unknown> }
// (see claude-tool-schemas.ts §5). This splits it and nothing more: both
// values are extracted unvalidated, mirroring how rawInput on
// report_submission is passed through. Authoritative EvidenceAssessmentSchema
// validation happens exactly once, in the orchestrator, uniformly for live and
// fake providers. If the wrapper is structurally malformed — not an object, or
// missing either key — the block is rejected as PROVIDER_PROTOCOL_INVALID
// WITHOUT echoing provider-controlled content, and the pre-#58 flat diagnostic
// shape (bare tool input) is rejected here too rather than accepted as a
// backdoor.
function tryToDiagnosticToolRequest(
  block: Anthropic.ToolUseBlock,
): { ok: true; request: DiagnosticToolRequest } | { ok: false } {
  const wrapper = block.input;
  if (wrapper === null || typeof wrapper !== "object" || Array.isArray(wrapper)) {
    return { ok: false };
  }

  const record = wrapper as Record<string, unknown>;
  if (!("evidenceAssessment" in record) || !("toolInput" in record)) {
    return { ok: false };
  }

  return {
    ok: true,
    request: {
      toolCallId: block.id,
      toolName: block.name,
      input: record.toolInput,
      rawAssessment: record.evidenceAssessment,
    },
  };
}

/**
 * The ONE compatibility repair applied to a submitted report, and deliberately
 * the narrowest that can exist: a MISSING `suggestedActions` becomes `[]`.
 *
 * Justified because omission and "no suggested actions" are the same claim —
 * `[]` is the only value a well-formed report with nothing to suggest could
 * carry, so supplying it invents no content the model did not assert. This is
 * not a hypothetical: a protected LIVE run completed its investigation and
 * then failed REPORT_SCHEMA_INVALID on exactly this, even though the field is
 * listed in the `required` array of the strict tool schema Claude was given
 * (claude-tool-schemas.ts) and `strict: true` was set on the tool. A required
 * field in a tool schema is not a guarantee the tool call carries it, so the
 * contract is enforced in depth: schema, prompt (claude-message-mapping.ts),
 * and this boundary — see docs/10-engineering-challenges.md.
 *
 * Everything else is left EXACTLY as received, so ResolutionReportSchema stays
 * the sole authority on validity:
 *   - `null`, a string, an object, a malformed array -> untouched, still fails
 *   - any other missing or invalid report field      -> untouched, still fails
 * so a genuinely invalid report still produces a REPORT_SCHEMA_INVALID
 * diagnostic pointing at the real problem, never at a value invented here.
 *
 * Lives at the provider/tool-input boundary rather than in the orchestrator,
 * persistence, or UI: it is a repair for how one provider fills one tool
 * schema, and the canonical domain contract must not learn about it.
 */
function normalizeSubmittedReportInput(rawInput: unknown): unknown {
  if (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return rawInput;
  }

  const report = rawInput as Record<string, unknown>;
  // `undefined` is the ONLY trigger. It covers both an absent key and an
  // explicitly-undefined one, and deliberately excludes `null` — that is a
  // value the model did assert, and it must still be rejected.
  if (report.suggestedActions !== undefined) return rawInput;

  return { ...report, suggestedActions: [] };
}

function protocolError(
  context: RawProviderTurnContext,
  message: string,
): AgentTurnResult {
  return {
    type: "protocol_error",
    providerRequestId: context.providerRequestId,
    usage: context.usage,
    code: "PROVIDER_PROTOCOL_INVALID",
    message,
  };
}

function outputTruncatedError(context: RawProviderTurnContext): AgentTurnResult {
  return {
    type: "protocol_error",
    providerRequestId: context.providerRequestId,
    usage: context.usage,
    code: "PROVIDER_OUTPUT_TRUNCATED",
    message: "The provider reached the configured output limit before completing its response.",
  };
}

// This handles only the response-content decision tree, and only ever runs
// on a response the SDK call already returned successfully — SDK/transport
// failures (auth, rate limit, connection, timeout, server errors) never
// reach this function; they're thrown as LlmProviderError by the adapter
// before a Message ever exists to normalize.
export function normalizeClaudeMessage(
  message: Anthropic.Message,
  context: RawProviderTurnContext,
): AgentTurnResult {
  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category;
    return protocolError(
      context,
      `Claude refused to respond${category ? ` (category: ${category})` : ""}.`,
    );
  }

  // Checked before the content decision tree below, and deliberately not
  // scoped to the finalization turn: a truncated investigation turn is
  // equally misclassified without this. Without this check, a truncated
  // response falls through into the content tree and is silently
  // reinterpreted as whatever partial content happens to be present — a
  // partially-filled submit_resolution_report tool_use block becomes
  // report_submission, which ResolutionReportSchema truthfully rejects for
  // its missing trailing fields but as REPORT_SCHEMA_INVALID, naming a model
  // contract defect that never happened instead of a harness budgeting
  // mistake. Returning here means REPORT_SUBMITTED is never emitted and the
  // partial report is never persisted.
  if (message.stop_reason === "max_tokens") {
    return outputTruncatedError(context);
  }

  const toolUseBlocks = message.content.filter(isToolUseBlock);
  const reportBlocks = toolUseBlocks.filter(
    (block) => block.name === SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  );
  const diagnosticBlocks = toolUseBlocks.filter(
    (block) => block.name !== SUBMIT_RESOLUTION_REPORT_TOOL_NAME,
  );

  if (reportBlocks.length > 0 && diagnosticBlocks.length > 0) {
    return protocolError(
      context,
      `Provider returned both a submit_resolution_report call and ${diagnosticBlocks.length} diagnostic tool call(s) in one turn; exactly one kind is supported per turn.`,
    );
  }

  if (reportBlocks.length >= 2) {
    return protocolError(
      context,
      `Provider returned ${reportBlocks.length} submit_resolution_report calls in one turn; at most one is supported.`,
    );
  }

  const [reportBlock] = reportBlocks;
  if (reportBlocks.length === 1 && reportBlock) {
    return {
      type: "report_submission",
      providerRequestId: context.providerRequestId,
      usage: context.usage,
      rawInput: normalizeSubmittedReportInput(reportBlock.input),
    };
  }

  // Structural split (§6) runs on EVERY diagnostic block before the
  // one-request-per-turn count check, so a malformed wrapper never slips
  // through as an accepted request. 0, or >=2, diagnostic tool calls (with 0
  // report calls) both collapse to protocol_error inside this shared,
  // unmodified helper — see docs/04-agent-design.md §10 and llm-provider.ts.
  const diagnosticRequests: DiagnosticToolRequest[] = [];
  for (const block of diagnosticBlocks) {
    const split = tryToDiagnosticToolRequest(block);
    if (!split.ok) {
      return protocolError(
        context,
        "A diagnostic tool call carried a malformed evidence-assessment wrapper.",
      );
    }
    diagnosticRequests.push(split.request);
  }

  return normalizeDiagnosticToolRequests(diagnosticRequests, context);
}
