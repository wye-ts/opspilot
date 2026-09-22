# FREEZE — paid LIVE measurement is on hold (owner, 2026-09-21)

**Do not run any paid provider script, and do not propose funding a measurement round,
until the owner explicitly lifts this.**

Frozen commands:
- `pnpm --filter @opspilot/worker run measure:completion-rate`
- `pnpm --filter @opspilot/worker run spike:rag` / `spike:claude`
- `pnpm --filter @opspilot/worker run test:claude:live`
- `generate:embedding-fixture` (billed Voyage calls)

## Why the queue looks ready but is NOT

#125/#128 (runtime guard) and #126/#129 (in-flight ledger) have both merged, so every
engineering prerequisite for a funded completion-rate round is now cleared. **The block is a
product decision, not an engineering gap.** The owner intends to switch models first.

A model switch changes `SUPPORTED_CLAUDE_MODEL` and the pricing table, so any sample taken now
is spent on a model being replaced. The completion-rate question and the public-trial gate stay
blocked on the model choice.

## Related item — RESOLVED

#133 (sonnet-5 pricing $3/$15 → $2/$10) was merged during the freeze on explicit owner
go-ahead. It spends nothing and corrects a 1.5x accounting error that was distorting every
cost judgement, including the model comparison the freeze exists to inform.

**Merging it does NOT lift the freeze.** The model decision is still open.

The freeze's own rationale was examined while comparing candidates, and one framing correction
belongs here: the daily spend is bounded by `LIVE_RUN_DAILY_COST_CEILING_USD` (1.00), a config
constant — NOT by the model's unit price. A cheaper model does not reduce spending under that
ceiling; it buys more runs per day. "I want to spend less" and "I want more trial throughput"
are different questions with different answers.

## What IS fine during the freeze

Free work on the open issues: docs, constant edits, UI fixes (#130/#131/#132), the harness
timeout (#127). Anything that spends nothing.

## To lift

Explicit owner go-ahead, naming the model. Delete this file in the same change that resumes
measurement.
