/**
 * Issue #76 §2.1 — one-time, owner-run Voyage embedding fixture generator.
 *
 * NOT runbooks-eval/ (see plan §0 fix 1's module-boundary analysis): this
 * script needs voyageai's SDK types and VoyageRunbookRetriever's existing,
 * unit-tested extractValidatedEmbeddings response validator, both of which
 * live in this app (ESM). runbooks-eval/ is CommonJS and may not import
 * from here — the reverse direction (this file importing FROM
 * runbooks-eval/, e.g. the query-set parser) is fine, and is how
 * score-query-set.ts/calibrate-min-score.ts already import FROM
 * packages/agent-runtime today.
 *
 * Run:
 *   pnpm --filter @opspilot/worker run generate:embedding-fixture
 *
 * Performs ONE owner-run fixture-generation operation, consisting of TWO
 * billed Voyage API requests (a document-embedding batch for the corpus, a
 * query-embedding batch for the query set) — the only network activity in
 * this issue's design. Never invoked automatically; never run in CI.
 *
 * NOTE: this composition root is never executed by automated tests or CI —
 * it requires VOYAGE_API_KEY and makes real, billed API calls. The testable
 * core (buildEmbeddingFixture) is unit-tested directly against a fake
 * VoyageEmbeddingClient, without ever importing or executing this file's
 * main().
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { VoyageAIClient } from "voyageai";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

import { parseQuerySet, QUERY_SET_PATH, type QueryRecord } from "../../../../runbooks-eval/validate-query-set";
import type { VoyageEmbeddingClient } from "../rag/voyage-embedding-client";
import { extractValidatedEmbeddings } from "../rag/voyage-runbook-retriever";

const { computeCorpusContentHash, sha256, loadDefaultRunbookCorpus } = opspilotAgentRuntime;

export const EMBEDDING_FIXTURE_PATH = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "..",
  "..",
  "..",
  "runbooks-eval",
  "embedding-fixture.json",
);

export interface EmbeddingFixtureVectorEntry {
  readonly id: string;
  readonly vector: readonly number[];
}

export interface EmbeddingFixture {
  readonly embeddingModel: string;
  readonly dimensions: number;
  readonly corpusContentHash: string;
  readonly queryContentHash: string;
  readonly chunks: readonly { readonly chunkId: string; readonly vector: readonly number[] }[];
  readonly queries: readonly EmbeddingFixtureVectorEntry[];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value;
}

function resolveEmbeddingModel(): string {
  return process.env.EMBEDDING_MODEL?.trim() || "voyage-4-lite";
}

const ALLOWED_EMBEDDING_DIMENSIONS = [256, 512, 1024, 2048] as const;

// Fail closed: an explicitly-set-but-invalid value is rejected before any
// client is constructed, never silently passed through to the SDK — mirrors
// run-rag-live-spike.ts's own resolveEmbeddingDimensions() exactly.
function resolveEmbeddingDimensions(): number {
  const raw = process.env.EMBEDDING_DIMENSIONS;
  if (raw === undefined || raw.trim() === "") {
    return 1024;
  }
  const parsed = Number(raw);
  if (!ALLOWED_EMBEDDING_DIMENSIONS.includes(parsed as (typeof ALLOWED_EMBEDDING_DIMENSIONS)[number])) {
    throw new Error(
      `EMBEDDING_DIMENSIONS must be one of ${ALLOWED_EMBEDDING_DIMENSIONS.join(", ")}, got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * The testable core: given a corpus, a query set, an embedding client, and
 * model/dimension configuration, performs exactly two embed() requests (one
 * document batch, one query batch — plan §0 fix 6's corrected request-count
 * claim) and returns a fully-formed, hash-stamped fixture. No file I/O; the
 * caller (main(), below) writes the result.
 */
export async function buildEmbeddingFixture(
  client: VoyageEmbeddingClient,
  model: string,
  dimensions: number,
  corpus: readonly StoredRunbookChunk[],
  queries: readonly QueryRecord[],
  rawQuerySetText: string,
): Promise<EmbeddingFixture> {
  const sortedChunks = [...corpus].sort((a, b) => a.chunkId.localeCompare(b.chunkId));
  const sortedQueries = [...queries].sort((a, b) => a.id.localeCompare(b.id));

  const documentResponse = await client.embed({
    input: sortedChunks.map((chunk) => chunk.content),
    model,
    inputType: "document",
    outputDimension: dimensions,
    outputDtype: "float",
  });
  const { vectors: chunkVectors } = extractValidatedEmbeddings(
    documentResponse,
    sortedChunks.length,
    dimensions,
    "document-embedding",
  );

  const queryResponse = await client.embed({
    input: sortedQueries.map((record) => record.query),
    model,
    inputType: "query",
    outputDimension: dimensions,
    outputDtype: "float",
  });
  const { vectors: queryVectors } = extractValidatedEmbeddings(
    queryResponse,
    sortedQueries.length,
    dimensions,
    "query-embedding",
  );

  return {
    embeddingModel: model,
    dimensions,
    corpusContentHash: computeCorpusContentHash(corpus),
    queryContentHash: sha256(rawQuerySetText),
    chunks: sortedChunks.map((chunk, index) => ({ chunkId: chunk.chunkId, vector: chunkVectors[index]! })),
    queries: sortedQueries.map((record, index) => ({ id: record.id, vector: queryVectors[index]! })),
  };
}

function serializeFixture(fixture: EmbeddingFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

async function main(): Promise<void> {
  const voyageApiKey = requireEnv("VOYAGE_API_KEY");
  const embeddingModel = resolveEmbeddingModel();
  const embeddingDimensions = resolveEmbeddingDimensions();

  const corpusLoad = await loadDefaultRunbookCorpus();

  const fs = await import("node:fs");
  const rawQuerySetText = fs.readFileSync(QUERY_SET_PATH, "utf8");
  const { querySet, errors } = parseQuerySet(rawQuerySetText);
  if (querySet === null) {
    throw new Error(`retrieval-query-set.json is malformed: ${errors.join("; ")}`);
  }

  const voyageClient = new VoyageAIClient({ apiKey: voyageApiKey, logging: { silent: true } });

  const fixture = await buildEmbeddingFixture(
    voyageClient,
    embeddingModel,
    embeddingDimensions,
    corpusLoad.chunks,
    querySet.queries,
    rawQuerySetText,
  );

  writeFileSync(EMBEDDING_FIXTURE_PATH, serializeFixture(fixture), "utf8");
  console.log(
    `Wrote ${path.relative(process.cwd(), EMBEDDING_FIXTURE_PATH)} ` +
      `(model=${embeddingModel}, dimensions=${embeddingDimensions}, ` +
      `${fixture.chunks.length} chunks, ${fixture.queries.length} queries).`,
  );
}

// ESM equivalent of `require.main === module` (this file has no CommonJS
// module object) — only runs main() when executed directly via `tsx`, never
// when buildEmbeddingFixture is imported for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
