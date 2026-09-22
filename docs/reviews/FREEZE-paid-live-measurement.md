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

## Related open item

`fix/133-sonnet-5-standard-pricing` (local branch, unmerged, commit `b0f6bfa`) corrects
claude-sonnet-5 pricing $3/$15 → $2/$10 (#133). Whether it should merge or be discarded depends
on whether sonnet-5 remains the model — do not merge it as a matter of course during the freeze.

## What IS fine during the freeze

Free work on the open issues: docs, constant edits, UI fixes (#130/#131/#132), the harness
timeout (#127). Anything that spends nothing.

## To lift

Explicit owner go-ahead, naming the model. Delete this file in the same change that resumes
measurement.
