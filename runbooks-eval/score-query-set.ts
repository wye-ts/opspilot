/**
 * Issue #75 — retrieval-quality scoring script (plan §2.1, §2.1a).
 *
 * Computes recall@k / mean reciprocal rank (per exact/paraphrase/near_miss
 * group) and falsePositiveRate (true_negative group) for EVERY candidate
 * retriever, against the committed labeled query set, using each retriever's
 * REAL `retrieve()` — the same code path production and the eval harness call.
 *
 * Run:
 *   pnpm exec tsx runbooks-eval/score-query-set.ts            # regenerate
 *   pnpm exec tsx runbooks-eval/score-query-set.ts --check    # fail on stale
 *
 * Output: runbooks-eval/query-set-scores.json, keyed BY RETRIEVER NAME (never
 * a flat unlabeled object — a flat shape can only ever carry one retriever's
 * numbers, silently discarding the rest; plan §2.1's round-1 BLOCKER fix), plus
 * a human-readable side-by-side comparison table on stdout.
 *
 * Freshness (plan §2.1a): the artifact carries real SHA-256 content hashes of
 * the loaded corpus and of retrieval-query-set.json's own bytes, plus a
 * per-retriever configuration fingerprint — never a hand-maintained version
 * string that editing a runbook does nothing to change. `--check` recomputes
 * everything fresh and byte-compares, exiting 1 on any mismatch. The eval CLI
 * (apps/worker/src/evaluation/run-eval.ts) independently re-derives
 * corpusContentHash at run time, so a stale artifact is rejected even without
 * a prior `--check` invocation.
 *
 * Metric definitions (plan §2.1, §2.2):
 *   - recallAtK (k = EVALUATION_TOP_K = 3): a query is a hit iff at least one
 *     of its expectedChunkIds appears in retrieve({query, topK: 3}).
 *   - meanReciprocalRank: encoded in SIXTHS as exact integers — each query
 *     contributes reciprocalRank * 6, i.e. 6 (rank 1), 3 (rank 2), 2 (rank 3),
 *     or 0 (miss); numerator is their sum, denominator is queryCount * 6.
 *     A float mean rounded back into numerator/denominator is lossy and
 *     diverges by language at exact tie points (Python banker's rounding vs.
 *     JS round-half-up) — the sixths encoding has no floating-point step at
 *     the persistence boundary at all.
 *   - falsePositiveRate (true_negative only): a query counts as a false
 *     positive iff the retriever's THRESHOLDED retrieve() returns ANY chunk.
 *     recall@k/MRR are deliberately NOT computed for true_negative — they are
 *     undefined for a query with no correct answer.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  BM25_B,
  BM25_K1,
  BM25RunbookRetriever,
  DEFAULT_BM25_RETRIEVER_MIN_SCORE,
} from "../packages/agent-runtime/src/rag/bm25-runbook-retriever";
import { computeCorpusContentHash } from "../packages/agent-runtime/src/rag/corpus-content-hash";
import {
  DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE,
  InMemoryKeywordRunbookRetriever,
} from "../packages/agent-runtime/src/rag/in-memory-runbook-retriever";
import { loadDefaultRunbookCorpus } from "../packages/agent-runtime/src/rag/load-default-runbook-corpus";
import type { RunbookRetriever, StoredRunbookChunk } from "../packages/agent-runtime/src/rag/runbook-retriever";
import { parseQuerySet, QUERY_SET_PATH, type QueryRecord } from "./validate-query-set";

export const SCORES_PATH = path.resolve(__dirname, "query-set-scores.json");

// Mirrors apps/worker/src/evaluation/types.ts's EVALUATION_TOP_K, following
// validate-query-set.ts's existing local-mirror convention.
const EVALUATION_TOP_K = 3;

// The LCM of every possible reciprocal-rank denominator at k = 3 ({1, 2, 3}),
// which makes every per-query contribution an exact integer.
const MRR_SCALE = 6;

export interface MetricRatio {
  readonly numerator: number;
  readonly denominator: number;
}

export interface GroupedRatios {
  readonly exact: MetricRatio;
  readonly paraphrase: MetricRatio;
  readonly nearMiss: MetricRatio;
}

export interface RetrieverScores {
  readonly recallAtK: GroupedRatios;
  readonly meanReciprocalRank: GroupedRatios;
  readonly falsePositiveRate: MetricRatio;
}

export interface QuerySetScores {
  readonly corpusContentHash: string;
  readonly queryContentHash: string;
  readonly retrieverFingerprints: Readonly<Record<string, string>>;
  readonly retrievers: Readonly<Record<string, RetrieverScores>>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// computeCorpusContentHash lives in packages/agent-runtime (imported above)
// rather than here, because apps/worker's eval CLI must re-derive the SAME
// hash from its own freshly-loaded corpus at run time — a second copy would
// defeat the freshness check the first time either was edited. See that
// module's comment.

// A hash of a retriever's effective, score-affecting configuration: its class
// name, its enforced threshold, and every tunable parameter. Changing k1/b or
// the frozen threshold changes this, which invalidates the artifact.
function fingerprint(className: string, minScore: number, params: Readonly<Record<string, number>>): string {
  return sha256(JSON.stringify({ className, minScore, params }));
}

export interface RetrieverCandidate {
  readonly name: string;
  readonly fingerprint: string;
  build(corpus: readonly StoredRunbookChunk[]): RunbookRetriever;
}

// The candidate set this issue compares. #76 adds a third (frozen-embedding)
// entry here without any schema change — the artifact is keyed by name.
export const RETRIEVER_CANDIDATES: readonly RetrieverCandidate[] = [
  {
    name: "keyword",
    fingerprint: fingerprint(
      "InMemoryKeywordRunbookRetriever",
      DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE,
      { titleWeight: 2, contentWeight: 1 },
    ),
    build: (corpus) => new InMemoryKeywordRunbookRetriever(corpus, DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE),
  },
  {
    name: "bm25",
    fingerprint: fingerprint("BM25RunbookRetriever", DEFAULT_BM25_RETRIEVER_MIN_SCORE, {
      k1: BM25_K1,
      b: BM25_B,
    }),
    build: (corpus) => new BM25RunbookRetriever(corpus, DEFAULT_BM25_RETRIEVER_MIN_SCORE),
  },
];

const SCORED_GROUPS = ["exact", "paraphrase", "near_miss"] as const;
type ScoredGroup = (typeof SCORED_GROUPS)[number];

const GROUP_FIELD: Readonly<Record<ScoredGroup, keyof GroupedRatios>> = {
  exact: "exact",
  paraphrase: "paraphrase",
  near_miss: "nearMiss",
};

async function scoreGroup(
  retriever: RunbookRetriever,
  records: readonly QueryRecord[],
): Promise<{ recall: MetricRatio; mrr: MetricRatio }> {
  let hits = 0;
  let reciprocalSixths = 0;

  for (const record of records) {
    const results = await retriever.retrieve({ query: record.query, topK: EVALUATION_TOP_K });
    const expected = new Set(record.expectedChunkIds);
    const firstCorrect = results.find((entry) => expected.has(entry.chunkId));

    if (firstCorrect !== undefined) {
      hits += 1;
      // rank is 1-indexed and bounded by EVALUATION_TOP_K, so MRR_SCALE /
      // rank is always one of {6, 3, 2} — an exact integer, never a float.
      reciprocalSixths += MRR_SCALE / firstCorrect.rank;
    }
  }

  return {
    recall: { numerator: hits, denominator: records.length },
    mrr: { numerator: reciprocalSixths, denominator: records.length * MRR_SCALE },
  };
}

export async function scoreRetriever(
  candidate: RetrieverCandidate,
  corpus: readonly StoredRunbookChunk[],
  queries: readonly QueryRecord[],
): Promise<RetrieverScores> {
  const retriever = candidate.build(corpus);

  const recall = {} as Record<keyof GroupedRatios, MetricRatio>;
  const mrr = {} as Record<keyof GroupedRatios, MetricRatio>;

  for (const group of SCORED_GROUPS) {
    const records = queries.filter((record) => record.group === group);
    const scored = await scoreGroup(retriever, records);
    recall[GROUP_FIELD[group]] = scored.recall;
    mrr[GROUP_FIELD[group]] = scored.mrr;
  }

  // falsePositiveRate — the THRESHOLDED retrieve() is the point: computing it
  // against raw pre-threshold scores would answer "does a wrong chunk score
  // above zero" (what validate-query-set.ts deliberately asks) rather than
  // "does the deployed retriever actually surface one".
  const trueNegatives = queries.filter((record) => record.group === "true_negative");
  let falsePositives = 0;
  for (const record of trueNegatives) {
    const results = await retriever.retrieve({ query: record.query, topK: EVALUATION_TOP_K });
    if (results.length > 0) falsePositives += 1;
  }

  return {
    recallAtK: recall as GroupedRatios,
    meanReciprocalRank: mrr as GroupedRatios,
    falsePositiveRate: { numerator: falsePositives, denominator: trueNegatives.length },
  };
}

export async function computeQuerySetScores(): Promise<QuerySetScores> {
  const corpusLoad = await loadDefaultRunbookCorpus();
  const rawQuerySet = readFileSync(QUERY_SET_PATH, "utf8");
  const { querySet, errors } = parseQuerySet(rawQuerySet);
  if (querySet === null) {
    throw new Error(`retrieval-query-set.json is malformed: ${errors.join("; ")}`);
  }

  const retrievers: Record<string, RetrieverScores> = {};
  const retrieverFingerprints: Record<string, string> = {};
  for (const candidate of RETRIEVER_CANDIDATES) {
    retrievers[candidate.name] = await scoreRetriever(candidate, corpusLoad.chunks, querySet.queries);
    retrieverFingerprints[candidate.name] = candidate.fingerprint;
  }

  return {
    corpusContentHash: computeCorpusContentHash(corpusLoad.chunks),
    queryContentHash: sha256(rawQuerySet),
    retrieverFingerprints,
    retrievers,
  };
}

// Deterministic serialization (fixed key order via the construction above,
// 2-space indent, trailing newline) so `--check`'s byte comparison is a real
// check and not a formatting coin flip.
export function serializeScores(scores: QuerySetScores): string {
  return `${JSON.stringify(scores, null, 2)}\n`;
}

function formatRatio(ratio: MetricRatio): string {
  if (ratio.denominator === 0) return `${ratio.numerator}/${ratio.denominator} (n/a)`;
  const value = ratio.numerator / ratio.denominator;
  return `${ratio.numerator}/${ratio.denominator} (${value.toFixed(3)})`;
}

// The retriever-vs-retriever comparison artifact this issue exists to produce
// — plain text, mirroring formatEvaluationReport's convention.
export function formatComparisonTable(scores: QuerySetScores): string {
  const names = Object.keys(scores.retrievers);
  const rows: { readonly label: string; readonly cells: readonly string[] }[] = [];

  const push = (label: string, pick: (entry: RetrieverScores) => MetricRatio): void => {
    rows.push({ label, cells: names.map((name) => formatRatio(pick(scores.retrievers[name]!))) });
  };

  push("recall@3 exact", (entry) => entry.recallAtK.exact);
  push("recall@3 paraphrase", (entry) => entry.recallAtK.paraphrase);
  push("recall@3 near_miss", (entry) => entry.recallAtK.nearMiss);
  push("MRR exact (sixths)", (entry) => entry.meanReciprocalRank.exact);
  push("MRR paraphrase (sixths)", (entry) => entry.meanReciprocalRank.paraphrase);
  push("MRR near_miss (sixths)", (entry) => entry.meanReciprocalRank.nearMiss);
  push("falsePositiveRate (true_negative)", (entry) => entry.falsePositiveRate);

  const labelWidth = Math.max(...rows.map((row) => row.label.length), "metric".length);
  const columnWidth = Math.max(
    ...rows.flatMap((row) => row.cells.map((cell) => cell.length)),
    ...names.map((name) => name.length),
  );

  const lines: string[] = [
    "Retrieval quality — labeled query set (runbooks-eval/retrieval-query-set.json)",
    "",
    `${"metric".padEnd(labelWidth)}  ${names.map((name) => name.padEnd(columnWidth)).join("  ")}`,
    `${"-".repeat(labelWidth)}  ${names.map(() => "-".repeat(columnWidth)).join("  ")}`,
  ];
  for (const row of rows) {
    lines.push(`${row.label.padEnd(labelWidth)}  ${row.cells.map((cell) => cell.padEnd(columnWidth)).join("  ")}`);
  }
  lines.push(
    "",
    `corpusContentHash: ${scores.corpusContentHash}`,
    `queryContentHash:  ${scores.queryContentHash}`,
  );
  for (const name of names) {
    lines.push(`fingerprint[${name}]: ${scores.retrieverFingerprints[name]}`);
  }
  return lines.join("\n");
}

export const STALE_MESSAGE =
  "query-set-scores.json is stale — regenerate with `pnpm exec tsx runbooks-eval/score-query-set.ts`.";

async function main(): Promise<void> {
  const checkMode = process.argv.includes("--check");
  const scores = await computeQuerySetScores();
  const serialized = serializeScores(scores);

  console.log(formatComparisonTable(scores));

  if (checkMode) {
    let committed: string;
    try {
      committed = readFileSync(SCORES_PATH, "utf8");
    } catch {
      console.error(`\n${STALE_MESSAGE} (the file is missing)`);
      process.exitCode = 1;
      return;
    }
    if (committed !== serialized) {
      console.error(`\n${STALE_MESSAGE}`);
      process.exitCode = 1;
      return;
    }
    console.log("\nquery-set-scores.json is current.");
    return;
  }

  writeFileSync(SCORES_PATH, serialized, "utf8");
  console.log(`\nWrote ${path.relative(process.cwd(), SCORES_PATH)}.`);
}

if (require.main === module) {
  void main();
}
