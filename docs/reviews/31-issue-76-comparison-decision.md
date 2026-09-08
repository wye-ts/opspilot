# Issue #76 — three-way retriever comparison result and selection decision

Recorded per plan §2.6/§7 acceptance criterion 4: the milestone-declared selection
policy applied exactly as written to the real numbers below, decision recorded
either way (including losing candidates' numbers), not just a winner's name.

## Real numbers (runbooks-eval/query-set-scores.json, this run)

| metric | keyword | bm25 | frozen-embedding |
| --- | --- | --- | --- |
| recall@3 exact | 10/10 (1.000) | 10/10 (1.000) | 10/10 (1.000) |
| recall@3 paraphrase | 10/10 (1.000) | 10/10 (1.000) | 10/10 (1.000) |
| recall@3 near_miss | 11/12 (0.917) | 10/12 (0.833) | **12/12 (1.000)** |
| MRR exact (sixths) | 60/60 (1.000) | 60/60 (1.000) | 60/60 (1.000) |
| MRR paraphrase (sixths) | 60/60 (1.000) | 60/60 (1.000) | 57/60 (0.950) |
| MRR near_miss (sixths) | 53/72 (0.736) | 49/72 (0.681) | **69/72 (0.958)** |
| falsePositiveRate (true_negative) | 8/8 (1.000) | 4/8 (0.500) | **3/8 (0.375)** |

corpusContentHash: `0dc04b99dee99bd7a7f37fbc6e09c1eade6e85a051978b379df467299269d59d`
queryContentHash: `b6cfb2373108cc86d5f0544999a04bf4616dcdcb930e0f82c045ccb517f991fd`

## Policy application, computed by `runbooks-eval/apply-selection-policy.ts` (milestone plan §2.1, quoted verbatim in this issue's own
plan §2.6, tie-break added by this issue's plan §2.6 as the milestone policy's
own text leaves it undefined)

**Tier 1 (primary metric — paraphrase-group recall@k):** all three candidates
tie at the ceiling, 10/10 (1.000). No candidate beats another on this metric.

**Tie-break (this issue's plan §2.6):** among candidates tied on the tier's
deciding metric, the already-shipped keyword retriever wins the tie if it
participates in it. Keyword is one of the three tied candidates here, so
**keyword wins the tie.**

**Decision: "no change."** This is the exact real-world case the round-2
Codex-review MAJOR finding predicted was reachable (keyword's paraphrase
recall@k was already 10/10 before this comparison ran) — confirming the
tie-break rule was a necessary fix, not speculative hardening.

## What the comparison nonetheless shows, recorded as evidence (not as a basis
for overriding the policy's own decision)

Frozen-embedding meaningfully outperforms both deterministic retrievers on
two dimensions the primary/tie-break metrics don't directly measure:
- **near-miss recall@3: 12/12 vs. keyword's 11/12 and BM25's 10/12** — the
  one dimension #74's corpus was deliberately built to stress (topically
  confusable chunks).
- **falsePositiveRate: 37.5% vs. keyword's 100% and BM25's 50%** — a real
  embedding-quality advantage on distinguishing "no good answer" from "a
  plausible-but-wrong answer."

This is exactly the kind of finding a future milestone (frozen-embedding
comparison already ships zero production wiring under any outcome — see
plan §2.7) could revisit if the shipped keyword retriever's paraphrase
recall ever regresses below ceiling on an expanded corpus, at which point
frozen-embedding (or a live embedding retriever) would have real room to
win the primary tier outright rather than only tie it.

## Deployment branching (plan §2.7)

**Keyword wins ("no change")** → `apps/api/src/execution/agent-runtime.module.ts`
is **not** modified in this issue. This is stated explicitly here rather than
left as an unexplained empty diff on that file.

No new follow-up issue is opened (that branch only applies when
frozen-embedding wins outright).
