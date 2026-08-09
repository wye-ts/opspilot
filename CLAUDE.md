# CLAUDE.md

See [`AGENTS.md`](AGENTS.md) for repository navigation. This file adds only the operating
instructions that are specific to working as Claude Code in this repo — it duplicates no
project/architecture content already in `AGENTS.md`, `CONTEXT.md`, or `README.md`.

- Treat [`CONTEXT.md`](CONTEXT.md) as stable, frozen vocabulary — do not reopen the decisions it
  records.
- Follow approved plans rather than improvising scope. If a task requires an architecture change,
  scope expansion, or contradicts an approved plan, stop and surface the conflict rather than
  proceeding.
- Use the Harness Foundation workflow (`agent:preflight` / `agent:verify` / `agent:scope-check` /
  `agent:review-bundle`, see [`scripts/agent/README.md`](scripts/agent/README.md)) for
  verification and review evidence rather than hand-assembling it.
- Never commit, push, merge, deploy, or make a LIVE/paid-provider request, and never add AI
  attribution (commit trailers, PR bylines, etc.) without explicit owner approval.
