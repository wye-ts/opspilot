# Milestone 13 — Retrieval Quality Evaluation + Adversarial Robustness Suite

| | |
| --- | --- |
| Scope | New milestone (no GitHub issue filed yet — this plan proposes the issue breakdown for owner review before filing). Closes the one concrete gap identified by an Opus-5 portfolio-value exploration (2026-09-06, verified against source before this plan was written): the project has an extensive *behavioral* eval harness (20 deterministic cases, 15 aggregate metrics) but zero *retrieval-quality* measurement and a single-case adversarial/injection eval. |
| Basis | `main` @ `0f515fe` (post-#72 docs cleanup), working tree clean |
| Status | Plan only. No repository source modified, no migration, no branch, no commit, push, PR, merge, GitHub issue, or provider/LIVE request. |
| Branch | This plan document itself lives on a `docs/milestone-13-retrieval-eval-plan` planning branch (not yet created); each of the five issues in §6 gets its own `feat/<issue-number>-<slug>` implementation branch once filed as a GitHub issue — no issue number is reserved yet, so none is named here to avoid colliding with a future real issue number the way an earlier draft of this plan did (it named `feat/73-...`, but #73 is already a merged PR). |
| Committed location | `docs/reviews/27-milestone-13-retrieval-and-adversarial-eval-plan.md` |

---

## 0. Why this milestone, and why not the alternatives considered

Three other candidates were evaluated and explicitly rejected before this one — recorded here so a
future reader can verify the narrowing was deliberate:

1. **Historical run list / run history UI.** Genuinely small (list endpoint + pagination + a
   table) and two prior plans (`docs/14-web-ui.md:711`, `docs/reviews/16-approval-workflow-ux-plan.md:248`)
   left the run-scoped layout ready for it without foreclosing it. Rejected as the *next* milestone
   because it demonstrates no engineering skill beyond CRUD, and it introduces a real new
   consideration (public-trial visitor free-text ticket summaries would become browsable) that
   isn't worth taking on for a low-value feature. Still available later, e.g. to let a demo visitor
   browse past investigations without spending their one daily LIVE-trial run.
2. **Multi-agent investigation workflow (PRD §17 item 5).** Rejected outright. The system has one
   diagnostic tool and a small runbook corpus — no genuine specialization exists for sub-agents to
   exploit. Building it would fight `CONTEXT.md`'s "smallest sufficient solution" posture, blow up
   the bounded-turn/cost model the entire LIVE safety story rests on, and force a rework of the
   eval harness's determinism guarantees, for a capability with no real justification in this
   system's shape. "Why multiple agents?" has no good answer here beyond resume padding.
3. **Real external integration with an idempotent delivery design (PRD §17 items 1–3, 12;
   `docs/03-technical-design.md` §8.2, §33 open question 6).** Genuinely the biggest narrative gap
   (approved actions are never executed today) and reuses the approval workflow and fail-closed
   config patterns well. Rejected as *this* milestone only because it's the one candidate with real
   blast radius — actual external credentials, actual external writes — and because it doesn't fit
   in the same harness/no-new-infrastructure envelope as the two issues below. Recorded as the
   strongest candidate for Milestone 14, after this milestone ships.

The milestone below was chosen because it is the only candidate that produces **measured results**,
which `docs/03-technical-design.md` §31 already requires of every resume claim this project makes —
and today there are essentially none of the retrieval-quality kind. It also reuses 100% of existing
infrastructure (the eval harness, the Python scoring service, the `RunbookRetriever` seam from #72)
and adds zero new runtime dependencies to any deployed path.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Deployed retriever | `packages/agent-runtime/src/rag/in-memory-runbook-retriever.ts` (`InMemoryKeywordRunbookRetriever`) | Raw, unweighted token-overlap scoring: `+2` per query token matched in the chunk title, `+1` per query token matched in the content, `0` otherwise. No stopwords, no IDF, no length normalization, no stemming. A chunk scoring `0` is excluded, not merely ranked last. Comment at the top of the file says explicitly: "not a stand-in for semantic embedding similarity." This is what `apps/api` constructs at container startup (issue #72) and what every FAKE and LIVE run in production retrieves against. |
| Offline embedding retriever | `apps/worker/src/rag/voyage-runbook-retriever.ts` (`VoyageRunbookRetriever`) | Real Voyage embeddings, cosine similarity, extensive response-shape validation (index remapping, dimension/finite/zero-norm checks). Lives only in `apps/worker`; never wired into `apps/api` (deliberately, per #72's plan — see §0 flag below). Re-embeds the full corpus on every call; no caching, no persistence (`docs/05-rag-design.md` §10). |
| Runbook corpus | `runbooks/*.md` (5 files) | Hand-authored Markdown, one topic each (notification-service, notification-queue, database-connections, billing-invoice-formatting, authentication-failures), 7 chunks total, each ~10–15 lines. Loaded once at container startup via `loadDefaultRunbookCorpus()`. Too small for any retrieval-method comparison to be statistically meaningful — cases 1–6 in the eval dataset are deliberately built so the target chunk is "provably dominant" by construction (`docs/07-evaluation-plan.md` §3), which is a correctness proof, not a discriminating quality measurement. |
| Eval harness dataset | `apps/worker/src/evaluation/evaluation-dataset.ts` + `cases/*.ts` | 20 fixed cases (`TOPIC_RUNBOOK_CASES` ×6, 2 fabricated-evidence cases, `PROTOCOL_AND_FAILURE_CASES` ×12, 1 structural injection probe, `CHECKPOINT_B_CASES` ×5 from #59). Comment at `evaluation-dataset.ts:19-21` confirms the dataset grew from 15 to 20 cases at #59 while staying "backward-compatible with the 15-case fixtures" — i.e. the 5 new cases were appended, not interleaved. |
| Eval harness retrieval metrics | `apps/worker/src/evaluation/evaluation-evaluator.ts` (`retrieval-top1`, `retrieval-hit3` checks); `services/evaluation/src/opspilot_evaluation/scoring/metrics.py` (`retrievalTop1`, `retrievalHitAt3` ratios) | Binary hit/miss only, evaluated against the live `InMemoryKeywordRunbookRetriever` (via the real orchestrator run, not a retriever called in isolation). No recall@k beyond k=3, no MRR, no per-query score distribution, no retriever-vs-retriever comparison capability at all. |
| Eval harness determinism guarantee | `docs/07-evaluation-plan.md` §3 (line 33), §9; §10's default-scorer statement (line ~463) | "fully offline, deterministic... no live provider, and no persistence" describes **case execution**: no case ever calls a real LLM or embedding provider, and every case's inputs/outputs are scripted and reproducible. It does **not** mean zero network calls end to end — corrected after a Codex-review BLOCKER-adjacent finding caught this plan's own first draft conflating the two: `docs/07-evaluation-plan.md` §10 states plainly that "the Python/FastAPI evaluation service is the default, authoritative scorer" for `pnpm --filter @opspilot/worker run eval` — that command normally makes one bounded HTTP call to the local evaluation service and persists the run/case/check/metric rows there. The **zero-network** invariant applies specifically to `EVALUATION_SCORER=local` (`LocalEvaluationScorer`, the explicit-only parity oracle) and to case execution itself (no LLM/embedding provider call, regardless of scorer mode). This milestone's frozen-embedding fixture (§2.1) must be scoped against the correct invariant: no live embedding-provider call during case execution in *either* scorer mode, not "no network calls at all." |
| Eval harness CI wiring | `.github/workflows/ci.yml` — `evaluation-service` job (Python service migrate+pytest) and `Cross-service parity (TS worker -> Python evaluation service)` job (`ci.yml:454`) | The eval harness **already runs in CI on every PR**, 3 times inside the cross-service-parity job — once via the default (service-scorer) path, once with the local oracle explicitly selected, once proving fail-closed behavior when the service is unreachable. `test:eval:cross-service` sets `EVALUATION_SERVICE_REQUIRED=1`, so the suite fails closed rather than skipping if the Python service isn't healthy. This contradicts an earlier framing ("the eval harness runs manually, CI doesn't run it") — per-case pass/fail regression gating is already live; **what's actually missing is an aggregate-metric drift gate** (§6 below) and job-name visibility (the job is titled "Cross-service parity," which does not read as "evals ran" to someone scanning the CI page). |
| Adversarial/injection coverage | `apps/worker/src/evaluation/cases/evidence-grounding-cases.ts` (`INJECTION_PROBE_STRUCTURAL_CASE`) + a separate manual live-spike scenario recorded in `docs/05-rag-design.md`/`docs/reviews/05-rag-design-spike-results.md` | Exactly one structural case in the deterministic harness: adversarial content is planted inside a retrieved chunk and the case proves evidence-grounding rejects a report that cites it. One additional manual (non-CI, non-repeatable) live spike exists from the original RAG design milestone. No systematic coverage of tool-output injection, instruction-override attempts, fabricated-evidence-ID smuggling via tool results (as opposed to RAG chunks), or role-confusion attempts. |
| Stale documentation found during this exploration | `README.md:297,300` say "15-case evaluation"; `evals/cases/` is an empty, unused directory (`ls` confirms zero files) | Both are pre-existing staleness unrelated to this milestone's design decisions — corrected as small fixes in §6, not treated as in-scope engineering work. |
| Scope precedent: Voyage-in-prod already deferred once | `docs/reviews/26-issue-72-runbook-retrieval-api-wiring-plan.md:57` | "`voyage-embedding-client.ts` / `voyage-runbook-retriever.ts` stay in `apps/worker` — out of scope (§5), and moving them would pull `voyageai` into `packages/agent-runtime`'s dependency graph, which `apps/api` would then also carry even though it never uses it." This was a **deliberate deferral**, not a rejection — #72's plan explicitly left the door open pending a reason to reopen it. This milestone provides that reason (see §2.1) but must state the reopening explicitly rather than silently reversing #72's scope, per this repo's own review-discipline convention. |
| Scope precedent: live embedding evaluation already deferred once | `docs/07-evaluation-plan.md:405` (approx.) defers "live Voyage evaluation" from the harness | This milestone's frozen-fixture approach (§2.1) is designed to **respect** that deferral, not reverse it — it never calls Voyage live from the harness; it calls Voyage exactly once, offline, outside the harness, to produce a committed fixture. |

---

## 2. Design

### 2.1 Retrieval-quality evaluation (Issues A–C)

**The reframe that matters:** this is not "wire `VoyageRunbookRetriever` into the deployed API." It
is "measure how good the deployed retriever actually is, build a second deterministic candidate
that costs nothing, and let data — not intuition — decide whether either replaces the shipped
keyword retriever." That is a materially different (and more defensible) engineering claim, and it
is the claim the eval harness is actually equipped to support today.

**Corpus expansion (Issue A).** Expand `runbooks/` from 5 files / 7 chunks to roughly 15–20
markdown files covering additional plausible incident topics with realistic content overlap
(e.g. two runbooks that both mention "timeout" and "retry" but resolve to different root causes —
the kind of near-miss confusion a real keyword retriever gets wrong and a real reader needs
disambiguated). Follow the existing frontmatter/chunk-comment format exactly
(`markdown-runbook-loader.ts`'s parser, `runbookId`/`serviceSlug`/`category` frontmatter,
`<!-- chunkId: ... -->` markers). This corpus becomes the new default corpus for both the
deployed retriever and the eval harness — no separate "eval-only" corpus, so the numbers this
milestone produces describe the actual production retrieval path.

**Retrieval eval query set (Issue A, same PR as corpus).** Author 30–40 labeled queries against
the expanded corpus, split into three groups the metrics must report separately (not blended —
per this repo's "severity-tiered, not blended" evaluation convention):
- **Exact/near-exact** queries (ticket language closely matches runbook title/content vocabulary)
  — the case the current keyword retriever is built for.
- **Paraphrase** queries (ticket language describes the same incident with different words —
  "emails are stuck" vs. a runbook titled "Notification Service Degradation") — the case a pure
  token-overlap retriever is expected to do worst on.
- **Near-miss distractor** queries (should retrieve a *specific* chunk among several plausible
  ones, proving discrimination, not just non-zero recall) and **true-negative** queries (no
  runbook should match; proves the retriever doesn't force a bad match when it should return
  nothing or a low-confidence result).

**New eval metrics (Issue B).** Extend `EvaluationMetrics` (TS `types.ts`) and
`EvaluationMetrics`/`aggregate_metrics` (Python `metrics.py`) with `recallAtK` (k configurable,
default matching `EVALUATION_TOP_K = 3`) and `meanReciprocalRank`, computed **per query group**
(exact / paraphrase / near-miss) so a retriever that's strong on exact matches and weak on
paraphrases doesn't average out to a misleadingly good aggregate. **True-negative queries are
explicitly excluded from recall@k/MRR** (Codex-review MAJOR finding, verified against source
before accepting: every `RunbookRetriever` implementation — keyword, and `VoyageRunbookRetriever`'s
cosine-similarity ranking — returns up to `topK` chunks unconditionally, with no relevance
threshold; `recall@k`/`MRR` are undefined for a query with no correct answer, and scoring a
"returns nothing relevant" case as an MRR of 0 would indistinguishably conflate it with "failed to
retrieve," which is the opposite of what a true-negative case is supposed to prove). True-negative
queries get their own metric instead: `falsePositiveRate` — the fraction of true-negative queries
for which the retriever returns *any* chunk scoring above a retriever-specific confidence
threshold. **The threshold is not an evaluation-only scoring cutoff — it must be the actual
result-filtering behavior applied in the deployed retriever** (Codex-review MAJOR finding, verified:
an eval-only threshold that doesn't match what `apps/api` actually returns would let a candidate
look safe on true negatives in the comparison while the deployed retriever still injects an
irrelevant chunk into a real investigation — the two must be the same code path, not two numbers
that happen to be compared). Each retriever's threshold is therefore added as a real, enforced
minimum-score cutoff in its own `RunbookRetriever.retrieve()` implementation (returning zero chunks
below threshold, not merely excluding them from the eval's count) — for the shipped keyword
retriever this is a **new, small, backward-compatible addition** (its current implementation already
excludes zero-scoring chunks entirely; a nonzero floor is the same mechanism, one more threshold
tier), and BM25/frozen-embedding get the same treatment built in from the start. The threshold value
itself is fixed **before** the held-out true-negative queries are scored (frozen ahead of time,
against a small held-out calibration set distinct from the reported comparison queries — never
tuned after seeing the true-negative results, which would be the exact overfitting the finding
warns against). This requires the eval harness's retrieval-observed-facts (`observed-facts.ts`) to
retain each retrieved chunk's **score**, not only its `chunkId` as today — a small, additive change
to `ObservedFacts` and the retrieval check logic in `evaluation-evaluator.ts`.

**A second deterministic retriever: BM25-style scoring (Issue B, same PR as metrics).** Implement
a new `RunbookRetriever` (`packages/agent-runtime/src/rag/bm25-runbook-retriever.ts` or similar)
with stopword filtering, inverse document frequency weighting, and document-length normalization —
the standard, free, zero-credential retrieval baseline this project has never had. This is
deterministic and adds no new dependency (a small in-repo IDF/BM25 implementation, not an external
library, matching this repo's existing preference for small hand-rolled deterministic logic over a
new dependency where the algorithm is simple — see `InMemoryKeywordRunbookRetriever` itself as
precedent for "implement it, don't import it" at this scale).

**Frozen-embedding comparison (Issue C).** Generate Voyage embeddings for the expanded corpus and
the 30–40 query set **once, offline, outside the eval harness**, and commit the resulting vectors
as a JSON fixture (mirroring this repo's existing fixture-based cross-language parity pattern,
e.g. `ts-parity-v2.json`). Add a **fixture-backed** retriever variant to the eval harness that reads
these frozen vectors and performs the same cosine-similarity ranking `VoyageRunbookRetriever`
does, but makes **zero** network calls — preserving the correctly-scoped case-execution
determinism invariant (§1) exactly, and respecting the existing "no live Voyage evaluation in the
harness" deferral (§1) rather than reversing it. **The fixture must fail closed if it goes stale**
(Codex-review MAJOR finding, verified: nothing in the first draft prevented a corpus or
query-set edit from silently invalidating already-committed vectors, which would let the
comparison score a retriever against text that no longer matches what it's claimed to represent).
The fixture therefore stores a content hash of every corpus chunk and every labeled query it
embeds, alongside the embedding model name/version; the fixture-backed retriever computes the same
hashes from the current corpus/query-set at comparison-run time and throws a clear
"fixture stale — regenerate via `<script>`" error on any mismatch, rather than silently ranking
against outdated vectors. Document the one-time fixture-generation script (`scripts/` or a worker
dev-script) so the fixture is regenerable if the corpus changes, but it is never regenerated
automatically or during CI.

**Comparison and decision (Issue C, same PR).** Run all three retrievers — keyword (shipped),
BM25 (new), frozen-embedding (new) — through the expanded eval dataset and report recall@k/MRR
(exact/paraphrase/near-miss) and `falsePositiveRate` (true-negative) per retriever.

**Selection policy, declared here rather than left to be improvised against the numbers**
(Codex-review MAJOR finding, verified: the plan's first draft required "letting data decide" with
no rule for resolving a conflicting-metrics matrix, e.g. keyword winning exact-query recall while
BM25 wins false-positive rate and embeddings win paraphrase MRR — an outcome entirely plausible
given each retriever's known design tradeoffs). Priority order, evaluated in sequence — the first
retriever satisfying a tier's minimum bar wins that tier, and **paraphrase recall@k is the primary
deciding metric**, because it is the one dimension the current keyword retriever is architecturally
weakest on (§1) and therefore the one this milestone exists to actually test:
1. **Primary: paraphrase-group recall@k.** The retriever with the highest paraphrase recall@k wins,
   *provided* it also clears two minimum bars: `falsePositiveRate` on the true-negative group must
   not exceed the shipped keyword retriever's own measured `falsePositiveRate` (never regress
   false-positive behavior to win on paraphrase recall), and exact-group recall@k must not fall
   more than 10 percentage points below the shipped keyword retriever's exact-group recall@k (never
   trade away the case the system is already good at for a paraphrase gain).
2. **Tie-break / no candidate clears both bars:** fall back to exact-group recall@k as the deciding
   metric under the same `falsePositiveRate` non-regression bar.
3. **No retriever beats the shipped keyword retriever on the primary metric while clearing both
   bars:** the shipped keyword retriever stays — "no change" is an explicit, legitimate outcome of
   this comparison, not a failure to reach a decision.

This policy is declared **before** Issue C's comparison is run (i.e. as part of this plan, not
authored after seeing the numbers), specifically to prevent post-hoc threshold or metric selection
from justifying whichever outcome looks best in hindsight.

**Deployment branching, separate from the selection policy above:** only two of the three possible
winners ship production code in this milestone (Codex-review MAJOR finding, verified: the frozen-embedding fixture
contains only the committed 30–40 evaluation query vectors — it cannot serve an arbitrary
production ticket summary, so it cannot be what `RUNBOOK_RETRIEVER` constructs in
`apps/api/src/execution/agent-runtime.module.ts` without a live Voyage call at request time, which
is explicitly out of scope per §5):

- **Keyword or BM25 wins:** ship it through the existing `RUNBOOK_RETRIEVER` provider-token seam in
  this milestone. Both are deterministic, in-process, and require no new runtime dependency —
  identical deployment shape to what's already there today.
- **Frozen-embedding wins:** this milestone does **not** wire a live embedding retriever into
  `apps/api`. It instead records the comparison result as the deliverable — "embeddings measurably
  outperform the deterministic alternatives on this corpus, by these numbers, on these query
  groups" — and opens a named follow-up issue (targeting Milestone 14 or later) to move
  `VoyageRunbookRetriever` into `packages/agent-runtime` and wire a live per-request call into
  `apps/api`, following the "move it, don't copy it" precedent from #72. The shipped retriever
  stays whichever of keyword/BM25 scored second-best, with that choice stated and justified in the
  same PR.

Acceptance criterion 6 (§7) is written to match this branching explicitly, rather than assuming
"ship the winner unconditionally" — which the frozen-fixture design (deliberately, per §5) cannot
satisfy for the embedding-wins case.

### 2.2 Adversarial/robustness eval suite (Issues D–E)

**A framing correction made after Codex review (BLOCKER, verified before accepting):** the first
draft of this section proposed 8–12 new `FakeAgentScenario`-based cases "proving the attack was
neutralized" across all six attack families below. That claim does not hold for every family.
`FakeAgentScenario` scripts a `FakeLlmProvider` that returns pre-authored turns regardless of what
retrieved content or tool output actually says — the same reason
`INJECTION_PROBE_STRUCTURAL_CASE` (the one existing case) documents its own scope narrowly: it
proves the **deterministic evidence-grounding validator** rejects a fabricated evidence ID, which
is a structural, code-level guarantee the harness genuinely can test. It does **not**, and cannot,
prove a real model resists following an injected instruction, because no real model is ever in the
loop. The six families split cleanly into two groups by whether the harness can actually test them:

**Structural families (deterministic, CI-gated, Issue D) — the harness's fixed validation code is
what's under test, and a `FakeAgentScenario` case genuinely proves it:**
- Instruction override embedded in a retrieved runbook chunk (already covered by
  `INJECTION_PROBE_STRUCTURAL_CASE` — keep, don't duplicate; proves evidence-grounding rejects a
  report citing a chunk-planted fabricated evidence ID).
- Fabricated evidence-ID smuggling via tool output (as opposed to the existing RAG-chunk-based
  fabrication cases 7/8 — proves the same evidence-grounding check catches both channels
  identically; still a structural, code-level assertion, not a model-behavior one).
- Tool-input-shaped smuggling attempted via a runbook chunk or tool response (proves the tool
  registry's schema/allowlist validation rejects an attacker-shaped tool call — again a structural
  guarantee already enforced in code, not a claim about what the model "chose" to do).

Each structural case reuses the existing `EvaluationCase`/`FakeAgentScenario` shape exactly — no
new harness machinery, only new cases and (if a genuinely new observable is needed) narrow
additions to `ObservedFacts`. These are the cases gated at 100% in CI (Issue E).

**Model-behavior families (NOT deterministically testable — explicitly out of scope for the CI
gate, Issue D documentation only):**
- Instruction override embedded in tool output (get_service_status response text) attempting to
  redirect the model's own next action.
- Exfiltration-style asks (content trying to get the model's report to include or repeat
  sensitive-looking strings verbatim).
- Role/authority confusion (content claiming to be a system message, an approval decision, or an
  escalated instruction) attempting to change the model's behavior mid-investigation.

These three require a real model actually reading and (not) acting on the injected content — no
deterministic scripted case can prove or disprove it, the same reason `docs/05-rag-design.md`'s
original live spike (§1, this plan) required a real Claude call rather than a fake one. Issue D
documents these three as **named, bounded manual live-spike scenarios** (mirroring
`docs/reviews/05-rag-design-spike-results.md`'s existing precedent exactly: a small number of
real, owner-run Claude calls against adversarial fixtures, results recorded as evidence, never
run automatically, never gated in CI, never treated as a recurring paid-test category). This is
the honest scope for "does the model resist these attacks" — this milestone does not invent a new
deterministic mechanism to answer a question only a live model call can actually answer.

**CI gate (Issue E, same PR).** Add an aggregate "adversarial pass rate" readout to the existing
report, covering only the structural families above (3 cases total post-expansion: the existing
`INJECTION_PROBE_STRUCTURAL_CASE` plus the 2 new structural cases); require 100% (every structural
case must pass, by design — this is a security suite, not a quality-tradeoff suite) in the same CI
job that already runs the eval harness. No new job needed. The model-behavior families' live-spike
results are recorded in `docs/07-evaluation-plan.md` as dated evidence (mirroring
`docs/05-rag-design-spike-results.md`), not as a CI gate — there is nothing deterministic to gate.

---

## 3. Compatibility

- The 20 existing behavioral eval cases are untouched. New retrieval-comparison logic and new
  adversarial cases are additive to `EVALUATION_CASES`/the corpus, not replacements.
- Corpus expansion changes `chunkId`s available for retrieval but does not remove or rename any
  existing chunk ID that current cases 1–6's `expectedTop1`/`expectedInTopK` assertions depend on —
  new runbooks/chunks are added alongside the existing five files, not merged into them.
- The `RunbookRetriever` interface (`packages/agent-runtime/src/rag/runbook-retriever.ts`) is
  unchanged. A new retriever implementation (BM25) satisfies the existing interface exactly, the
  same way `InMemoryKeywordRunbookRetriever` and `VoyageRunbookRetriever` already do — no interface
  change, no consumer change beyond which concrete retriever `apps/api`'s `RUNBOOK_RETRIEVER`
  provider token constructs (per #72's existing wiring).
- `EvaluationMetrics`'s new fields (`recallAtK`, `meanReciprocalRank`, `falsePositiveRate`,
  per-group breakdowns) are additive to both the TS type and the Python `EvaluationMetrics`/DB
  model — but **read compatibility for pre-existing persisted runs requires an explicit third
  metric-shape generation**, following the exact precedent `services/evaluation/src/opspilot_evaluation/api.py`
  already established at #59 (Codex-review MAJOR finding, verified against source before accepting:
  `_read_metrics` currently accepts exactly two valid persisted shapes — `ORIGINAL_METRIC_NAMES`
  alone (pre-Checkpoint-B) or `ORIGINAL_METRIC_NAMES + NEW_METRIC_NAMES` together (post-Checkpoint-B,
  today's 15 fields) — and fails closed on anything else, including a partial set). This milestone
  adds a third tuple, e.g. `MILESTONE_13_METRIC_NAMES`, and extends `_read_metrics` to accept three
  valid shapes (6-only, 6+9, or 6+9+new) with the same "synthesize the missing generation's ratios
  as 0/0, never invent PASS/FAIL/N/A rows" rule #59 already uses for the 6-only case — not two
  shapes as a naive additive read would silently assume. This is Issue B's responsibility (the same
  PR that adds the new metric fields), not deferred to a later cleanup.

---

## 4. Verification plan — and an explicit limit of what it can prove

| Case | Expected result |
| --- | --- |
| Existing 20 behavioral cases, keyword and BM25 retrievers substituted in turn | All 20 still pass with the shipped keyword retriever unchanged (regression check); explicitly documented whether they pass unchanged with BM25 substituted (some may not, if the substitute retriever ranks differently — this is a finding to report, not a bug to hide). **The frozen-embedding retriever is explicitly NOT substituted into the 20 existing cases** (Codex-review MAJOR finding, verified: the frozen fixture only contains vectors for the 30–40 labeled comparison queries authored in Issue A, not the 20 existing cases' own `retrievalQuery` strings — extending fixture coverage to all 20 cases' queries too is unnecessary scope; the frozen-embedding retriever is evaluated only against the query set it was built for) |
| New 30–40 retrieval-quality queries × 3 retrievers | recall@3 / MRR computed per exact/paraphrase/near-miss group per retriever; `falsePositiveRate` computed per retriever for the true-negative group (§2.1) — report is the deliverable, not a fixed pass/fail bar (this is a *comparison*, not a regression gate) |
| 3 structural adversarial cases (existing 1 + 2 new — §2.2) | 100% pass rate required in CI |
| 3 model-behavior adversarial scenarios (§2.2) | Not a pass/fail CI check — a manual, dated, owner-run live-spike record in `docs/07-evaluation-plan.md`, same evidentiary form as `docs/reviews/05-rag-design-spike-results.md` |
| `pnpm --filter @opspilot/worker run eval` (default service-scorer mode) | Exits 0 with the expanded case count and new metrics rendered; makes its normal bounded HTTP call to the local Python evaluation service and persists the run (§1 — this is expected, not a determinism violation) |
| `EVALUATION_SCORER=local pnpm --filter @opspilot/worker run eval` | Exits 0 with identical case-level results to the service-scorer run, zero network calls of any kind (the actual zero-network claim, correctly scoped per §1) |
| `pnpm --filter @opspilot/worker run test:eval:cross-service` | TS/Python parity holds for the new metric fields — cross-service-parity test asserts numerator/denominator equality the same way it does for the existing six/fifteen |
| A pre-Milestone-13 persisted 15-metric v2 evaluation run, read via `GET` after this milestone ships | Still reads successfully, with the three new Milestone-13 ratios synthesized as 0/0 — proves the third read-compatibility shape (§3) actually works, not just that it was described |
| A true-negative query that returns a chunk scoring above the retriever's real (not eval-only) threshold | The same chunk is absent from that retriever's actual `apps/api` response for the equivalent request — proves the threshold is one enforced code path, not two independently-tunable numbers |
| Fixture staleness check: edit one committed runbook chunk's text without regenerating the fixture, then run the frozen-embedding comparison | Comparison run fails closed with a "fixture stale — regenerate" error, not a silent stale-vector ranking |
| Frozen-embedding fixture generation script, run manually once | Produces a fixture file with the expanded corpus's vectors plus their content hashes; committed to the repo; never re-run automatically |
| Full existing test suite (`pnpm agent:verify --final`) | No regression outside the touched packages |

**What this verification cannot prove:** a deterministic offline eval — however well-designed the
query set — cannot prove real-world retrieval quality against a genuinely unseen ticket
distribution, because the query set is authored by the same person who authored the corpus (label
leakage is structurally possible even when unintended). It also cannot prove the frozen-embedding
comparison stays representative if Voyage's model is updated (`VoyageRunbookRetriever`'s API
contract, not this milestone's fixture, would need to be re-validated against a live call if the
project ever adopted it for real). Bounded, named recommendation for closing that gap: one
controlled, manual live-spike run (mirroring the existing `docs/05-rag-design-spike-results.md`
precedent) against 3–5 realistic held-out tickets not present in either the eval dataset or the
corpus-authoring process, recorded as evidence the same way the original RAG spike was — not a new
routine paid-test category, and not gated in CI.

---

## 5. Out of scope (explicit)

- Wiring `VoyageRunbookRetriever` (or any live-embedding retriever) into the deployed
  `apps/api` path with live network calls at request time. The frozen-fixture comparison in §2.1
  is entirely offline; if the data justifies adopting embeddings, that adoption (moving the
  Voyage retriever into `packages/agent-runtime` and wiring live calls into `apps/api`, following
  the "move it, don't copy it" precedent from #72) is a **follow-up decision**, not part of this
  milestone's deliverable.
- Persisting retrieval-quality eval results to the Python evaluation service's database tables.
  The existing `evaluation_metrics` table (six-then-fifteen fields) is extended additively; no new
  persistence surface, historical trend storage, or dashboard is built here.
- A metrics-baseline drift gate (failing CI when aggregate metrics regress without a baseline
  update). Flagged as a good half-day hygiene item in §6 but explicitly not bundled into this
  milestone's issues — it's orthogonal to retrieval/adversarial content and shouldn't block this
  PR's review.
- Any change to the deployed retriever's runtime behavior for LIVE runs beyond whichever retriever
  Issue C's comparison selects — this milestone does not change bounds, timeouts, or the
  `RUNBOOK_RETRIEVER` construction pattern itself.
- Deterministic CI coverage of model-behavior attack families (tool-output instruction override,
  exfiltration-style asks, role/authority confusion) — §2.2 establishes these are only testable via
  a real model call, not a scripted `FakeAgentScenario`; this milestone runs and records one manual
  live spike per family (Issue D) but does not attempt to gate them in CI.
- The real external integration / idempotent-action milestone (§0, item 3) — a separate, larger
  piece of future work, not started here.
- The historical-run-list UI (§0, item 1) — not started here.

---

## 6. Sequencing

Test-first per repo convention; each issue below ships as its own PR through the standard harness
cycle (`agent:verify` → `agent:review-bundle` → `agent:codex-review`).

1. **Issue A — Corpus expansion + retrieval query set.** Author ~15–20 runbook files (with
   deliberate near-miss overlap) and the 30–40 labeled query set (exact / paraphrase / near-miss /
   true-negative groups). Verify the existing 20 behavioral cases still pass unmodified against the
   expanded corpus with the shipped keyword retriever (their `expectedTop1`/`expectedInTopK` chunk
   IDs must remain unambiguous; the near-miss chunks must not accidentally out-score them under the
   `+2`/`+1` keyword scoring rule — check this explicitly before merging).
2. **Issue B — recall@k/MRR/falsePositiveRate metrics + BM25 retriever + metric read-compatibility.**
   Add the per-group metric fields (including `falsePositiveRate`) to both TS and Python scorers
   (parity-tested), and extend `_read_metrics` (and its TS equivalent) with the third
   `MILESTONE_13_METRIC_NAMES` read-compatibility shape (§3) — verified against a pre-existing
   persisted 15-metric run, not just implemented. Add the enforced minimum-score threshold to
   `InMemoryKeywordRunbookRetriever.retrieve()` (§2.1) as a real filtering behavior, frozen ahead of
   scoring the true-negative set. Implement the BM25-style retriever satisfying `RunbookRetriever`
   with its own threshold built in from the start. Run the comparison harness against keyword vs.
   BM25 only (embedding arm comes in Issue C) and report results, including `falsePositiveRate`.
3. **Issue C — Frozen-embedding fixture + three-way comparison + retriever decision.** Generate and
   commit the offline Voyage-embedding fixture, including corpus/query-set content hashes and
   embedding model metadata for staleness detection (§2.1). Add the fixture-backed retriever
   variant (with its own frozen threshold) to the comparison, and confirm the staleness check fails
   closed on an edited corpus chunk before merging. Produce the final three-way
   recall@k/MRR/falsePositiveRate report. Apply the selection policy declared in §2.1 (not a policy
   authored after seeing these numbers) and record the retriever decision per §2.1's deployment
   branching (ship the winner via `RUNBOOK_RETRIEVER` if keyword or BM25 wins; record the
   comparison plus a named follow-up issue if frozen-embedding wins, shipping the second-best
   deterministic retriever instead).
4. **Issue D — Adversarial case expansion.** Author the 2 new structural cases (§2.2: tool-output
   evidence-ID smuggling, tool-input-shaped smuggling), confirming each fails closed the same way
   the existing fabricated-evidence cases do (`REPORT_EVIDENCE_INVALID` or the appropriate existing
   failure code — no new error code invented unless a genuinely new failure shape is discovered).
   Separately, run and record the 3 model-behavior live-spike scenarios (§2.2: tool-output
   instruction override, exfiltration-style asks, role/authority confusion) as a one-time, owner-run
   manual exercise against a real Claude call — not a CI-gated deterministic case.
5. **Issue E — CI adversarial gate + small doc fixes.** Add the adversarial pass-rate readout and
   require 100% in the existing eval CI job. In the same PR (small, unrelated-but-cheap fixes found
   during this exploration): correct README's "15-case evaluation" → "20-case evaluation" (two
   occurrences), remove the empty unused `evals/cases/` directory, and rename the CI job step or
   add a comment so "eval harness ran" is visible from the Actions UI without reading the script.
6. `agent:verify --final`, `agent:review-bundle`, `agent:codex-review` per the standard harness
   cycle for each PR above (this milestone spans 5 PRs, each gets its own review cycle within this
   repo's stated one-initial-plus-one-final-rereview budget per PR, not per milestone).
7. Update `docs/07-evaluation-plan.md` (new metrics, new retriever, expanded corpus, adversarial
   suite) and `README.md` (case count, retrieval-quality claim, any resume-bullet-eligible measured
   result) to reflect the new state, following this repo's existing "correct stale docs against
   real source" discipline.

---

## 7. Acceptance criteria

1. `runbooks/` contains ~15–20 files with deliberate topical near-miss overlap; all pre-existing
   chunk IDs referenced by the 20 existing eval cases remain present and still resolve to the same
   `expectedTop1`/`expectedInTopK` results under the shipped keyword retriever.
2. A committed, labeled retrieval query set (30–40 queries across exact/paraphrase/near-miss/
   true-negative groups) exists and is used by the comparison in Issue C.
3. `EvaluationMetrics` (TS and Python) carries `recallAtK`/`meanReciprocalRank` (per exact/
   paraphrase/near-miss group) and `falsePositiveRate` (true-negative group), with cross-service
   parity tests passing for the new fields. A pre-existing persisted 15-metric v2 evaluation run
   remains readable after this milestone ships, via a third explicit read-compatibility metric
   shape (§3) — not merely additive types that happen to compile.
4. A deterministic BM25-style `RunbookRetriever` implementation exists, satisfies the existing
   interface, and adds no new runtime dependency to any deployed path. Both it and the shipped
   keyword retriever enforce a real, frozen-ahead-of-scoring minimum-score threshold as actual
   result-filtering behavior in `retrieve()` — not an evaluation-only cutoff applied only when
   computing `falsePositiveRate`.
5. A frozen-vector fixture for the expanded corpus + query set is committed, including content
   hashes and embedding-model metadata; `EVALUATION_SCORER=local` compares all three retrievers
   with **zero live network calls** during case execution (the correctly scoped offline/
   deterministic invariant per §1 — not "zero network calls in every scorer mode," which the
   harness never guaranteed). The comparison fails closed with a clear error, rather than silently
   ranking against stale vectors, if the corpus or query set has changed since the fixture was
   generated.
6. A retriever decision is made and recorded using the selection policy declared in §2.1 (paraphrase
   recall@k as the primary metric, subject to the `falsePositiveRate` non-regression and exact-recall
   floor bars) — not a policy improvised after seeing the comparison numbers — branching correctly on
   which retriever wins: if keyword or BM25 wins, it ships via `RUNBOOK_RETRIEVER` in this
   milestone; if frozen-embedding wins, the comparison result and a named Milestone-14-or-later
   follow-up issue are the deliverable instead, and the shipped retriever stays whichever of
   keyword/BM25 scored second-best. Either way, the decision — not just the numbers — is recorded.
7. 2 new structural adversarial cases exist (tool-output evidence-ID smuggling, tool-input-shaped
   smuggling) alongside the existing `INJECTION_PROBE_STRUCTURAL_CASE`; all 3 pass at 100% and
   this is enforced in the existing eval CI job. 3 model-behavior scenarios (tool-output
   instruction override, exfiltration-style asks, role/authority confusion) are run once as a
   manual live spike and recorded as dated evidence in `docs/07-evaluation-plan.md` — never
   claimed as CI-gated or as proof of production model behavior beyond that one dated observation.
8. All pre-existing 20 behavioral eval cases and the full `agent:verify --final` suite pass with no
   regressions.
9. `README.md` and `docs/07-evaluation-plan.md` reflect the new case count, new metrics, and
   whichever retriever the decision in #6 selected — no stale claim about case count, retriever
   behavior, or "not yet built" retrieval-quality measurement remains after this milestone merges.
