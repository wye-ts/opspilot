import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { AgentConversationMessage, StoredRunbookChunk } from "@opspilot/agent-runtime";
import type { InvestigationEventPayload } from "@opspilot/contracts";

import { InMemoryKeywordRunbookRetriever } from "../rag";
import { resolveCorpus } from "./dataset-validation";
import { alwaysFailsTool } from "./fixtures/always-fails-tool";
import { buildObservedFacts } from "./observed-facts";
import { createRecordingProvider, type RecordedProviderTurn } from "./recording-provider";
import { createRecordingToolRegistry, type RecordedToolExecution } from "./recording-tool-registry";
import { EVALUATION_TOP_K, type EvaluationCase, type ToolProfile } from "./types";
import { buildEvaluationCaseInputV2, type EvaluationCaseInputV2 } from "./v2-types";

const { runAgentOrchestrator, FakeLlmProvider, getServiceStatusTool } = opspilotAgentRuntime;

function resolveTools(profile: ToolProfile) {
  switch (profile) {
    case "default":
      return [getServiceStatusTool];
    case "with-always-fails-tool":
      return [getServiceStatusTool, alwaysFailsTool];
  }
}

// Executes one case and normalizes its outcome — this, buildObservedFacts,
// and nothing else in the package touches AgentOrchestratorResult. The
// runner never scores; it only ever produces normalized input for a scorer
// to consume later (see the OpsPilot #61 Phase 1 HQ targeted corrections,
// correction 1 and correction 5).
//
// OpsPilot #59 Checkpoint A §4 adds two additive observation channels to the
// same run: the orchestrator's existing optional emitLifecycleEvent is wired
// to a per-case in-order collector (canonical payloads, never a parallel
// event model), and the provider is wrapped by the recording provider so
// every turn's index/phase/usage is observed. Both stay evaluation-local —
// production orchestrator/provider behavior is unchanged.
async function runOneCase(
  evaluationCase: EvaluationCase,
  defaultCorpus: readonly StoredRunbookChunk[],
  injectionProbeChunk: StoredRunbookChunk,
): Promise<EvaluationCaseInputV2> {
  // Fresh, per-case construction of every stateful collaborator — nothing is
  // reused across cases except the read-only default corpus array itself
  // (see docs/07-evaluation-plan.md).
  const effectiveCorpus = resolveCorpus(evaluationCase.corpusProfile, defaultCorpus, injectionProbeChunk);
  const retriever = new InMemoryKeywordRunbookRetriever(effectiveCorpus);
  const recorder: RecordedToolExecution[] = [];
  const toolRegistry = createRecordingToolRegistry(resolveTools(evaluationCase.toolProfile), recorder);
  const provider = new FakeLlmProvider(evaluationCase.scenario);
  const lifecycleEvents: InvestigationEventPayload[] = [];
  const providerTurns: RecordedProviderTurn[] = [];
  const recordingProvider = createRecordingProvider(provider, providerTurns);

  const ticketContext: AgentConversationMessage = {
    role: "ticket_context",
    ticketId: evaluationCase.ticketContext.ticketId,
    summary: evaluationCase.ticketContext.summary,
  };

  const agentResult = await runAgentOrchestrator({
    provider: recordingProvider,
    toolRegistry,
    initialConversation: [ticketContext],
    retriever,
    retrievalInput: { query: evaluationCase.retrievalQuery, topK: EVALUATION_TOP_K },
    emitLifecycleEvent: async (payload) => {
      lifecycleEvents.push(payload);
    },
  });

  const observed = buildObservedFacts(agentResult, recorder, lifecycleEvents, providerTurns);
  return buildEvaluationCaseInputV2(evaluationCase.id, evaluationCase.expectations, observed);
}

// Executes every case and returns normalized inputs, in supplied order —
// never sorted or parallelized, so output order always matches input order
// (see docs/07-evaluation-plan.md). Scoring is not this function's
// responsibility: the composition root (run-eval.ts) wraps these into an
// EvaluationSuiteInputV2 and hands it to an EvaluationScorer.
export async function runEvaluationSuite(input: {
  readonly cases: readonly EvaluationCase[];
  readonly defaultCorpus: readonly StoredRunbookChunk[];
  readonly injectionProbeChunk: StoredRunbookChunk;
}): Promise<readonly EvaluationCaseInputV2[]> {
  const { cases, defaultCorpus, injectionProbeChunk } = input;
  const results: EvaluationCaseInputV2[] = [];

  for (const evaluationCase of cases) {
    results.push(await runOneCase(evaluationCase, defaultCorpus, injectionProbeChunk));
  }

  return results;
}
