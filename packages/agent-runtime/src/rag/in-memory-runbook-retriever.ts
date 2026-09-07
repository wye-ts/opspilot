import type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RunbookRetriever,
  StoredRunbookChunk,
} from "./runbook-retriever";

function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

// A hotfix-scoped closed-class function-word list (articles, pronouns,
// auxiliary/modal verbs, prepositions, conjunctions) — deliberately NOT the
// full BM25/IDF-aware retriever issue #75 scopes; see that issue for a real
// corpus-derived frequency measure. This exists because a query built
// entirely (or almost entirely) from function words — e.g. a real production
// failure: "i cannot send message to my client" — scored > 0 against three
// topically unrelated runbook chunks purely because each one happened to
// contain the word "to" somewhere in its own prose, which then reached a LIVE
// Claude call as "retrieved evidence" for a ticket the corpus has nothing to
// say about. Filtering these out of the QUERY only (never the corpus content
// — a real runbook's own prose is untouched)
// removes exactly this class of accidental single-token overlap without
// touching how content is scored once a real topical token is present.
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the",
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "this", "that", "these", "those",
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing",
  "and", "but", "if", "or", "because", "as", "until", "while",
  "of", "at", "by", "for", "with", "about", "against", "between",
  "into", "through", "during", "before", "after", "above", "below",
  "to", "from", "up", "down", "in", "out", "on", "off", "over", "under",
  "again", "further", "then", "once", "here", "there", "when", "where",
  "why", "how", "all", "any", "both", "each", "few", "more", "most",
  "other", "some", "such", "no", "nor", "not", "only", "own", "same",
  "so", "than", "too", "very", "s", "t", "can", "will", "just", "don",
  "should", "now", "cannot", "could", "would", "shall", "might", "must",
]);

// Query tokens only — never chunk title/content tokens (see STOPWORDS
// comment above). A query built ENTIRELY from stopwords tokenizes to an
// empty set, which scoreChunk already handles: every chunk scores 0 and is
// excluded by the score > 0 filter below, the same honest "no match" result
// a query with no vocabulary overlap at all already produces.
function tokenizeQuery(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(text)) {
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
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
    const queryTokens = tokenizeQuery(input.query);

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
