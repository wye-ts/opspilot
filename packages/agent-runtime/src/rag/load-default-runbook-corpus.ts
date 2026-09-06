import path from "node:path";

import { MarkdownRunbookCorpusLoader, type RunbookCorpusLoadResult } from "./markdown-runbook-loader";

// apps/worker/src/rag/ (pre-#72) -> apps/worker/src -> apps/worker -> apps ->
// repo root, four levels up, was the original ESM (`import.meta.url`) form.
// Issue #72: relocated to packages/agent-runtime, which compiles to CommonJS
// (see packages/agent-runtime/tsconfig.build.json's "module": "Node16" with
// no "type": "module" in this package's package.json — import.meta is a
// compile error under that output, exactly the same reason
// packages/provider-claude's claude-model.test.ts already documents for its
// own __dirname-based path). __dirname resolves to the same physical
// directory import.meta.url did, so the depth (4 up) is unchanged — verified
// directly for both environments this function actually runs in: `tsx`
// executing src/ (Vitest, via `pnpm --filter @opspilot/agent-runtime run
// test`) and the compiled dist/ output invoked via plain `require()`
// (simulating the production container).
export function resolveDefaultRunbooksDir(): string {
  return path.resolve(__dirname, "../../../../runbooks");
}

export async function loadDefaultRunbookCorpus(): Promise<RunbookCorpusLoadResult> {
  const loader = new MarkdownRunbookCorpusLoader({ runbooksDir: resolveDefaultRunbooksDir() });
  return loader.load();
}
