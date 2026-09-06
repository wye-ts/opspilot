import opspilotAgentRuntime from "@opspilot/agent-runtime";

export const {
  RetrieverError,
  validateRetrievalInput,
  validateRetrievedChunks,
  formatRagContext,
  INJECTION_PROBE_CHUNK,
  InMemoryKeywordRunbookRetriever,
  MarkdownRunbookCorpusLoader,
  RunbookLoadError,
  loadDefaultRunbookCorpus,
  resolveDefaultRunbooksDir,
  validateStoredRunbookChunks,
} = opspilotAgentRuntime;

export type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RetrieverErrorCategory,
  RunbookRetriever,
  StoredRunbookChunk,
  RagContextEntry,
  MarkdownRunbookCorpusLoaderOptions,
  RunbookCorpusLoader,
  RunbookCorpusLoadResult,
  RunbookLoadErrorCategory,
} from "@opspilot/agent-runtime";

export { type VoyageEmbeddingClient } from "./voyage-embedding-client";
export { VoyageRunbookRetriever } from "./voyage-runbook-retriever";
