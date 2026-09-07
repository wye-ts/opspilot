# Issue #74 — Expand runbook corpus + author retrieval-quality query set

| | |
| --- | --- |
| Scope | [#74](https://github.com/wye-ts/opspilot/issues/74) "Expand runbook corpus + author retrieval-quality query set" — corpus + query-set authoring only; no new metrics, retrievers, or eval-harness code (those are #75/#76). |
| Basis | `main` @ `0f515fe` (post-#72 docs cleanup), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/74-runbook-corpus-query-set` (created, empty) |
| Committed location | `docs/reviews/28-issue-74-runbook-corpus-query-set-plan.md` |

---

## Scope decision (if the issue text admits more than one reading)

The issue could be read two ways: (a) grow `runbooks/` into an eval-only fixture directory
separate from what `apps/api` loads at startup, or (b) grow the single `runbooks/` directory that
already backs both the deployed retriever and the eval harness. `docs/reviews/27-milestone-13-...
-plan.md` §2.1 already settled this ("no separate eval-only corpus, so the numbers this milestone
produces describe the actual production retrieval path") — this plan follows that decision rather
than reopening it. **Decision: (b), single shared `runbooks/` directory.**

The query-set format also admits two readings: a flat list of query strings, or labeled records
carrying the query, its group, and its expected answer(s). Flat strings would be useless to #75
(which must score recall@k/MRR per group against a known-correct chunk) — the plan-level design
(§2.1) already specifies "30–40 labeled queries in four groups." **Decision: labeled JSON records**
(query text, group, expected chunk id(s) where applicable), not a plain string list.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Runbook corpus | `runbooks/*.md` (5 files) | `notification-service.md`, `notification-queue.md`, `authentication-failures.md`, `database-connections.md`, `billing-invoice-formatting.md` — 7 chunks total. Frontmatter: `runbookId`/`serviceSlug`/`category` (category is one of `IncidentCategorySchema`'s six values — `packages/contracts/src/resolution-report.ts:13-20`). Each chunk: `## <title>` heading, then a `<!-- chunkId: ... -->` comment, then one paragraph of body text. |
| Loader / parser | `packages/agent-runtime/src/rag/markdown-runbook-loader.ts` | Strict format enforcement: exactly one `---`-delimited frontmatter block with only `runbookId`/`serviceSlug`/`category` keys (`ALLOWED_METADATA_KEYS`), slugs matching `^[a-z0-9]+(-[a-z0-9]+)*$`, category matching `^[A-Z]+(_[A-Z]+)*$`, at most one H1, one or more H2 chunk headings each immediately followed (skipping blank lines) by a `<!-- chunkId: slug -->` comment, non-empty chunk body, no nested directories, no symlinks, real-path containment check. Corpus-wide duplicate `chunkId` across files is rejected (`DUPLICATE_CHUNK_ID`). |
| Corpus-wide shape validation | `packages/agent-runtime/src/rag/runbook-corpus-validation.ts` | `validateStoredRunbookChunks` — every chunk's `chunkId` non-empty and ≤128 chars (mirrors `packages/contracts`' `RetrievalSummaryEntrySchema` bound exactly — a violation here fails container startup loudly instead of failing a real run mid-flight, per #72). |
| Load path | `packages/agent-runtime/src/rag/load-default-runbook-corpus.ts` | `resolveDefaultRunbooksDir()` resolves 4 levels up from its own compiled location to the repo-root `runbooks/` dir — unaffected by adding/renaming files inside that directory. |
| Eval dataset's hard dependency on today's exact chunk set | `apps/worker/src/evaluation/cases/topic-runbook-cases.ts`, `evidence-grounding-cases.ts`, `protocol-and-failure-cases.ts`, `checkpoint-b-cases.ts` | All 20 existing cases reference today's 7 chunk ids by exact string literal in `expectedTop1`/`expectedInTopK`/`forbiddenChunkIds`/evidence `evidenceId` fields (e.g. `runbook-notification-degradation-001`). `dataset-validation.ts`'s `validateCase` cross-checks every referenced id against the *effective corpus* (`resolveCorpus` → the real loaded corpus for `corpusProfile: "default"`), so a corpus edit that removes or renames any of the 7 ids fails eval-harness validation, not silently. |
| Test files hard-coding today's exact corpus size | `packages/agent-runtime/src/rag/load-default-runbook-corpus.test.ts:25-27`, `apps/worker/src/demo/run-rag-agent-demo.test.ts:46-47` | Both assert `sourceFileCount === 5` and `chunks.length === 7` against the *real* loaded corpus (not a fixture) — these will fail the moment `runbooks/` grows, by design (they're proving today's exact shape), and must be updated in this issue's own PR to the new file/chunk counts. `load-default-runbook-corpus.test.ts`'s `EXPECTED_CHUNK_IDS` constant is doubly-used (also drives the separate "no line breaks in the seven migrated chunks" test at line 69) — the two uses must not be conflated when this file changes (§2.4). |
| Retriever scoring (what "near-miss overlap" must actually defeat) | `packages/agent-runtime/src/rag/in-memory-runbook-retriever.ts` | Token-overlap only: `+2` per query token found in `chunk.title`, `+1` if found in `chunk.content`, `0` otherwise (no stopwords/IDF/stemming). A chunk scoring `0` is excluded entirely. Ties broken by `chunkId` ascending. This is the retriever the new corpus and query set must be authored *against* — a near-miss pair only "confuses" this retriever if the two chunks share enough raw tokens (not just topic), and a paraphrase query only "defeats" it if it swaps out the runbook's own vocabulary for synonyms. |
| `topK` bound | `packages/agent-runtime/src/rag/retrieval-validation.ts:7` | `topK` must be an integer in `[1, 5]`; the eval harness's own constant is `EVALUATION_TOP_K = 3` (`apps/worker/src/evaluation/types.ts:18`, "no case may override topK"). Query-set authoring must design near-miss/expectedInTopK expectations against `topK = 3`, not an arbitrary k. |
| Incident category enum (for new runbooks' frontmatter) | `packages/contracts/src/resolution-report.ts:13-20` | `IncidentCategorySchema = z.enum(["SERVICE_DEGRADATION", "RATE_LIMITING", "AUTHENTICATION", "CONFIGURATION", "DATA_QUALITY", "UNKNOWN"])`. Today's 5 runbooks use 4 of these (no `RATE_LIMITING`, no `UNKNOWN`) — new runbooks should exercise `RATE_LIMITING` too, since it is a real category with zero corpus coverage today. |
| No existing query-set file/format to follow | (none) | This repo has no precedent structured query-set fixture to imitate; the shape is a new, small design decision here (§2 below), not an existing convention to preserve. |

---

## 2. Design

### 2.1 Corpus expansion — target shape

Grow `runbooks/` from 5 files / 7 chunks to **16 files / ~24 chunks**, all through the existing
loader with zero parser/validator changes. Concretely:

- **Keep all 5 existing files and their 7 chunk ids completely unchanged** (content, title, and
  chunk id) — the 20 existing eval cases' `expectedTop1`/`expectedInTopK`/evidence citations must
  keep passing unmodified (per #74's own acceptance criteria and the milestone plan's explicit
  requirement).
- **Add 11 new files**, each 1-2 chunks, covering:
  - 3 files that are deliberate **near-miss pairs/triples** with an *existing* topic — sharing
    enough raw vocabulary with an existing runbook to score non-zero under the keyword retriever,
    but resolving to a genuinely different root cause (e.g. a new `notification-rate-limit.md`
    sharing "notification"/"delayed"/"queue"-adjacent tokens with the existing notification
    runbooks but describing a rate-limit-triggered incident, `category: RATE_LIMITING`, distinct
    from the existing DEGRADATION/queue-backlog pair).
  - 4 files introducing **new, unrelated topics** (to give true-negative queries something
    plausible-but-wrong to almost-match, and to give paraphrase queries more than one correct
    target family to test against) — e.g. deployment-rollback, cache-invalidation,
    third-party-webhook-delivery, and a second `RATE_LIMITING` example
    (API-rate-limit-vs-notification-rate-limit, an intentional near-miss *pair between two new
    files*, not just new-vs-old).
  - 4 files that are themselves **near-miss pairs against each other** (2 pairs), independent of
    the existing 5 files, so the corpus's internal discrimination difficulty isn't solely anchored
    to the original topics.
- Every new file follows the existing format exactly: `runbookId`/`serviceSlug`/`category`
  frontmatter, one H1, one or more `## <title>` chunks each with a `<!-- chunkId: ... -->` comment
  and one paragraph of body content — verified by running the unmodified loader/validator against
  the new files (§4).
- New chunk ids follow the existing naming convention (`runbook-<topic-slug>-<NNN>`), globally
  unique (enforced by the loader's `DUPLICATE_CHUNK_ID` check, not just visually).

### 2.2 Query-set format and content

New file: `runbooks-eval/retrieval-query-set.json` (a top-level directory sibling to `runbooks/`,
not inside it — the loader's directory scan would otherwise need to special-case excluding it,
and this keeps the eval-only fixture visibly separate from the production corpus directory per
§0's "no separate corpus" decision, which concerns the corpus, not the query fixture built against
it).

```jsonc
{
  "corpusVersion": "<content hash of the full expanded corpus, see #76 for the hashing scheme this must be compatible with>",
  "queries": [
    {
      "id": "q-exact-001",
      "group": "exact",
      "query": "notification service degradation",
      "expectedChunkIds": ["runbook-notification-degradation-001"],
      "distractorChunkIds": []
    },
    {
      "id": "q-paraphrase-001",
      "group": "paraphrase",
      "query": "emails are stuck and not going out",
      "expectedChunkIds": ["runbook-notification-degradation-001"],
      "distractorChunkIds": []
    },
    {
      "id": "q-nearmiss-001",
      "group": "near_miss",
      "query": "notification rate limit exceeded",
      "expectedChunkIds": ["runbook-notification-rate-limit-001"],
      "distractorChunkIds": ["runbook-notification-degradation-001"]
    },
    {
      "id": "q-truenegative-001",
      "group": "true_negative",
      "query": "notification service maintenance window schedule",
      "expectedChunkIds": [],
      "distractorChunkIds": ["runbook-notification-degradation-001"]
    }
  ]
}
```

- **`group`** is one of the four fixed literals `exact | paraphrase | near_miss | true_negative` —
  #75's per-group recall@k/MRR breakdown keys off this field directly, so the four literal values
  used here are load-bearing for #75's implementation, not just documentation.
- **`expectedChunkIds`** is empty for every `true_negative` query (by definition) and non-empty
  (1+ ids) for the other three groups — enforced mechanically, not just by convention (§4 check 4).
- **`distractorChunkIds`** is a new, required field for `near_miss` and `true_negative` queries
  (empty array allowed only for `exact`/`paraphrase`, where no specific confusable chunk is being
  engineered against). It names the chunk(s) this query is deliberately designed to be confusable
  with (Codex-review MAJOR finding, verified against the plan's own retriever description in §1:
  without a declared distractor, a "near-miss" query that the keyword retriever trivially
  disambiguates, or a "true-negative" query built from vocabulary absent from the whole corpus,
  would pass every planned check while testing nothing near the actual discrimination/false-
  positive behavior these groups exist to measure). Concretely:
  - **`near_miss`**: at least one `distractorChunkIds` entry must rank in the retriever's top-3
    for this query (a genuine top-K contender, not merely a nonzero score) while not being in
    `expectedChunkIds` — proving the query is actually confusable at the `topK=3` bound the eval
    harness uses, not just superficially topic-adjacent. At least 4 of the 12 near-miss queries
    (roughly a third) must additionally be queries where the shipped keyword retriever currently
    ranks a distractor *above* the correct `expectedChunkIds` entry — i.e. queries the current
    retriever gets wrong today — so #75/#76's later comparison against BM25/embeddings has real
    room to show improvement, not just confirm the keyword retriever already wins everywhere.
  - **`true_negative`**: at least one `distractorChunkIds` entry must score strictly greater than
    zero under the shipped keyword retriever's raw (pre-threshold) scoring — a plausible-but-wrong
    match, not a query built from vocabulary absent from the whole corpus. This is what gives
    #75's `falsePositiveRate` metric something real to measure: a threshold that correctly
    suppresses a positively-scored wrong answer is a meaningful result, while suppressing a
    zero-scoring non-match proves nothing (the un-thresholded retriever already excludes
    zero-scoring chunks entirely — see §1).
- Target counts per group, summing to the plan's stated 30-40: **10 exact, 10 paraphrase, 12
  near-miss, 8 true-negative** (40 total) — near-miss gets the largest allocation because it is
  the group requiring the most corpus-design care (each one depends on a specific engineered
  distractor pair existing in §2.1).
- Every `expectedChunkIds`/`distractorChunkIds` entry must reference a real chunk id present in
  the expanded corpus — verified mechanically in §4, not just by eye.

### 2.3 What this issue does **not** touch

No changes to `EvaluationMetrics`, `evaluation-evaluator.ts`, `observed-facts.ts`,
`in-memory-runbook-retriever.ts`, or any new `RunbookRetriever` implementation — the query-set
JSON file is inert data until #75 adds the code that reads and scores against it during the real
eval run. This issue's only executable-code changes are the two test-count updates in §2.4 and a
small, standalone `runbooks-eval/validate-query-set.ts` script (§4) that checks the query set's
own internal shape and distractor-competitiveness — it is committed (not throwaway, per §7) so
#75 can extend it, but it is never wired into the eval harness itself; it is a standalone
authoring-time check, run manually per §6, not part of `pnpm --filter @opspilot/worker run eval`.

### 2.4 Required test updates (mechanical, not new behavior)

- `packages/agent-runtime/src/rag/load-default-runbook-corpus.test.ts:5-13,25-27` — **do not**
  extend the existing `EXPECTED_CHUNK_IDS` constant in place (Codex-review MAJOR finding, verified
  against the actual test file: that same constant is also the filter driving the "contains no
  line breaks in any of the seven migrated chunk bodies" test at line 69-78 — silently growing it
  to include new chunk ids would retroactively impose the migration-only no-line-break constraint
  on every new runbook chunk, contradicting this plan's own statement that test stays scoped to
  the original 7). Instead: keep `EXPECTED_CHUNK_IDS` unchanged (still exactly the original 7,
  still the sole input to the no-line-break test), and add a **second**, separate constant (e.g.
  `ALL_EXPECTED_CHUNK_IDS`, the original 7 plus every new chunk id) used only by the
  `sourceFileCount`/`chunks.length`/full-id-set assertions at lines 25-27. The two constants must
  never be merged into one.
- `apps/worker/src/demo/run-rag-agent-demo.test.ts:46-47` — same two count assertions, same new
  totals (this file has no equivalent line-break test, so no analogous split is needed here).
- Add one new test case in `load-default-runbook-corpus.test.ts` asserting that at least one of
  the 11 new runbook files' chunk content DOES contain a line break (i.e. its Markdown source
  wraps the paragraph across physical lines) and that this chunk is correctly absent from
  `EXPECTED_CHUNK_IDS`'s no-line-break check — a direct regression test proving the two constants
  stayed split rather than merged (the finding's own `missingTest` recommendation).

---

## 3. Compatibility

No persisted data, API contract, or schema changes. The 20 existing eval cases are the
compatibility surface that matters here, and they are protected structurally: `dataset-validation
.ts`'s `validateCase` already cross-checks every case's referenced chunk ids against the live
loaded corpus on every `pnpm --filter @opspilot/worker run eval` invocation (including in CI's
cross-service-parity job) — if this issue's corpus edit ever broke one of the 7 original ids, the
eval harness would fail validation immediately, not silently. No new compatibility mechanism is
needed beyond running the existing suite (§4).

---

## 4. Verification plan — and an explicit limit of what it can prove

| # | Check | Command / method | Proves |
| --- | --- | --- | --- |
| 1 | New/existing runbook files all parse under the unmodified loader | `pnpm --filter @opspilot/agent-runtime run test -- load-default-runbook-corpus` | Format compliance (frontmatter, chunk headings, chunk-id comments) for the full expanded corpus, not just the 5 original files. |
| 2 | Full 20-case eval suite still passes unmodified against the expanded corpus | `EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval` (offline; see opspilot-development skill's pitfall #1 — bare `pnpm eval` calls the Python service, which is a heavier and unnecessary dependency for this check) | The 7 original chunk ids' exact retrieval ranks are unchanged by the new distractor content — the load-bearing acceptance criterion. |
| 3 | No duplicate chunk ids across old + new files | Already enforced by the loader itself (`DUPLICATE_CHUNK_ID`) — check 1 above fails loudly if violated; no separate script needed. |
| 4 | Query-set records are internally valid | A committed validation script (`runbooks-eval/validate-query-set.ts` or similar — small enough to keep, since #75 will extend it rather than throw it away) checking: every `id` and `query` string non-empty and unique; `group` is one of the four fixed literals with exactly the target count per group (10/10/12/8); every `exact`/`paraphrase`/`near_miss` record has 1+ `expectedChunkIds`; every `true_negative` record has exactly 0 `expectedChunkIds`; every `expectedChunkIds`/`distractorChunkIds` entry references a real corpus chunk id | The query-set JSON is structurally sound and internally consistent with the corpus and its own labeling rules — not just "doesn't crash the harness," but shaped so #75's recall/MRR/false-positive-rate code can trust every field without re-deriving these invariants itself (Codex-review MAJOR finding: the original single membership-only check let a positive-group record with empty `expectedChunkIds`, or a `true_negative` record wrongly carrying non-empty `expectedChunkIds`, pass silently). |
| 5 | Near-miss and true-negative distractors are genuinely confusable, not superficially so | Same script, calling `InMemoryKeywordRunbookRetriever.retrieve()` directly for every `near_miss`/`true_negative` query and asserting: (a) every declared `distractorChunkIds` entry scores `> 0`; (b) for `near_miss`, at least one distractor ranks within the retriever's top-3 (`topK=3`) and is not itself in `expectedChunkIds`, with at least 4 of the 12 near-miss queries additionally having a distractor rank *above* the correct answer; (c) for `true_negative`, at least one distractor scores `> 0` under the retriever's raw pre-threshold scoring | The near-miss queries are actually confusable at the harness's real `topK=3` bound (not just "nonzero somewhere"), and at least some already fool today's retriever — giving #75/#76's later BM25/embedding comparison real room to show a difference. The true-negative queries exercise the false-positive-rate metric's actual purpose (suppressing a positively-scored wrong answer), not a trivial all-zero-score case the un-thresholded retriever already excludes for free (Codex-review MAJOR findings, both verified against §1's description of the shipped retriever's exact scoring/filtering behavior). |
| 6 | `pnpm agent:verify --final` | Per `AGENTS.md` | Typecheck + full test suite pass repo-wide, not just the touched files. |

**What this verification cannot prove:** that the near-miss/paraphrase queries are *realistic*
incident language a real support engineer would actually type, or that the corpus's topical
coverage is representative of a real production runbook library. Both are inherently a judgment
call by whoever authors the 40 queries and 11 new runbooks, not something a deterministic check
can validate. No further action is proposed here — the corpus is a portfolio-scale fixture (16
files), not a production knowledge base, and over-engineering "realism" verification for it would
not match `CONTEXT.md`'s smallest-sufficient-solution posture.

---

## 5. Out of scope (explicit)

- Any change to `EvaluationMetrics`, evaluator/observed-facts code, or any `RunbookRetriever`
  implementation (BM25, threshold enforcement) — all of #75.
- The frozen-embedding fixture and three-way comparison — #76.
- Wiring anything new into `apps/api` — no production retriever selection changes here.
- A corpus-content-hash/staleness-guard mechanism — that belongs to #76's frozen-embedding fixture
  design (which needs one to detect drift against committed embeddings); this issue's query set
  carries a `corpusVersion` field as a forward-compatible placeholder only, not an enforced check.

---

## 6. Sequencing

1. Author the 11 new runbook Markdown files (§2.1), running the loader test locally after each
   batch of 2-3 files to catch format mistakes early rather than all at once at the end.
2. Update the two test files' count assertions (§2.4).
3. Run the full 20-case eval suite (§4 check 2) — confirm zero regressions before writing a single
   query.
4. Write `runbooks-eval/validate-query-set.ts` (§4 checks 4-5) before authoring queries, not after
   — the record-shape and distractor-competitiveness rules it encodes are exactly what determines
   whether a candidate query/distractor pair is acceptable, so authoring against a stub set of
   queries with no validator would risk discovering the near-miss/true-negative distractor
   requirements only after all 40 are already written.
5. Author `retrieval-query-set.json`'s 40 entries (§2.2), running the validator (§4 checks 4-5)
   iteratively as queries are added, not only once at the end — a `near_miss`/`true_negative` query
   that fails the distractor-competitiveness check needs a different corpus distractor authored
   for it, which may in turn require a small addition back in §2.1's corpus (an expected, normal
   iteration between steps 1 and 5, not a sign either step was done wrong).
6. `pnpm agent:verify --final`.
7. `pnpm agent:review-bundle` + `pnpm agent:codex-review` per the standard harness cycle.

---

## 7. Acceptance criteria

1. `runbooks/` contains 16 files (5 unchanged + 11 new) with at least 3 deliberate near-miss
   pairs/triples, verified by check 5 (§4) actually scoring the distractor above zero.
2. All 7 pre-existing chunk ids remain present, unchanged in content/title, and the full 20-case
   eval suite passes unmodified (`EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval`
   exits 0).
3. `runbooks-eval/retrieval-query-set.json` exists with 40 labeled queries across exactly the four
   groups `exact` (10) / `paraphrase` (10) / `near_miss` (12) / `true_negative` (8); every
   `exact`/`paraphrase`/`near_miss` record has 1+ non-empty `expectedChunkIds`, every
   `true_negative` record has exactly 0; every `expectedChunkIds`/`distractorChunkIds` entry
   references a real corpus chunk id (check 4, §4).
4. Every `near_miss` query's declared distractor(s) score `> 0` and at least one ranks in the
   retriever's real top-3 for that query without being the correct answer; at least 4 of the 12
   near-miss queries have a distractor ranking *above* the correct answer today. Every
   `true_negative` query's declared distractor scores `> 0` under the retriever's raw pre-threshold
   scoring (check 5, §4) — both are Codex-review-driven strengthenings over a membership-only check
   and are the criteria that make the false-positive-rate and near-miss-discrimination metrics
   #75/#76 will build meaningful rather than trivially satisfied.
5. `runbooks-eval/validate-query-set.ts` (or equivalent) is committed, not a throwaway script, so
   #75 can extend it rather than re-derive the same invariants independently.
6. `pnpm agent:verify --final` passes.
