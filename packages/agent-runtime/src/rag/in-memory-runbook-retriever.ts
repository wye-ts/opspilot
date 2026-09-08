import type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RunbookRetriever,
  StoredRunbookChunk,
} from "./runbook-retriever";
import { tokenize, tokenizeQuery } from "./tokenize";

// Issue #75 §2.4 — the single source of truth for this retriever's enforced
// minimum-score floor. Every production-relevant construction site imports
// THIS constant; none re-declares the literal (apps/api's RUNBOOK_RETRIEVER
// provider, apps/worker's evaluation-runner, and runbooks-eval's scoring
// script). A second, independently-passed number that "happens to agree
// today" is exactly the silent-drift failure this constant exists to prevent.
//
// Value frozen by the committed calibration procedure in
// runbooks-eval/calibrate-min-score.ts (run BEFORE any false-positive-rate
// measurement, never tuned afterwards): the smallest integer threshold that
// excludes at least half of the 12 near-miss queries' own declared distractor
// scores while still passing every exact/paraphrase query's own top-1 correct
// answer. See runbooks-eval/min-score-calibration.json for the recorded run.
//
// Honest recorded outcome for THIS retriever: the correct-answer constraint
// binds first — the lowest correct top-answer score across all 20
// exact/paraphrase queries is 3, while 11 of the 12 near-miss distractors also
// score >= 3, so no constraint-satisfying integer reaches the half-exclusion
// target (2 excludes 1/12). 2 is the smallest integer achieving that maximum
// allowed exclusion. BM25RunbookRetriever's own calibration (see
// runbooks-eval/min-score-calibration.json) hits the SAME structural limit —
// its real full-corpus distractor scores also cluster close to its correct
// answers' scores (3/12 excluded, not the 6/12 target either) — so neither
// retriever's global floor alone fully separates a plausible-but-wrong match
// from a correct one on this corpus; #75's real, measured falsePositiveRate
// numbers (query-set-scores.json) are the actual comparison this issue
// exists to produce, not a claim that either retriever's threshold alone
// "solves" false positives.
export const DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE = 2;

// Deterministic keyword/token-overlap scoring — explicitly not a stand-in for
// semantic embedding similarity (see VoyageRunbookRetriever for that, and
// BM25RunbookRetriever for a corpus-frequency-aware lexical alternative). For
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
  // `minScore` defaults to 0 — the exact pre-#75 behavior, so a bare
  // construction (a unit test exercising the raw scoring, or
  // validate-query-set.ts's deliberate PRE-threshold distractor-competitiveness
  // probe) is unchanged. Production call sites pass
  // DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE explicitly and never rely on this
  // default.
  constructor(
    private readonly corpus: readonly StoredRunbookChunk[],
    private readonly minScore: number = 0,
  ) {}

  async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
    const queryTokens = tokenizeQuery(input.query);

    const scored = this.corpus
      .map((chunk) => ({ chunk, score: scoreChunk(queryTokens, chunk) }))
      // `score > 0` is the historical exclusion (a chunk with no overlap at
      // all is never a result); `score >= minScore` is #75's real, enforced
      // relevance floor layered on top of it. Both apply — the floor only ever
      // raises the bar, never loosens it.
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
