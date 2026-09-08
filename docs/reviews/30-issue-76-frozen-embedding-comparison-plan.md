# Issue #76 — Frozen-embedding fixture + three-way retriever comparison + decision

| | |
| --- | --- |
| Scope | [#76](https://github.com/wye-ts/opspilot/issues/76) "Frozen-embedding fixture + three-way retriever comparison + decision" — implements Milestone 13's Issue C (`docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md` §2.1, §6 step 3). Depends on #74 (merged, `fc46828`) and #75 (merged, `bff3d5a`). |
| Basis | `main` @ `bff3d5a` (PR #83 merge), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit beyond this doc, push, PR, merge. No provider/LIVE request yet — the one owner-run Voyage fixture-generation operation this issue requires happens during implementation, not planning, and needs owner go-ahead first (§2.1). |
| Branch | `feat/76-frozen-embedding-comparison` (created, empty) |
| Committed location | `docs/reviews/30-issue-76-frozen-embedding-comparison-plan.md` |

---

## Scope decision

The issue text admits one structural question: does the frozen-embedding retriever live behind
the *same* `RunbookRetriever` interface / `RETRIEVER_CANDIDATES` seam #75 built, or does #76 need
its own comparison machinery? **Decision: reuse #75's seam exactly, add one candidate.**
`runbooks-eval/score-query-set.ts:119` already anticipates this in its own comment: *"#76 adds a
third (frozen-embedding) entry here without any schema change — the artifact is keyed by name."*
Building a parallel comparison path would contradict that precedent for no benefit — the existing
`RetrieverCandidate` shape (`name`, `fingerprint`, `build(corpus)`) already fits a fixture-backed
retriever, and `query-set-scores.json` / `RetrievalQualityMetricsInput` are already retriever-name
keyed, not retriever-count-limited.

---

## 0. Round-1 Codex review — corrections applied to this plan before implementation

`pnpm agent:codex-review` ran once against this plan (plan-only diff, per `opspilot-development`
skill's "running the harness on a plan document" convention). Verdict: `NEEDS_FIXES`, 1 BLOCKER +
4 MAJOR + 1 MINOR, all verified against the real repo (module boundaries, `tsconfig.json`
`rootDir`, `package.json` `"type"` fields, the Dockerfile's actual `COPY` list, the real
`calibrate-min-score.ts` loop bounds) before being accepted. Every finding is fixed in the design
below; this section records what changed and why, so a future reader does not need to diff two
plan revisions to understand the correction:

1. **[BLOCKER] Module-boundary violation in the original design.** The first draft had the
   fixture-generation script (`runbooks-eval/`, CommonJS) importing `voyage-runbook-retriever.ts`
   (`apps/worker`, ESM) — a module-system mismatch and the wrong dependency direction (`apps/worker`
   already depends on `@opspilot/agent-runtime`; nothing may depend back into `apps/worker`). It
   also had `packages/agent-runtime`'s `retriever-fingerprints.ts` — a file re-exported into
   production's dependency graph via `apps/api` — implicitly needing to read
   `runbooks-eval/embedding-fixture.json`, a file the Dockerfile never copies into any image (§1
   confirms: only `runbooks` is copied, never `runbooks-eval`). **Fix:** the generation script
   moves into `apps/worker/src/demo/` (§2.1) — the same home `run-rag-live-spike.ts` already has,
   already ESM, already depends on `voyageai` — eliminating the reverse-import entirely. The two
   pure-math functions every cosine-similarity retriever needs (`cosineSimilarity`, `l2Norm`)
   relocate to `packages/agent-runtime` (§2.3) — genuinely provider-neutral, zero SDK dependency,
   the same "shared primitive, single implementation" pattern `corpus-content-hash.ts` already
   establishes — and `apps/worker`'s `VoyageRunbookRetriever` imports them from there instead of
   defining them locally. `CURRENT_RETRIEVER_FINGERPRINTS` (§2.5) stays exactly as it is today
   (pure, no I/O, safe to import in production) — the frozen-embedding candidate's fingerprint is
   computed by a separate **pure function** fed the already-loaded fixture's own metadata, called
   only by `runbooks-eval/` scripts that have already read the file — never a static map entry
   requiring file I/O at module-evaluation time.
2. **[MAJOR] No independently-trusted values to validate staleness against.** The first draft's
   `FixtureBackedRunbookRetriever` constructor took only the corpus and the parsed query set — it
   could not reproduce a query-set content hash (no shared hash function existed; `score-query-set.ts`
   computes one locally and inline) and had no independently-supplied expected model/dimension to
   compare the fixture against. **Fix:** a shared `sha256(text)` helper is added once (§2.2) and
   used everywhere a raw-bytes hash is needed (corpus already has its own typed hash function;
   query-set text gets the same treatment). The retriever's construction validates the loaded
   fixture's `corpusContentHash` against the corpus it was actually built with (as before) **and**
   its `queryContentHash` against the query-set text it was actually built with, **and** its
   `embeddingModel`/`dimensions` against explicitly-passed expected values — not silently trusted
   from the fixture's own self-reported metadata (§2.3).
3. **[MAJOR] Fingerprint didn't identify the vectors themselves.** A vector-coordinate edit with
   unchanged metadata (model, dimensions, corpus/query hashes) left the fingerprint unchanged.
   **Fix:** the frozen-embedding fingerprint now includes a canonical hash of the fixture's own
   vector payload (§2.5), computed by a shared, pure function — any vector edit changes it.
4. **[MAJOR] Fractional-score calibration was structurally broken.** The original design changed
   only the sweep step (`candidate += 0.01`) while leaving `maxAllowed = Math.floor(lowestCorrectTop1Score)`
   unchanged — for any cosine score below 1.0 (the overwhelmingly common case), `maxAllowed` floors
   to `0`, so the sweep can never select a nonzero threshold. **Fix:** `calibrateRetriever()` is
   generalized to sweep **integer ticks of an explicit step size** (default `1`, unchanged for
   keyword/BM25; `0.01` for frozen-embedding), converting only the chosen tick back to a real score
   at the end (§2.4) — not a partial patch to the existing integer loop.
5. **[MAJOR] The committed fixture was validated only at generation, never at consumption.** A
   hand-edited or corrupted `embedding-fixture.json` (wrong vector length, duplicate/missing IDs,
   non-finite or zero-norm vector) would previously reach cosine-ranking code unchecked, which can
   produce `NaN` or silently wrong rankings. **Fix:** `FixtureBackedRunbookRetriever`'s constructor
   parses and structurally validates the loaded fixture — shape, dimension, unique/complete
   chunk-and-query ID coverage against the current corpus/query set, finite non-zero vectors — and
   throws fail-closed before any `retrieve()` call, not merely at generation time (§2.3).
6. **[MINOR] Consent text undercounted the request count.** The first draft's consent note said
   "one real... Voyage API call"; the design itself always required two (a document-embedding batch
   and a query-embedding batch). **Fix:** stated accurately as one owner-run operation consisting
   of two billed requests (§2.1), with a dedicated test asserting exactly that shape.

Review budget for this plan-only diff after round 1: fixes applied above, plan re-submitted for a
second round.

## 0a. Round-2 Codex review — corrections applied to this plan before implementation

A second `pnpm agent:codex-review` ran against the round-1-fixed plan. Verdict: `NEEDS_FIXES`, 0
BLOCKER + 4 MAJOR (no MINOR). All four verified against the real repo (`calibrate-min-score.ts`'s
actual `rawScore()` helper and its self-filtering behavior against a nonzero threshold;
`retrieval-quality-config.ts`'s actual `resolveRetrievalQualityMetrics` source, confirming it never
reads or compares `queryContentHash` today; `computeRetrieverFingerprint()`'s existing signature,
confirming keyword/BM25 already fold `minScore` into their own fingerprints; and the milestone
plan's own §2.1 text, confirming it states no tie-break rule) before being accepted. This repo's
review budget (`CONTEXT.md` "Review closure": one initial review + one final re-review for a
normal issue) is spent after this round. All four findings are small, in-scope, real defects that
do not reopen or reverse any owner-confirmed decision — fixed directly below, no third paid round
run, per Human/HQ's own stopping decision on this plan-only diff:

1. **[MAJOR] Calibration had no unthresholded scoring path for the frozen-embedding candidate.**
   `calibrate-min-score.ts`'s `rawScore()` helper retrieves through the retriever's own
   `retrieve()` method — if `FixtureBackedRunbookRetriever` always applied its frozen (nonzero)
   `minScore` internally, calibration would silently score its own already-filtered output,
   producing an unstable, self-referential threshold (the same class of bug #75's round-1 review
   already caught once, in the single-chunk-corpus version of BM25/keyword calibration). **Fix:**
   `FixtureBackedRunbookRetriever`'s constructor takes an explicit `minScore` parameter with no
   internal default — `calibrate-min-score.ts` constructs a calibration-time instance with
   `minScore: 0`, exactly mirroring how keyword/BM25 are already calibrated (§2.3).
2. **[MAJOR] The eval-CLI consumption path never validated query-set freshness, for any
   retriever.** `resolveRetrievalQualityMetrics` checks `corpusContentHash` but never
   `queryContentHash` — a gap that predates this issue (already true for keyword/BM25 under #75)
   and that the fixture's own construction-time check cannot close, because
   `resolveRetrievalQualityMetrics` never constructs a `FixtureBackedRunbookRetriever` at all; it
   only reads the precomputed `query-set-scores.json` artifact. **Fix:** the CLI-level freshness
   check gains an independent `queryContentHash` comparison for **all three** retrievers, using
   the same shared `sha256()` helper this issue already introduces (§2.5) — closing a pre-existing
   gap for keyword/BM25 as a side effect, not just adding a frozen-embedding special case.
3. **[MAJOR] The frozen-embedding fingerprint omitted the enforced `minScore`.** Changing
   `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` after `query-set-scores.json` was generated left the
   fingerprint (and therefore the runtime freshness check) unchanged, silently accepting stale
   metrics computed under the old threshold — the same class of gap keyword/BM25's own
   `computeRetrieverFingerprint()` already closes by folding `minScore` into their fingerprints.
   **Fix:** `computeFrozenEmbeddingFingerprint()` takes an explicit `minScore` parameter, called
   identically from `score-query-set.ts` and `retrieval-quality-config.ts` with the same frozen
   constant (§2.5).
4. **[MAJOR] The declared selection policy has no tie-break rule, and this plan's deployment
   branching (§2.7) could be read as directing two different outcomes from an identical, real
   tie** (keyword's paraphrase recall@k is already 10/10 — the maximum possible value — so any
   candidate that also reaches 10/10 produces an exact tie, not a win, under the milestone policy's
   literal text). **Fix:** a narrowly-scoped tie-break is added (§2.6) — the already-shipped
   keyword retriever wins a tie it participates in; otherwise the lower `falsePositiveRate` (a
   metric §2.1's own two minimum bars already treat as a safety property) decides — applied only
   to resolve a tie within the tier the policy's own rules already selected, never as a new
   independent deciding metric.

Review budget for this plan-only diff after round 2: all findings fixed below; the plan is ready
for implementation (§6).

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Retriever seam | `packages/agent-runtime/src/rag/runbook-retriever.ts` | `RunbookRetriever.retrieve()` — the one interface every candidate (keyword, BM25, Voyage-live, and this issue's frozen-embedding) implements. No changes needed. |
| Live embedding retriever | `apps/worker/src/rag/voyage-runbook-retriever.ts` (`VoyageRunbookRetriever`) | Real Voyage embeddings, cosine similarity, extensive response-shape validation (index remapping, dimension/finite/zero-norm checks via `extractValidatedEmbeddings`). Lives only in `apps/worker`, ESM (`apps/worker/package.json` has `"type": "module"`). Currently defines `cosineSimilarity`/`l2Norm` locally — these relocate to `packages/agent-runtime` (§2.3, §0 fix 1) and this file imports them from there instead. `extractValidatedEmbeddings` stays here unchanged — the new fixture-generation script (§2.1) lives in this same app and reuses it directly, so it never needs relocating. |
| Embedding client seam | `apps/worker/src/rag/voyage-embedding-client.ts` (`VoyageEmbeddingClient`) | Narrow `embed(request): Promise<EmbedResponse>` interface — what the fixture-generation script (§2.1) constructs a real client against. |
| Module-system boundary | `package.json` (root, no `"type"` field → CommonJS default), `apps/worker/package.json` (`"type": "module"`), `runbooks-eval/tsconfig.json` (`module: "Node16"`, no separate `"type"`, so it inherits the root's CommonJS default) | `runbooks-eval/` scripts are CommonJS; `apps/worker/` is ESM. Neither may directly `require`/`import` the other's source. `packages/agent-runtime` builds with `rootDir: "src"` (its own `tsconfig.json`) and is consumed by both — the only safe place for code that both a CJS script and an ESM app need identically (§0 fix 1). |
| Dockerfile production boundary | `Dockerfile` (repo root) | Copies `packages/*/dist`, `apps/api/dist`, `apps/web/dist`, and `runbooks/` (the corpus) into the production image. **Never copies `runbooks-eval/`** — any production code path that unconditionally reads a `runbooks-eval/*.json` file at import time would crash image startup. This is why `CURRENT_RETRIEVER_FINGERPRINTS` (§2.5) must stay I/O-free (§0 fix 1) — it is re-exported through `packages/agent-runtime`'s public `index.ts`, which production's `agent-runtime.module.ts` already imports from. |
| Live API key present | `apps/worker/.env` | `VOYAGE_API_KEY` and `EMBEDDING_MODEL=voyage-4-lite` are both set to real values in this developer's local env (not committed — `.env` is gitignored; `.env.example` carries an empty placeholder). The fixture-generation script (§2.1) can run against the real Voyage API today without any new credential setup, but doing so is a real, billed, external call — see §2.1's consent note. |
| Retriever comparison harness | `runbooks-eval/score-query-set.ts` | `RETRIEVER_CANDIDATES: readonly RetrieverCandidate[]` currently holds exactly `keyword` and `bm25`. Each candidate supplies `name`, a `fingerprint`, and `build(corpus): RunbookRetriever`. `computeQuerySetScores()` iterates the array, scores every candidate against the same 40-query set, and writes one keyed artifact (`query-set-scores.json`) — this issue adds one array entry, no schema change (confirmed by the module's own comment at line 119, quoted above). Also computes `queryContentHash` via a **locally inlined** `sha256(rawQuerySet)` call today — no shared hash function exists yet for query-set bytes (§0 fix 2 adds one). |
| `retrieval-quality-config.ts`'s freshness check | `apps/worker/src/evaluation/retrieval-quality-config.ts` | Validates a selected artifact entry's `corpusContentHash` against the corpus the CLI just loaded, and its stored per-retriever fingerprint against `CURRENT_RETRIEVER_FINGERPRINTS`. **Never validates `queryContentHash`** today (confirmed: no such comparison exists in the current source) — restated here because the frozen-embedding path (§2.3) must not silently inherit this gap; the retriever's own constructor validates query-set freshness directly rather than relying on this CLI-level check to ever be extended to cover it. |
| Threshold calibration | `runbooks-eval/calibrate-min-score.ts` | Computes each retriever's frozen `minScore` via a fixed procedure: smallest integer excluding ≥ half of the 12 near-miss distractor scores while never excluding a real exact/paraphrase top answer. `maxAllowed = Math.floor(lowestCorrectTop1Score)` and the sweep loop increments by integer `1` — correct for keyword/BM25's small-integer score scale, but structurally wrong for a `[-1, 1]`-ranged cosine score (§0 fix 4). Currently calibrates `keyword` and `bm25` only, against retrievers built from the **full corpus** (a round-1 #75 Codex BLOCKER fix — single-chunk-corpus calibration was rejected as scoring in the wrong space; this issue's frozen-embedding calibration follows the same full-corpus rule). |
| Retriever fingerprints | `packages/agent-runtime/src/rag/retriever-fingerprints.ts` | `CURRENT_RETRIEVER_FINGERPRINTS: Record<"keyword" \| "bm25", string>` — a hash of each retriever's class name + minScore + tunable params, computed synchronously at module-load time from pure in-code constants (no file I/O). This module is re-exported through `packages/agent-runtime`'s public `index.ts`, which `apps/api`'s production code already imports from (§1's Dockerfile row) — it must stay import-safe in production. The frozen-embedding candidate's fingerprint is data-defined (depends on an external fixture file), not code-defined, so it is deliberately **not** added as a third static map entry (§0 fix 1, §2.5). |
| Corpus/query freshness | `packages/agent-runtime/src/rag/corpus-content-hash.ts` | `computeCorpusContentHash()` hashes the loaded corpus's canonical content — reused unchanged. This issue adds a sibling shared `sha256(text)` helper (§2.2, §0 fix 2) for hashing the query-set's raw bytes identically everywhere it's needed, replacing `score-query-set.ts`'s current local inline version. |
| Selection policy | `docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md` §2.1 (quoted in full in §2.6 below) | Already declared, before this issue runs, specifically to prevent post-hoc metric shopping. This plan does not redefine it — it applies it mechanically to whatever real numbers come out of the comparison. |
| Deployment seam | `apps/api/src/execution/agent-runtime.module.ts` | `RUNBOOK_RETRIEVER` provider token, built once at container startup via `useFactory`, currently constructs `InMemoryKeywordRunbookRetriever` with the shared `DEFAULT_KEYWORD_RETRIEVER_MIN_SCORE` constant. If keyword or BM25 wins the comparison (§2.6), this factory is the one place that changes. If frozen-embedding wins, this file is explicitly **not** touched (§2.7) — the fixture cannot serve an arbitrary production query. |
| Existing comparison numbers (keyword vs. BM25, already measured by #75) | `runbooks-eval/query-set-scores.json` | keyword: recall@3 exact 10/10, paraphrase 10/10, near_miss 11/12; falsePositiveRate 8/8 (i.e. **100%** — every true-negative query still returns a chunk at the calibrated threshold). BM25: recall@3 exact 10/10, paraphrase 10/10, near_miss 10/12; falsePositiveRate 4/8 (50%). Both retrievers' calibration (`min-score-calibration.json`) recorded `targetMet: false`. This is pre-existing, already-shipped, already-accepted state from #75 — restated here only because §2.6's non-regression bar is defined relative to keyword's own 8/8 falsePositiveRate (a ceiling that is, in practice, not very restrictive: 100% is already the worst possible value). Not in scope to fix in #76. |
| Provider-neutral cost note | `apps/worker/src/demo/run-rag-live-spike.ts` (comment, lines ~39-41) | `voyage-4-lite` priced at $0.02 per 1M tokens in this repo's own pricing table. The corpus is 24 short chunks + 40 short queries — a few thousand tokens total. One fixture-generation operation costs a small fraction of a cent. |

---

## 2. Design

### 2.1 Fixture-generation script — one owner-run operation, outside the eval harness, correctly homed

New script: `apps/worker/src/demo/generate-embedding-fixture.ts` — **not** `runbooks-eval/`, per
§0 fix 1: this script needs `voyageai`'s SDK types and `VoyageRunbookRetriever`'s existing,
unit-tested `extractValidatedEmbeddings` response validator, both of which live in `apps/worker`
(ESM). Placing it there (mirroring `run-rag-live-spike.ts`'s existing pattern exactly: real API
key from `.env`, manual invocation only, never CI) means it needs **zero** relocation of SDK-typed
code and creates no reverse dependency from `apps/worker` back into `runbooks-eval`.

New `apps/worker/package.json` script, following the existing `spike:rag` pattern:
```
"generate:embedding-fixture": "pnpm run build:deps && tsx src/demo/generate-embedding-fixture.ts"
```

This performs **one owner-run fixture-generation operation, consisting of two billed Voyage API
requests** (a document-embedding batch for the 24 corpus chunks, a query-embedding batch for the
40 queries — the same two-call shape `VoyageRunbookRetriever.retrieve()` already uses per query,
batched once here instead of per-request) — the only network activity anywhere in this issue's
design; everything downstream of the committed fixture is offline.

**Consent, per this repo's and this session's cost-transparency convention:** this is one
owner-run generation operation (two billed requests) against the developer's own `VOYAGE_API_KEY`
(present in `apps/worker/.env`, §1). Estimated cost is a small fraction of a cent (§1, ~2-3K
tokens at $0.02/1M). The implementation step that runs this script requires the owner's explicit
go-ahead before executing it, stated plainly at that point in the session — not assumed from this
plan's approval alone.

The script:
1. Loads the corpus (`loadDefaultRunbookCorpus()`) and the query set (`retrieval-query-set.json`,
   via the same `parseQuerySet`/`QUERY_SET_PATH` `runbooks-eval/validate-query-set.ts` already
   exports — `apps/worker` can import from `runbooks-eval/` since that direction (app importing a
   root-level fixture/script directory as plain TS, not as a package) is how `score-query-set.ts`
   and `calibrate-min-score.ts` already import `packages/agent-runtime`'s code today; the reverse
   direction, `runbooks-eval` importing `apps/worker`, is what §0 fix 1 eliminates).
2. Constructs a real `VoyageAIClient` via the existing `VoyageEmbeddingClient` seam — no new
   client abstraction.
3. Embeds every corpus chunk's `content` (`inputType: "document"`) and every query's `query` text
   (`inputType: "query"`) — two requests total. A dedicated unit test (against a fake
   `VoyageEmbeddingClient`) asserts exactly these two requests, with the correct `inputType` and
   complete batch contents each — the concrete regression test for the corrected request-count
   claim (§0 fix 6).
4. Validates each response with `extractValidatedEmbeddings` — reused directly from
   `voyage-runbook-retriever.ts` (exported for this purpose; same-app import, no relocation
   needed per §0 fix 1's simplification).
5. Computes `corpusContentHash` (existing shared function) and the query-set's raw-bytes hash via
   the new shared `sha256(text)` helper (§2.2, §0 fix 2) — the **same** function
   `FixtureBackedRunbookRetriever` later re-derives from, so generation and consumption can never
   compute this hash two different ways.
6. Writes the result as a committed JSON fixture (§2.2).

### 2.2 Fixture format and staleness guard

New committed file: `runbooks-eval/embedding-fixture.json`. Mirrors this repo's existing
fixture-based parity pattern (`apps/worker/src/evaluation/fixtures/ts-parity-v2.json`) and the
freshness-hash pattern `corpus-content-hash.ts`/`query-set-scores.json` already establish:

```
{
  "embeddingModel": "voyage-4-lite",
  "dimensions": <int>,
  "corpusContentHash": "<sha256, computeCorpusContentHash() — same function score-query-set.ts uses>",
  "queryContentHash": "<sha256, the NEW shared sha256(text) helper — same function score-query-set.ts's own queryContentHash field now also uses (§0 fix 2), replacing its current local inline sha256>",
  "chunks": [ { "chunkId": "...", "vector": [...] }, ... ],   // sorted by chunkId
  "queries": [ { "id": "...", "vector": [...] }, ... ]          // sorted by query id
}
```

New shared helper: `packages/agent-runtime/src/rag/corpus-content-hash.ts` gains an exported
`sha256(text: string): string` (thin wrapper over `node:crypto`, already imported there) —
`score-query-set.ts`'s existing local `sha256()` is deleted and replaced with this import, so
generation-time and comparison-time query-hashing can never independently drift (§0 fix 2).

**Fail-closed staleness check** — `FixtureBackedRunbookRetriever`'s constructor (§2.3) takes four
**explicitly-supplied, independently-derived** expected values (never trusted from the fixture's
own self-reported metadata alone): the corpus it was built with, the raw query-set text it was
built with, the expected `embeddingModel`, and the expected `dimensions`. It re-derives
`corpusContentHash`/`queryContentHash` from the first two using the shared functions above and
compares all four fields against the loaded fixture's own stored values, throwing
`RetrieverError("REQUEST_INVALID", "fixture stale — regenerate via apps/worker's generate:embedding-fixture script")`
on any mismatch (§0 fix 2). This is a real `RunbookRetriever`-shaped error (not a thrown plain
`Error`), consistent with every other retriever in this codebase.

### 2.3 `FixtureBackedRunbookRetriever` — zero network calls, shared ranking math, validates on construction

`cosineSimilarity`/`l2Norm` relocate to a new file,
`packages/agent-runtime/src/rag/cosine-similarity.ts` (§0 fix 1) — pure, provider-neutral math
with zero SDK dependency, exported from the package's public `index.ts`. `apps/worker`'s
`voyage-runbook-retriever.ts` imports them from there instead of defining them locally; its own
test suite is unaffected (same function behavior, new import path).

New file: `packages/agent-runtime/src/rag/fixture-backed-runbook-retriever.ts` (shared package —
the eval harness / `runbooks-eval/` scripts and, if this candidate ever won and needed wiring,
`apps/api` would all need to construct it without pulling in `apps/worker`'s dependency graph;
this file has no `voyageai` import at all, only plain JSON + the relocated cosine math).

- **Constructor validates the loaded fixture before anything else runs** (§0 fix 5): parses the
  raw fixture JSON structurally (required fields present and correctly typed), then checks —
  every `chunks`/`queries` entry has a unique, non-empty id; the `chunks` id set exactly equals
  the current corpus's chunk-id set (no orphan, no missing chunk); the `queries` id set exactly
  equals the current query-set's id set; every vector has exactly `dimensions` entries, every
  value finite, and a nonzero L2 norm. Any violation throws `RetrieverError("REQUEST_INVALID", ...)`
  at construction — never at first `retrieve()` call, and never silently producing `NaN` rankings.
- Constructor also performs the staleness check (§2.2) against the four independently-supplied
  expected values.
- Constructor takes an **explicit `minScore: number` parameter, no default inside the class
  itself** (round-2 Codex-review MAJOR fix — verified against `calibrate-min-score.ts`'s actual
  `rawScore()` helper, which retrieves against `topK: corpusSize` and reads a chunk's score from
  the result, exactly as it does for keyword/BM25 today: a nonzero enforced threshold silently
  excludes below-threshold chunks from the result set entirely, so calibration would score its own
  already-filtered output and produce an unstable, self-referential threshold, mirroring the exact
  bug #75's round-1 review caught in the single-chunk-corpus version of this same mistake). Callers
  choose the value: `score-query-set.ts`/production code pass the frozen
  `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` constant (§2.4); `calibrate-min-score.ts`'s
  `calibrateRetriever()` passes `0` when constructing the calibration-time instance, so `rawScore()`
  observes the true unthresholded cosine similarity — the same pattern `InMemoryKeywordRunbookRetriever`/
  `BM25RunbookRetriever` already support via their own constructors accepting an explicit minScore
  (confirmed against source: both existing retrievers already take this as a constructor argument,
  not a class-internal default; this is not a new pattern, only extending it to the third
  retriever).
- `retrieve({ query, topK })` looks up the **query's own precomputed vector by matching the exact
  query string** against the fixture's `queries` entries (this fixture only ever serves the 40
  committed evaluation queries — it is not a general-purpose retriever, and this lookup-by-exact-
  query-text is what makes that limitation structurally explicit rather than implicit). An
  unrecognized query string throws `RetrieverError("REQUEST_INVALID", ...)` — never falls back to
  a live embedding call, which would silently reintroduce the network dependency this fixture
  exists to eliminate.
- Cosine similarity against every corpus-chunk vector, using the relocated shared
  `cosineSimilarity`/`l2Norm`, filtered by the constructor-supplied `minScore` — same real,
  enforced `retrieve()`-level filtering behavior every other retriever in this comparison has.

### 2.4 Threshold calibration for the frozen-embedding candidate — generalized, not patched

`runbooks-eval/calibrate-min-score.ts`'s `calibrateRetriever()` gains an explicit `step: number`
parameter (default `1`, so keyword/BM25's existing calibrated values and committed
`min-score-calibration.json` entries are byte-identical and unaffected — a regression test asserts
this). The sweep changes from integer-score iteration to **integer-tick** iteration of the step
size, fixing the fractional-score bug (§0 fix 4) at its root rather than patching only the
increment:

```
const maxAllowedTicks = Math.floor(lowestCorrectTop1Score / step);
const excludedAtTick = (tick: number) => distractorScores.filter((s) => s < tick * step).length;
// sweep tick = 0..maxAllowedTicks, same target-met / max-exclusion-fallback logic as today,
// operating on ticks instead of raw scores throughout the loop
// chosen score = round(chosenTick * step, decimalPlacesFor(step)) — computed ONCE at the end,
// avoiding floating-point drift accumulating across loop iterations
```

A new `frozen-embedding` entry is added to `computeCalibration()`'s retriever list, built from the
committed fixture (not a live Voyage call — calibration must also stay offline once the fixture
exists), passing `step: 0.01`. The chosen value becomes a new frozen constant,
`DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE`, exported from `fixture-backed-runbook-retriever.ts` the
same way the other two default constants are exported from their own retriever files.

### 2.5 Wiring into the comparison harness — pure fingerprint function, no static map entry, no schema change

- `retriever-fingerprints.ts`: `CURRENT_RETRIEVER_FINGERPRINTS` is **unchanged** (§0 fix 1) — it
  stays `Record<"keyword" | "bm25", string>`, pure, I/O-free, production-import-safe. A new
  **pure function** is added alongside it:
  ```
  export function computeFrozenEmbeddingFingerprint(fixture: {
    embeddingModel: string;
    dimensions: number;
    corpusContentHash: string;
    queryContentHash: string;
    vectorPayloadHash: string;  // NEW — see below, fixes §0 fix 3
  }, minScore: number): string
  ```
  where `vectorPayloadHash` is produced by a new shared, pure `computeEmbeddingFixturePayloadHash()`
  (same file or a sibling in `packages/agent-runtime`) that canonically sorts and hashes every
  `chunks[].vector`/`queries[].vector` entry together — the missing piece from §0 fix 3: any
  single coordinate edit changes this hash even when every metadata field stays the same. The
  **explicit `minScore` parameter** (round-2 Codex-review MAJOR fix — verified: the first draft's
  signature took only fixture-derived fields, so freezing a new `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE`
  value after `query-set-scores.json` was generated left the fingerprint — and therefore the
  runtime freshness check — unchanged, silently accepting stale falsePositiveRate/recall numbers
  computed under the old threshold) mirrors exactly how `computeRetrieverFingerprint()` already
  folds `minScore` into keyword's and BM25's own fingerprints (§1) — this is the same rule applied
  to the third retriever, not a new one. Both `score-query-set.ts` and `retrieval-quality-config.ts`
  call this function with the **same** `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` constant import (never
  two independently-typed literals), so a threshold change can never silently drift the two call
  sites apart. Both functions take fully-formed data as parameters; neither performs file I/O, so
  both stay safe to import from a production-facing module.
- `score-query-set.ts`: add one entry to `RETRIEVER_CANDIDATES` whose `fingerprint` is computed by
  calling `computeFrozenEmbeddingFingerprint(loadedFixture, DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE)`
  **after** loading and validating the fixture (the script already reads files; this is not a new
  I/O boundary for it) — never a `CURRENT_RETRIEVER_FINGERPRINTS["frozen-embedding"]` lookup,
  because no such static entry exists.
  `build: (corpus) => new FixtureBackedRunbookRetriever(corpus, rawQuerySetText, loadedFixture, EXPECTED_EMBEDDING_MODEL, EXPECTED_DIMENSIONS, DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE)`.
- `retrieval-quality-config.ts`'s freshness check, when `retrieverName === "frozen-embedding"`,
  performs the equivalent runtime (not module-load-time) fingerprint comparison: lazily loads the
  fixture (mirroring its existing lazily-injected `readArtifact` pattern for `query-set-scores.json`
  — never a top-level `readFileSync`), computes `computeFrozenEmbeddingFingerprint()` on it, and
  compares against the stored value in `query-set-scores.json` — the same freshness guarantee
  BM25/keyword already get from the static map, achieved without ever requiring
  `runbooks-eval/embedding-fixture.json` to exist at production import time (§1's Dockerfile
  constraint).
- **`retrieval-quality-config.ts` also gains an independent `queryContentHash` check, for ALL
  three retrievers, not only frozen-embedding** (round-2 Codex-review MAJOR fix — verified against
  the actual current source: `resolveRetrievalQualityMetrics` today validates `corpusContentHash`
  against the corpus the CLI just loaded, but never reads or compares `queryContentHash` at all —
  a pre-existing gap #75 already left open for keyword/BM25, restated in §1's current-state
  findings, that this issue's own new `sha256(text)` helper (§2.2) now makes trivial to close for
  every candidate at once rather than adding a frozen-embedding-only special case). The function
  gains a `readQuerySet: () => string` parameter (same injectable-reader pattern as
  `readArtifact`, defaulting to `readFileSync(QUERY_SET_PATH, "utf8")`), re-derives the hash via
  the shared `sha256()` helper, and compares it against the artifact's stored `queryContentHash`
  before attaching any retriever's metrics — an edited `retrieval-query-set.json` with an
  unchanged corpus now fails closed for every retriever selection, not only ones this issue adds.
- Regenerate `query-set-scores.json` and `min-score-calibration.json` by re-running the existing
  scripts (now with three candidates) — not hand-edited.

### 2.6 Comparison and decision — applying the pre-declared selection policy exactly

Run all three retrievers through `score-query-set.ts` and read the real recall@k/MRR
(exact/paraphrase/near-miss) and `falsePositiveRate` numbers it produces. Then apply the
**selection policy already declared in the milestone plan**
(`docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md` §2.1, quoted here in full so
this issue's plan does not silently redeclare or drift from it):

> 1. **Primary: paraphrase-group recall@k.** The retriever with the highest paraphrase recall@k
>    wins, *provided* it also clears two minimum bars: `falsePositiveRate` on the true-negative
>    group must not exceed the shipped keyword retriever's own measured `falsePositiveRate` (never
>    regress false-positive behavior to win on paraphrase recall), and exact-group recall@k must
>    not fall more than 10 percentage points below the shipped keyword retriever's exact-group
>    recall@k (never trade away the case the system is already good at for a paraphrase gain).
> 2. **Tie-break / no candidate clears both bars:** fall back to exact-group recall@k as the
>    deciding metric under the same `falsePositiveRate` non-regression bar.
> 3. **No retriever beats the shipped keyword retriever on the primary metric while clearing both
>    bars:** the shipped keyword retriever stays — "no change" is an explicit, legitimate outcome
>    of this comparison, not a failure to reach a decision.

This is applied **mechanically** to the real numbers produced — this plan does not pre-guess the
outcome (§1's restated keyword/BM25 numbers already show keyword's paraphrase recall@k is 10/10,
i.e. already at ceiling, so the primary metric's only real question this issue answers is whether
frozen-embedding also reaches 10/10 while clearing both bars; near-miss recall — not the primary
metric, but the more informative comparison given #74's corpus was deliberately built with
near-miss confusability — and `falsePositiveRate` are where a real embedding-vs-deterministic
difference is most likely to show up in practice).

**Tie-break rule, added here because the milestone policy's own text is ambiguous on it** (round-2
Codex-review MAJOR fix — verified: the milestone plan's §2.1 text says "the retriever with the
highest paraphrase recall@k wins," but does not say what happens when two or more candidates that
both clear the two minimum bars tie exactly on that metric — a real, not merely theoretical,
possibility here since keyword's paraphrase recall@k is already 10/10, the maximum possible value,
so any candidate that also reaches 10/10 produces an exact tie rather than a win. Left undefined,
§2.7's deployment branching could be read as directing two different outcomes — "frozen-embedding
is a possible winner" and "keyword wins because frozen did not beat it" — from the identical
numbers, which §7 acceptance criterion 4 explicitly forbids). **This plan adds the following
tie-break, consistent with `CONTEXT.md`'s "prefer the smallest demonstrably sufficient design"
engineering posture, and applies it only to resolve an exact tie on the metric that already
decided the tier (never as a new independent deciding metric):** among candidates tied on the
metric that decided the tier (paraphrase recall@k under policy tier 1, or exact recall@k under
tier 2), the **already-shipped keyword retriever wins the tie** if it is one of the tied
candidates — "no change" is the smallest-sufficient outcome when a new candidate does no better,
only equally well, on the metric that matters most. If keyword is not among the tied candidates
(e.g. BM25 and frozen-embedding tie for the win, both beating keyword), the **lower
`falsePositiveRate`** breaks the tie, since §2.1's own two minimum bars already establish
`falsePositiveRate` as the metric this comparison treats as a safety property, not merely a
secondary metric — a lower false-positive rate is the more defensible reason to prefer one
otherwise-equal candidate over another. This tie-break is scoped narrowly (applies only inside an
already-identified tier, never overrides which tier decides) so it does not reopen or contradict
the milestone plan's own policy — it fills the one gap that policy's text left open.

The result — including the losing candidates' numbers, not just the winner's — is recorded in this
issue's PR body as the deliverable the milestone plan (§0) requires: "a data-backed decision...
backed by a three-way recall@k/MRR/falsePositiveRate comparison," not just a winner's name.

### 2.7 Deployment branching — separate from the selection policy itself

Per the milestone plan §2.1 and this issue's own "Out of scope" (below), only two of the three
possible winners result in a change to `apps/api/src/execution/agent-runtime.module.ts`:

- **Keyword or BM25 wins:** wire it into the existing `RUNBOOK_RETRIEVER` provider-token factory
  in this same PR — deterministic, in-process, no new runtime dependency, identical deployment
  shape to what's already there. (If keyword wins, i.e. "no change," this factory is untouched and
  that outcome is stated explicitly rather than silently implied by an empty diff.)
- **Frozen-embedding wins:** `agent-runtime.module.ts` is **not** touched — the fixture only ever
  serves the 40 committed evaluation queries (§2.3), so it cannot be what a real production ticket
  summary queries against; the Dockerfile also never ships `runbooks-eval/` (§1), which would make
  the fixture unreadable in production even if wiring were attempted. Instead: record the
  comparison result as the deliverable (§2.6), and open a new, named GitHub issue (title pattern:
  "Wire live VoyageRunbookRetriever into apps/api (frozen-embedding comparison won, #76)")
  targeting a future milestone, following the "move it, don't copy it" precedent #72's plan already
  established. The shipped retriever stays whichever of keyword/BM25 scored second-best on the
  same policy, applied again one tier down, with that choice stated and justified in the same PR.

---

## 3. Compatibility

- `QuerySetScores`/`RetrievalQualityMetricsInput`/`EvaluationSuiteInputV2` schemas: unchanged.
  Retriever-name-keyed already; adding `"frozen-embedding"` as a new key is additive, not a shape
  change.
- `CURRENT_RETRIEVER_FINGERPRINTS`'s TypeScript shape (`Record<"keyword" | "bm25", string>`) is
  unchanged — no widening to a third literal key, since frozen-embedding's fingerprint is
  deliberately never a static map entry (§2.5). Any code indexing this map by a literal
  `"keyword"`/`"bm25"` key keeps its exact current type.
- `calibrateRetriever()`'s new `step` parameter defaults to `1` — a dedicated regression test
  asserts the existing `keyword`/`bm25` calibrated values and the committed
  `min-score-calibration.json` bytes are unchanged by this signature change.
- A pre-existing persisted eval run scored against `keyword` or `bm25` (from #75) keeps reading
  exactly as it does today — nothing about this issue touches `EvaluationMetrics` persistence or
  the Python service's schema.
- `voyage-runbook-retriever.ts`'s relocation of `cosineSimilarity`/`l2Norm` to
  `packages/agent-runtime` is a pure import-path change — its existing test suite exercises the
  same function behavior through the new import, not new behavior.
- If keyword/BM25 wins and is wired into `apps/api`: existing `runbook-retrieval-wiring.test.ts`
  integration tests (added in #72, exercised again in #75's BM25 wiring precedent) must keep
  passing unmodified in intent — same assertion shape, only the constructed retriever class (or
  nothing, if keyword/"no change" wins) differs.

## 4. Verification plan

| Case | Expectation |
| --- | --- |
| Fixture-generation script, run once against real Voyage API | Produces a fixture whose `corpusContentHash`/`queryContentHash` match the current corpus/query-set; committed. |
| Fixture-generation script's request shape (fake client) | Exactly two requests: one document batch (all 24 chunk contents, `inputType: "document"`), one query batch (all 40 query texts, `inputType: "query"`). |
| `FixtureBackedRunbookRetriever` constructed against a well-formed, current fixture | Constructs successfully; `retrieve()` for a fixture query returns ranked results identical (bit-for-bit) to hand-computed cosine similarity against the fixture's stored vectors. |
| `FixtureBackedRunbookRetriever.retrieve()` for a query NOT in the fixture | Throws `RetrieverError("REQUEST_INVALID", ...)`, never falls back to a live call. |
| Constructed against a corpus whose content hash disagrees with the fixture | Throws the fixture-stale error at construction time. |
| Constructed against a query-set text whose hash disagrees with the fixture | Throws the fixture-stale error at construction time (the previously-missing check, §0 fix 2). |
| Constructed with an expected `embeddingModel`/`dimensions` that disagrees with the fixture's stored values | Throws the fixture-stale error at construction time (the previously-missing check, §0 fix 2). |
| Constructed against a fixture with a duplicate/missing chunk or query id, a wrong-length vector, a non-finite value, or a zero-norm vector | Throws a structural-validation error at construction time, before any `retrieve()` call (§0 fix 5). |
| `computeFrozenEmbeddingFingerprint()` / `computeEmbeddingFixturePayloadHash()` | Mutating one vector coordinate while holding every metadata field constant changes the resulting fingerprint (§0 fix 3). |
| `computeFrozenEmbeddingFingerprint()` with `minScore` changed, fixture metadata unchanged | Fingerprint changes; the stored artifact fingerprint is rejected as stale at CLI runtime (§0a fix 3). |
| `calibrateRetriever()` constructing its calibration-time frozen-embedding instance | Constructs `FixtureBackedRunbookRetriever` with `minScore: 0`; `rawScore()` observes the true unthresholded cosine similarity even when `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` is nonzero (the concrete regression test for §0a fix 1's bug). |
| `resolveRetrievalQualityMetrics` with an edited `retrieval-query-set.json`, corpus/fixture unchanged | Rejects the artifact as stale for keyword, BM25, AND frozen-embedding selections alike (the concrete regression test for §0a fix 2 — a pre-existing gap closed for all three, not only the new candidate). |
| Selection-policy tie-break: frozen-embedding ties keyword's paraphrase and exact recall@k, both clear the bars | Keyword wins the tie (table-driven test asserting the single intended winner, the concrete regression test for §0a fix 4). |
| Selection-policy tie-break: BM25 and frozen-embedding tie for the win, both beating keyword, with different falsePositiveRate | The candidate with the lower `falsePositiveRate` wins the tie. |
| `calibrateRetriever()` regression (keyword/BM25, default `step: 1`) | Produces byte-identical `min-score-calibration.json` entries and frozen constants to what #75 already committed. |
| `calibrateRetriever()` with a fractional `step` and a lowest-correct score below 1.0 | Selects a nonzero threshold when the exclusion target is reachable below that score (the concrete regression test for §0 fix 4's bug). |
| Three-way `score-query-set.ts` run | Produces a `query-set-scores.json` with all three retriever names present, each carrying real (not placeholder) recall@k/MRR/falsePositiveRate numbers. |
| Selection policy applied to the real three-way numbers | Documented in the PR body: which tier decided, which retriever won, and the losing candidates' numbers. |
| Deployment branching | If keyword/BM25 wins: `apps/api`'s existing runbook-retrieval-wiring test suite passes against the (possibly changed) factory. If frozen-embedding wins: `agent-runtime.module.ts` diff is empty, and a new follow-up issue exists (linked in the PR body). |
| Production build/typecheck after all relocations | `packages/agent-runtime`, `apps/worker`, and `apps/api` all build and typecheck cleanly; the production Docker image builds and starts without `runbooks-eval/` present (the concrete regression test for §0 fix 1's boundary claim). |

**What this verification cannot prove:** the frozen fixture reflects Voyage's real embedding
quality *for these 40 committed queries only* — it says nothing about how the same model would
score a real, unscripted production ticket summary. This is the same boundary the milestone plan
already draws (§2.1's "cannot serve an arbitrary production query" framing) and is the direct
reason §2.7 forbids wiring the fixture-backed retriever into `apps/api` under any outcome. No
additional live-model observation is warranted here — retrieval quality's only honest "real"
measurement would be a live Voyage retriever in production traffic, which is exactly the deferred
follow-up §2.7 describes if frozen-embedding wins.

## 5. Out of scope

- Wiring `VoyageRunbookRetriever` (live, per-request) into `apps/api`, under any comparison
  outcome — per the milestone plan's own explicit exclusion, a separate follow-up decision if
  frozen-embedding wins (§2.7).
- Any change to the adversarial/injection eval suite (#77/#78's scope).
- Re-running or re-tuning keyword/BM25's own calibration values — #75's calibration stands
  unchanged (§3); only the calibration *procedure* is generalized to support a step size, and only
  a new frozen-embedding entry is added to the same script.
- A caching layer for `VoyageRunbookRetriever`'s live per-request re-embedding — orthogonal to this
  issue's frozen, offline fixture and already noted as a known gap in `docs/05-rag-design.md` §10.
- CI wiring for the fixture-generation script — it is a one-time, owner-run script, never invoked
  automatically (same posture as `calibrate-min-score.ts`'s calibration procedure).
- Copying `runbooks-eval/` into the production Docker image, under any outcome — the fixture is
  explicitly never a production asset (§1, §2.7).

## 6. Sequencing

0. Re-run `pnpm agent:codex-review` against this corrected plan before implementation starts,
   confirming both rounds' fixes (§0, §0a) resolve the prior findings (this repo's plan-review
   convention).
1. Relocate `cosineSimilarity`/`l2Norm` to `packages/agent-runtime`; update
   `voyage-runbook-retriever.ts`'s imports; confirm its existing test suite still passes unchanged.
2. Add the shared `sha256(text)` helper to `corpus-content-hash.ts`; update `score-query-set.ts`
   to use it instead of its local inline version; confirm `query-set-scores.json` is byte-identical
   after the swap (pure refactor, no behavior change).
3. Owner go-ahead for the one owner-run Voyage fixture-generation operation (§2.1), then write and
   run `apps/worker/src/demo/generate-embedding-fixture.ts`; commit `embedding-fixture.json`.
4. `FixtureBackedRunbookRetriever` + tests (construction validation, staleness on all four
   dimensions, fixture-miss, ranking correctness, explicit-`minScore` constructor parameter).
5. Generalize `calibrate-min-score.ts`'s `calibrateRetriever()` with the `step` parameter and
   construct its frozen-embedding calibration instance with `minScore: 0` (§0a fix 1); add the
   frozen-embedding entry; regenerate `min-score-calibration.json`; freeze
   `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE`.
6. Add `computeFrozenEmbeddingFingerprint` (taking `minScore`, §0a fix 3) /
   `computeEmbeddingFixturePayloadHash` to `retriever-fingerprints.ts`; wire the third
   `RETRIEVER_CANDIDATES` entry into `score-query-set.ts`; extend `retrieval-quality-config.ts`'s
   freshness check with the `queryContentHash` comparison for all three retrievers (§0a fix 2) and
   the frozen-embedding fingerprint comparison; regenerate `query-set-scores.json` (now three-way).
7. Apply the selection policy, including the tie-break rule (§2.6, §0a fix 4), to the real numbers;
   write the decision into the PR body.
8. Deployment branching (§2.7): wire the winner into `agent-runtime.module.ts`, or open the
   named follow-up issue and leave it untouched.
9. `pnpm agent:verify --final`; confirm the production Docker image still builds without
   `runbooks-eval/`; `pnpm agent:review-bundle`; `pnpm agent:codex-review`.

## 7. Acceptance criteria

1. `embedding-fixture.json` is committed with real content hashes (corpus + query set) and
   embedding-model/dimension metadata; a corpus, query-set, model, or dimension change since
   generation is independently detectable at retriever-construction time.
2. `FixtureBackedRunbookRetriever` makes zero network calls, validates the loaded fixture's
   structure before any `retrieve()` call, and fails closed with a clear "fixture stale —
   regenerate" error on any of the four staleness dimensions (corpus, query set, model, dimension)
   — verified by a dedicated test per dimension, not just "the check exists."
3. A real three-way recall@k/MRR/falsePositiveRate comparison (keyword / BM25 / frozen-embedding)
   is produced by `score-query-set.ts` and reported in the PR body.
4. The selection policy declared in `docs/reviews/27-...-plan.md` §2.1 is applied exactly as
   written — not improvised against the numbers — and the decision (including losing candidates'
   numbers) is recorded either way.
5. If keyword or BM25 wins: it is wired into `apps/api`'s `RUNBOOK_RETRIEVER`, and existing API
   integration tests pass unmodified in intent.
6. If frozen-embedding wins: `apps/api` is **not** wired to any live embedding retriever in this
   issue; a named follow-up issue exists; the second-best deterministic retriever ships instead,
   with that choice justified in the same PR.
7. `packages/agent-runtime` (including the relocated cosine-similarity math and the new fixture
   fingerprint functions) stays free of any file I/O at module-evaluation time; the production
   Docker image builds and starts successfully without `runbooks-eval/` present.
8. Calibration for every candidate, including frozen-embedding, scores unthresholded raw values —
   verified by a test proving the frozen-embedding calibration path never applies
   `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` internally during calibration.
9. `resolveRetrievalQualityMetrics` rejects a stale artifact on a query-set-only edit (corpus and
   fixture unchanged) for all three retriever selections, closing a gap that predates this issue.
10. The frozen-embedding fingerprint changes when `DEFAULT_FIXTURE_RETRIEVER_MIN_SCORE` changes,
    with fixture content held constant.
11. A tie between the shipped keyword retriever and any new candidate, on the metric that decided
    the winning tier, resolves to keyword — verified by a table-driven test with a real tied input.
