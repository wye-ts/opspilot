# OpsPilot — Tool Design

| Field | Value |
| --- | --- |
| Document | Tool Design |
| Status | Pointer document — no separate tool design was ever authored under this number |
| Project | OpsPilot — AI Support and Incident Resolution Agent |
| Last updated | September 2026 |

## Why this document is a pointer

`docs/03-technical-design.md` and `docs/04-agent-design.md` both list
`docs/06-tool-design.md` as a related/next document. A standalone tool design was planned
under this number and never written — the content landed inside the two parent documents
instead, and duplicating it here would create two sources of truth for the same contracts.

This file exists so those references resolve to something accurate rather than to a blank
page. It adds no new design decisions.

## Where the tool design actually lives

| Topic | Authoritative location |
| --- | --- |
| `DiagnosticTool` vs `ActionDefinition` type boundary | `docs/03-technical-design.md` §14.1 |
| Tool registry and permission classification | `docs/03-technical-design.md` §14.2 |
| The five designed MVP read-only diagnostic tools | `docs/03-technical-design.md` §14.3 |
| Approval-required actions (never agent-executable) | `docs/03-technical-design.md` §14.4 |
| The agent loop, tool offering, and phase budgets | `docs/04-agent-design.md` §11, §12, §13 |
| One diagnostic tool request per provider turn | `docs/04-agent-design.md` §10 |
| Tool-output validation and evidence grounding | `docs/04-agent-design.md` §11 steps 4/8, §12 |
| `search_runbooks` as retrieval rather than a tool call | `docs/05-rag-design.md` |

## Implementation state (September 2026)

The designed MVP set in §14.3 names five read-only diagnostic tools. **One is implemented from
that list**, and one shipped tool has no §14.3 counterpart at all — the catalog and the design
list have diverged, which is recorded here rather than quietly reconciled.

| Designed tool (§14.3) | Implemented |
| --- | --- |
| `check_service_status` | Yes — shipped as `get_service_status` (`packages/agent-runtime/src/tools/get-service-status.ts`), a seeded three-service lookup returning `OPERATIONAL`/`DEGRADED`/`OUTAGE`/`UNKNOWN` |
| `search_runbooks` | Not as a model-callable tool. Runbook retrieval is performed by the application before the agent loop and supplied as context, not requested by the model (`docs/05-rag-design.md`) |
| `search_logs` | No |
| `find_similar_incidents` | No |
| `lookup_customer_account` | No |

| Shipped tool with no §14.3 entry | Origin |
| --- | --- |
| `get_recent_deployments` | Issue #93 (Milestone 14). A seeded most-recent-first deployment lookup over the same three service slugs, returning `knownService` plus `SUCCEEDED`/`FAILED`/`ROLLED_BACK` outcomes (`packages/agent-runtime/src/tools/get-recent-deployments.ts`). It was never part of the §14.3 draft — that list is a pre-implementation design artifact, not a queue being worked through in order |

`DIAGNOSTIC_TOOL_CATALOG` (`packages/agent-runtime/src/tools/diagnostic-tool-catalog.ts`) is
therefore a two-entry array. The surrounding machinery is not specific to either tool, but the
ownership split matters if you extend the catalog:

- **`InMemoryToolRegistry`** accepts any `readonly DiagnosticToolDefinition[]` and resolves a
  requested tool by name.
- **`AgentOrchestrator`** owns the *budget*: it counts accepted diagnostic calls, passes
  `diagnosticCallsRemaining` into each turn, and refuses a request once
  `MAX_DIAGNOSTIC_TOOL_CALLS = 3` of `MAX_PROVIDER_TURNS = 5` is reached. It never receives or
  filters tool definitions.
- **`ClaudeLlmProvider`** owns the *offered list*: it offers its full configured
  `diagnosticTools` array plus the finalizer on an `INVESTIGATION` turn **that still has
  diagnostic budget**, and the finalizer alone — with `tool_choice` forcing it — on a
  `FINALIZATION` turn **or any turn whose `diagnosticCallsRemaining` is `0`**
  (`claude-llm-provider.ts` `buildRequestParams`).

  The offered list does **not** shrink gradually as the budget shrinks: it is the full catalog at
  `diagnosticCallsRemaining >= 1` and the finalizer alone at `0`. In between, the remaining budget
  reaches the model only as prompt text (`investigationGuidance`), so do not rely on the offered
  list to signal how much budget is left — only that some remains.

  The zero-budget case became reachable with issue #107's slack (a turn can now be `INVESTIGATION`
  by position with no budget left) and is handled deliberately: leaving such a turn on
  `tool_choice: auto` would let the model return a text-only response, which normalizes to
  `PROVIDER_PROTOCOL_INVALID` and ends the run with no report at all.

Two consequences worth stating plainly rather than leaving for a reader to infer:

- **Multi-step investigation is bounded by turns, not by tool variety.** Issues #57/#58 allow
  up to three diagnostic calls with evidence-sufficiency-driven continuation. With a two-entry
  catalog a run can now vary both *which* tool it calls and its `serviceSlug` argument, but the
  binding constraint is still `MAX_DIAGNOSTIC_TOOL_CALLS = 3`, not the catalog's size.
- **Tool-*selection* quality is not a measurable property today.** `docs/01-prd.md` §11 lists
  "tool selection accuracy" as an AI quality metric. The evaluation harness does ship a real
  `toolCorrectness` metric (five checks: `tool-requested`, `tool-executed`, `tool-completed`,
  and two forbidden-tool checks — `apps/worker/src/evaluation/evaluation-metrics.ts`), which
  catches a missing, misnamed, or forbidden call. But it measures *correctness against a
  case-declared expectation* under a fixture-driven provider, not *selection*. **Catalog size
  does not change this.** `apps/worker/src/evaluation/evaluation-runner.ts` constructs a
  `FakeLlmProvider` per case, so every provider turn — including which tool is requested — is
  scripted by the case fixture. A second tool shipped in #93/#94 and the metric is no more
  informative about model choice than it was with one. Whether a real model *chooses* well is
  answerable only by a live run, recorded as a bounded observation, never as a CI-gated property.

Neither is an architectural limit — the registry and the per-turn budget accounting are already
tool-count-neutral, and the catalog is a plain array. They are unfilled capacity.
