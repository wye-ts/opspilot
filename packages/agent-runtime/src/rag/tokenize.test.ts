import { describe, expect, it } from "vitest";

import { InMemoryKeywordRunbookRetriever } from "./in-memory-runbook-retriever";
import { loadDefaultRunbookCorpus } from "./load-default-runbook-corpus";
import type { RetrievedRunbookChunk, StoredRunbookChunk } from "./runbook-retriever";
import { STOPWORDS, tokenize, tokenizeQuery } from "./tokenize";

// ---------------------------------------------------------------------------
// Issue #75 §6 step 1: the extraction of tokenize()/tokenizeQuery()/STOPWORDS
// out of in-memory-runbook-retriever.ts into tokenize.ts must be a pure move —
// the keyword retriever's observable behavior must be byte-for-byte unchanged.
//
// The proof below is not "the new code looks the same": FROZEN_* are verbatim
// copies of the pre-extraction implementations (in-memory-runbook-retriever.ts
// at commit 9cec936, lines 8-76), kept here as a frozen oracle. Every test in
// this file compares the SHIPPED implementation against that oracle over real
// inputs — the whole production runbook corpus, plus adversarial strings — so
// any future edit to tokenize.ts that changes behavior fails here rather than
// silently shifting every retrieval score in the repo.
// ---------------------------------------------------------------------------

function frozenTokenize(text: string): ReadonlySet<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 0));
}

const FROZEN_STOPWORDS: ReadonlySet<string> = new Set([
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

function frozenTokenizeQuery(text: string): ReadonlySet<string> {
  const tokens = new Set<string>();
  for (const token of frozenTokenize(text)) {
    if (!FROZEN_STOPWORDS.has(token)) tokens.add(token);
  }
  return tokens;
}

// Verbatim copy of the pre-extraction scoreChunk + retrieve() body, so the
// equivalence check below exercises the real end-to-end ranking, not just the
// tokenizer in isolation.
function frozenScoreChunk(queryTokens: ReadonlySet<string>, chunk: StoredRunbookChunk): number {
  const titleTokens = frozenTokenize(chunk.title);
  const contentTokens = frozenTokenize(chunk.content);
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

function frozenRetrieve(
  corpus: readonly StoredRunbookChunk[],
  query: string,
  topK: number,
): readonly RetrievedRunbookChunk[] {
  const queryTokens = frozenTokenizeQuery(query);
  return corpus
    .map((chunk) => ({ chunk, score: frozenScoreChunk(queryTokens, chunk) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.chunk.chunkId.localeCompare(b.chunk.chunkId);
    })
    .slice(0, topK)
    .map(({ chunk, score }, index) => ({ ...chunk, score, rank: index + 1 }));
}

const PROBE_STRINGS: readonly string[] = [
  "",
  "   ",
  "notification service degradation delayed",
  "Notification Service Degradation",
  "i cannot send message to my client",
  "I am unable to authenticate and cannot log in",
  "emails are stuck and not going out",
  "DATABASE connection-pool SATURATION!!",
  "500s, 429s and 200s — mixed 2xx/5xx codes",
  "under_score-hyphen.dot/slash",
  "MiXeD CaSe TOKENS",
  "café naïve résumé",          // non-ASCII: the regex splits on them identically
  "tabs\tand\nnewlines\r\nhere",
  "aaa   bbb",
  "the a an of to and",          // all stopwords
  "s t don",                     // single-letter stopword entries
  "xyzzy plugh qwerty",
];

describe("tokenize.ts extraction is behavior-preserving", () => {
  it("STOPWORDS is exactly the pre-extraction list (same size, same members)", () => {
    expect(STOPWORDS.size).toBe(FROZEN_STOPWORDS.size);
    expect([...STOPWORDS].sort()).toEqual([...FROZEN_STOPWORDS].sort());
  });

  it("tokenize() matches the frozen pre-extraction implementation on every probe string", () => {
    for (const probe of PROBE_STRINGS) {
      expect([...tokenize(probe)]).toEqual([...frozenTokenize(probe)]);
    }
  });

  it("tokenizeQuery() matches the frozen pre-extraction implementation on every probe string", () => {
    for (const probe of PROBE_STRINGS) {
      expect([...tokenizeQuery(probe)]).toEqual([...frozenTokenizeQuery(probe)]);
    }
  });

  it("tokenizeQuery() is tokenize() minus exactly the stopwords", () => {
    for (const probe of PROBE_STRINGS) {
      const expected = [...tokenize(probe)].filter((token) => !STOPWORDS.has(token));
      expect([...tokenizeQuery(probe)]).toEqual(expected);
    }
  });

  it("tokenize() matches the frozen implementation on every real corpus title and content", async () => {
    const corpus = await loadDefaultRunbookCorpus();
    expect(corpus.chunks.length).toBeGreaterThan(0);
    for (const chunk of corpus.chunks) {
      expect([...tokenize(chunk.title)]).toEqual([...frozenTokenize(chunk.title)]);
      expect([...tokenize(chunk.content)]).toEqual([...frozenTokenize(chunk.content)]);
    }
  });

  it("the shipped keyword retriever ranks the REAL corpus identically to the frozen pre-extraction code", async () => {
    const corpus = await loadDefaultRunbookCorpus();
    // minScore 0 = the pre-#75 default: this test isolates the extraction,
    // not the threshold (which is covered in in-memory-runbook-retriever.test.ts).
    const retriever = new InMemoryKeywordRunbookRetriever(corpus.chunks, 0);

    for (const probe of PROBE_STRINGS) {
      for (const topK of [1, 3, 5]) {
        const actual = await retriever.retrieve({ query: probe, topK });
        expect(actual).toEqual(frozenRetrieve(corpus.chunks, probe, topK));
      }
    }
  });
});
