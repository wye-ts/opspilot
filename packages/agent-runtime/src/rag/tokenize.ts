// Shared lexical tokenization for the in-repo, dependency-free retrievers
// (InMemoryKeywordRunbookRetriever and BM25RunbookRetriever).
//
// Issue #75 §2.3: these three symbols previously lived as module-private
// helpers inside in-memory-runbook-retriever.ts. BM25 needs the SAME
// tokenization and the SAME query-side stopword filtering — duplicating the
// stopword list into a second file would let the two copies diverge the first
// time either one is edited (this repo's "move it, don't copy it" precedent).
// They are hoisted here verbatim rather than exported from the keyword
// retriever's own module, so that module does not have to export internals it
// otherwise has no reason to publish.
//
// Behavior is byte-for-byte identical to the pre-hoist implementation — see
// tokenize.test.ts, which pins the exact token sets, and
// in-memory-runbook-retriever.test.ts, whose scoring assertions are unchanged.

export function tokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

// A hotfix-scoped closed-class function-word list (articles, pronouns,
// auxiliary/modal verbs, prepositions, conjunctions) — deliberately NOT a
// corpus-derived frequency measure. (BM25's IDF, added in issue #75, is that
// corpus-derived measure; this list still applies to BM25's query side too,
// so both retrievers agree on what counts as a content token at all.) This
// exists because a query built entirely (or almost entirely) from function
// words — e.g. a real production failure: "i cannot send message to my
// client" — scored > 0 against three topically unrelated runbook chunks
// purely because each one happened to contain the word "to" somewhere in its
// own prose, which then reached a LIVE Claude call as "retrieved evidence"
// for a ticket the corpus has nothing to say about. Filtering these out of
// the QUERY only (never the corpus content — a real runbook's own prose is
// untouched) removes exactly this class of accidental single-token overlap
// without touching how content is scored once a real topical token is
// present.
export const STOPWORDS: ReadonlySet<string> = new Set([
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
// empty set, which both retrievers already handle: every chunk scores 0 and
// is excluded by the score > 0 filter, the same honest "no match" result a
// query with no vocabulary overlap at all already produces.
export function tokenizeQuery(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(text)) {
    if (!STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}
