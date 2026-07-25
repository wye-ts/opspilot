import opspilotAgentRuntime from "@opspilot/agent-runtime";

export const {
  RetrieverError,
  validateRetrievalInput,
  validateRetrievedChunks,
  formatRagContext,
  INJECTION_PROBE_CHUNK,
} = opspilotAgentRuntime;

export type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RetrieverErrorCategory,
  RunbookRetriever,
  StoredRunbookChunk,
  RagContextEntry,
} from "@opspilot/agent-runtime";

export { validateStoredRunbookChunks } from "./runbook-corpus-validation";
export {
  MarkdownRunbookCorpusLoader,
  RunbookLoadError,
  type MarkdownRunbookCorpusLoaderOptions,
  type RunbookCorpusLoader,
  type RunbookCorpusLoadResult,
  type RunbookLoadErrorCategory,
} from "./markdown-runbook-loader";
export { loadDefaultRunbookCorpus, resolveDefaultRunbooksDir } from "./load-default-runbook-corpus";
export { InMemoryKeywordRunbookRetriever } from "./in-memory-runbook-retriever";
export { type VoyageEmbeddingClient } from "./voyage-embedding-client";
export { VoyageRunbookRetriever } from "./voyage-runbook-retriever";
