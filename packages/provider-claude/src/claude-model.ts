/**
 * The single source of truth for which Claude model this milestone supports.
 *
 * It lives in the provider layer, not in packages/agent-runtime: the neutral
 * runtime ships inside the API production image and must stay vendor-agnostic,
 * so it parameterizes the live model type rather than naming one.
 *
 * Every path that can construct a ClaudeLlmProvider — the configuration-selected
 * factory and both historical spike runners — validates through this module, so
 * there is no route by which an unvalidated model reaches a request.
 */
export const SUPPORTED_CLAUDE_MODEL = "claude-sonnet-5" as const;

export type SupportedClaudeModel = typeof SUPPORTED_CLAUDE_MODEL;

/**
 * Why exactly one model, rather than an open string:
 *
 * The adapter sends `thinking: { type: "disabled" }` on every request, because
 * this model's default adaptive thinking is incompatible with the forced
 * `tool_choice` the FINALIZATION turn requires, and the provider-neutral
 * conversation shape carries no thinking blocks to replay. Other Claude models
 * differ materially here — thinking cannot be disabled at all on some, and is
 * effort-gated on others — so that request policy is valid *by construction*
 * only while the model is pinned. Supporting another model means a
 * capability-aware request policy and its own tests, not a wider type.
 */
export const UNSUPPORTED_CLAUDE_MODEL_MESSAGE =
  `ANTHROPIC_MODEL must be '${SUPPORTED_CLAUDE_MODEL}'; no other model is supported in this milestone.`;

export function isSupportedClaudeModel(model: string): model is SupportedClaudeModel {
  return model === SUPPORTED_CLAUDE_MODEL;
}

export class UnsupportedClaudeModelError extends Error {
  constructor() {
    // Names the variable and the one accepted value; never echoes the rejected
    // input, which could carry whatever a caller happened to export.
    super(UNSUPPORTED_CLAUDE_MODEL_MESSAGE);
    this.name = "UnsupportedClaudeModelError";
  }
}

/**
 * Narrows an untrusted environment value to the supported model, or throws.
 * Used by the historical spike runners, which have their own env contract and
 * do not go through parseProviderConfig.
 */
export function requireSupportedClaudeModel(model: string | undefined): SupportedClaudeModel {
  const trimmed = model?.trim();
  if (trimmed === undefined || !isSupportedClaudeModel(trimmed)) {
    throw new UnsupportedClaudeModelError();
  }
  return trimmed;
}
