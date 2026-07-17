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

export interface FakeAgentScenario {
  readonly id: string;
  readonly turns: readonly FakeProviderTurn[];
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
    const scriptedTurn = this.scenario.turns[input.turnIndex];

    if (!scriptedTurn) {
      throw new FakeScenarioTurnNotFoundError(
        this.scenario.id,
        input.turnIndex,
      );
    }

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
