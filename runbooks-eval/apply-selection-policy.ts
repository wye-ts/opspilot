/**
 * Issue #76 §2.6 — applies the milestone-declared selection policy
 * (docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md §2.1)
 * mechanically to a QuerySetScores comparison result, plus the narrowly-
 * scoped tie-break this issue's own plan adds (§2.6, round-2 Codex-review
 * MAJOR fix #4) for the one gap the milestone policy's own text leaves
 * open: what happens when two or more candidates that both clear the two
 * minimum bars tie EXACTLY on the metric deciding the tier.
 *
 * Run:
 *   pnpm exec tsx runbooks-eval/apply-selection-policy.ts
 *
 * Policy (verbatim from the milestone plan §2.1):
 *   1. Primary: paraphrase-group recall@k. Highest wins, provided it clears
 *      two bars: falsePositiveRate must not exceed keyword's own measured
 *      falsePositiveRate, and exact-group recall@k must not fall more than
 *      10 percentage points below keyword's exact-group recall@k.
 *   2. Tie-break / no candidate clears both bars: fall back to exact-group
 *      recall@k as the deciding metric under the same falsePositiveRate
 *      non-regression bar (note: ONLY the falsePositiveRate bar carries
 *      over — the exact-recall-non-regression bar is specific to tier 1,
 *      since exact recall IS the deciding metric at tier 2).
 *   3. No retriever beats keyword on the primary metric while clearing both
 *      bars, and none clears the falsePositiveRate bar at tier 2 either:
 *      keyword stays — "no change" is a legitimate outcome.
 *
 * Tie-break addition (this issue's plan §2.6): among non-keyword candidates
 * that clear the relevant tier's bar(s), keyword is always included as a
 * ranking participant (it trivially satisfies any bar defined relative to
 * itself) — so a tie at the top of a tier's ranking that includes keyword
 * resolves to keyword; a tie among non-keyword candidates only resolves by
 * lower falsePositiveRate. Tier 3 ("no change") is reserved for the case
 * where NO non-keyword candidate clears even the weakest applicable bar —
 * this is what makes tier 3 structurally reachable rather than dead code:
 * eligibility is evaluated over NON-keyword candidates only, with keyword
 * folded into the ranking pool afterward, never into the eligibility check
 * itself (keyword comparing its own falsePositiveRate/exact-recall against
 * itself would otherwise trivially "pass" every bar, making tier 3
 * unreachable).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { MetricRatio, QuerySetScores, RetrieverScores } from "./score-query-set";

const SCORES_PATH = path.resolve(__dirname, "query-set-scores.json");

const KEYWORD_NAME = "keyword";
const EXACT_RECALL_NON_REGRESSION_POINTS = 10;

export type SelectionTier = "primary-paraphrase-recall" | "tiebreak-exact-recall" | "no-change";

export interface SelectionResult {
  readonly tier: SelectionTier;
  readonly winner: string;
  readonly tiedCandidates: readonly string[];
  readonly tieBrokenBy: "keyword-participant" | "lower-false-positive-rate" | null;
}

function ratioValue(ratio: MetricRatio): number {
  if (ratio.denominator === 0) return 0;
  return ratio.numerator / ratio.denominator;
}

function clearsFalsePositiveBar(candidate: RetrieverScores, keywordScores: RetrieverScores): boolean {
  return ratioValue(candidate.falsePositiveRate) <= ratioValue(keywordScores.falsePositiveRate);
}

function clearsExactRecallNonRegressionBar(candidate: RetrieverScores, keywordScores: RetrieverScores): boolean {
  return (
    ratioValue(candidate.recallAtK.exact) >=
    ratioValue(keywordScores.recallAtK.exact) - EXACT_RECALL_NON_REGRESSION_POINTS / 100
  );
}

// Ranks `pool` (which always includes keyword — it is always a legitimate
// "no better challenger" baseline) by `pick`, applying this issue's
// tie-break rule to the top-scoring subset.
function rankPool(
  pool: readonly string[],
  scores: Readonly<Record<string, RetrieverScores>>,
  pick: (entry: RetrieverScores) => MetricRatio,
): { winner: string; tied: readonly string[]; tieBrokenBy: SelectionResult["tieBrokenBy"] } {
  const values = pool.map((name) => ({ name, value: ratioValue(pick(scores[name]!)) }));
  const maxValue = Math.max(...values.map((entry) => entry.value));
  const tied = values.filter((entry) => entry.value === maxValue).map((entry) => entry.name);

  if (tied.length === 1) {
    return { winner: tied[0]!, tied, tieBrokenBy: null };
  }
  if (tied.includes(KEYWORD_NAME)) {
    return { winner: KEYWORD_NAME, tied, tieBrokenBy: "keyword-participant" };
  }
  const lowestFalsePositive = tied
    .map((name) => ({ name, fpr: ratioValue(scores[name]!.falsePositiveRate) }))
    .sort((a, b) => a.fpr - b.fpr)[0]!;
  return { winner: lowestFalsePositive.name, tied, tieBrokenBy: "lower-false-positive-rate" };
}

export function applySelectionPolicy(scores: QuerySetScores): SelectionResult {
  const keywordScores = scores.retrievers[KEYWORD_NAME];
  if (keywordScores === undefined) {
    throw new Error("applySelectionPolicy: query-set-scores.json has no 'keyword' entry to compare against.");
  }

  const nonKeywordNames = Object.keys(scores.retrievers).filter((name) => name !== KEYWORD_NAME);

  // Tier 1: candidates clearing BOTH bars (falsePositiveRate non-regression
  // AND exact-recall non-regression), ranked by paraphrase recall@k.
  const tier1Eligible = nonKeywordNames.filter(
    (name) =>
      clearsFalsePositiveBar(scores.retrievers[name]!, keywordScores) &&
      clearsExactRecallNonRegressionBar(scores.retrievers[name]!, keywordScores),
  );
  if (tier1Eligible.length > 0) {
    const result = rankPool([...tier1Eligible, KEYWORD_NAME], scores.retrievers, (entry) => entry.recallAtK.paraphrase);
    return { tier: "primary-paraphrase-recall", winner: result.winner, tiedCandidates: result.tied, tieBrokenBy: result.tieBrokenBy };
  }

  // Tier 2: candidates clearing ONLY the falsePositiveRate bar (the
  // exact-recall bar does not apply once exact recall itself becomes the
  // deciding metric), ranked by exact recall@k.
  const tier2Eligible = nonKeywordNames.filter((name) => clearsFalsePositiveBar(scores.retrievers[name]!, keywordScores));
  if (tier2Eligible.length > 0) {
    const result = rankPool([...tier2Eligible, KEYWORD_NAME], scores.retrievers, (entry) => entry.recallAtK.exact);
    return { tier: "tiebreak-exact-recall", winner: result.winner, tiedCandidates: result.tied, tieBrokenBy: result.tieBrokenBy };
  }

  // Tier 3: no non-keyword candidate clears even the falsePositiveRate bar.
  return { tier: "no-change", winner: KEYWORD_NAME, tiedCandidates: [KEYWORD_NAME], tieBrokenBy: null };
}

function render(result: SelectionResult): string {
  const lines = [
    `Selection policy result: tier=${result.tier}`,
    `Winner: ${result.winner}`,
    `Tied candidates at deciding tier: ${result.tiedCandidates.join(", ")}`,
    `Tie broken by: ${result.tieBrokenBy ?? "n/a (outright win or no-change)"}`,
  ];
  return lines.join("\n");
}

function main(): void {
  const scores = JSON.parse(readFileSync(SCORES_PATH, "utf8")) as QuerySetScores;
  console.log(render(applySelectionPolicy(scores)));
}

if (require.main === module) {
  main();
}
