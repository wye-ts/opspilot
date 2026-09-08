/**
 * Milestone 13 Issue B (#75) §2.5 — opt-in retrieval-quality attachment for an
 * eval run.
 *
 * Two env vars, both parsed here, failing closed on anything ambiguous:
 *
 *   EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1
 *       Read runbooks-eval/query-set-scores.json and attach one retriever's
 *       precomputed numbers to this run's EvaluationSuiteInputV2.
 *   EVALUATION_RETRIEVAL_QUALITY_RETRIEVER=<name>
 *       REQUIRED whenever the flag above is set. Selects exactly one entry
 *       from the keyed artifact. Omitting it, or naming a retriever absent
 *       from the file, is a configuration error — never a silent default,
 *       because the file holds several retrievers' numbers and a run reports
 *       on exactly one (comparing two means running twice and diffing).
 *
 * Freshness (plan §2.1a): this module re-derives corpusContentHash from the
 * corpus the CLI ITSELF just loaded and compares it to the artifact's stored
 * hash BEFORE attaching anything. That runtime binding is independent of ever
 * having run `score-query-set.ts --check`: a direct eval invocation against a
 * corpus edited since the artifact was generated fails closed here, rather
 * than silently reporting outdated numbers.
 *
 * Issue #76 §2.5 (round-2 Codex-review MAJOR fix #2) — a SECOND freshness
 * check re-derives queryContentHash from the CURRENT retrieval-query-set.json
 * bytes and compares it too, for EVERY retriever selection (keyword/bm25/
 * frozen-embedding alike) — closing a gap that predates this issue: #75's
 * version of this module validated corpusContentHash but never
 * queryContentHash, so an edited query set with an unchanged corpus was
 * silently accepted as fresh for every retriever, not only ones #76 adds.
 *
 * Issue #76 §2.5 (round-2 Codex-review MAJOR fix #3) — when the selected
 * retriever is "frozen-embedding", a THIRD check re-derives its fingerprint
 * from the loaded embedding fixture (via computeFrozenEmbeddingFingerprint,
 * a pure function — never a top-level fixture read at module-evaluation
 * time, matching CURRENT_RETRIEVER_FINGERPRINTS's own production-import-safe
 * posture) and compares it against the artifact's stored fingerprint —
 * the same freshness guarantee CURRENT_RETRIEVER_FINGERPRINTS already gives
 * keyword/BM25, achieved without ever requiring
 * runbooks-eval/embedding-fixture.json to exist at production import time.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

// The SAME implementation runbooks-eval/score-query-set.ts uses to stamp the
// artifact — imported from the shared package, never re-derived here (see
// packages/agent-runtime/src/rag/corpus-content-hash.ts).
import {
  computeCorpusContentHash,
  computeEmbeddingFixturePayloadHash,
  computeFrozenEmbeddingFingerprint,
  CURRENT_RETRIEVER_FINGERPRINTS,
  DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE,
  sha256,
} from "../rag";
import type { MetricRatioInput, RetrievalQualityMetricsInput } from "./v2-types";

export const INCLUDE_RETRIEVAL_QUALITY_ENV = "EVALUATION_INCLUDE_RETRIEVAL_QUALITY";
export const RETRIEVAL_QUALITY_RETRIEVER_ENV = "EVALUATION_RETRIEVAL_QUALITY_RETRIEVER";

const RUNBOOKS_EVAL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "runbooks-eval");

// runbooks-eval/ is a top-level fixture directory, not a workspace package —
// resolved relative to this file, the same way the parity fixture path is.
export const QUERY_SET_SCORES_PATH = join(RUNBOOKS_EVAL_DIR, "query-set-scores.json");
export const RETRIEVAL_QUERY_SET_PATH = join(RUNBOOKS_EVAL_DIR, "retrieval-query-set.json");
export const EMBEDDING_FIXTURE_PATH = join(RUNBOOKS_EVAL_DIR, "embedding-fixture.json");

const FROZEN_EMBEDDING_RETRIEVER_NAME = "frozen-embedding";

// A fail-closed configuration error, rendered by the CLI through the same
// already-safe path EvaluationScorerConfigError uses (only this message text
// is ever shown; nothing else is leaked).
export class RetrievalQualityConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetrievalQualityConfigError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRatio(value: unknown, path: string): MetricRatioInput {
  if (!isRecord(value)) {
    throw new RetrievalQualityConfigError(`query-set-scores.json: expected an object at ${path}.`);
  }
  const { numerator, denominator } = value;
  if (typeof numerator !== "number" || !Number.isInteger(numerator) || numerator < 0) {
    throw new RetrievalQualityConfigError(
      `query-set-scores.json: ${path}.numerator must be a non-negative integer.`,
    );
  }
  if (typeof denominator !== "number" || !Number.isInteger(denominator) || denominator < 0) {
    throw new RetrievalQualityConfigError(
      `query-set-scores.json: ${path}.denominator must be a non-negative integer.`,
    );
  }
  // Codex-review MAJOR fix, verified against source: without this check, an
  // artifact carrying {numerator: 11, denominator: 10} or {numerator: 1,
  // denominator: 0} parsed successfully and flowed straight through to a
  // persisted/reported metric above 100% or a positive numerator over a
  // zero denominator — the pass-through design (plan §0's own decision gate)
  // has no later recomputation step that could ever catch this, so the
  // parser is the only place it can be caught. A single `numerator >
  // denominator` check correctly covers BOTH invalid shapes: when
  // denominator is 0, any positive numerator is already > 0, so a
  // zero-denominator/positive-numerator ratio is rejected by this same
  // comparison — a separate explicit zero-denominator branch would be
  // unreachable dead code. The genuine 0/0 "not evaluated" shape (denominator
  // 0, numerator 0) correctly passes: 0 > 0 is false.
  if (numerator > denominator) {
    throw new RetrievalQualityConfigError(
      `query-set-scores.json: ${path}.numerator (${numerator}) must not exceed ` +
        `${path}.denominator (${denominator}).`,
    );
  }
  return { numerator, denominator };
}

function parseGrouped(value: unknown, path: string): RetrievalQualityMetricsInput["recallAtK"] {
  if (!isRecord(value)) {
    throw new RetrievalQualityConfigError(`query-set-scores.json: expected an object at ${path}.`);
  }
  return {
    exact: parseRatio(value.exact, `${path}.exact`),
    paraphrase: parseRatio(value.paraphrase, `${path}.paraphrase`),
    nearMiss: parseRatio(value.nearMiss, `${path}.nearMiss`),
  };
}

export interface RetrievalQualityEnv {
  readonly [key: string]: string | undefined;
}

// Reads the raw fixture and derives the SAME EmbeddingFixtureFingerprintInput
// shape score-query-set.ts's buildFrozenEmbeddingFingerprintInput() derives —
// duplicated here (not imported from runbooks-eval/) because apps/worker (ESM)
// importing FROM runbooks-eval/ (CommonJS) is the safe direction this plan's
// §0 fix 1 already established (score-query-set.ts/calibrate-min-score.ts
// import FROM packages/agent-runtime, never the reverse) — this file already
// does the same thing (reads a runbooks-eval/ JSON artifact directly), so no
// new precedent is set.
function deriveFrozenEmbeddingFingerprint(readFixture: () => string): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFixture());
  } catch {
    throw new RetrievalQualityConfigError(
      "embedding-fixture.json could not be read or parsed — generate it with " +
        "`pnpm --filter @opspilot/worker run generate:embedding-fixture`.",
    );
  }
  if (!isRecord(raw)) {
    throw new RetrievalQualityConfigError("embedding-fixture.json must be a JSON object.");
  }
  const { embeddingModel, dimensions, corpusContentHash, queryContentHash, chunks, queries } = raw;
  if (
    typeof embeddingModel !== "string" ||
    typeof dimensions !== "number" ||
    typeof corpusContentHash !== "string" ||
    typeof queryContentHash !== "string" ||
    !Array.isArray(chunks) ||
    !Array.isArray(queries)
  ) {
    throw new RetrievalQualityConfigError("embedding-fixture.json is malformed.");
  }
  const vectorPayloadHash = computeEmbeddingFixturePayloadHash(
    chunks as readonly { chunkId: string; vector: readonly number[] }[],
    queries as readonly { id: string; vector: readonly number[] }[],
  );
  return computeFrozenEmbeddingFingerprint(
    { embeddingModel, dimensions, corpusContentHash, queryContentHash, vectorPayloadHash },
    DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE,
  );
}

/**
 * Resolves the retrieval-quality input for this run, or `undefined` when the
 * feature is not enabled (the default for every existing CI/local invocation).
 *
 * Throws RetrievalQualityConfigError on: the selector env var missing while
 * the flag is set, an unreadable/malformed artifact, a retriever name absent
 * from the artifact, an artifact whose stored corpusContentHash OR
 * queryContentHash disagrees with the current corpus/query set, or (for
 * "frozen-embedding") a fingerprint mismatch against the current
 * embedding-fixture.json.
 */
export function resolveRetrievalQualityMetrics(
  env: RetrievalQualityEnv,
  corpus: readonly StoredRunbookChunk[],
  readArtifact: () => string = () => readFileSync(QUERY_SET_SCORES_PATH, "utf8"),
  readQuerySet: () => string = () => readFileSync(RETRIEVAL_QUERY_SET_PATH, "utf8"),
  readEmbeddingFixture: () => string = () => readFileSync(EMBEDDING_FIXTURE_PATH, "utf8"),
): RetrievalQualityMetricsInput | undefined {
  const flag = env[INCLUDE_RETRIEVAL_QUALITY_ENV];
  if (flag === undefined || flag.trim() === "" || flag.trim() === "0") return undefined;
  if (flag.trim() !== "1") {
    throw new RetrievalQualityConfigError(
      `${INCLUDE_RETRIEVAL_QUALITY_ENV} must be "1" when set (got "${flag}").`,
    );
  }

  const retrieverName = env[RETRIEVAL_QUALITY_RETRIEVER_ENV]?.trim();
  if (retrieverName === undefined || retrieverName === "") {
    throw new RetrievalQualityConfigError(
      `${RETRIEVAL_QUALITY_RETRIEVER_ENV} is required whenever ${INCLUDE_RETRIEVAL_QUALITY_ENV}=1 ` +
        `is set: query-set-scores.json holds several retrievers' numbers and one eval run reports ` +
        `on exactly one of them.`,
    );
  }

  let raw: string;
  try {
    raw = readArtifact();
  } catch {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json could not be read — generate it with " +
        "`pnpm exec tsx runbooks-eval/score-query-set.ts`.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RetrievalQualityConfigError("query-set-scores.json is not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new RetrievalQualityConfigError("query-set-scores.json must be a JSON object.");
  }

  const storedHash = parsed.corpusContentHash;
  if (typeof storedHash !== "string" || storedHash.length === 0) {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json: corpusContentHash must be a non-empty string.",
    );
  }

  // The runtime freshness binding — deliberately NOT dependent on anyone
  // having run `score-query-set.ts --check` first.
  const actualHash = computeCorpusContentHash(corpus);
  if (actualHash !== storedHash) {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json is stale — the loaded runbook corpus does not match the corpus its " +
        "numbers were computed against. Regenerate with " +
        "`pnpm exec tsx runbooks-eval/score-query-set.ts`.",
    );
  }

  // Issue #76 §2.5 / round-2 fix #2 — independent queryContentHash check,
  // applied to EVERY retriever selection (not only frozen-embedding).
  const storedQueryHash = parsed.queryContentHash;
  if (typeof storedQueryHash !== "string" || storedQueryHash.length === 0) {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json: queryContentHash must be a non-empty string.",
    );
  }
  let rawQuerySet: string;
  try {
    rawQuerySet = readQuerySet();
  } catch {
    throw new RetrievalQualityConfigError(
      "retrieval-query-set.json could not be read while validating query-set-scores.json's freshness.",
    );
  }
  const actualQueryHash = sha256(rawQuerySet);
  if (actualQueryHash !== storedQueryHash) {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json is stale — the loaded query set does not match the query set its numbers " +
        "were computed against. Regenerate with `pnpm exec tsx runbooks-eval/score-query-set.ts`.",
    );
  }

  const retrievers = parsed.retrievers;
  if (!isRecord(retrievers)) {
    throw new RetrievalQualityConfigError("query-set-scores.json: retrievers must be an object.");
  }
  const entry = retrievers[retrieverName];
  if (entry === undefined) {
    const available = Object.keys(retrievers).sort().join(", ") || "none";
    throw new RetrievalQualityConfigError(
      `${RETRIEVAL_QUALITY_RETRIEVER_ENV}="${retrieverName}" is not present in ` +
        `query-set-scores.json (available: ${available}).`,
    );
  }

  // Codex-review MAJOR fix, verified against source: the corpus-hash check
  // above catches a CONTENT edit but not a CONFIGURATION edit — changing
  // DEFAULT_BM25_RETRIEVER_MIN_SCORE, BM25_K1/B, or a keyword-retriever
  // weight changes what the retriever actually returns without touching the
  // corpus at all, and a direct eval-CLI invocation with no prior `--check`
  // run would otherwise attach the stale artifact's numbers silently. Both
  // this module and score-query-set.ts read the SAME CURRENT_RETRIEVER_FINGERPRINTS
  // map (retriever-fingerprints.ts) — never independently recomputed — so
  // this comparison can never itself drift out of sync with what the
  // artifact was actually stamped with.
  const storedFingerprints = parsed.retrieverFingerprints;
  if (!isRecord(storedFingerprints)) {
    throw new RetrievalQualityConfigError(
      "query-set-scores.json: retrieverFingerprints must be an object.",
    );
  }
  const storedFingerprint = storedFingerprints[retrieverName];

  // Issue #76 §2.5 / round-2 fix #3 — "frozen-embedding" has no static
  // CURRENT_RETRIEVER_FINGERPRINTS entry (deliberately — plan §0 fix 1's
  // Dockerfile-boundary rule keeps that map I/O-free for production-import
  // safety), so its current fingerprint is derived here, on demand, from the
  // loaded embedding fixture instead.
  const currentFingerprint =
    retrieverName === FROZEN_EMBEDDING_RETRIEVER_NAME
      ? deriveFrozenEmbeddingFingerprint(readEmbeddingFixture)
      : CURRENT_RETRIEVER_FINGERPRINTS[retrieverName];

  if (currentFingerprint === undefined) {
    throw new RetrievalQualityConfigError(
      `${RETRIEVAL_QUALITY_RETRIEVER_ENV}="${retrieverName}" has no known current configuration ` +
        `fingerprint — it is not one of this codebase's retriever candidates.`,
    );
  }
  if (storedFingerprint !== currentFingerprint) {
    throw new RetrievalQualityConfigError(
      `query-set-scores.json is stale — retriever "${retrieverName}"'s configuration (threshold, ` +
        "scoring parameters) no longer matches what its numbers were computed against. " +
        "Regenerate with `pnpm exec tsx runbooks-eval/score-query-set.ts`.",
    );
  }
  if (!isRecord(entry)) {
    throw new RetrievalQualityConfigError(
      `query-set-scores.json: retrievers.${retrieverName} must be an object.`,
    );
  }

  return {
    retrieverName,
    corpusContentHash: storedHash,
    recallAtK: parseGrouped(entry.recallAtK, `retrievers.${retrieverName}.recallAtK`),
    meanReciprocalRank: parseGrouped(
      entry.meanReciprocalRank,
      `retrievers.${retrieverName}.meanReciprocalRank`,
    ),
    falsePositiveRate: parseRatio(
      entry.falsePositiveRate,
      `retrievers.${retrieverName}.falsePositiveRate`,
    ),
  };
}
