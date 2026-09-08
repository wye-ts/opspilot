import { describe, expect, it } from "vitest";

import { calibrateRetriever } from "../../../../runbooks-eval/calibrate-min-score";
import type { QueryRecord } from "../../../../runbooks-eval/validate-query-set";
import type { RetrievalInput, RetrievedRunbookChunk, RunbookRetriever, StoredRunbookChunk } from "@opspilot/agent-runtime";

// Issue #76 §0/§0a — regression tests for calibrateRetriever()'s two round-2
// fixes: (1) the fractional-step sweep, which the pre-fix version could never
// select a nonzero threshold for (plan §0 fix 4), and (2) confirming
// calibration observes TRUE unthresholded scores from a fake retriever whose
// own minScore parameter is under the test's control (the general mechanism
// plan §0a fix 1 relies on — FixtureBackedRunbookRetriever's own dedicated
// test file covers ITS specific minScore=0 behavior).

const corpus: readonly StoredRunbookChunk[] = [
  { chunkId: "correct", runbookId: "r1", title: "Correct", content: "correct answer" },
  { chunkId: "distractor-1", runbookId: "r1", title: "Distractor 1", content: "distractor one" },
  { chunkId: "distractor-2", runbookId: "r1", title: "Distractor 2", content: "distractor two" },
];

// A minimal fake RunbookRetriever whose scores are fixed per-chunk, fed
// unthresholded (mirrors the shape calibrateRetriever's rawScore() helper
// expects: it calls retrieve() with a large topK and reads a chunk's score
// out of the result).
function buildFakeScoredRetriever(scoresByChunkId: Readonly<Record<string, number>>): RunbookRetriever {
  return {
    async retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]> {
      const scored = corpus
        .map((chunk) => ({ chunk, score: scoresByChunkId[chunk.chunkId] ?? 0 }))
        .sort((a, b) => b.score - a.score)
        .slice(0, input.topK);
      return scored.map(({ chunk, score }, index) => ({ ...chunk, score, rank: index + 1 }));
    },
  };
}

const queries: readonly QueryRecord[] = [
  {
    id: "q-exact",
    group: "exact",
    query: "the query",
    expectedChunkIds: ["correct"],
    distractorChunkIds: [],
  },
  {
    id: "q-near-miss",
    group: "near_miss",
    query: "the query",
    expectedChunkIds: ["correct"],
    distractorChunkIds: ["distractor-1", "distractor-2"],
  },
];

describe("calibrateRetriever step parameter", () => {
  it("with the default step=1, behaves exactly as the pre-#76 integer sweep for integer-scale scores", async () => {
    const retriever = buildFakeScoredRetriever({ correct: 5, "distractor-1": 3, "distractor-2": 2 });
    const result = await calibrateRetriever("test", () => retriever, corpus, queries);

    expect(result.step).toBe(1);
    // Both distractors (3, 2) must be excluded (target = ceil(2/2) = 2), and
    // the correct answer's score (5) must still clear the chosen floor.
    expect(result.chosenMinScore).toBe(3);
    expect(result.targetMet).toBe(true);
    expect(result.constraintSatisfied).toBe(true);
  });

  it("with a fractional step and a lowest-correct score below 1.0, selects a nonzero threshold when reachable (the concrete regression test for the pre-#76 bug)", async () => {
    // Pre-#76 bug: maxAllowed = Math.floor(lowestCorrectTop1Score) = floor(0.84) = 0,
    // so the sweep could only ever evaluate tick 0 (score 0) — never select a
    // nonzero threshold no matter how separable the scores were.
    const retriever = buildFakeScoredRetriever({ correct: 0.84, "distractor-1": 0.42, "distractor-2": 0.2 });
    const result = await calibrateRetriever("test", () => retriever, corpus, queries, 0.01);

    expect(result.step).toBe(0.01);
    expect(result.chosenMinScore).toBeGreaterThan(0);
    expect(result.chosenMinScore).toBeLessThanOrEqual(0.84);
    // Target = ceil(2 distractors / 2) = 1 — the SMALLEST threshold meeting
    // that target is chosen, which excludes only the lower-scoring
    // distractor (0.2), not necessarily both.
    expect(result.excludedDistractorCount).toBeGreaterThanOrEqual(1);
    expect(result.targetMet).toBe(true);
  });

  it("never exceeds the lowest correct-answer score, at any step size", async () => {
    const retriever = buildFakeScoredRetriever({ correct: 0.5, "distractor-1": 0.9, "distractor-2": 0.95 });
    const result = await calibrateRetriever("test", () => retriever, corpus, queries, 0.01);

    expect(result.chosenMinScore).toBeLessThanOrEqual(0.5);
    expect(result.constraintSatisfied).toBe(true);
  });

  it("falls back to the smallest tick achieving max exclusion when the target is unreachable under the constraint", async () => {
    // lowestCorrectTop1Score = 0.3 caps maxAllowedTicks; neither distractor
    // (0.35, 0.4) can be excluded without exceeding that cap, so the target
    // (exclude 2/2) is unreachable and the fallback (max achievable, 0) applies.
    const retriever = buildFakeScoredRetriever({ correct: 0.3, "distractor-1": 0.35, "distractor-2": 0.4 });
    const result = await calibrateRetriever("test", () => retriever, corpus, queries, 0.01);

    expect(result.targetMet).toBe(false);
    expect(result.chosenMinScore).toBe(0);
    expect(result.constraintSatisfied).toBe(true);
  });
});
