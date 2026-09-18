# OpsPilot — Tool Design

| Field | Value |
| --- | --- |
| Document | Tool Design |
| Status | Pointer document, plus two sections that are authoritative here: "Implementation state" and "What this milestone did not settle" |
| Project | OpsPilot — AI Support and Incident Resolution Agent |
| Last updated | September 2026 |

## Why this document is a pointer

`docs/03-technical-design.md` and `docs/04-agent-design.md` both list
`docs/06-tool-design.md` as a related/next document. A standalone tool design was planned
under this number and never written — the content landed inside the two parent documents
instead, and duplicating it here would create two sources of truth for the same contracts.

This file exists so those references resolve to something accurate rather than to a blank
page. For the *contracts* — type boundaries, registry, phase budgets — it adds nothing and
the table below names the authoritative location for each.

Two sections are exceptions and **are** authoritative here, because they have no home in the
parent documents: "Implementation state" records which designed tools actually exist, and
"What this milestone did not settle" records a decision about catalog growth. Both describe
the gap between design and implementation, which is precisely what a design document cannot
describe about itself. If either ever contradicts `docs/03-technical-design.md` or
`docs/04-agent-design.md` on a *contract*, those win.

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
  informative about model choice than it was with one.

Neither is an architectural limit — the registry and the per-turn budget accounting are already
tool-count-neutral, and the catalog is a plain array. They are unfilled capacity.

## What this milestone did not settle

Milestone 14 closed with the catalog at two tools. It did **not** establish how many tools the
catalog should hold, and the reason is worth recording: **no mechanism in this repository can
currently answer that question**, and the two candidates fail for structurally different reasons.

| Mechanism | Why it cannot answer it |
| --- | --- |
| Evaluation harness (CI) | `evaluation-runner.ts` constructs a `FakeLlmProvider` per case, so every tool request in all 26 cases is scripted by the case fixture. It measures correctness against a declared expectation. No model choice occurs, so no number of added cases makes it informative about selection. |
| LIVE spike (`two-tool-usage`) | A real model does choose, but the scenario is manual, single-*scenario*, non-deterministic, and not CI-gated. Its four recorded runs agree, but they vary nothing: one ticket, one prompt, one retrieval result. Agreement across repetitions of an identical input bounds the observable variation only very loosely, and says nothing about behavior on any other ticket. |

An earlier revision of `docs/reviews/47-issue-95-two-tool-usage-spike-results.md` did draw a
catalog-sizing conclusion from the spike — that a `get_recent_deployments` call on a
rate-limiting ticket was unmotivated budget waste, and therefore evidence against a third tool.
**That inference was withdrawn during review.** It rested on the ticket's "no release has been
announced", but an unannounced release is not an absent one: consulting the deployment record
rather than trusting an announcement is ordinary differential diagnosis. Top-ranked retrieval is
likewise not authoritative exclusion. The scenario was renamed from `tool-discipline` to
`two-tool-usage` for the same reason — it never measured discipline, and the name claimed more
than the mechanism proves.

Answering the question properly would need a context that *authoritatively rules a cause out*,
several distinct tickets, and enough runs per ticket to separate a tendency from sampling noise —
i.e. a real experiment, not a spike. Absent that, **a third diagnostic tool should not be added on
the grounds that it improves investigation quality**, because there is no mechanism that would
show whether it did. Adding one to satisfy a concrete product requirement remains fine; the
registry and budget accounting are tool-count-neutral.

The narrower lesson generalizes past the catalog: when a capability's quality is unmeasurable,
expanding the capability does not make it measurable. It only widens the surface no one can
assess.
