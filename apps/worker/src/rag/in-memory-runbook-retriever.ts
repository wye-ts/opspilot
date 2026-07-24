import type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RunbookRetriever,
  StoredRunbookChunk,
} from "@opspilot/agent-runtime";

function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

// Deterministic keyword/token-overlap scoring — explicitly not a stand-in for
// semantic embedding similarity (see VoyageRunbookRetriever for that). For
// each unique query token: +2 if it appears in the chunk's title, else +1 if
// it appears in the chunk's content, else +0. Chunks scoring 0 are excluded
// entirely, not just ranked last. Ties are broken by chunkId ascending, which
// is deterministic regardless of corpus array order.
function scoreChunk(queryTokens: ReadonlySet<string>, chunk: StoredRunbookChunk): number {
  const titleTokens = tokenize(chunk.title);
  const contentTokens = tokenize(chunk.content);
  let score = 0;
  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      score += 2;
    } else if (contentTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

export class InMemoryKeywordRunbookRetriever implements RunbookRetriever {
  constructor(private readonly corpus: readonly StoredRunbookChunk[]) {}

  async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
    const queryTokens = tokenize(input.query);

    const scored = this.corpus
      .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.chunk.chunkId.localeCompare(b.chunk.chunkId);
      })
      .slice(0, input.topK);

    return scored.map(({ chunk, score }, index) => ({
      ...chunk,
      score,
      rank: index + 1,
    }));
  }
}
