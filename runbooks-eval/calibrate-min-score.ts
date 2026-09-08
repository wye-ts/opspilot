/**
 * Issue #75 — minimum-score threshold calibration (plan §2.4).
 *
 * The frozen `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE` /
 * `DEFAULT_BM25_RETRIEVER_MIN_SCORE` values are the OUTPUT of this procedure,
 * which is committed (not just its resulting number) so it can be re-run
 * whenever the corpus or query set changes.
 *
 * Run:
 *   pnpm exec tsx runbooks-eval/calibrate-min-score.ts
 *   pnpm exec tsx runbooks-eval/calibrate-min-score.ts --check
 *
 * Procedure (fixed BEFORE any falsePositiveRate is measured — never tuned
 * after seeing a result, which is the overfitting risk the milestone plan's
 * own finding warns against):
 *
 *   Calibration set: the 12 near_miss queries' own `distractorChunkIds`,
 *   scored RAW (minScore = 0) — deliberately NOT the 8 true_negative queries,
 *   which are the held-out set `falsePositiveRate` is later measured against.
 *   #74's validator already proved every one of these distractors scores > 0
 *   and is topically plausible-but-wrong, so they are exactly the "wrong match
 *   a real query surfaces" population a floor should suppress.
 *
 *   Constraint: every `exact`/`paraphrase` query's own top-1 correct answer
 *   must still clear the floor (a threshold that silences a correct answer is
 *   not a candidate at any exclusion rate).
 *
 *   Choice: the SMALLEST integer threshold that excludes at least half of the
 *   calibration distractor scores while satisfying the constraint above. If no
 *   integer threshold excludes half of them (which is the real, observed case
 *   for the keyword retriever — its correct answers and its distractors overlap
 *   on the same small integer score scale, so the constraint binds first), the
 *   SMALLEST integer achieving the maximum exclusion the constraint allows is
 *   chosen, and the shortfall is reported explicitly rather than silently
 *   relaxing the correct-answer constraint. Smallest-of-equals matters: two
 *   thresholds that exclude the same distractors are not equivalent for
 *   anything outside the calibration set (a higher one suppresses strictly
 *   more real answers for no measured benefit), so the smallest is the
 *   demonstrably sufficient one.
 *
 * The result is written to `runbooks-eval/min-score-calibration.json` and must
 * agree with the two exported constants; `--check` recomputes and fails
 * closed on any disagreement (so a corpus/query-set/scoring edit that moves
 * the calibrated value cannot silently leave the constants stale).
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BM25RunbookRetriever,
  DEFAULT_BM25_RETRIEVER_MIN_SCORE,
} from "../packages/agent-runtime/src/rag/bm25-runbook-retriever";
import {
  DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE,
  InMemoryKeywordRunbookRetriever,
} from "../packages/agent-runtime/src/rag/in-memory-runbook-retriever";
import { loadDefaultRunbookCorpus } from "../packages/agent-runtime/src/rag/load-default-runbook-corpus";
import type { RunbookRetriever, StoredRunbookChunk } from "../packages/agent-runtime/src/rag/runbook-retriever";
import { parseQuerySet, QUERY_SET_PATH, type QueryRecord } from "./validate-query-set";

const CALIBRATION_PATH = path.resolve(__dirname, "min-score-calibration.json");

// Mirrors apps/worker/src/evaluation/types.ts's EVALUATION_TOP_K, following
// validate-query-set.ts's existing local-mirror convention (runbooks-eval/ has
// no dependency on apps/worker).
const EVALUATION_TOP_K = 3;

export interface RetrieverCalibration {
  readonly retrieverName: string;
  readonly chosenMinScore: number;
  readonly distractorScores: readonly number[];
  readonly excludedDistractorCount: number;
  readonly distractorExclusionTarget: number;
  readonly lowestCorrectTop1Score: number;
  readonly constraintSatisfied: boolean;
  readonly targetMet: boolean;
}

export interface CalibrationResult {
  readonly procedure: string;
  readonly retrievers: readonly RetrieverCalibration[];
}

// Raw (pre-threshold) score of ONE chunk for ONE query, read from a
// retriever built against the FULL corpus (Codex-review BLOCKER fix,
// verified against source: scoring against a single-chunk corpus makes
// BM25's IDF/length-normalization meaningless — N=1 always, so every
// distractor calibrates in a fictional one-document scoring space that
// disagrees with the real 24-chunk corpus every deployed retriever
// actually scores against). `topK` must be large enough to surface every
// chunk that scores > 0 for the query — the full corpus size is always
// sufficient since a retriever never returns more results than it has
// chunks.
async function rawScore(
  retriever: RunbookRetriever,
  corpusSize: number,
  chunkId: string,
  query: string,
): Promise<number> {
  const results = await retriever.retrieve({ query, topK: corpusSize });
  return results.find((entry) => entry.chunkId === chunkId)?.score ?? 0;
}

export async function calibrateRetriever(
  retrieverName: string,
  build: (corpus: readonly StoredRunbookChunk[]) => RunbookRetriever,
  corpus: readonly StoredRunbookChunk[],
  queries: readonly QueryRecord[],
): Promise<RetrieverCalibration> {
  const chunksById = new Map(corpus.map((chunk) => [chunk.chunkId, chunk]));
  const retriever = build(corpus);

  // --- Calibration population: near_miss distractor scores ------------------
  const distractorScores: number[] = [];
  for (const record of queries) {
    if (record.group !== "near_miss") continue;
    for (const chunkId of record.distractorChunkIds) {
      if (!chunksById.has(chunkId)) continue;
      distractorScores.push(await rawScore(retriever, corpus.length, chunkId, record.query));
    }
  }

  // --- Constraint population: each positive query's own correct top answer --
  // For an `exact` record this is its real top-1 (which #74's validator
  // already proves is an expected answer); for a `paraphrase` record it is the
  // best-scoring expected answer inside the real top-K. A floor above this
  // would silence a correct answer.
  let lowestCorrectTop1Score = Number.POSITIVE_INFINITY;
  for (const record of queries) {
    if (record.group !== "exact" && record.group !== "paraphrase") continue;
    const topK = await retriever.retrieve({ query: record.query, topK: EVALUATION_TOP_K });
    const expected = new Set(record.expectedChunkIds);
    const bestCorrect = topK.find((entry) => expected.has(entry.chunkId));
    if (bestCorrect === undefined) {
      // #74's validator forbids this; treat it as a hard zero so calibration
      // cannot silently produce a threshold that assumes it away.
      lowestCorrectTop1Score = 0;
      continue;
    }
    lowestCorrectTop1Score = Math.min(lowestCorrectTop1Score, bestCorrect.score);
  }
  if (!Number.isFinite(lowestCorrectTop1Score)) lowestCorrectTop1Score = 0;

  const distractorExclusionTarget = Math.ceil(distractorScores.length / 2);
  const maxAllowed = Math.floor(lowestCorrectTop1Score);

  // Smallest integer threshold meeting the exclusion target while never
  // exceeding the lowest correct-answer score. When the target is
  // unreachable under that constraint, fall back to the SMALLEST integer
  // achieving the maximum exclusion the constraint does allow.
  const excludedAt = (candidate: number): number =>
    distractorScores.filter((score) => score < candidate).length;

  let chosen = 0;
  let targetMet = false;
  for (let candidate = 0; candidate <= maxAllowed; candidate += 1) {
    if (excludedAt(candidate) >= distractorExclusionTarget) {
      chosen = candidate;
      targetMet = true;
      break;
    }
  }

  if (!targetMet) {
    let bestExcluded = -1;
    for (let candidate = 0; candidate <= maxAllowed; candidate += 1) {
      const excluded = excludedAt(candidate);
      if (excluded > bestExcluded) {
        bestExcluded = excluded;
        chosen = candidate;
      }
    }
  }

  const excludedDistractorCount = excludedAt(chosen);

  return {
    retrieverName,
    chosenMinScore: chosen,
    distractorScores,
    excludedDistractorCount,
    distractorExclusionTarget,
    lowestCorrectTop1Score,
    constraintSatisfied: chosen <= lowestCorrectTop1Score,
    targetMet,
  };
}

export async function computeCalibration(): Promise<CalibrationResult> {
  const corpusLoad = await loadDefaultRunbookCorpus();
  const { querySet, errors } = parseQuerySet(readFileSync(QUERY_SET_PATH, "utf8"));
  if (querySet === null) {
    throw new Error(`retrieval-query-set.json is malformed: ${errors.join("; ")}`);
  }

  return {
    procedure:
      "smallest integer minScore excluding >= half of the 12 near_miss queries' own distractor " +
      "scores (raw, pre-threshold) while every exact/paraphrase query's own correct top answer " +
      "still clears the floor; the 8 true_negative queries are held out for falsePositiveRate",
    retrievers: [
      await calibrateRetriever(
        "keyword",
        (corpus) => new InMemoryKeywordRunbookRetriever(corpus, 0),
        corpusLoad.chunks,
        querySet.queries,
      ),
      await calibrateRetriever(
        "bm25",
        (corpus) => new BM25RunbookRetriever(corpus, 0),
        corpusLoad.chunks,
        querySet.queries,
      ),
    ],
  };
}

function render(result: CalibrationResult): string {
  const lines: string[] = ["Minimum-score threshold calibration (issue #75 §2.4)", ""];
  for (const entry of result.retrievers) {
    const sorted = [...entry.distractorScores].sort((a, b) => a - b);
    lines.push(
      `${entry.retrieverName}:`,
      `  near_miss distractor scores (n=${sorted.length}): ${sorted.map((s) => s.toFixed(3)).join(", ")}`,
      `  lowest correct top-answer score across exact+paraphrase: ${entry.lowestCorrectTop1Score.toFixed(3)}`,
      `  chosen minScore: ${entry.chosenMinScore}`,
      `  distractors excluded: ${entry.excludedDistractorCount}/${sorted.length} ` +
        `(target >= ${entry.distractorExclusionTarget}, met: ${entry.targetMet})`,
      `  correct-answer constraint satisfied: ${entry.constraintSatisfied}`,
      "",
    );
  }
  return lines.join("\n");
}

// Serialized deterministically (fixed key order, 2-space indent, trailing
// newline) so `--check`'s byte comparison is meaningful.
function serialize(result: CalibrationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

const FROZEN_CONSTANTS: Readonly<Record<string, number>> = {
  keyword: DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE,
  bm25: DEFAULT_BM25_RETRIEVER_MIN_SCORE,
};

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const result = await computeCalibration();
  const serialized = serialize(result);

  console.log(render(result));

  const constantMismatches = result.retrievers
    .filter((entry) => FROZEN_CONSTANTS[entry.retrieverName] !== entry.chosenMinScore)
    .map(
      (entry) =>
        `${entry.retrieverName}: calibration produces ${entry.chosenMinScore}, ` +
        `but the exported constant is ${FROZEN_CONSTANTS[entry.retrieverName]}`,
    );

  if (checkMode) {
    let committed: string;
    try {
      committed = readFileSync(CALIBRATION_PATH, "utf8");
    } catch {
      console.error(
        "min-score-calibration.json is missing — regenerate with " +
          "`pnpm exec tsx runbooks-eval/calibrate-min-score.ts`.",
      );
      process.exitCode = 1;
      return;
    }
    if (committed !== serialized) {
      console.error(
        "min-score-calibration.json is stale — regenerate with " +
          "`pnpm exec tsx runbooks-eval/calibrate-min-score.ts`.",
      );
      process.exitCode = 1;
      return;
    }
    if (constantMismatches.length > 0) {
      console.error("Frozen threshold constants disagree with the calibration:");
      for (const message of constantMismatches) console.error(`  - ${message}`);
      process.exitCode = 1;
      return;
    }
    console.log("Calibration is current and matches the frozen constants.");
    return;
  }

  writeFileSync(CALIBRATION_PATH, serialized, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), CALIBRATION_PATH)}.`);
  if (constantMismatches.length > 0) {
    console.error("\nWARNING — frozen threshold constants disagree with this calibration:");
    for (const message of constantMismatches) console.error(`  - ${message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
