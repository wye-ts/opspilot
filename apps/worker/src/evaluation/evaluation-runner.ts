import { runAgentOrchestrator } from "../agent/agent-orchestrator";
import { FakeLlmProvider } from "../providers/fake-llm-provider";
import type { AgentConversationMessage } from "../providers/llm-provider";
import { InMemoryKeywordRunbookRetriever } from "../rag/in-memory-runbook-retriever";
import type { StoredRunbookChunk } from "../rag/runbook-retriever";
import { getServiceStatusTool } from "../tools/get-service-status";
import { resolveCorpus } from "./dataset-validation";
import { evaluateCase } from "./evaluation-evaluator";
import { alwaysFailsTool } from "./fixtures/always-fails-tool";
import { createRecordingToolRegistry, type RecordedToolExecution } from "./recording-tool-registry";
import { EVALUATION_TOP_K, type EvaluationCase, type EvaluationCaseResult, type ToolProfile } from "./types";

function resolveTools(profile: ToolProfile) {
  switch (profile) {
    case "default":
      return [getServiceStatusTool];
    case "with-always-fails-tool":
      return [getServiceStatusTool, alwaysFailsTool];
  }
}

async function runOneCase(
  evaluationCase: EvaluationCase,
  defaultCorpus: readonly StoredRunbookChunk[],
  injectionProbeChunk: StoredRunbookChunk,
): Promise<EvaluationCaseResult> {
  // Fresh, per-case construction of every stateful collaborator — nothing is
  // reused across cases except the read-only default corpus array itself
  // (see docs/07-evaluation-plan.md).
  const effectiveCorpus = resolveCorpus(evaluationCase.corpusProfile, defaultCorpus, injectionProbeChunk);
  const retriever = new InMemoryKeywordRunbookRetriever(effectiveCorpus);
  const recorder: RecordedToolExecution[] = [];
  const toolRegistry = createRecordingToolRegistry(resolveTools(evaluationCase.toolProfile), recorder);
  const provider = new FakeLlmProvider(evaluationCase.scenario);

  const ticketContext: AgentConversationMessage = {
    role: "ticket_context",
    ticketId: evaluationCase.ticketContext.ticketId,
    summary: evaluationCase.ticketContext.summary,
  };

  const agentResult = await runAgentOrchestrator({
    provider,
    toolRegistry,
    initialConversation: [ticketContext],
    retriever,
    retrievalInput: { query: evaluationCase.retrievalQuery, topK: EVALUATION_TOP_K },
  });

  return evaluateCase(evaluationCase, agentResult, recorder);
}

export async function runEvaluationSuite(input: {
  readonly cases: readonly EvaluationCase[];
  readonly defaultCorpus: readonly StoredRunbookChunk[];
  readonly injectionProbeChunk: StoredRunbookChunk;
}): Promise<readonly EvaluationCaseResult[]> {
  const { cases, defaultCorpus, injectionProbeChunk } = input;
  const results: EvaluationCaseResult[] = [];

  // Sequential, in supplied order — never sorted or parallelized, so output
  // order always matches input order (see docs/07-evaluation-plan.md).
  for (const evaluationCase of cases) {
    results.push(await runOneCase(evaluationCase, defaultCorpus, injectionProbeChunk));
  }

  return results;
}
