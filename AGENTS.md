# AGENTS.md

Pointer/navigation doc for this repo's AI-assisted engineering workflow: plan → implementation
session → verification → review artifacts → independent review → adjudication → fix → final
verification → owner-controlled commit. The **Harness Foundation** mechanizes the deterministic,
repetitive parts of that workflow — it does not touch plan approval, independent-review findings
authorship, adjudication, or the commit/push/merge decision, which stay human/model judgment. See
`CONTEXT.md` (repo root) for the frozen vocabulary and constraints.

## The four commands

| Command | Purpose | Reference |
| --- | --- | --- |
| `pnpm agent:preflight` | Read-only git/environment diagnostic | [`scripts/agent/README.md`](scripts/agent/README.md), [`CONTEXT.md`](CONTEXT.md) |
| `pnpm agent:verify --focused\|--final` | Focused (touched-workspace) or final (CI-equivalent) verification | [`scripts/agent/README.md`](scripts/agent/README.md), [`CONTEXT.md`](CONTEXT.md) |
| `pnpm agent:scope-check` | Opt-in check that the complete change set matches a declared scope | [`scripts/agent/README.md`](scripts/agent/README.md), [`CONTEXT.md`](CONTEXT.md) |
| `pnpm agent:review-bundle` | Evidence collector: diff + machine-readable manifest, never a correctness gate | [`scripts/agent/README.md`](scripts/agent/README.md), [`CONTEXT.md`](CONTEXT.md) |

Full CLI flags, JSON shapes, and exit codes: [`scripts/agent/README.md`](scripts/agent/README.md).

**Safety guarantee**: a task declaration is only ever read via an explicit `--task <path>` on any
of the four commands above — never auto-discovered by well-known filename.

## Where to go next

- Local development commands (install, typecheck, test, build, run): [`README.md`](README.md#local-development).
- CI/CD and deployment: [`docs/08-cicd-deployment.md`](docs/08-cicd-deployment.md).
- Architecture: [`docs/03-technical-design.md`](docs/03-technical-design.md),
  [`docs/04-agent-design.md`](docs/04-agent-design.md).
- History and prior engineering decisions: [`docs/10-engineering-challenges.md`](docs/10-engineering-challenges.md).

Note: `runbooks/` at the repo root is product RAG fixture content (sample incident runbooks the
agent retrieves against), not engineering runbooks for this repository.
