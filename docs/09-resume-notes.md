# OpsPilot — Resume Notes

| Field | Value |
| --- | --- |
| Document | Resume Notes |
| Status | Pointer document — resume material lives elsewhere and is deliberately not duplicated here |
| Project | OpsPilot — AI Support and Incident Resolution Agent |
| Last updated | September 2026 |

## Why this document is a pointer

This file was reserved early in the project for resume/portfolio notes and was never written.
The material ended up in two places that are already maintained, and a third copy here would
be the one most likely to go stale — which is exactly the failure mode that matters for career
claims.

## Where resume material actually lives

| Topic | Authoritative location |
| --- | --- |
| Draft resume description and bullets, each annotated with whether it is earned by shipped code | `docs/01-prd.md` §18 |
| Portfolio-ready deliverable checklist and the rule that claims use measured results only | `docs/03-technical-design.md` §31 |
| Engineering decisions worth discussing in an interview (including rejected alternatives) | `docs/10-engineering-challenges.md` |
| Recorded retriever comparison and the decision it bound | `docs/reviews/31-issue-76-comparison-decision.md` |
| Live real-model validation evidence | `docs/15-live-demo-evidence.md`, `README.md` → Live validation evidence |

## The one rule to carry out of this document

A claim's verb must match what shipped. `docs/01-prd.md` §18 annotates four of its five draft
bullets, with the specific gap named in each case: two are unearned as written (`pgvector` and a
deployed embedding store were never built — precomputed embeddings exist only as a committed
offline comparison fixture; and there is no action-execution path for an approval control to
gate), one is accurate only because its verb is `Designed` (the shipped catalog holds two tools,
but only one of them is from the five that bullet describes — a second tool shipping does not
make a `Designed`-verb bullet more earned), and one is partly earned (the evaluation harness
measures deterministic tool correctness but not classification accuracy, latency, cost, or
model tool-*selection* quality). `Designed` is not `Built`;
`Built` is not `Measured`; `records a decision` is not `gates execution`. Strengthen a bullet
only when the code and the measurement both exist, and prefer the narrower claim that cites a
real number (a 40-query labeled retrieval set, a recorded three-way comparison) over the
broader claim that cites none.
