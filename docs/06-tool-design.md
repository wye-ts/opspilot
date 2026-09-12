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

The designed MVP set in §14.3 names five read-only diagnostic tools. **One is implemented.**

| Designed tool (§14.3) | Implemented |
| --- | --- |
| `check_service_status` | Yes — shipped as `get_service_status` (`packages/agent-runtime/src/tools/get-service-status.ts`), a seeded three-service lookup returning `OPERATIONAL`/`DEGRADED`/`OUTAGE`/`UNKNOWN` |
| `search_runbooks` | Not as a model-callable tool. Runbook retrieval is performed by the application before the agent loop and supplied as context, not requested by the model (`docs/05-rag-design.md`) |
| `search_logs` | No |
| `find_similar_incidents` | No |
| `lookup_customer_account` | No |

`DIAGNOSTIC_TOOL_CATALOG` (`packages/agent-runtime/src/tools/diagnostic-tool-catalog.ts`) is
therefore a one-entry array. The surrounding machinery is not specific to that one tool, but the
ownership split matters if you extend the catalog:

- **`InMemoryToolRegistry`** accepts any `readonly DiagnosticToolDefinition[]` and resolves a
  requested tool by name.
- **`AgentOrchestrator`** owns the *budget*: it counts accepted diagnostic calls, passes
  `diagnosticCallsRemaining` into each turn, and refuses a request once
  `MAX_DIAGNOSTIC_TOOL_CALLS = 3` of `MAX_PROVIDER_TURNS = 4` is reached. It never receives or
  filters tool definitions.
- **`ClaudeLlmProvider`** owns the *offered list*: it offers its full configured
  `diagnosticTools` array plus the finalizer on every `INVESTIGATION` turn, and the finalizer
  alone on `FINALIZATION` (`claude-llm-provider.ts` `buildRequestParams`). The offered list does
  **not** shrink as the remaining budget shrinks — `diagnosticCallsRemaining` reaches the model
  only as prompt text (`investigationGuidance`), so do not rely on the orchestrator to withhold
  a tool the budget can no longer afford.

Two consequences worth stating plainly rather than leaving for a reader to infer:

- **Multi-step investigation is bounded by turns, not by tool variety.** Issues #57/#58 allow
  up to three diagnostic calls with evidence-sufficiency-driven continuation, but with a
  one-entry catalog the only available variation between calls is the `serviceSlug` argument.
- **Tool-*selection* quality is not a measurable property today.** `docs/01-prd.md` §11 lists
  "tool selection accuracy" as an AI quality metric. The evaluation harness does ship a real
  `toolCorrectness` metric (five checks: `tool-requested`, `tool-executed`, `tool-completed`,
  and two forbidden-tool checks — `apps/worker/src/evaluation/evaluation-metrics.ts`), which
  catches a missing, misnamed, or forbidden call. But it measures *correctness against a
  case-declared expectation* under a fixture-driven provider, not *selection* — and with one
  tool in the catalog there is no alternative to choose wrongly. Adding tools is what would
  make a selection metric informative.

Neither is an architectural limit — the registry and the per-turn budget accounting are already
tool-count-neutral, and the catalog is a plain array. They are unfilled capacity.
