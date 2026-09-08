import { computeCorpusContentHash, sha256 } from "./corpus-content-hash";
import { cosineSimilarity } from "./cosine-similarity";
import type {
  RetrievalInput,
  RetrievedRunbookChunk,
  RunbookRetriever,
  StoredRunbookChunk,
} from "./runbook-retriever";
import { RetrieverError } from "./runbook-retriever";

// Issue #76 §2.3 — the third retriever candidate: ranks against frozen,
// offline, pre-committed Voyage embeddings (runbooks-eval/embedding-fixture.json)
// rather than a live embedding call. Zero network calls, zero `voyageai`
// import — lives in the shared package (not apps/worker) so the eval harness
// and, if this candidate ever won the comparison, apps/api could construct
// it without pulling in apps/worker's dependency graph (plan §0 fix 1).
//
// Only ever serves the exact query strings committed in the fixture (the 40
// labeled evaluation queries) — this is NOT a general-purpose retriever, and
// the exact-string lookup in retrieve() below is what makes that limitation
// structurally explicit rather than an accidental gap.

// Issue #76 §2.4 — the single source of truth for this retriever's enforced
// minimum-score floor (the frozen-embedding counterpart to
// DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE / DEFAULT_BM25_RETRIEVER_MIN_SCORE).
// Frozen by the same committed calibration procedure
// (runbooks-eval/calibrate-min-score.ts, step=0.01) run against this
// retriever's own raw cosine-similarity scores — see
// runbooks-eval/min-score-calibration.json for the recorded run.
export const DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE = 0.41;

export interface FixtureQueryRecord {
  readonly id: string;
  readonly query: string;
}

interface RawFixtureChunkEntry {
  readonly chunkId: string;
  readonly vector: readonly number[];
}

interface RawFixtureQueryEntry {
  readonly id: string;
  readonly vector: readonly number[];
}

interface ValidatedFixture {
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly corpusContentHash: string;
  readonly queryContentHash: string;
  readonly chunkVectorsById: ReadonlyMap<string, readonly number[]>;
  readonly queryVectorsById: ReadonlyMap<string, readonly number[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteVector(value: unknown, dimensions: number): value is readonly number[] {
  return (
    Array.isArray(value) &&
    value.length === dimensions &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

function vectorNorm(vector: readonly number[]): number {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  return Math.sqrt(sumSquares);
}

// Parses and structurally validates the raw fixture JSON (already
// JSON.parse()'d by the caller — this class performs no file I/O itself,
// matching InMemoryKeywordRunbookRetriever/BM25RunbookRetriever's existing
// "pure, testable, no I/O inside the class" constructor shape).
//
// Every check below throws RetrieverError("REQUEST_INVALID", ...) at
// construction time, before any retrieve() call — plan §0 fix 5: a
// hand-edited or corrupted fixture must never reach cosine-ranking code
// unchecked (which can produce NaN or silently wrong rankings).
function parseAndValidateFixture(
  rawFixture: unknown,
  corpus: readonly StoredRunbookChunk[],
  queries: readonly FixtureQueryRecord[],
): ValidatedFixture {
  if (!isRecord(rawFixture)) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json must be a JSON object.");
  }

  const { embeddingModel, dimensions, corpusContentHash, queryContentHash, chunks, queries: fixtureQueries } =
    rawFixture;

  if (typeof embeddingModel !== "string" || embeddingModel.length === 0) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: embeddingModel must be a non-empty string.");
  }
  if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions <= 0) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: dimensions must be a positive integer.");
  }
  if (typeof corpusContentHash !== "string" || corpusContentHash.length === 0) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: corpusContentHash must be a non-empty string.");
  }
  if (typeof queryContentHash !== "string" || queryContentHash.length === 0) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: queryContentHash must be a non-empty string.");
  }
  if (!Array.isArray(chunks)) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: chunks must be an array.");
  }
  if (!Array.isArray(fixtureQueries)) {
    throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: queries must be an array.");
  }

  const chunkVectorsById = new Map<string, readonly number[]>();
  for (const entry of chunks as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry.chunkId !== "string" || entry.chunkId.length === 0) {
      throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: every chunks entry must have a non-empty chunkId.");
    }
    if (chunkVectorsById.has(entry.chunkId)) {
      throw new RetrieverError("REQUEST_INVALID", `embedding-fixture.json: duplicate chunk id "${entry.chunkId}".`);
    }
    if (!isFiniteVector(entry.vector, dimensions)) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        `embedding-fixture.json: chunk "${entry.chunkId}" has a malformed vector (expected ${dimensions} finite entries).`,
      );
    }
    if (vectorNorm(entry.vector) === 0) {
      throw new RetrieverError("REQUEST_INVALID", `embedding-fixture.json: chunk "${entry.chunkId}" has a zero-norm vector.`);
    }
    chunkVectorsById.set(entry.chunkId, entry.vector);
  }

  const queryVectorsById = new Map<string, readonly number[]>();
  for (const entry of fixtureQueries as readonly unknown[]) {
    if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.length === 0) {
      throw new RetrieverError("REQUEST_INVALID", "embedding-fixture.json: every queries entry must have a non-empty id.");
    }
    if (queryVectorsById.has(entry.id)) {
      throw new RetrieverError("REQUEST_INVALID", `embedding-fixture.json: duplicate query id "${entry.id}".`);
    }
    if (!isFiniteVector(entry.vector, dimensions)) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        `embedding-fixture.json: query "${entry.id}" has a malformed vector (expected ${dimensions} finite entries).`,
      );
    }
    if (vectorNorm(entry.vector) === 0) {
      throw new RetrieverError("REQUEST_INVALID", `embedding-fixture.json: query "${entry.id}" has a zero-norm vector.`);
    }
    queryVectorsById.set(entry.id, entry.vector);
  }

  // The fixture's chunk-id set must exactly equal the CURRENT corpus's
  // chunk-id set — no orphan (a fixture entry for a chunk that no longer
  // exists), no missing (a current chunk the fixture never embedded).
  const corpusChunkIds = new Set(corpus.map((chunk) => chunk.chunkId));
  if (
    corpusChunkIds.size !== chunkVectorsById.size ||
    ![...corpusChunkIds].every((id) => chunkVectorsById.has(id))
  ) {
    throw new RetrieverError(
      "REQUEST_INVALID",
      "embedding-fixture.json: chunk id set does not exactly match the current corpus — fixture stale, regenerate via apps/worker's generate:embedding-fixture script.",
    );
  }

  // Same exact-equality rule for the query id set against the CURRENT query set.
  const currentQueryIds = new Set(queries.map((record) => record.id));
  if (
    currentQueryIds.size !== queryVectorsById.size ||
    ![...currentQueryIds].every((id) => queryVectorsById.has(id))
  ) {
    throw new RetrieverError(
      "REQUEST_INVALID",
      "embedding-fixture.json: query id set does not exactly match the current query set — fixture stale, regenerate via apps/worker's generate:embedding-fixture script.",
    );
  }

  return {
    embeddingModel,
    dimensions,
    corpusContentHash,
    queryContentHash,
    chunkVectorsById,
    queryVectorsById,
  };
}

export class FixtureBackedRunbookRetriever implements RunbookRetriever {
  private readonly fixture: ValidatedFixture;
  private readonly corpus: readonly StoredRunbookChunk[];
  private readonly queryTextById: ReadonlyMap<string, string>;
  private readonly queryIdByText: ReadonlyMap<string, string>;

  // No default for `minScore` — deliberately (plan §0a fix 1): a nonzero
  // default would let calibration silently score its own already-filtered
  // output, the same self-referential-threshold bug caught once already in
  // BM25/keyword calibration. Calibration callers pass 0 explicitly;
  // production/comparison callers pass DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE
  // explicitly (calibrate-min-score.ts, once frozen).
  constructor(
    corpus: readonly StoredRunbookChunk[],
    queries: readonly FixtureQueryRecord[],
    rawQuerySetText: string,
    rawFixture: unknown,
    expectedEmbeddingModel: string,
    expectedDimensions: number,
    private readonly minScore: number,
  ) {
    const fixture = parseAndValidateFixture(rawFixture, corpus, queries);

    // Fail-closed staleness check (plan §2.2, §0 fix 2): four
    // independently-derived expected values, never trusted from the
    // fixture's own self-reported metadata alone.
    const actualCorpusHash = computeCorpusContentHash(corpus);
    if (fixture.corpusContentHash !== actualCorpusHash) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        "fixture stale — the loaded runbook corpus does not match embedding-fixture.json's corpusContentHash. Regenerate via apps/worker's generate:embedding-fixture script.",
      );
    }
    const actualQueryHash = sha256(rawQuerySetText);
    if (fixture.queryContentHash !== actualQueryHash) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        "fixture stale — the loaded query set does not match embedding-fixture.json's queryContentHash. Regenerate via apps/worker's generate:embedding-fixture script.",
      );
    }
    if (fixture.embeddingModel !== expectedEmbeddingModel) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        `fixture stale — embedding-fixture.json's embeddingModel ("${fixture.embeddingModel}") does not match the expected model ("${expectedEmbeddingModel}"). Regenerate via apps/worker's generate:embedding-fixture script.`,
      );
    }
    if (fixture.dimensions !== expectedDimensions) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        `fixture stale — embedding-fixture.json's dimensions (${fixture.dimensions}) does not match the expected dimensions (${expectedDimensions}). Regenerate via apps/worker's generate:embedding-fixture script.`,
      );
    }

    this.fixture = fixture;
    this.corpus = corpus;
    this.queryTextById = new Map(queries.map((record) => [record.id, record.query]));
    this.queryIdByText = new Map(queries.map((record) => [record.query, record.id]));
  }

  async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
    const queryId = this.queryIdByText.get(input.query);
    if (queryId === undefined) {
      throw new RetrieverError(
        "REQUEST_INVALID",
        "FixtureBackedRunbookRetriever only serves the exact query strings committed in embedding-fixture.json's query set — never falls back to a live embedding call.",
      );
    }
    const queryVector = this.fixture.queryVectorsById.get(queryId)!;

    const scored = this.corpus
      .map((chunk) => ({
        chunk,
        score: cosineSimilarity(queryVector, this.fixture.chunkVectorsById.get(chunk.chunkId)!),
      }))
      .filter(({ score }) => score >= this.minScore)
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
