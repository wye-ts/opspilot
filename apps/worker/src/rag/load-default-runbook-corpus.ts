import path from "node:path";
import { fileURLToPath } from "node:url";

import { MarkdownRunbookCorpusLoader, type RunbookCorpusLoadResult } from "./markdown-runbook-loader";

// apps/worker/src/rag/ -> apps/worker/src -> apps/worker -> apps -> repo root.
export function resolveDefaultRunbooksDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../runbooks");
}

export async function loadDefaultRunbookCorpus(): Promise<RunbookCorpusLoadResult> {
  const loader = new MarkdownRunbookCorpusLoader({ runbooksDir: resolveDefaultRunbooksDir() });
  return loader.load();
}
