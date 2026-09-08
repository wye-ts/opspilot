import type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RunbookRetriever,
  StoredRunbookChunk,
} from "./runbook-retriever";
import { tokenize, tokenizeQuery } from "./tokenize";

// Issue #75 §2.3 — a hand-rolled Okapi BM25 retriever. No new runtime
// dependency: the same "implement it, don't import it" posture
// InMemoryKeywordRunbookRetriever already established for this corpus size
// (tens of chunks, all resident in memory).
//
// The conventional defaults. No tuning corpus exists that would justify
// anything else, and the plan explicitly does not ask for parameter
// calibration — only for a real, second lexical retriever whose numbers can be
// compared against the incumbent keyword retriever's.
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

// Issue #75 §2.4 — the single source of truth for THIS retriever's enforced
// minimum-score floor (the BM25 counterpart to
// DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE). Same rule: imported at every
// production-relevant construction site, never re-declared as a literal.
// Frozen by the same committed calibration procedure
// (runbooks-eval/calibrate-min-score.ts) run against BM25's own raw scores —
// BM25 scores are real-valued sums of IDF-weighted terms, not the keyword
// retriever's small integers, so the two thresholds are on different scales
// and are calibrated independently.
export const DEFAULT_BM25_RETRIEVER_MIN_SCORE = 6;

interface IndexedChunk {
  readonly chunk: StoredRunbookChunk;
  // Title text is concatenated into the scored document and weighted no
  // differently from content — unlike the keyword retriever's +2/+1 split.
  // BM25's own length normalization already accounts for a short title vs. a
  // longer body; layering a second title-boost heuristic on top would just be
  // recreating the keyword retriever's rule inside a different algorithm.
  readonly termFrequencies: ReadonlyMap<string, number>;
  readonly length: number;
}

function termFrequencies(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  // Document-side tokens are NOT stopword-filtered (matching the keyword
  // retriever: filtering is query-side only, so a runbook's own prose is never
  // altered). BM25's IDF already discounts terms appearing in most documents,
  // which is the corpus-derived version of the same idea; the query-side
  // stopword filter still applies via tokenizeQuery below, so a
  // function-word-only query scores nothing here too.
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (token.length === 0) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

export class BM25RunbookRetriever implements RunbookRetriever {
  private readonly indexed: readonly IndexedChunk[];
  private readonly documentFrequency: ReadonlyMap<string, number>;
  private readonly averageLength: number;

  constructor(
    corpus: readonly StoredRunbookChunk[],
    private readonly minScore: number = 0,
  ) {
    const indexed: IndexedChunk[] = corpus.map((chunk) => {
      const counts = termFrequencies(`${chunk.title} ${chunk.content}`);
      let length = 0;
      for (const count of counts.values()) length += count;
      return { chunk, termFrequencies: counts, length };
    });

    const documentFrequency = new Map<string, number>();
    for (const entry of indexed) {
      // `tokenize` (the deduplicating set form) is exactly the right shape
      // for document frequency: one increment per document per distinct term.
      for (const term of tokenize(`${entry.chunk.title} ${entry.chunk.content}`)) {
        documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      }
    }

    const totalLength = indexed.reduce((sum, entry) => sum + entry.length, 0);

    this.indexed = indexed;
    this.documentFrequency = documentFrequency;
    // An empty corpus has no documents to normalize against; 0 keeps the
    // length-normalization term well-defined (the loop below never runs).
    this.averageLength = indexed.length === 0 ? 0 : totalLength / indexed.length;
  }

  // The standard Robertson/Sparck-Jones smoothed IDF, in the +1 form that
  // stays non-negative for every df <= N (the unsmoothed form goes negative
  // for a term appearing in more than half the corpus, which on a corpus this
  // small would let a common term actively penalize a chunk that contains it).
  private idf(term: string): number {
    const n = this.indexed.length;
    const df = this.documentFrequency.get(term) ?? 0;
    return Math.log((n - df + 0.5) / (df + 0.5) + 1);
  }

  private score(queryTokens: ReadonlySet<string>, entry: IndexedChunk): number {
    if (this.averageLength === 0) return 0;
    let score = 0;
    for (const term of queryTokens) {
      const tf = entry.termFrequencies.get(term);
      if (tf === undefined) continue;
      const numerator = tf * (BM25_K1 + 1);
      const denominator =
        tf + BM25_K1 * (1 - BM25_B + BM25_B * (entry.length / this.averageLength));
      score += this.idf(term) * (numerator / denominator);
    }
    return score;
  }

  async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
    const queryTokens = tokenizeQuery(input.query);

    const scored = this.indexed
      .map((entry) => ({ chunk: entry.chunk, score: this.score(queryTokens, entry) }))
      // Identical two-part filter to the keyword retriever: `> 0` excludes a
      // chunk with no query-term overlap at all; `>= minScore` is the real,
      // enforced relevance floor (§2.4) that the same code path serves to
      // production, the eval harness, and the scoring script alike.
      .filter(({ score }) => score > 0 && score >= this.minScore)
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
