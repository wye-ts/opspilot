# Issue #75 — Add recall@k/MRR/falsePositiveRate metrics + BM25 retriever + metric read-compatibility

| | |
| --- | --- |
| Scope | #75 "Add recall@k/MRR/falsePositiveRate metrics + BM25 retriever + metric read-compatibility" — implements Milestone 13's Issue B (`docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md` §2.1, §6 step 2). Depends on #74 (merged, `fc46828`). |
| Basis | `main` @ `fc46828` (PR #82 merge), working tree clean |
| Status | Plan only. No repository source modified, no migration, no branch commit beyond this doc, push, PR, merge, or provider/LIVE request. |
| Branch | `feat/75-recall-metrics-bm25-retriever` (created, empty) |
| Committed location | `docs/reviews/29-issue-75-recall-metrics-bm25-retriever-plan.md` |

---

## Owner decision gate (2026-09-08) — where the new metrics come from

**Note on process:** this repo has no separate `docs/DECISIONS.md`/ADR log — decisions are recorded
inline in the governing plan document (per `opspilot-development` skill's template "Scope decision"
convention, e.g. #72/#74's plans). Recording this gate here, not in a new file.

**The problem this gate resolves:** the milestone plan (§2.1) specifies that `recallAtK`,
`meanReciprocalRank` (per exact/paraphrase/near-miss query group), and `falsePositiveRate`
(true-negative group) join the same persisted `EvaluationMetrics` shape the 20-case behavioral
harness already populates. But every existing ratio in that shape (`retrievalTop1`,
`rootCauseDiscipline`, etc.) is *derived from `EvaluationCase` check results* — a full simulated
agent run (retrieval → tool calls → report → checks). The 40 labeled queries authored in #74
(`runbooks-eval/retrieval-query-set.json`) are not `EvaluationCase`s: they carry no scenario, no
tool profile, no report expectations — just `{ query, group, expectedChunkIds, distractorChunkIds }`.
There is no case-derivation path these three metrics can travel through unmodified.

**Two candidate designs, both satisfying the milestone plan's literal text:**

1. **(Rejected) Port the retriever/corpus into the Python evaluation service** and have it
   independently score the 40-query set, alongside the TS worker doing the same, then compare.
   Rejected: `InMemoryKeywordRunbookRetriever`/`loadDefaultRunbookCorpus` exist only in
   `packages/agent-runtime` (TypeScript); porting them into Python creates a second scoring
   implementation of the same logic that can silently drift the first time either side's scoring
   rule changes (this is exactly the class of duplication `docs/opspilot-development`'s "move it,
   don't copy it" precedent and this repo's "smallest sufficient design" posture both exist to
   prevent). The milestone plan never asked for an independent Python-side retrieval
   implementation — only for the metrics to be computed and reported.
2. **(Adopted) Precompute the three ratios once, deterministically, in TS — outside the case
   harness — and pass them through as opaque, already-scored data.** A new script
   (`runbooks-eval/score-query-set.ts`, extending the pattern `runbooks-eval/validate-query-set.ts`
   already establishes: load the real corpus, construct the real retriever, call `retrieve()`
   directly, no case/scenario/tool machinery involved) computes `recallAtK`/`meanReciprocalRank` per
   group and `falsePositiveRate` for true-negative, for each of the (eventually two, keyword + BM25)
   retrievers under test. The three resulting `{numerator, denominator}` ratios are attached to
   `EvaluationSuiteInputV2` as a new **optional, pre-scored** field (not derived by either scorer).
   `LocalEvaluationScorer` and the Python service's `create_evaluation` both copy this field
   straight into the persisted `EvaluationMetrics` unchanged — neither one computes it, both merely
   carry it. This keeps cross-service parity trivial (both sides echo the same input) and adds zero
   new dependency or duplicated scoring logic to the Python service.

**Decision (owner, 2026-09-08): adopt option 2 (precompute-and-pass-through).**

**Consequence that must be stated explicitly in every place that touches the new fields (schema
comments, `_read_metrics`'s docstring, this plan's §2 design section):** the 15 (soon 18) existing
`EvaluationMetrics` fields share one semantic — "derived from this run's own case checks." The three
new fields (`recallAtK`, `meanReciprocalRank`, `falsePositiveRate`) have a **different** semantic —
"precomputed once against a fixed, versioned query set, independent of which case suite ran." A
future reader must not assume the new fields update per-run the way the other fifteen do; the
`corpusVersion` field already present in `retrieval-query-set.json` (added in #74 specifically as a
forward-compatible placeholder for this) is what changes when the precomputed numbers need
regenerating, not a new eval run.

**Revisit when:** if a future milestone genuinely needs the Python evaluation service to score
retrieval independently of the TS worker (e.g. a Python-native retriever candidate), this
pass-through design would need to be revisited — at that point a real second implementation becomes
justified, not merely convenient, and the "move it, don't copy it" objection above no longer applies
the same way.

---

## 0. Review-provenance correction (2026-09-08)

The version of this plan first committed as `9cec936` mislabeled its own review history: it cited
"Codex round-1" and "Codex round-2" findings throughout, implying two independent Codex review
passes. **Only one `pnpm agent:codex-review` call was ever made against this plan** (2026-09-08
00:05 UTC-7, recorded in `.agent/codex/review-findings.json` / `.agent/logs/codex-review.log`),
producing exactly four findings:

1. **[BLOCKER]** Nested retrieval metrics do not map to the flat persistence schema.
2. **[MAJOR]** Retriever identity and score provenance are discarded before persistence.
3. **[MAJOR]** The plan defines two incompatible MRR wire schemas.
4. **[MAJOR]** The claimed runtime corpus freshness check has no corpus binding.

Every in-line "Codex round-1"/"Codex round-2" citation below has been corrected to one of two real
states, checked against the finding list above:

- Where the citation matches one of the four real findings, it is now labeled plainly
  **"Codex-review [SEVERITY] fix"** (no round number — there was only one round).
- Where the citation described a fifth/sixth "finding" **not present** in the actual review output
  (the retriever-keyed `score-query-set.ts` output/CLI-selector requirement, and the
  `evaluation-runner.ts` second threshold-construction-site gap), it is now labeled
  **"self-identified during drafting — not a Codex finding"**. Both of these design points are
  still adopted in this plan on their own technical merits (verified against source directly, same
  as any other design decision here) — they were simply never raised by the actual review, and
  attributing them to it was inaccurate.

Per owner instruction (2026-09-08): this correction is a relabeling pass only. No additional
`agent:codex-review` round is being run to re-validate the plan; the four real findings above were
already fixed in the design sections below before this plan was first committed, and that remains
the basis for proceeding to implementation.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Persisted metrics shape (TS) | `apps/worker/src/evaluation/types.ts` (`EvaluationMetrics`), `evaluation-metrics.ts` (`aggregateMetrics`) | 15 `{numerator, denominator}` ratios: 6 original (`retrievalTop1`, `retrievalHitAt3`, `schemaHandlingCorrectness`, `evidenceGroundingCorrectness`, `toolCorrectness`, `expectedStatusCorrectness`) + 9 from #59 Checkpoint B (`rootCauseDiscipline`, ..., `deterministicRecovery`). All derived from `EvaluationCaseResultV2.checks[]` by check name via `simpleRatio`/`toolCorrectnessRatio`. |
| Persisted metrics shape (Python) | `services/evaluation/src/opspilot_evaluation/schemas.py` (`EvaluationMetrics`, `MetricRatio`), `scoring/metrics.py` (`aggregate_metrics`) | Exact mirror of the TS shape and derivation, field-for-field, ratio-for-ratio — parity-tested via `apps/worker/src/evaluation/parity-vectors.test.ts` and the cross-service-parity CI job. |
| Read-compatibility for persisted rows | `services/evaluation/src/opspilot_evaluation/api.py` `_read_metrics`, `ORIGINAL_METRIC_NAMES` (6) / `NEW_METRIC_NAMES` (9) | Accepts exactly two persisted shapes: 6-only (pre-#59) or 6+9 (post-#59). Fails closed (`INTERNAL_ERROR`) on a missing original, an unknown name, or a partial (some-but-not-all) `NEW_METRIC_NAMES` set. A pre-#59 row is served with the nine #59 ratios synthesized as 0/0 — never inventing PASS/FAIL rows. This is the exact precedent Milestone 13 §3 requires extending to a third generation. |
| Retriever interface | `packages/agent-runtime/src/rag/runbook-retriever.ts` | `RunbookRetriever.retrieve(input: RetrievalInput): Promise<readonly RetrievedRunbookChunk[]>`. `RetrievalInput = { query, topK }`. `RetrievedRunbookChunk` extends `StoredRunbookChunk` with `score`/`rank`. No relevance threshold in the interface itself — each implementation decides its own cutoff. |
| Shipped retriever | `packages/agent-runtime/src/rag/in-memory-runbook-retriever.ts` (`InMemoryKeywordRunbookRetriever`) | Token-overlap scoring (+2 title, +1 content, per query token after stopword filtering — #79 hotfix), chunks scoring 0 excluded entirely (an implicit `> 0` threshold already exists; #75 adds a real, configurable, nonzero floor on top of this, per milestone plan §2.1). Ties broken by `chunkId` ascending. This is what `apps/api`'s `RUNBOOK_RETRIEVER` provider token constructs (issue #72) and what every LIVE/FAKE run retrieves against. |
| Labeled query set | `runbooks-eval/retrieval-query-set.json` (40 records: 10 exact / 10 paraphrase / 12 near_miss / 8 true_negative), `runbooks-eval/validate-query-set.ts` | Committed in #74. Validator already proves, against the real shipped retriever: every `expectedChunkIds`/`distractorChunkIds` id is real; every near_miss query has a distractor in the real top-3 not itself an expected answer (>=4/12 where the distractor outranks the correct answer); every true_negative query has a distractor scoring `> 0` pre-threshold; every exact query's real top-1 is an expected answer; every paraphrase query has an expected answer in the real top-3. This is exactly the ground truth #75's new metrics script needs — the validator's `rawScore`/retrieval-calling pattern is the direct precedent for #75's scoring script. |
| Retrieval trace event shape | `packages/contracts/src/agent-trace-event.ts` (`RetrievalSummaryEntrySchema`) | `{ chunkId, rank, score }` only — `score` is already carried on every `RETRIEVAL_COMPLETED` trace event and therefore already reaches `ObservedFacts` if `buildObservedFacts` chooses to keep it (see next row). No schema change needed to add score visibility to the trace itself. |
| Eval-harness retrieval observation | `apps/worker/src/evaluation/observed-facts.ts` (`RetrievalFacts`) | Currently `{ completed: boolean, chunkIds: readonly string[] }` — retains chunk IDs only, discards each entry's `score` even though the trace event already carries it (`retrievalEvent.chunks.map((chunk) => chunk.chunkId)` drops `.score`/`.rank`). Milestone plan §2.1 calls for retaining score to support the real, enforced retriever threshold — but per the decision gate above, `falsePositiveRate` is computed by the new standalone script against the labeled query set directly (not through this observation path), so **no change to `ObservedFacts`/`observed-facts.ts` is required by this issue** — this narrows the milestone plan's stated need down to what #75 actually requires; flagged explicitly since the milestone plan implied a change here. |
| Cross-service parity test | `apps/worker/src/evaluation/parity-vectors.test.ts`, `fixtures/ts-parity-v2.json` | Regenerates a fixture from the real 20-case dataset and asserts byte-identical output against the committed fixture — the existing mechanism this issue's new field must not break (the fixture's `EvaluationSuiteInputV2` shape gets one new optional field; a 20-case run with the field omitted must still parity-match). |
| `EVALUATION_TOP_K` | `apps/worker/src/evaluation/types.ts:18` | `= 3`, used by the case harness. `runbooks-eval/validate-query-set.ts` already mirrors this constant locally (not imported, to keep `runbooks-eval/` free of a dependency on `apps/worker`) for its own top-3 checks — #75's new scoring script follows the same local-mirror convention, not a new shared import. |

---

## 2. Design

### 2.1 Retrieval-metrics scoring script (new, standalone — the mechanism behind the decision gate)

New file: `runbooks-eval/score-query-set.ts`. Sibling to `validate-query-set.ts`, reusing its
`parseQuerySet`/`QueryRecord`/`QUERY_GROUPS` exports (import from `./validate-query-set`, do not
duplicate the parsing logic).

For each retriever under test (keyword today; keyword + BM25 once §2.3 ships) and each of the three
scored groups (`exact`, `paraphrase`, `near_miss` — **not** `true_negative`, per the milestone
plan's explicit exclusion, §1 above):

- **`recallAtK`** (k = `EVALUATION_TOP_K` = 3, mirrored locally as in `validate-query-set.ts`):
  for each query, call `retriever.retrieve({ query, topK: 3 })`; the query counts as a hit iff at
  least one of its `expectedChunkIds` appears in the returned chunk ids. Ratio = hits / total
  queries in that group.
- **`meanReciprocalRank`**: for each query, find the rank (1-indexed) of the first returned chunk
  that is a member of `expectedChunkIds`; reciprocal is `1/rank`, or `0` if no expected chunk
  appears in the returned top-`k`. Because `k = 3`, every reciprocal rank is exactly one of
  `{1, 1/2, 1/3, 0}` — encoded in sixths as each query's integer contribution (`6`/`3`/`2`/`0`
  respectively; §2.2 explains why this exact-integer encoding replaces a naive float mean).
  The group's `numerator` is the sum of these integer contributions, `denominator` is
  `queryCount * 6` — carried as a `MetricRatio`, the same shape as every other metric in
  `EvaluationMetrics` (§2.2 schema note explains the rejected float-mean alternative).

For `true_negative`:

- **`falsePositiveRate`**: for each true-negative query, call `retriever.retrieve({ query, topK: 3
  })` **using the retriever's real, thresholded `retrieve()`** (§2.4 — the enforced minimum-score
  floor). The query counts as a false positive iff the retriever returns **any** chunk at all
  (every returned chunk is, by construction of the true-negative label, wrong). Ratio = false
  positives / total true-negative queries. This is why §2.4's threshold must be live in
  `retrieve()` itself before this ratio is computed — computing it against the pre-threshold score
  (as `validate-query-set.ts`'s existing checks do, deliberately, to prove distractor
  competitiveness) would answer a different question ("does a wrong chunk exist above zero") than
  the one `falsePositiveRate` needs to answer ("does the deployed retriever actually surface it").

**Script output shape (revised after Codex round-1 BLOCKER, verified against source before
accepting: the CLI wiring in §2.5 has no retriever selector, so a flat unlabeled metrics object
cannot represent two retrievers' worth of numbers without silently discarding one)** — a single
JSON file keyed by retriever name, both retrievers' full per-group numbers present side by side:

```json
{
  "corpusContentHash": "<sha256 of the canonical loaded corpus's chunk content, computed by hashing loadDefaultRunbookCorpus()'s own output — not a hand-maintained version string>",
  "queryContentHash": "<sha256 of retrieval-query-set.json's own contents>",
  "retrieverFingerprints": { "keyword": "<hash>", "bm25": "<hash>" },
  "retrievers": {
    "keyword": { "recallAtK": {...}, "meanReciprocalRank": {...}, "falsePositiveRate": {...} },
    "bm25": { "recallAtK": {...}, "meanReciprocalRank": {...}, "falsePositiveRate": {...} }
  }
}
```

`corpusContentHash`/`queryContentHash` are **computed hashes of the actual loaded content**
(Codex round-2 MAJOR fix, verified: the first draft's `corpusVersion` was a hand-maintained literal
string — `"issue-74-initial"` — that editing a runbook's prose does nothing to change; a real
freshness check needs the artifact bound to the content itself, not a string someone has to
remember to bump), replacing the human-maintained `corpusVersion` placeholder `retrieval-query-set.json`
introduced in #74 (that field can still exist there for human-readable labeling, but is no longer
what freshness checking keys off). `retrieverFingerprints` is a hash of each retriever's effective
configuration (class name + threshold value + any tunable parameter, e.g. BM25's k1/b). Written to
`runbooks-eval/query-set-scores.json` (committed). Also prints a human-readable comparison table
to stdout for the PR description (mirrors `formatEvaluationReport`'s plain-text convention) showing
both retrievers' numbers side by side — the actual retriever-vs-retriever comparison artifact this
issue exists to produce.

### 2.1a Freshness binding on the committed score artifact (Codex round-1 MAJOR, verified: nothing in
the first draft bound `query-set-scores.json` to the corpus/retriever state it was computed against
— exactly the same class of gap the milestone plan's own §2.1 already identifies and fixes for
#76's frozen-embedding fixture via a content-hash staleness guard; this issue's artifact needs the
identical treatment, not a weaker one just because it's cheap to regenerate)

`query-set-scores.json` carries `corpusContentHash`/`queryContentHash` (real content hashes, §2.1
above — **not** the human-maintained `corpusVersion` string, per the round-2 fix) and
`retrieverFingerprints` (above). `score-query-set.ts` gains a `--check` mode: it recomputes both
retrievers' numbers fresh against the current corpus/query-set/threshold configuration — hashing
the freshly-loaded corpus and query set exactly the same way the generator does — and byte-compares
the result to the committed file, exiting 1 with a clear "query-set-scores.json is stale —
regenerate with `pnpm exec tsx runbooks-eval/score-query-set.ts`" message on any mismatch — never
silently reading stale numbers. `pnpm agent:verify --final` (or a CI step) runs `score-query-set.ts
--check`, so a corpus edit, retriever scoring change, or threshold change that isn't accompanied by
a regenerated fixture fails CI the same way a stale `ts-parity-v2.json` already does today
(`parity-vectors.test.ts`'s existing regenerate-and-byte-compare pattern is the direct precedent,
reused here rather than inventing a new staleness-detection mechanism).

**The eval CLI itself (§2.5) also re-derives `corpusContentHash` from its own freshly-loaded corpus
at eval-run time and compares it to the artifact's stored hash before attaching
`retrievalQualityMetrics`** (Codex round-2 MAJOR fix, verified: the first draft's runtime check
compared only the hand-maintained `corpusVersion` string, which a corpus edit does nothing to
change — the CI-only `--check` mode alone was therefore the *only* real enforcement point, and a
direct eval-CLI invocation with a stale artifact but no prior `--check` run would silently pass).
This closes the gap without requiring `--check` to have run first: the CLI itself refuses to attach
a `retrievalQualityMetrics` value whose stored `corpusContentHash` disagrees with the hash of what
it just loaded, exiting with the same "stale — regenerate" error `--check` produces.

### 2.2 `EvaluationMetrics`/`EvaluationSuiteInputV2` schema additions (TS + Python)

**`EvaluationMetrics` (types.ts, schemas.py) gains four new fields**, appended after
`deterministicRecovery` (append-only, matching the #59 Checkpoint B precedent of extension by
addition, never reordering):

```ts
// Milestone 13 Issue B — precomputed against runbooks-eval/retrieval-query-set.json,
// NOT derived from this run's own EvaluationCaseResultV2 checks (see plan §0 decision
// gate). All four sub-metrics use the same {numerator, denominator} MetricRatio shape as
// every other EvaluationMetrics field — meanReciprocalRank is NOT a bare float (see the
// sixths-encoding note below this block for why a plain-number shape was rejected).
readonly recallAtK: {
  readonly exact: { readonly numerator: number; readonly denominator: number };
  readonly paraphrase: { readonly numerator: number; readonly denominator: number };
  readonly nearMiss: { readonly numerator: number; readonly denominator: number };
};
readonly meanReciprocalRank: {
  readonly exact: { readonly numerator: number; readonly denominator: number };
  readonly paraphrase: { readonly numerator: number; readonly denominator: number };
  readonly nearMiss: { readonly numerator: number; readonly denominator: number };
};
readonly falsePositiveRate: { readonly numerator: number; readonly denominator: number };

// Nullable provenance sibling (Codex round-2 MAJOR fix, §2.2 below): present iff the
// three fields above were populated from a real retrieval-quality run rather than left
// at the zero-default. Absent from every ordinary case-only run's persisted output.
readonly retrievalQualityProvenance: {
  readonly retrieverName: string;
  readonly corpusContentHash: string;
} | null;
```

Python mirror in `schemas.py` follows the exact same nesting (`RecallAtK`/`MeanReciprocalRank`
small nested `BaseModel`s, `model_config = ConfigDict(extra="forbid")` matching every existing
model in the file).

**`EvaluationSuiteInputV2` gains one new optional field** carrying the precomputed numbers for
**exactly one named retriever** through from the CLI to whichever scorer runs (never an unlabeled
blob — Codex round-1 BLOCKER fix, §2.1):

```ts
// Optional: present only when a retrieval-quality comparison run supplies it (via
// runbooks-eval/query-set-scores.json's per-retriever entry, §2.1/§2.5). Absent on an
// ordinary case-only eval run (e.g. CI's cross-service-parity job) — see §3 for what an
// absent value means for the persisted metrics. `retrieverName` records WHICH of
// query-set-scores.json's entries this run reports — comparing keyword vs. BM25 means
// running the CLI twice (once per retrieverName) and diffing the two persisted runs, the
// same "one config per run" shape every other eval-run dimension already follows (e.g.
// scorerSelection); it does not mean fabricating a combined multi-retriever run.
readonly retrievalQualityMetrics?: {
  readonly retrieverName: string;
  readonly recallAtK: { readonly exact: MetricRatio; readonly paraphrase: MetricRatio; readonly nearMiss: MetricRatio };
  readonly meanReciprocalRank: { readonly exact: MetricRatio; readonly paraphrase: MetricRatio; readonly nearMiss: MetricRatio };
  readonly falsePositiveRate: MetricRatio;
};
```

**`meanReciprocalRank`'s wire/persisted shape is `MetricRatio`, not a plain float** (revised after
Codex round-1 MAJOR, verified by direct calculation before accepting: a naive `round(mean *
denominator)` conversion is lossy and diverges by language at exact tie points — e.g. a 10-query
group with one rank-2 hit and nine misses has true MRR 0.05; `round(0.05 * 10) = round(0.5)`, which
Python's banker's-rounding yields `0` and JavaScript's `Math.round` yields `1`, producing two
different persisted values for the identical input depending on which service computed it).
Because `EVALUATION_TOP_K = 3` bounds every possible reciprocal rank to exactly `{1, 1/2, 1/3, 0}`,
sixths represent all four values as exact integers with no rounding at all: for each query, its
contribution is `reciprocalRank * 6` (`6` for rank 1, `3` for rank 2, `2` for rank 3, `0` for a
miss); the group's `numerator` is the sum of these integers, `denominator` is `queryCount * 6`. This
is exact (no floating-point conversion, no language-specific rounding mode), round-trips
losslessly through persistence, and preserves the existing `0/0`-means-absent /
`0/queryCount*6`-means-evaluated-all-miss distinction the rest of this schema already relies on.
The formatter divides `numerator/denominator` to render a human-readable mean, same as every other
ratio.

**Both scorers copy this field straight through, never compute it themselves, and both propagate
`retrievalQualityProvenance` alongside it (Codex round-2 MAJOR fix, §2.2's new nullable field —
verified: the first draft's `retrievalQualityMetrics.retrieverName` on the INPUT side had no
corresponding field anywhere on the persisted/OUTPUT `EvaluationMetrics`, so two runs — one scored
against keyword, one against BM25 — would persist indistinguishably once the transient request
context was gone):**

- `LocalEvaluationScorer.score()` (`evaluation-scorer.ts`): after computing the existing 15-field
  `aggregateMetrics(results)`, if `suiteInput.retrievalQualityMetrics` is present, spread its
  `recallAtK`/`meanReciprocalRank`/`falsePositiveRate` on top and set
  `retrievalQualityProvenance = { retrieverName: suiteInput.retrievalQualityMetrics.retrieverName,
  corpusContentHash: <the artifact's stored hash, threaded through from §2.1's file> }`; when
  absent, all three metric fields fall back to zero-ratio defaults (mirrors the exact
  `_zero_ratio()` pattern `schemas.py` already uses for the #59 fields) and
  `retrievalQualityProvenance` is `null` — distinct from, and simpler than, `_read_metrics`'s
  persisted-row read-compatibility case in §3, which handles an OLD ROW missing the field, not a
  current INPUT missing it.
- Python's `create_evaluation` (`api.py`): identical passthrough-or-null-provenance logic before
  calling `aggregate_metrics` (which itself gains the four new fields as parameters, or the
  passthrough happens at the `create_evaluation` call site, not inside `aggregate_metrics`, to keep
  that function's existing "operates only on case results" contract unchanged — implementer's
  choice, but the call site is where `retrievalQualityProvenance` must be threaded through
  regardless, since `aggregate_metrics` never sees `suiteInput`).

### 2.3 BM25 retriever

New file: `packages/agent-runtime/src/rag/bm25-runbook-retriever.ts`, implementing
`RunbookRetriever` (no interface change). Small in-repo implementation, no new dependency (matches
`InMemoryKeywordRunbookRetriever`'s own "implement it, don't import it" precedent, milestone plan
§2.1):

- Tokenize with the same `tokenize()`/stopword-filtered `tokenizeQuery()` split
  `in-memory-runbook-retriever.ts` already uses for queries (import and reuse, do not duplicate the
  stopword list — export it from the keyword retriever's module or hoist it into a shared
  `tokenize.ts` in the same directory; **hoisting is preferred** to avoid the keyword retriever
  file exporting internals it doesn't otherwise need to).
- Standard BM25 scoring (k1 = 1.5, b = 0.75 — the conventional defaults; no tuning corpus exists to
  justify anything else, and the milestone plan does not ask for calibration): IDF computed over
  the full corpus per unique query token (`ln((N - df + 0.5) / (df + 0.5) + 1)`, the standard
  Robertson/Sparck-Jones smoothed form that stays non-negative for `df <= N`), term frequency
  from chunk content (title text is concatenated into the scored document, weighted no differently
  from content — unlike the keyword retriever's title/content split — since BM25's own length
  normalization already handles the length difference between a short title and a longer body,
  and inventing a second title-boost mechanism on top of BM25 would just be recreating the keyword
  retriever's own heuristic inside a different algorithm).
- Own enforced minimum-score threshold (§2.4 applies symmetrically to both retrievers).
- Deterministic tie-break: score descending, `chunkId` ascending — identical convention to the
  keyword retriever.

### 2.4 Enforced minimum-score threshold — real `retrieve()` behavior, not an eval-only cutoff,
**and a single source of truth across every construction site** (Codex round-1 MAJOR, verified by
reading `apps/worker/src/evaluation/evaluation-runner.ts:46` directly: `runOneCase` constructs
`new InMemoryKeywordRunbookRetriever(effectiveCorpus)` with no threshold argument at all — the
first draft of this plan updated only `apps/api`'s construction site, leaving the 20-case
behavioral suite scoring against the legacy zero-threshold retriever while production filters
with the frozen value. A query whose expected chunk scores between 0 and the frozen threshold would
then pass the eval suite while failing in production — the exact silent-drift class the milestone
plan's own finding on this threshold already warns about, just at a second call site the first
draft missed)

Per milestone plan §2.1 (Codex-review MAJOR finding, already verified there): the threshold must be
the actual `retrieve()` filtering behavior every construction site shares — `apps/api`'s LIVE/FAKE
runs, the behavioral eval suite, AND `falsePositiveRate` scoring — never independently-tunable
numbers that can silently drift apart.

- The frozen threshold value (calibration procedure below) is exported as a single named constant
  — `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE` in `packages/agent-runtime/src/rag/in-memory-runbook-retriever.ts`
  (and its BM25 counterpart) — imported by every construction site, never re-declared as a literal
  at each call site. This is the actual fix: a single source of truth, not three independently
  passed numbers that happen to agree today.
- `InMemoryKeywordRunbookRetriever.retrieve()`: add a constructor-level `minScore` parameter,
  applied as `score >= minScore` alongside the existing `score > 0` filter (a strict superset —
  raising the floor above the current implicit `> 0` cutoff, never loosening it). Additive and
  backward-compatible for any call site that doesn't pass it (defaults to `0`, today's exact
  behavior) — but the three production-relevant call sites below are updated to pass
  `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE` explicitly, never relying on the zero default:
  1. `apps/api`'s `RUNBOOK_RETRIEVER` construction (`agent-runtime.module.ts`, from #72).
  2. `apps/worker/src/evaluation/evaluation-runner.ts`'s `runOneCase` — the exact gap this Codex
     finding caught. This is what makes the §4 "all 20 cases pass with the new threshold applied"
     verification claim actually true, rather than untested.
  3. `runbooks-eval/score-query-set.ts` (§2.1), when scoring the keyword retriever.
- `BM25RunbookRetriever`: same `minScore` constructor parameter and same single-constant
  requirement from day one (no legacy default to preserve, since it doesn't exist yet) — its own
  `DEFAULT_BM25_RETRIEVER_MIN_SCORE` constant, imported at the same three call sites once BM25 is
  also wired anywhere a retriever is constructed for one of those three purposes.
- **Threshold value is frozen BEFORE running `falsePositiveRate` against the true-negative group**
  (never tuned after seeing results — the exact overfitting risk the milestone plan's finding
  warns against). Calibration: run both retrievers' raw (unthresholded) scores against a **held-out
  calibration set distinct from the 8 committed true-negative queries** — the 12 near-miss queries'
  own `distractorChunkIds` scores (already validated by #74's validator to be `> 0` and
  topically-plausible-but-wrong) serve this purpose without authoring new fixture content: the
  threshold is set to the smallest integer value that excludes at least half of those distractor
  scores while still passing every `exact`/`paraphrase` query's own top-1 correct answer. This
  calibration procedure itself is committed (a documented step in `score-query-set.ts` or a
  sibling script), not just its resulting number, so it can be re-run if the corpus changes.

### 2.5 CLI wiring — `runbooks-eval/score-query-set.ts` output into a real eval run

`apps/worker/src/evaluation/run-eval.ts`'s CLI gains a new optional flag/env var (naming:
`--with-retrieval-quality` or `EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1`, consistent with this file's
`apps/worker/src/evaluation/run-eval.ts`'s CLI gains two new optional flag/env var pairs, consistent
with this file's existing env-var-driven configuration style:

- `EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1` — when set, reads the committed
  `runbooks-eval/query-set-scores.json` (§2.1's keyed-by-retriever output).
- `EVALUATION_RETRIEVAL_QUALITY_RETRIEVER=<name>` — **required whenever the flag above is set**
  (fails closed with a clear config error if omitted or if `<name>` isn't a key present in
  `query-set-scores.json`'s `retrievers` object) — selects exactly one retriever's entry from the
  keyed file (Codex round-1 BLOCKER fix, §2.1/§2.2: the file holds both retrievers' numbers, but
  one eval run reports on exactly one, the same "one config per run" convention
  `scorerSelection` already follows). The CLI also validates the selected entry's
  `corpusContentHash`/`retrieverFingerprints` (§2.1, §2.1a) against a freshly-computed hash of the
  currently-loaded corpus and the retriever's actual current configuration before attaching it,
  refusing to run with a stale artifact rather than silently reporting outdated numbers.

The selected retriever's entry is attached as `retrievalQualityMetrics` (§2.2, including its
`retrieverName`) on the `EvaluationSuiteInputV2` this run builds, before handing it to whichever
scorer is selected. Absent the flag (the default, including every existing CI/local invocation),
`retrievalQualityMetrics` stays `undefined` and the three new metric fields read as the
zero-default (§2.2) — **this is why the flag is opt-in, not automatic on every eval run**: the
existing 20-case behavioral suite and the retrieval-quality comparison are two different
measurements (per-run case correctness vs. a fixed-query-set retriever comparison), and forcing
every ordinary eval invocation to also load and attach retrieval-quality numbers would conflate
them silently in every persisted run's output. Comparing keyword vs. BM25 means running the CLI
twice, once per `EVALUATION_RETRIEVAL_QUALITY_RETRIEVER` value, and diffing the two persisted runs.

---

## 3. Compatibility — third read-compatibility shape, and the nested/flat persistence mapping

**Explicit bidirectional mapping between `EvaluationMetrics`'s nested wire shape and the flat
`evaluation_metrics` table's per-metric-name rows** (Codex round-2 BLOCKER fix, verified against
source before accepting: `_metric_ratio(metrics, name)` in `api.py` is `getattr(metrics, name)` —
it has no path to reach `metrics.recallAtK.exact` from the flat string `"recallAtKExact"`; the
first draft never specified this mapping and the existing helper cannot derive it automatically).
Add one small, explicit, hand-written mapping table in `api.py` (and its TS mirror in
`evaluation-metrics.ts`/`evaluation-scorer.ts`), used by both `_persist_evaluation` (nested → flat,
on write) and `_read_metrics` (flat → nested, on read) — never a generic reflective/dynamic
traversal, matching this file's existing preference for explicit, statically-checkable code over
metaprogramming:

```python
# Bidirectional, hand-written — not derived via getattr/setattr introspection, so a
# typo or a schema-shape change fails typecheck/tests immediately rather than at
# runtime. Each entry: (flat persisted name, path into the nested EvaluationMetrics model).
MILESTONE_13_METRIC_PATHS: tuple[tuple[str, tuple[str, str]], ...] = (
    ("recallAtKExact", ("recallAtK", "exact")),
    ("recallAtKParaphrase", ("recallAtK", "paraphrase")),
    ("recallAtKNearMiss", ("recallAtK", "nearMiss")),
    ("meanReciprocalRankExact", ("meanReciprocalRank", "exact")),
    ("meanReciprocalRankParaphrase", ("meanReciprocalRank", "paraphrase")),
    ("meanReciprocalRankNearMiss", ("meanReciprocalRank", "nearMiss")),
    ("falsePositiveRate", ("falsePositiveRate", None)),  # not nested — top-level MetricRatio
)
MILESTONE_13_METRIC_NAMES = tuple(flat_name for flat_name, _ in MILESTONE_13_METRIC_PATHS)
```

`_persist_evaluation` writes one `EvaluationMetric` row per `MILESTONE_13_METRIC_PATHS` entry,
resolving the nested path explicitly (`getattr(getattr(metrics, group), field)` when the path has
two segments, `getattr(metrics, group)` directly for `falsePositiveRate`) rather than a flat
`getattr(metrics, flat_name)` the model doesn't support. `_read_metrics` does the inverse: for each
`MILESTONE_13_METRIC_PATHS` entry present in the stored row set, construct the corresponding nested
`MetricRatio` (or `MetricRatio(0, 0)` for the whole generation when absent, exactly as the existing
two-shape logic already does for #59's fields) and assemble `recallAtK`/`meanReciprocalRank` as
nested objects before constructing the `EvaluationMetrics` response. The TS mirror
(`aggregateMetrics`/`evaluation-metrics.ts`'s persistence-adjacent helper, whichever module ends up
owning the flat<->nested conversion for the TS-side `LocalEvaluationScorer` path if it also
persists — see #3's cross-service parity test in §4) follows the identical explicit table, keyed by
the same seven flat names, so a Codex reviewer (or a future engineer) checking one side's mapping
against the other finds them structurally identical, not independently re-derived.

**`retrievalQualityProvenance` (§2.2) persists as two additional plain columns on the existing
`evaluation_run` row — `retrieval_quality_retriever_name: str | None` and
`retrieval_quality_corpus_hash: str | None`** (Codex round-2 MAJOR fix, verified: without this, two
persisted runs scored against different retrievers are indistinguishable once their originating
request is gone). Both are `NULL` for every ordinary case-only run — a genuinely new, small,
additive migration (one row, two nullable text columns, no backfill needed since no prior row could
ever have had these values). `_persist_evaluation` sets them from
`metrics.retrievalQualityProvenance` when non-null; `_read_metrics` reconstructs
`retrievalQualityProvenance` as `null` when both columns are `NULL` on the row (which is exactly
every pre-Milestone-13 row, satisfying the same read-compatibility requirement as the flat-metric
mapping above) or as `{retrieverName, corpusContentHash}` when both are present. A row with exactly
one of the two columns set is an internal-data inconsistency (the same "fail closed on a malformed
partial shape" discipline `_read_metrics` already applies to `NEW_METRIC_NAMES`) — reject via
`INTERNAL_ERROR`, don't guess.

Following `_read_metrics`'s exact established precedent (`ORIGINAL_METRIC_NAMES` /
`NEW_METRIC_NAMES`, §1 above) for the flat-metric-name generations themselves:

`meanReciprocalRank`'s three sub-fields persist as ordinary `MetricRatio` rows in the existing
`evaluation_metrics` table (no migration, no new column for these three — only the two provenance
columns above are new) — the sixths encoding fixed in §2.2 (Codex round-1 MAJOR fix) means
`numerator`/`denominator` are already exact integers with no lossy conversion at the persistence
boundary, unlike the rejected float-mean-times-rounding alternative that motivated this section
originally.

That gives exactly **seven** new persisted metric names (`MILESTONE_13_METRIC_NAMES`, derived from
`MILESTONE_13_METRIC_PATHS` above) plus the two new nullable provenance columns. `_read_metrics`
extends to accept **three** valid persisted shapes (6-only, 6+9, or 6+9+7 = up to 22 total metric
fields, independent of the two provenance columns which are checked separately per the paragraph
above), synthesizing any missing generation's ratios as 0/0, exactly as the existing two-shape
logic already does for the 9-field generation. A pre-existing persisted 15-metric run must read
successfully with the new Milestone-13 ratios synthesized as 0/0 and
`retrievalQualityProvenance: null` (§4 verification).

---

## 4. Verification plan — and an explicit limit of what it can prove

| Case | Expected result |
| --- | --- |
| `pnpm --filter @opspilot/agent-runtime test` | `BM25RunbookRetriever` unit tests pass: deterministic scoring, tie-break, threshold filtering, IDF sanity (a token appearing in every chunk scores lower than one appearing in one chunk). |
| `pnpm exec tsx runbooks-eval/score-query-set.ts` | Exits 0, writes `query-set-scores.json`, prints a comparison table for keyword vs. BM25 recall@k/MRR/falsePositiveRate per group. |
| `pnpm exec tsx runbooks-eval/validate-query-set.ts` (re-run, unmodified from #74) | Still exits 0 — confirms #75's retriever/threshold changes don't regress #74's own distractor-competitiveness guarantees. |
| Existing 20 behavioral cases, `EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval` | All 20 still pass unchanged — the new threshold must not silently exclude a chunk any existing case's `expectedTop1`/`expectedInTopK` depends on (check explicitly; a case whose expected chunk scores below the frozen threshold is a real regression to catch before merging, not after). |
| `EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1 EVALUATION_RETRIEVAL_QUALITY_RETRIEVER=keyword EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval` | Same 20 cases pass; persisted/printed metrics now include real (non-zero-default) `recallAtK`/`meanReciprocalRank`/`falsePositiveRate` for the named retriever, sourced from the committed `query-set-scores.json`. Re-run with `EVALUATION_RETRIEVAL_QUALITY_RETRIEVER=bm25` and confirm a different, independently-attributable set of numbers. |
| `EVALUATION_RETRIEVAL_QUALITY_RETRIEVER` omitted while `EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1` is set | Fails closed with a clear config error (§2.5) — proves the retriever-selection requirement is enforced, not merely documented. |
| `pnpm exec tsx runbooks-eval/score-query-set.ts --check` after editing one committed runbook chunk without regenerating `query-set-scores.json` | Exits 1 with a "stale — regenerate" error (§2.1a) — proves the freshness binding is real, not merely described. |
| Direct eval-CLI invocation (`EVALUATION_INCLUDE_RETRIEVAL_QUALITY=1`) against a corpus edited since `query-set-scores.json` was last generated, with NO prior `--check` run | Fails closed with the same "stale — regenerate" error, proving the runtime hash check (§2.1a) is independent of ever having run `--check` first. |
| A service POST/GET round-trip with `retrievalQualityMetrics` present, then a second round-trip for a different `retrieverName` | Both persist and read back with their own distinct `retrievalQualityProvenance.retrieverName`/`corpusContentHash` (§3) — proves persisted runs are attributable to the retriever that produced them, not indistinguishable. |
| A stored row with exactly one of the two provenance columns set (a malformed/hand-crafted test fixture) | `_read_metrics` rejects it via `INTERNAL_ERROR` (§3) — proves the partial-provenance case fails closed rather than guessing. |
| `pnpm --filter @opspilot/worker run test:eval:cross-service` | TS/Python parity holds for all four new fields (three metric fields plus `retrievalQualityProvenance`) — asserts identical values when the same `retrievalQualityMetrics` input is supplied to both scorers. |
| A pre-existing persisted 15-metric v2 run, read via `GET /evaluations/{id}` after this ships | Still reads successfully; the new Milestone-13 fields synthesize as 0/0 — proves the third read-compatibility shape, not just describes it. |
| A true-negative query scoring above the frozen threshold pre-fix, at or below it post-fix | Confirmed via `score-query-set.ts`'s own output before/after the threshold change — the same evidence class `validate-query-set.ts` already produces for #74's near-miss claims. |
| A real request against local `apps/api` (`POST /v1/agent-jobs` + a FAKE run) with a ticket summary matching one of the 8 true-negative queries | Returns zero retrieved chunks in the `RETRIEVAL_COMPLETED` trace event — proves the threshold is the same enforced code path in production, not an eval-only number (mirrors the recipe in `opspilot-development`'s "Diagnosing a LIVE run failure" section, applied here as a proactive check rather than incident diagnosis). |
| `pnpm agent:verify --final` | No regression outside touched packages. |

**What this verification cannot prove:** recall@k/MRR against a 40-query set authored by the same
process that authored the corpus is not proof of real-world retrieval quality against a genuinely
unseen ticket distribution — the same limitation the milestone plan's §4 already states for the
corpus/query-set as a whole. This issue does not attempt to close that gap (§5); the milestone
plan's own bounded recommendation (a manual held-out live-spike, Issue C's concern) is the intended
closing mechanism, not part of #75.

---

## 5. Out of scope (explicit)

- The frozen-embedding retriever and three-way comparison (#76, per the milestone plan's issue
  breakdown — `retrievalQualityMetrics`'s shape here is designed to accept a third retriever's
  scores later without a further schema change, but #76 is the one that adds them).
- Wiring BM25 (or keyword, if it stays) into `apps/api`'s deployed `RUNBOOK_RETRIEVER` as the
  *result of a comparison decision* — the milestone plan's selection policy (§2.1, "Primary:
  paraphrase-group recall@k...") is Issue C's (#76's) responsibility once all three retrievers'
  numbers exist; #75 ships BM25 as an available, tested `RunbookRetriever` implementation and
  reports its numbers, but does not itself decide or switch which retriever `apps/api` constructs.
- Any change to `ObservedFacts`/`observed-facts.ts` (see §1 finding — narrowed from the milestone
  plan's implied scope, since `falsePositiveRate` is computed by the standalone script against the
  query set directly, not through case-run observation).
- Persisting `query-set-scores.json`'s raw per-query results (only the aggregated ratios cross into
  `EvaluationMetrics`) — per-query detail lives in the committed JSON file and the script's stdout
  table, not in the database.
- Adversarial/injection eval suite work (#77, #78 — separate milestone issues).
- Any change to `EVALUATION_TOP_K` itself, or to the keyword retriever's title/content `+2`/`+1`
  weighting (only its threshold gains a new parameter).

---

## 6. Sequencing

Test-first per repo convention.

1. Hoist shared tokenize/stopword helpers out of `in-memory-runbook-retriever.ts` (or duplicate
   into a new `tokenize.ts` — hoist preferred, §2.3) with tests confirming the keyword retriever's
   existing behavior is byte-for-byte unchanged after the extraction.
2. Implement `BM25RunbookRetriever` + unit tests (§2.3).
3. Add the `minScore` threshold parameter to both retrievers (§2.4) with unit tests; run the
   calibration procedure against the near-miss distractor scores to fix the frozen value; export it
   as `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE`; wire it into **all three** call sites — `apps/api`'s
   `RUNBOOK_RETRIEVER` construction, `evaluation-runner.ts`'s `runOneCase`, and (once written)
   `score-query-set.ts` — never a literal re-declared at each site (§2.4).
4. Re-run `runbooks-eval/validate-query-set.ts` (unmodified) — confirm no regression from the
   threshold change; re-run the 20 behavioral cases — confirm no `expectedTop1`/`expectedInTopK`
   regression from the threshold.
5. Author `runbooks-eval/score-query-set.ts` (§2.1); commit its `query-set-scores.json` output.
6. Extend `EvaluationMetrics`/`EvaluationSuiteInputV2` (TS + Python) with the nested
   `recallAtK`/`meanReciprocalRank`/`falsePositiveRate`/`retrievalQualityProvenance` fields, the
   explicit `MILESTONE_13_METRIC_PATHS` nested<->flat mapping table (§3), the two new nullable
   provenance columns (migration), `aggregateMetrics`/`aggregate_metrics` passthrough logic, and
   `_read_metrics`'s third shape (§2.2, §3) — with parity tests and a persisted-pre-existing-row
   read test proving `retrievalQualityProvenance: null` for old rows.
7. Wire the CLI opt-in flag (§2.5); update `evaluation-formatter.ts`'s report rendering to print
   the new retrieval-quality fields when present.
8. `pnpm agent:verify --final`; confirm the full verification table (§4).
9. `agent:review-bundle` → `agent:codex-review` on the implementation diff (separate from this
   plan-only review).

---

## 7. Acceptance criteria

1. `EvaluationMetrics` (TS and Python) carries the nested `recallAtK`/`meanReciprocalRank`/
   `falsePositiveRate`/`retrievalQualityProvenance` fields, connected to the flat
   `evaluation_metrics` table via the explicit `MILESTONE_13_METRIC_PATHS` mapping (§3) — not a
   flat `getattr`/`setattr` mismatch; cross-service parity tests pass for both a present and an
   absent `retrievalQualityMetrics` input.
2. A pre-existing persisted 15-metric v2 evaluation run reads successfully after this ships, with
   the new metric fields synthesized as 0/0 and `retrievalQualityProvenance: null`, as documented
   in §3.
3. The keyword and BM25 retrievers' thresholds are real `retrieve()` behavior enforced from a
   single named constant, applied identically at all three construction sites (`apps/api`,
   `evaluation-runner.ts`, `score-query-set.ts`) — verified by (a) a request against local
   `apps/api` returning zero chunks for a true-negative query, and (b) all 20 behavioral eval cases
   passing against the SAME threshold constant, not an independently-set eval-only value (§4).
4. `BM25RunbookRetriever` exists, satisfies `RunbookRetriever`, adds no new runtime dependency, and
   has its own enforced threshold from the same frozen calibration.
5. `runbooks-eval/score-query-set.ts` is a committed script (not throwaway), producing a
   retriever-keyed `runbooks-eval/query-set-scores.json` (both keyword and BM25 entries, never an
   unlabeled/single-retriever blob), extending `validate-query-set.ts`'s parsing rather than
   duplicating it, and supporting a `--check` mode that fails closed on a stale artifact (§2.1a).
6. All 20 existing behavioral eval cases pass unchanged with the new threshold applied via
   `evaluation-runner.ts`'s own retriever construction (not merely via `apps/api`'s).
7. The eval CLI requires an explicit `EVALUATION_RETRIEVAL_QUALITY_RETRIEVER` selection whenever
   `EVALUATION_INCLUDE_RETRIEVAL_QUALITY` is set, and fails closed (not silently defaults) when it
   is missing or names a retriever absent from `query-set-scores.json`.
8. `query-set-scores.json`'s freshness is bound to a real content hash of the loaded corpus and
   query set (`corpusContentHash`/`queryContentHash`), not a hand-maintained version string —
   verified by both `score-query-set.ts --check` AND a direct eval-CLI invocation (with no prior
   `--check` run) rejecting a stale artifact after a corpus edit (§2.1a, §4).
9. Two persisted evaluation runs scored against different retrievers (keyword vs. BM25) are
   distinguishable after persistence via `retrievalQualityProvenance.retrieverName` on each — never
   indistinguishable once the originating request context is gone (§3, §4).
10. `pnpm agent:verify --final` passes with no regression outside touched packages.
