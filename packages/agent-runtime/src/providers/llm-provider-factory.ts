import type { LlmProvider } from "./llm-provider";

/**
 * Provider selection, parameterized by the live model type.
 *
 * The type parameter is what keeps this module **vendor-agnostic**: the neutral
 * runtime knows a live selection carries *some* model identifier, but never
 * which models exist. Naming a concrete model here would put Anthropic
 * knowledge into the package that ships inside the API production image, and
 * would have to change every time a provider is added or a model retired.
 *
 * The provider layer narrows it — see SupportedClaudeModel in
 * apps/worker/src/providers/claude-model.ts.
 *
 * A discriminated union rather than `{ providerMode, modelIdentifier? }`, so
 * the invalid combinations are unrepresentable: a LIVE selection cannot omit
 * its model, and a FAKE selection cannot smuggle a live model in.
 *
 * Deliberately NOT parameterized by AgentJobRecord (or any @opspilot/database
 * type). The provider abstraction only needs to know *which provider to
 * build*, never the ticket being investigated — and keeping database types out
 * of it is what lets a vendor adapter move into its own package without
 * dragging Prisma into every consumer. Callers that hold a database row
 * convert it to a selection at their own boundary.
 */
export type LlmProviderSelection<TLiveModel extends string = string> =
  | {
      readonly providerMode: "FAKE";
      readonly modelIdentifier?: null;
    }
  | {
      readonly providerMode: "LIVE";
      readonly modelIdentifier: TLiveModel;
    };

export interface LlmProviderFactory<TLiveModel extends string = string> {
  createProvider(selection: LlmProviderSelection<TLiveModel>): LlmProvider;
}
