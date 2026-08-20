import type { AgentTurnInput, AgentTurnPhase, LlmProvider } from "@opspilot/agent-runtime";
import type { TokenUsage } from "@opspilot/contracts";

// One recorded provider call: the orchestrator-assigned turn index, the
// phase of that turn, and the turn's reported token usage. The index/phase
// come from the input the orchestrator supplied; the usage comes from the
// turn result (see AgentTurnResult). A turn that reports no usage (the
// protocol_error variant's `usage` is optional) is recorded as the
// deterministic zero usage below, so provider call count and token sums stay
// well-defined for every run.
export interface RecordedProviderTurn {
  readonly turnIndex: number;
  readonly phase: AgentTurnPhase;
  readonly usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

// Evaluation-local provider decorator (OpsPilot #59 Checkpoint A §4.2):
// wraps runAgentTurn so each provider call is observed deterministically —
// turn index, phase, and usage — without altering provider production
// semantics at all. It delegates fully, awaits the real call, appends the
// observation, and returns the real result untouched. buildObservedFacts
// consumes the recorder to derive provider call count and token totals.
//
// providerTurnsUsed / usage.providerCalls count provider INVOCATION ATTEMPTS,
// not successes: a call that throws is still an attempt the orchestrator made,
// so the turn is recorded BEFORE delegating. Token totals stay conservative —
// an attempt starts at zero usage, and only a successful return folds in the
// provider-reported usage — so a thrown request is never assigned fabricated
// tokens. This keeps the observation truthful for the future bounds/time/cost
// metric (OpsPilot #59 Checkpoint A follow-up).
export function createRecordingProvider(
  provider: LlmProvider,
  recorder: RecordedProviderTurn[],
): LlmProvider {
  return {
    async runAgentTurn(input: AgentTurnInput) {
      // Recorded before delegating so an attempt that then throws is still
      // counted. The mutable local keeps capture-before-delegate ordering
      // while the recorder's readonly RecordedProviderTurn view is preserved:
      // the object pushed first (zero usage) is the same object updated in
      // place on success. A throw propagates unchanged, leaving the zero-usage
      // attempt recorded — never swallowed, remapped, wrapped, retried, or
      // re-invoked.
      const record: { turnIndex: number; phase: AgentTurnPhase; usage: TokenUsage } = {
        turnIndex: input.turnIndex,
        phase: input.phase,
        usage: ZERO_USAGE,
      };
      recorder.push(record);

      const result = await provider.runAgentTurn(input);

      // Success: fold the provider-reported usage into the already-counted
      // attempt. A returned turn without usage (protocol_error) stays zero.
      record.usage = result.usage ?? ZERO_USAGE;
      return result;
    },
  };
}
