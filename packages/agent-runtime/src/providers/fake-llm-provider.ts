import type {
  AgentTurnResult,
  DiagnosticToolRequest,
  TokenUsage,
} from "@opspilot/contracts";

import {
  normalizeDiagnosticToolRequests,
  type AgentTurnInput,
  type LlmProvider,
} from "./llm-provider";

// A scripted turn models what the (fake) provider would have returned
// before normalization, so scenarios can exercise normalization behavior
// (docs/04-agent-design.md §10) such as multiple diagnostic tool requests
// collapsing into a protocol_error.
export type FakeProviderTurn =
  | {
      readonly kind: "diagnostic_tool_requests";
      readonly usage: TokenUsage;
      readonly requests: readonly DiagnosticToolRequest[];
    }
  | {
      readonly kind: "report_submission";
      readonly usage: TokenUsage;
      readonly rawInput: unknown;
    };

// Issue #58 Checkpoint B (§12): a turn may also be a DETERMINISTIC PURE
// FUNCTION of the supplied AgentTurnInput, returning the same turn literal
// form. This lets a scenario react to what the run actually looked like at
// that point — e.g. the model-visible prior tool result or the remaining
// diagnostic budget — instead of a hardcoded fixed sequence, while staying
// fully deterministic: the function must depend only on `input` (no clock,
// network, randomness, or module-global mutable state). The literal turn form
// remains backward compatible; scenario fixtures written as plain turns are
// unchanged.
export type FakeProviderTurnResolver = (
  input: AgentTurnInput,
) => FakeProviderTurn;

export interface FakeAgentScenario {
  readonly id: string;
  readonly turns: readonly (FakeProviderTurn | FakeProviderTurnResolver)[];
}

export class FakeScenarioTurnNotFoundError extends Error {
  constructor(scenarioId: string, turnIndex: number) {
    super(`Scenario "${scenarioId}" has no scripted turn ${turnIndex}.`);
    this.name = "FakeScenarioTurnNotFoundError";
  }
}

export class FakeLlmProvider implements LlmProvider {
  constructor(private readonly scenario: FakeAgentScenario) {}

  async runAgentTurn(input: AgentTurnInput): Promise<AgentTurnResult> {
    const scriptedEntry = this.scenario.turns[input.turnIndex];

    if (!scriptedEntry) {
      throw new FakeScenarioTurnNotFoundError(
        this.scenario.id,
        input.turnIndex,
      );
    }

    // §12: resolve a function-form turn against the actual turn input. The
    // resolver is deterministic (depends only on `input`), so the resolved
    // turn is fully predictable for a given run history — this never
    // introduces clock/network/randomness.
    const scriptedTurn =
      typeof scriptedEntry === "function" ? scriptedEntry(input) : scriptedEntry;

    const context = {
      providerRequestId: `${this.scenario.id}:${input.turnIndex}`,
      usage: scriptedTurn.usage,
    };

    if (scriptedTurn.kind === "diagnostic_tool_requests") {
      return normalizeDiagnosticToolRequests(scriptedTurn.requests, context);
    }

    return {
      type: "report_submission",
      providerRequestId: context.providerRequestId,
      usage: context.usage,
      rawInput: scriptedTurn.rawInput,
    };
  }
}
