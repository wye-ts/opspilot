/**
 * Issue #74 — retrieval query-set validator.
 *
 * Standalone, committed authoring-time check for
 * `runbooks-eval/retrieval-query-set.json`. Deliberately NOT wired into
 * `pnpm --filter @opspilot/worker run eval`: the query set is inert data until
 * issue #75 adds the code that scores against it during a real eval run. This
 * script exists so #75 can extend it rather than re-derive the same invariants
 * (plan §2.3, §7 criterion 5).
 *
 * Run:
 *   pnpm exec tsx runbooks-eval/validate-query-set.ts
 *
 * Typecheck (runbooks-eval/ is a top-level fixture directory, not a pnpm
 * workspace package, so the repo-wide `pnpm typecheck` does not cover it —
 * this directory carries its own tsconfig for that purpose):
 *   pnpm exec tsc -p runbooks-eval/tsconfig.json
 *
 * Exits 0 when every check passes; 1 with a list of failures otherwise.
 *
 * Checks (plan §4 checks 4-5):
 *   1. Every record's `id` and `query` is a non-empty string; both are unique
 *      across the set.
 *   2. Every `group` is one of the four fixed literals, with EXACTLY the
 *      declared per-group counts (10 exact / 10 paraphrase / 12 near_miss /
 *      8 true_negative, 40 total).
 *   3. Every exact/paraphrase/near_miss record declares 1+ `expectedChunkIds`;
 *      every true_negative record declares exactly 0.
 *   4. Every `expectedChunkIds`/`distractorChunkIds` entry is a real chunk id
 *      in the loaded corpus.
 *   5. Distractor competitiveness, measured against the SHIPPED retriever's own
 *      scoring — never a re-implementation of it:
 *        (a) every declared distractor scores strictly > 0;
 *        (b) every near_miss query has >= 1 distractor inside the retriever's
 *            real top-3 (the harness's EVALUATION_TOP_K) that is not itself an
 *            expected answer;
 *        (c) >= 4 of the 12 near_miss queries have a distractor ranked ABOVE
 *            the correct answer today, so #75/#76's later BM25/embedding
 *            comparison has real room to show an improvement;
 *        (d) every true_negative query has >= 1 distractor scoring > 0 under
 *            the retriever's raw pre-threshold scoring — a plausible-but-wrong
 *            match, not a query the zero-score exclusion already filters for
 *            free.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { InMemoryKeywordRunbookRetriever } from "../packages/agent-runtime/src/rag/in-memory-runbook-retriever";
import { loadDefaultRunbookCorpus } from "../packages/agent-runtime/src/rag/load-default-runbook-corpus";
import type { StoredRunbookChunk } from "../packages/agent-runtime/src/rag/runbook-retriever";

// Mirrors apps/worker/src/evaluation/types.ts's EVALUATION_TOP_K. The near-miss
// competitiveness rules are only meaningful at the k the harness actually uses.
const EVALUATION_TOP_K = 3;

export const QUERY_GROUPS = ["exact", "paraphrase", "near_miss", "true_negative"] as const;
export type QueryGroup = (typeof QUERY_GROUPS)[number];

// Load-bearing for #75's per-group recall@k/MRR breakdown, not documentation.
export const REQUIRED_GROUP_COUNTS: Readonly<Record<QueryGroup, number>> = {
  exact: 10,
  paraphrase: 10,
  near_miss: 12,
  true_negative: 8,
};

// Plan §2.2: at least a third of the near-miss group must be queries the
// shipped keyword retriever gets WRONG today.
const MIN_NEAR_MISS_RETRIEVER_FAILURES = 4;

export interface QueryRecord {
  readonly id: string;
  readonly group: QueryGroup;
  readonly query: string;
  readonly expectedChunkIds: readonly string[];
  readonly distractorChunkIds: readonly string[];
}

export interface QuerySet {
  readonly corpusVersion: string;
  readonly queries: readonly QueryRecord[];
}

export const QUERY_SET_PATH = path.resolve(__dirname, "retrieval-query-set.json");

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Structural parse. Anything that is not shaped like a QuerySet is a hard
 * failure here rather than a confusing downstream error.
 */
export function parseQuerySet(raw: string): { querySet: QuerySet | null; errors: string[] } {
  const errors: string[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { querySet: null, errors: ["retrieval-query-set.json is not valid JSON."] };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { querySet: null, errors: ["retrieval-query-set.json must be a JSON object."] };
  }

  const candidate = parsed as Record<string, unknown>;

  // corpusVersion is a forward-compatible placeholder for #76's frozen-embedding
  // staleness guard (plan §5) — its VALUE is explicitly not checked here, only
  // that the field is present and a non-empty string.
  if (!isNonEmptyString(candidate.corpusVersion)) {
    errors.push("corpusVersion must be a non-empty string.");
  }

  if (!Array.isArray(candidate.queries)) {
    errors.push("queries must be an array.");
    return { querySet: null, errors };
  }

  const records: QueryRecord[] = [];
  candidate.queries.forEach((entry, index) => {
    const label = `queries[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${label} must be an object.`);
      return;
    }
    const record = entry as Record<string, unknown>;

    const allowedKeys = new Set(["id", "group", "query", "expectedChunkIds", "distractorChunkIds"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) errors.push(`${label} has an unknown field "${key}".`);
    }

    if (!isNonEmptyString(record.id)) errors.push(`${label}.id must be a non-empty string.`);
    if (!isNonEmptyString(record.query)) errors.push(`${label}.query must be a non-empty string.`);
    if (typeof record.group !== "string" || !(QUERY_GROUPS as readonly string[]).includes(record.group)) {
      errors.push(`${label}.group must be one of ${QUERY_GROUPS.join(" | ")}.`);
    }
    if (!isStringArray(record.expectedChunkIds)) {
      errors.push(`${label}.expectedChunkIds must be an array of strings.`);
    }
    if (!isStringArray(record.distractorChunkIds)) {
      errors.push(`${label}.distractorChunkIds must be an array of strings.`);
    }

    if (
      isNonEmptyString(record.id) &&
      isNonEmptyString(record.query) &&
      typeof record.group === "string" &&
      (QUERY_GROUPS as readonly string[]).includes(record.group) &&
      isStringArray(record.expectedChunkIds) &&
      isStringArray(record.distractorChunkIds)
    ) {
      records.push({
        id: record.id,
        group: record.group as QueryGroup,
        query: record.query,
        expectedChunkIds: record.expectedChunkIds,
        distractorChunkIds: record.distractorChunkIds,
      });
    }
  });

  if (errors.length > 0) return { querySet: null, errors };

  return {
    querySet: { corpusVersion: candidate.corpusVersion as string, queries: records },
    errors,
  };
}

/**
 * Raw pre-threshold score of ONE chunk for ONE query, obtained by running the
 * shipped retriever over a single-chunk corpus. This deliberately avoids
 * re-implementing scoreChunk(): the retriever excludes any chunk scoring 0
 * entirely, so an empty result means score 0 and a returned entry carries the
 * real score. If the retriever's scoring ever changes, this moves with it.
 */
async function rawScore(chunk: StoredRunbookChunk, query: string): Promise<number> {
  const isolated = new InMemoryKeywordRunbookRetriever([chunk]);
  const results = await isolated.retrieve({ query, topK: 1 });
  return results[0]?.score ?? 0;
}

export interface ValidationResult {
  readonly errors: readonly string[];
  readonly nearMissRetrieverFailures: readonly string[];
}

export async function validateQuerySet(
  querySet: QuerySet,
  corpus: readonly StoredRunbookChunk[],
): Promise<ValidationResult> {
  const errors: string[] = [];
  const retriever = new InMemoryKeywordRunbookRetriever(corpus);
  const chunksById = new Map(corpus.map((chunk) => [chunk.chunkId, chunk]));

  // --- Check 1: unique, non-empty ids and query texts -----------------------
  const seenIds = new Set<string>();
  const seenQueries = new Set<string>();
  for (const record of querySet.queries) {
    if (seenIds.has(record.id)) errors.push(`Duplicate query id "${record.id}".`);
    seenIds.add(record.id);

    const normalizedQuery = record.query.trim().toLowerCase();
    if (seenQueries.has(normalizedQuery)) {
      errors.push(`Duplicate query text on "${record.id}".`);
    }
    seenQueries.add(normalizedQuery);
  }

  // --- Check 2: exact per-group counts --------------------------------------
  const expectedTotal = Object.values(REQUIRED_GROUP_COUNTS).reduce((sum, n) => sum + n, 0);
  if (querySet.queries.length !== expectedTotal) {
    errors.push(`Expected ${expectedTotal} queries, found ${querySet.queries.length}.`);
  }
  for (const group of QUERY_GROUPS) {
    const actual = querySet.queries.filter((record) => record.group === group).length;
    const required = REQUIRED_GROUP_COUNTS[group];
    if (actual !== required) {
      errors.push(`Group "${group}" must have exactly ${required} queries, found ${actual}.`);
    }
  }

  // --- Check 3 + 4: label/answer consistency and corpus membership ----------
  for (const record of querySet.queries) {
    if (record.group === "true_negative") {
      if (record.expectedChunkIds.length !== 0) {
        errors.push(`${record.id}: a true_negative record must declare 0 expectedChunkIds.`);
      }
    } else if (record.expectedChunkIds.length === 0) {
      errors.push(`${record.id}: a ${record.group} record must declare 1+ expectedChunkIds.`);
    }

    for (const chunkId of [...record.expectedChunkIds, ...record.distractorChunkIds]) {
      if (!chunksById.has(chunkId)) {
        errors.push(`${record.id}: "${chunkId}" is not a chunk id in the loaded corpus.`);
      }
    }

    for (const chunkId of record.distractorChunkIds) {
      if (record.expectedChunkIds.includes(chunkId)) {
        errors.push(`${record.id}: "${chunkId}" is declared as both expected and distractor.`);
      }
    }

    if (
      (record.group === "near_miss" || record.group === "true_negative") &&
      record.distractorChunkIds.length === 0
    ) {
      errors.push(`${record.id}: a ${record.group} record must declare 1+ distractorChunkIds.`);
    }
  }

  // --- Check 5: distractor competitiveness against the real retriever -------
  const nearMissRetrieverFailures: string[] = [];

  for (const record of querySet.queries) {
    if (record.group !== "near_miss" && record.group !== "true_negative") continue;

    // (a) every declared distractor must score > 0.
    for (const chunkId of record.distractorChunkIds) {
      const chunk = chunksById.get(chunkId);
      if (chunk === undefined) continue; // already reported by check 4
      const score = await rawScore(chunk, record.query);
      if (score <= 0) {
        errors.push(
          `${record.id}: distractor "${chunkId}" scores ${score} (must be > 0 to be a plausible wrong match).`,
        );
      }
    }

    if (record.group === "true_negative") {
      // (d) covered by (a) above, which requires EVERY distractor to score > 0
      // — strictly stronger than the plan's "at least one". Nothing further.
      continue;
    }

    // (b) at least one distractor inside the real top-3, not an expected answer.
    const topK = await retriever.retrieve({ query: record.query, topK: EVALUATION_TOP_K });
    const rankOf = new Map(topK.map((entry) => [entry.chunkId, entry.rank]));

    const competingDistractors = record.distractorChunkIds.filter(
      (chunkId) => rankOf.has(chunkId) && !record.expectedChunkIds.includes(chunkId),
    );
    if (competingDistractors.length === 0) {
      errors.push(
        `${record.id}: no declared distractor ranks in the retriever's top-${EVALUATION_TOP_K} ` +
          `(returned: ${topK.map((entry) => entry.chunkId).join(", ") || "nothing"}).`,
      );
      continue;
    }

    // (c) does a distractor currently beat the correct answer? An expected
    // answer absent from the top-K is treated as ranking worse than anything
    // present in it.
    const bestExpectedRank = Math.min(
      ...record.expectedChunkIds.map((chunkId) => rankOf.get(chunkId) ?? Number.POSITIVE_INFINITY),
    );
    const bestDistractorRank = Math.min(
      ...competingDistractors.map((chunkId) => rankOf.get(chunkId) ?? Number.POSITIVE_INFINITY),
    );
    if (bestDistractorRank < bestExpectedRank) {
      nearMissRetrieverFailures.push(record.id);
    }
  }

  if (nearMissRetrieverFailures.length < MIN_NEAR_MISS_RETRIEVER_FAILURES) {
    errors.push(
      `At least ${MIN_NEAR_MISS_RETRIEVER_FAILURES} near_miss queries must have a distractor ranked ` +
        `above the correct answer under the shipped retriever; found ${nearMissRetrieverFailures.length}.`,
    );
  }

  return { errors, nearMissRetrieverFailures };
}

async function main(): Promise<void> {
  const corpusLoad = await loadDefaultRunbookCorpus();

  const { querySet, errors: parseErrors } = parseQuerySet(readFileSync(QUERY_SET_PATH, "utf8"));
  if (querySet === null) {
    console.error("Query-set validation FAILED (structure):");
    for (const error of parseErrors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  const { errors, nearMissRetrieverFailures } = await validateQuerySet(querySet, corpusLoad.chunks);

  console.log(
    `Corpus: ${corpusLoad.sourceFileCount} runbook files, ${corpusLoad.chunks.length} chunks.`,
  );
  console.log(`Query set: ${querySet.queries.length} records (corpusVersion "${querySet.corpusVersion}").`);
  for (const group of QUERY_GROUPS) {
    const count = querySet.queries.filter((record) => record.group === group).length;
    console.log(`  ${group.padEnd(14)} ${count}/${REQUIRED_GROUP_COUNTS[group]}`);
  }
  console.log(
    `near_miss queries the shipped keyword retriever gets WRONG today: ` +
      `${nearMissRetrieverFailures.length}/${REQUIRED_GROUP_COUNTS.near_miss} ` +
      `(minimum ${MIN_NEAR_MISS_RETRIEVER_FAILURES}) — ${nearMissRetrieverFailures.join(", ") || "none"}`,
  );

  if (errors.length > 0) {
    console.error(`\nQuery-set validation FAILED with ${errors.length} issue(s):`);
    for (const error of errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log("\nQuery-set validation PASSED.");
}

if (require.main === module) {
  void main();
}
