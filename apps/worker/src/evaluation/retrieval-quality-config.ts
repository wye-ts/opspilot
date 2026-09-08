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
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

// The SAME implementation runbooks-eval/score-query-set.ts uses to stamp the
// artifact — imported from the shared package, never re-derived here (see
// packages/agent-runtime/src/rag/corpus-content-hash.ts).
import { computeCorpusContentHash, CURRENT_RETRIEVER_FINGERPRINTS } from "../rag";
import type { MetricRatioInput, RetrievalQualityMetricsInput } from "./v2-types";

export const INCLUDE_RETRIEVAL_QUALITY_ENV = "EVALUATION_INCLUDE_RETRIEVAL_QUALITY";
export const RETRIEVAL_QUALITY_RETRIEVER_ENV = "EVALUATION_RETRIEVAL_QUALITY_RETRIEVER";

// runbooks-eval/ is a top-level fixture directory, not a workspace package —
// resolved relative to this file, the same way the parity fixture path is.
export const QUERY_SET_SCORES_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "runbooks-eval",
  "query-set-scores.json",
);

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

/**
 * Resolves the retrieval-quality input for this run, or `undefined` when the
 * feature is not enabled (the default for every existing CI/local invocation).
 *
 * Throws RetrievalQualityConfigError on: the selector env var missing while
 * the flag is set, an unreadable/malformed artifact, a retriever name absent
 * from the artifact, or an artifact whose stored corpusContentHash disagrees
 * with the hash of the corpus this run just loaded.
 */
export function resolveRetrievalQualityMetrics(
  env: RetrievalQualityEnv,
  corpus: readonly StoredRunbookChunk[],
  readArtifact: () => string = () => readFileSync(QUERY_SET_SCORES_PATH, "utf8"),
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
  const currentFingerprint = CURRENT_RETRIEVER_FINGERPRINTS[retrieverName];
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
