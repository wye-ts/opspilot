# Milestone 14 — A Second Diagnostic Tool (`get_recent_deployments`)

| | |
| --- | --- |
| Scope | Add exactly one read-only diagnostic tool to `DIAGNOSTIC_TOOL_CATALOG`, closing the gap between the "bounded multi-step diagnostic investigation" capability name and a one-entry catalog. No GitHub issue filed yet — this plan proposes the milestone. |
| Basis | `main` @ `b854cba` (PR #92, "docs: correct unearned resume claims + fill two empty referenced docs"), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit of code, no PR, merge, or deploy. No provider/LIVE request. |
| Branch | `docs/milestone-14-second-diagnostic-tool` (created, holds this document only) |
| Committed location | `docs/reviews/37-milestone-14-second-diagnostic-tool-plan.md` |

---

> **Status: historical plan, archived after the fact. Not current state.**
>
> Written on `main` @ `b854cba`, *before* any Milestone 14 work landed, and
> committed here only after the milestone closed — it sat on an unmerged branch
> throughout, which is why `docs/reviews/46-...` and `47-...` referenced a path
> that did not resolve. Archived unmodified (apart from this banner) so the
> plan-then-execute record is complete.
>
> It has since diverged from the implementation. Known drift, verified against
> source at archive time:
>
> | Plan says | Actual |
> | --- | --- |
> | `MAX_PROVIDER_TURNS = 4` | **5** (`packages/contracts/src/agent-run-bounds.ts`), changed by #107 |
> | Proposes the milestone, "no GitHub issue filed yet" | Shipped as #93/#94/#95; milestone closed |
> | Plans the LIVE spike as support for a catalog-sizing decision | That framing did not survive — see §"What this milestone did not settle" in `docs/06-tool-design.md` |
>
> For current state read `docs/06-tool-design.md` and
> `docs/03-technical-design.md`; for what the LIVE spike actually produced read
> `docs/reviews/47-issue-95-two-tool-usage-spike-results.md`.

## 0. Why this milestone, and the value claim it must NOT make

### The real defect

Issues #57/#58 shipped **bounded multi-step diagnostic investigation**: up to
`MAX_DIAGNOSTIC_TOOL_CALLS = 3` diagnostic calls across `MAX_PROVIDER_TURNS = 4`, with
continuation gated on evidence sufficiency. The mechanism is real and reviewed.

The catalog it operates over has **one entry**. With one tool, the only variation available
across three "multi-step" calls is the `serviceSlug` argument, resolved against a seeded
three-service lookup table (`get-service-status.ts`). The capability's *name* promises chained
corroboration across distinct signals; the mechanism delivers repeated queries against one table.

That is the gap this milestone closes, and it is a semantic-honesty gap — the exact class of
defect PR #92 just spent six review rounds removing from this repo's documentation. It is now
visible in a reader-facing doc: `docs/06-tool-design.md`'s "Implementation state" section
(authored in PR #92) states plainly that the catalog is a one-entry array and that multi-step
investigation is "bounded by turns, not by tool variety."

### The claim this milestone must NOT make — and a correction to `docs/06-tool-design.md`

`docs/06-tool-design.md` currently ends with:

> **Adding tools is what would make a selection metric informative.**

**That sentence is wrong and this milestone must correct it rather than build on it.** Verified
against source:

- `evaluation-runner.ts:60` constructs `new FakeLlmProvider(evaluationCase.scenario)` per case.
  Every provider turn — including which tool is requested — is scripted by the case fixture.
- `toolCorrectnessRatio` (`evaluation-metrics.ts:82-94`) counts cases whose declared tool checks
  all PASS. It scores whether the orchestrator honored a **case-declared** call.

No number of catalog entries makes a fixture-scripted provider's choice informative about a real
model's choice. Tool-*selection* quality remains a single paid live-spike observation, never a
CI-gated property. Correcting this sentence is in scope (§2.6); it is a claim introduced by the
most recent merged PR, and leaving it standing would let a future reader treat it as the
justification for this very milestone.

### The two claims this milestone MAY make

1. **Semantic honesty.** "Multi-step diagnostic investigation" becomes a name whose mechanism can
   chain genuinely distinct signals, instead of one whose only variation is an argument value.
   **Narrowed after round-2 review (§1):** the second signal supports ruling a hypothesis OUT and
   naming an unresolved lead. It does not support a new causal conclusion, and this milestone
   claims no new root-cause capability.
2. **A new deterministic, CI-gated structural property.** Heterogeneous tool schemas have never
   traversed the `registry.find → inputSchema.safeParse → execute → outputSchema →
   TOOL_EXECUTION evidence` path. At N=1 that path has only ever been exercised by one
   input/output shape. At N=2 with a genuinely different shape (scalar enum vs. bounded list),
   shape-correctness along that path becomes a real offline-testable property.

Claim 2 is about the *orchestrator/registry* handling shapes correctly. It is not, and must not
be written as, a claim about model behavior.

---

## 1. Scope decision — which tool, and the candidates refuted

### Candidate generation basis

The five-tool list in `docs/03-technical-design.md` §14.3 was **not** used as the candidate pool.
That list was authored before any implementation existed — the same batch and the same unverified
standing as the draft resume bullets PR #92 had to correct. A future-tense promise in a
pre-implementation design doc is a claim to audit, not scope to fulfil. Candidates were instead
generated from entities that verifiably exist in the running system:

- `TicketContext` = `{ ticketId, summary }` only (`packages/contracts/src/ticket-context.ts`) —
  no priority, no customer, no history.
- `IncidentCategorySchema` = `SERVICE_DEGRADATION | RATE_LIMITING | AUTHENTICATION |
  CONFIGURATION | DATA_QUALITY | UNKNOWN`.
- `EvidenceSourceTypeSchema` = `RAG_CHUNK | TOOL_EXECUTION` only.
- 16-file runbook corpus, including `deployment-rollback.md`.

### Decision: `get_recent_deployments`. Exactly one tool. N=2.

**Rationale.** It is the only candidate that produces a genuine reasoning branch *without*
introducing free-text evidence. Its output is structured enums, version strings, and fixture-fixed
timestamps — a model cannot narrate a root cause out of it the way it can out of log lines, but it
is still a bounded **list**, which is precisely the output-shape difference Claim 2 needs. The
existing `deployment-rollback.md` runbook lets RAG evidence and tool evidence corroborate each
other, which is what a multi-signal investigation should look like.

### Correction to the reasoning branch — TWICE corrected, and the second correction is load-bearing

**First framing (HQ, verbal, withdrawn):** *"service is DEGRADED and was deployed 20 minutes ago →
root cause is CONFIGURATION."* Withdrawn because "20 minutes ago" requires a wall-clock read, and
every existing diagnostic tool is a seeded lookup with no clock and no network.

**Second framing (this plan, round-1 draft, ALSO withdrawn):** *"most recent deployment is
`ROLLED_BACK`/`FAILED` alongside `DEGRADED` → points at `CONFIGURATION`."* Round-2 independent
review raised this as a BLOCKER. **Accepted after verifying `runbooks/deployment-rollback.md`
directly.** The runbook's chunk `runbook-deployment-rollback-001` states the actual criteria:

> Roll back a release when the error budget burn rate **triples within ten minutes** of a rollout
> and the regression is **reproducible on the new revision but not the previous one**.

The proposed tool reports *neither* — no burn rate, no revision-level regression comparison, and
(by design) no incident timing. Worse, both outcome values are ambiguous in the wrong direction: a
`FAILED` deployment may never have reached production at all, and a `ROLLED_BACK` one may describe
an *already-remediated* incident. A fixture-scripted eval case asserting that chain would have
CI-blessed an unsupported causal conclusion — the exact "the mechanism does not prove what the
name claims" defect this milestone exists to fix, reintroduced inside the fix.

I also mis-cited `docs/04-agent-design.md` §21 as forbidding clock reads in production tools. §21
is **Fake Provider Design**; it constrains the fake provider's determinism, not every diagnostic
tool. The determinism argument for a seeded fixture still stands on the `get_service_status`
precedent and on eval reproducibility — but §21 is not its authority, and the plan should not have
claimed it was.

**Third and current framing — the tool supports NEGATIVE and CORROBORATIVE reasoning, not a causal
conclusion.** This is a narrowing of the milestone's claim, made deliberately:

- A `knownService: true` service with **no** recent deployments **rules deployment out** as a
  contributing factor. A negative is exactly what this data can support.
- A recent deployment alongside `DEGRADED` is a **lead requiring evidence the system does not
  have** — the correct report is `INSUFFICIENT` with `rootCause: null`, naming the specific
  missing facts (burn-rate change, revision-level reproducibility) per the runbook's own criteria.
- `knownService: false` supports **nothing** in either direction.

This is still a genuine second signal and still a real reasoning branch — it just yields
"deployment ruled out" / "deployment is an unresolved lead" rather than a root-cause assignment.
**No eval case in this milestone may assert `CONFIGURATION` as a root cause grounded on deployment
outcome.** §3.3 and §7 are written to enforce that.

### Rejected candidates

| Candidate | Verdict |
| --- | --- |
| `get_error_rate_metrics` | **Deferred, not rejected** — see §5 for the explicit decision trigger. Concept overlaps `get_service_status` (both answer "how is this service right now"), so it adds less heterogeneity than deployments. It would also introduce *numeric* evidence, and how a number qualifies as grounding a `ROOT_CAUSE` claim is an unanswered contract question that does not belong inside a milestone whose purpose is closing a semantic-honesty gap. |
| `search_logs` (§14.3) | **Rejected for this milestone.** Free-text log lines become quotable evidence a model will narrate a root cause from. Under this repo's grounding rules that is the highest-cost fixture-design risk available, and `get_recent_deployments` delivers the same list-shape coverage without it. |
| `search_runbooks` / `find_similar_incidents` | **Rejected.** Retrieval runs before the agent loop and is supplied as context, not requested by the model — a boundary `docs/05-rag-design.md` already decided. A model-callable retrieval tool reopens that decision as a side effect of an unrelated milestone. |
| `lookup_customer_account` (§14.3) | **Rejected.** `TicketContext` carries no customer field. The capability would require inventing the entity it acts on. |
| Any state-changing tool | **Rejected.** `DiagnosticTool` and `ActionDefinition` are a deliberate type split (`docs/03-technical-design.md` §14.1) so approval-required actions cannot be modeled as executable tools. |

### Prior-scope check

`grep -ril` across `docs/reviews/*.md` found **no prior owner-directed exclusion** of adding a
second diagnostic tool. The opposite: `docs/reviews/25-issue-56-richer-agent-activity-plan.md`
§5 defers tool input/output enrichment and states it is *"worth a future issue once/if a second
diagnostic tool or a concrete product need makes the generic phrasing feel insufficient."* This
milestone **triggers that condition**. Whether to act on it is decided in §5, not assumed.

---

## 2. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Catalog | `packages/agent-runtime/src/tools/diagnostic-tool-catalog.ts` | One entry: `GET_SERVICE_STATUS_CATALOG_ENTRY`. Carries the tool plus its model-facing `description`. |
| Tool contract | `packages/agent-runtime/src/tools/diagnostic-tool.ts` | `DiagnosticToolDefinition` is deliberately non-generic — `execute(input: unknown)`. Registry and orchestrator only ever see `unknown`; `inputSchema`/`outputSchema` are the whole validation boundary. **No change needed to add a tool.** |
| Registry | same file, `InMemoryToolRegistry` | Plain name→tool map over `readonly DiagnosticToolDefinition[]`. Tool-count-neutral. |
| Budget | `packages/contracts/src/agent-run-bounds.ts` | `MAX_PROVIDER_TURNS = 4`, `MAX_DIAGNOSTIC_TOOL_CALLS = 3`. **A "same diagnostic tool calls: 2" limit exists ONLY in `docs/04-agent-design.md`'s explicitly aspirational, unwired `AGENT_MAX_*` table. No such limit is implemented** — grep for `MAX_SAME_TOOL`/`perToolCount` returns nothing. |
| Offered list | `packages/provider-claude/src/create-llm-provider.ts:100` | `options.diagnosticTools ?? DIAGNOSTIC_TOOL_CATALOG`. `apps/api` never passes `diagnosticTools` — it inherits the catalog. |
| **Executable registry (production)** | `apps/api/src/execution/agent-runtime.module.ts:49` | `new InMemoryToolRegistry([getServiceStatusTool])` — **a hardcoded array literal, NOT derived from the catalog.** |
| Registry miss | `packages/agent-runtime/src/agent/agent-orchestrator.ts:615-624` | `toolRegistry.find(toolName)` returning undefined emits `TOOL_FAILED`/`TOOL_NOT_FOUND` and **fails the entire run**. |
| Eval tool wiring | `apps/worker/src/evaluation/evaluation-runner.ts:17-26` | `resolveTools(profile)`: `"default"` → `[getServiceStatusTool]`, also hardcoded. `toolProfile` is a closed 3-literal union validated in `dataset-validation.ts:70-75`. |
| Other registry sites | 9 further non-test `new InMemoryToolRegistry([...])` call sites across `apps/worker/src/demo/*` and `apps/worker/src/smoke/*` | Each independently hardcodes its tool list. |
| Web UI labels | `apps/web/src/trace/trace-product-labels.ts:25`, `investigation-progress/investigation-event-labels.ts` | Keyed by tool name, with a safe generic fallback (`"Running a diagnostic tool"`). An unknown tool degrades, it does not break. |
| Prompt worked examples | `packages/provider-claude/src/claude-message-mapping.ts:242,258,266,283` | `BASE_SYSTEM_PROMPT`'s evidence examples name `get_service_status` in `finding` prose. Current prompt version: `opspilot-agent-v5`. |
| Deterministic API scenario | `apps/api/src/execution/deterministic-scenario.ts` | Scripts exactly one `get_service_status` call per FAKE run, keyed on a bounded summary→slug keyword map. |

### 2.1 The finding that changes this milestone's shape

**The offered-tool list and the executable registry are wired from two different sources.**

Adding an entry to `DIAGNOSTIC_TOOL_CATALOG` immediately causes `ClaudeLlmProvider` to **offer**
the new tool on every LIVE `INVESTIGATION` turn (it inherits the catalog by default). The
production registry at `agent-runtime.module.ts:49` would **not** contain it. The model would
request a tool the registry cannot resolve, and `agent-orchestrator.ts:617` would fail the run
with `TOOL_NOT_FOUND`.

This is not a latent risk — it is a **guaranteed LIVE-path failure introduced by a one-line
catalog edit**, and it would not be caught by any FAKE-mode test, because `FakeLlmProvider`
scripts which tool is requested and the eval harness builds its own registry via `resolveTools`.

Consequences for this plan:

- Issue A is **not** "add a file and append to an array." Its load-bearing work is reconciling
  the two wiring sources.
- The fix must make the divergence structurally impossible to reintroduce, not merely patch the
  one site. Recommended: production wiring derives its registry from
  `DIAGNOSTIC_TOOL_CATALOG.map(entry => entry.tool)` rather than a hand-listed array, so "offered"
  and "executable" have exactly one source. The `references/…-threshold` precedent in this repo is
  the same discipline: one named export, grepped to every construction site.
- Worker demo/smoke sites that deliberately pin a narrow registry (e.g. the adversarial spike's
  `recordingTool`) must stay pinned and be individually confirmed, not blanket-rewritten.

---

## 3. Design

### 3.1 The tool

`packages/agent-runtime/src/tools/get-recent-deployments.ts`, modeled directly on
`get-service-status.ts`.

**Input** — `.strict()`:

```
{ serviceSlug: string (min 1, max 100) }
```

No time-range parameter. A time window implies a clock the tool does not have; accepting one and
ignoring it would be a schema that over-promises. The fixture defines what "recent" means.

**Output** — `.strict()`:

```
{
  serviceSlug: string,
  deployments: Array<{
    deploymentId: string,
    version: string,
    outcome: "SUCCEEDED" | "FAILED" | "ROLLED_BACK",
    deployedAt: string   // canonical ISO-8601/RFC3339 UTC datetime, fixture-fixed, never clock-derived
  }>   // max length bounded (proposed: 5), ordered most-recent-first
}
```

`deployedAt` is validated as a **canonical ISO-8601/RFC3339 datetime**, not a bare string
(round-2 independent review, MINOR — accepted). An unrestricted `z.string()` would accept
`"yesterday"` or `"2026-13-99"` from a hand-edited fixture, and both would pass the output-schema
boundary while breaking chronological ordering or feeding the model an invalid date.

**Fixture:** a seeded `Readonly<Record<string, readonly DeploymentRecord[]>>` over the same three
service slugs `get_service_status` already knows (`notification-service`, `billing-service`,
`auth-service`), so the two tools corroborate rather than describe disjoint worlds.

**Unknown-slug behavior — the load-bearing decision.** An unknown slug returns
`deployments: []`. It must NOT be conflated with "no recent deployments," and the empty array must
not be readable as evidence of a clean deployment history. This is the exact distinction
`get_service_status` already draws by returning `UNKNOWN` rather than defaulting to
`OPERATIONAL`. Because an empty array is structurally ambiguous in a way an enum is not, the
output schema carries an explicit third state:

```
{ serviceSlug, knownService: boolean, deployments: [...] }
```

`knownService: false` with `deployments: []` means *the tool has no record of this service*.
`knownService: true` with `deployments: []` means *this service is known and has no recent
deployments*. Collapsing these two into a bare empty array would let a model ground "no recent
deploys, so deployment is ruled out" on the absence of a fixture entry — an unearned negative
claim, and precisely the failure mode `get_service_status`'s `UNKNOWN` was designed to prevent.

**No `reasoningHint`, no `likelyCause`, no derived boolean.** The tool reports facts; the branch
is the model's to make.

### 3.2 Production wiring (the §2.1 fix)

- `apps/api/src/execution/agent-runtime.module.ts` derives `TOOL_REGISTRY` from
  `DIAGNOSTIC_TOOL_CATALOG`, not a hand-listed array.
- Every other non-test `new InMemoryToolRegistry([...])` site is enumerated and individually
  classified as *should follow the catalog* or *deliberately pinned*, with the reason recorded.
- A test asserts that the production registry resolves **every** catalog entry by name — the
  regression guard for the divergence itself, not for this one tool.

### 3.3 Evaluation

- `resolveTools("default")` returns both catalog tools.
- New eval cases exercising a genuine two-tool chain. **Per §1's third framing, no case may assert
  a root cause grounded on deployment outcome.** The two-tool chain proves the orchestrator
  executes, validates, and grounds across heterogeneous tools — it does not bless a causal claim:
  - **Deployment ruled out (positive negative-reasoning case):** `get_service_status` returns
    `DEGRADED`; `get_recent_deployments` returns `knownService: true, deployments: []`. The report
    grounds on two distinct `TOOL_EXECUTION` locators plus a `RAG_CHUNK`, and states deployment is
    excluded as a contributing factor. This is the case that demonstrates real multi-signal
    reasoning.
  - **Unresolved lead:** `DEGRADED` plus a recent `ROLLED_BACK` deployment must produce
    `evidenceState: INSUFFICIENT`, `rootCause: null`, and prose naming the missing burn-rate /
    revision-regression facts. A case asserting `CONFIGURATION` here is explicitly forbidden.
  - **Unknown service:** `knownService: false` must produce an honest `INSUFFICIENT` report and
    must **not** be read as "no deployments, therefore ruled out."
  - **Negative cases required by round-2 review:** an old `FAILED` deployment, and a completed
    `ROLLED_BACK` deployment, each keeping `rootCause: null` / `INSUFFICIENT`.
- Whether this needs a new `toolProfile` literal or fits `"default"` is decided during
  implementation; `dataset-validation.ts`'s exhaustive literal check must be updated in the same
  change if a literal is added.

**Stated limit, to be repeated in the acceptance criteria:** these cases prove the orchestrator
executes, validates, and grounds a two-tool chain correctly. They prove **nothing** about whether
a real model would choose the second tool. The provider is fixture-scripted.

### 3.4 Model-facing surface — a versioned change, triggered by the catalog, not by prose

Adding a second tool changes what the model sees in two places: the new catalog `description`,
and `BASE_SYSTEM_PROMPT`'s worked examples, which currently name `get_service_status` in every
evidence-`finding` example. Leaving those untouched offers a tool the prompt's own examples never
illustrate.

**The version bump is triggered by the catalog entry becoming active, NOT by whether
`BASE_SYSTEM_PROMPT` prose changed** (round-1 independent review, MAJOR — accepted). The catalog
`description` is model-facing text and the offered-tool list is part of the behavioral contract a
version identifies: `ClaudeLlmProvider` offers `DIAGNOSTIC_TOOL_CATALOG` by default, so the moment
Issue A merges, a LIVE turn presents two tools. If the bump waited for Issue C, one-tool and
two-tool LIVE runs would both record `opspilot-agent-v5`, and `AgentRun.promptVersion`'s whole
purpose — telling you which behavioral contract a stored run was produced under — would be
defeated for exactly the runs the milestone cares about.

Therefore the §20.4 protocol moves **with Issue A**, prose change or not: catalog entry →
version-lineage comment → §20.4 `v6` literal + supersedes paragraph (stating that the change is
the offered-tool set, and whether prose also moved) → `docs/03-technical-design.md`'s
`AGENT_PROMPT_VERSION` default. Issue C may then make prose edits *within* v6 only if it does so
before any LIVE run is recorded against v6; otherwise it bumps again.

**A related gap this exposes, recorded not silently fixed:** `AGENT_PROMPT_VERSION` appears
**only in documentation and source comments** — `grep -rn "AGENT_PROMPT_VERSION" --include=*.ts`
returns four comment lines and no read. `AgentRun` has no `promptVersion` column
(`schema.prisma`), and `AgentTurnInput` does not carry one (`llm-provider.ts` explicitly lists
`promptVersion` among the §9 contract fields *not* pulled forward). So §20.4's "`AgentRun.promptVersion`
stores a logical version" describes a design target, not shipped behavior, and the auditability
argument above is currently aspirational for that reason. Closing it is **out of scope** (§5) —
but the plan must not imply the bump buys an audit guarantee the schema does not yet provide.

The §20.4 before/after eval regression is required, **with its standard limitation stated**:
`FakeLlmProvider` is fixture-driven, so identical BEFORE/AFTER counts prove no break in the
existing evaluation contract and are not evidence of changed model behavior.

**Open for implementation-time decision:** whether continuation guidance needs explicit
tool-choice language, or whether the existing "a specific allowed diagnostic can materially reduce
an identified evidence gap" rule already covers it. Default to changing nothing beyond what the
catalog addition requires — a speculative prompt edit is still out of scope.

### 3.5 Web UI

Add `get_recent_deployments` to `TOOL_PRODUCT_ACTIONS` and `KNOWN_TOOL_DISPLAY_NAMES`. Without
this the UI degrades to `"Running a diagnostic tool"` — safe, but it renders a two-tool
investigation as two indistinguishable generic rows, which undercuts the one surface where the
milestone's point is visible to a reader.

Tool input/output enrichment (`docs/reviews/25` §5) stays **out of scope** — see §5.

### 3.6 Documentation

- `docs/06-tool-design.md` — implementation-state matrix updated; **and the incorrect "Adding
  tools is what would make a selection metric informative" sentence corrected** per §0.
- `docs/04-agent-design.md` — §20.4 if and only if prompt prose changed.
- `README.md` — Roadmap entry for Milestone 14 (a closed milestone with no Roadmap line hides the
  work from every reader).
- `docs/03-technical-design.md` §14.3 — record which designed tools remain unbuilt and that the
  list is an audited pre-implementation draft, not queued scope.

---

## 4. Verification plan — and its explicit limit

| # | Case | Expected |
| --- | --- | --- |
| 1 | Known slug with deployment history | `knownService: true`, ordered non-empty list |
| 2 | Known slug, no deployments | `knownService: true`, `deployments: []` |
| 3 | Unknown slug | `knownService: false`, `deployments: []` |
| 4 | Malformed input (missing/extra/oversized `serviceSlug`) | `inputSchema.safeParse` fails → `TOOL_INPUT_INVALID`, no execution |
| 5 | Output conforms to `outputSchema` for every fixture entry | PASS |
| 6 | Production registry resolves every `DIAGNOSTIC_TOOL_CATALOG` entry by name | PASS — the §2.1 regression guard |
| 7 | Two-tool "deployment ruled out" case: both calls execute, both `TOOL_EXECUTION` locators distinct, report grounds on both + RAG | PASS |
| 8 | `knownService: false` eval case does not produce a ruled-out-deployment conclusion | PASS |
| 8a | Recent `ROLLED_BACK` deployment + `DEGRADED`: `rootCause: null`, `INSUFFICIENT` | PASS — asserting `CONFIGURATION` here is a defect |
| 8b | Old `FAILED` deployment + `DEGRADED`: `rootCause: null`, `INSUFFICIENT` | PASS |
| 8c | `deployedAt` rejects `"yesterday"` and `"2026-13-99"`; accepts canonical UTC | PASS |
| 9 | Budget interaction: a scripted 3-call chain across two tools stays within `MAX_DIAGNOSTIC_TOOL_CALLS` | PASS |
| 10 | `agent:verify --final` | **`status: PASS`, with all four ordered steps executed** — `typecheck`, `test`, `build`, `@opspilot/web check:bundle` |

### 4.1 The `--final` gate must actually pass — and it now does, on the repo's own Node version

An earlier draft of this plan accepted "green except the four known pre-existing `apps/web`
localStorage failures." **That is withdrawn** (round-1 independent review, MAJOR — accepted after
verifying `scripts/agent/verify.ts`).

`runFinal` (`verify.ts:170-178`) iterates `FINAL_MODE_STEPS` and **breaks on the first FAIL**
("fail-fast, matching CI's own step ordering"). The order is `typecheck → test → build →
check:bundle`. A failing `pnpm test` therefore means `build` and `check:bundle` **never run at
all**. Accepting a FAIL at step 2 would let this milestone merge without ever executing the build
or the web bundle guard — and this milestone touches `apps/web` (§3.5).

**Root cause, established before filing: the four failures are a local Node-version mismatch, not
a repository defect.** `.nvmrc` pins `22.21.0` and CI reads it via `node-version-file`, which is
why CI has been green throughout. The local shell's default `node` is `v26.7.0`, whose warning
reads: `localStorage is not available because --localstorage-file was not provided`. Under Node 26
a bare `window.localStorage` access does not behave as the four containment assertions
(`expect(window.localStorage.length).toBe(0)`) require — these are the LIVE-token containment
tests, which assert a secret never reaches storage.

Verified directly:

```
node --version                                  # v26.7.0 -> 4 failed | 650 passed
export PATH="$HOME/.nvm/versions/node/v22.21.0/bin:$PATH"
node --version                                  # v22.21.0 -> 654 passed (49 files)
pnpm agent:verify --final                       # verify --final: PASS  (all four steps executed)
```

**Consequences:**

1. **No prerequisite issue is needed.** An earlier draft of this section proposed filing one; that
   is withdrawn. The milestone starts at Issue A.
2. **Every `agent:verify` run in this milestone must use the `.nvmrc` version.** Running the gate
   on the shell default silently fail-fasts at step 2 and never reaches `build`/`check:bundle` —
   the exact hole this section exists to close. Confirm `node --version` reports `22.21.0` before
   trusting any verify result.
3. **PR #92's characterization was incomplete, not wrong.** "Pre-existing and reproducible on
   unmodified `main`" was true; both runs were simply on the wrong Node. Recorded here so a future
   session does not re-derive this from scratch or re-accept the failures as tolerable.

### What deterministic verification cannot prove

It cannot prove a real model **chooses** the right tool, chooses it in a sensible order, or avoids
burning budget on the less useful one. `FakeLlmProvider` scripts every turn. Additionally,
`ClaudeLlmProvider` offers its full configured tool list on every `INVESTIGATION` turn and does
**not** shrink it as budget shrinks — `diagnosticCallsRemaining` reaches the model only as prompt
text. At N=2 a model can therefore spend its whole budget on the less informative tool, and no
offline test can detect it.

**Bounded closure:** one recorded LIVE spike (a single manual observation, never a CI gate, never
a new routine paid-test category) on a ticket whose correct investigation requires both tools.

**Procedure** (stated here rather than by reference — an earlier draft cited a
`references/live-spike-validation.md` path that does not exist in this repository; round-1
independent review, MINOR — accepted). Follow the established pattern:

- Scenario logic goes in `apps/worker/src/demo/run-rag-live-spike-scenarios.ts`, unit-tested
  directly in its `.test.ts` sibling **without importing or executing the live composition root**.
- **`apps/worker/src/demo/run-rag-live-spike.ts` must also be changed** (round-2 independent
  review, MAJOR — accepted after reading the file). Its composition root constructs
  `new ClaudeLlmProvider({ ..., diagnosticTools: [GET_SERVICE_STATUS_CATALOG_ENTRY] })` — an
  explicit single-entry list, **not** the catalog default. Without a change here the model is
  never offered `get_recent_deployments`, and the spike would either observe only the old
  one-tool contract or fail with `TOOL_NOT_FOUND` — in both cases producing no evidence for the
  closure it exists to provide. The new scenario must be wired with both catalog entries **and** a
  registry containing both tools; historical scenarios that deliberately pin a narrow tool list
  (the adversarial `recordingTool` paths) stay pinned, so prefer scenario-specific wiring over
  changing the shared construction.
- A transport-level test asserts the new scenario's request offers both diagnostic tool names, and
  a registry assertion confirms both resolve. This is the same offered-vs-executable divergence
  §2.1 identifies in production, reappearing in the spike's own composition root.
- The run is invoked via `pnpm --filter @opspilot/worker run spike:rag`
  (`apps/worker/src/demo/run-rag-live-spike.ts`) against a real `ANTHROPIC_API_KEY`.
- Results are recorded in a new `docs/reviews/NN-milestone-14-…-spike-results.md`, following the
  header-table shape of `docs/reviews/33-issue-77-adversarial-case-expansion-spike-results.md`
  (Spike / Scenario logic / Related design / Date / Status / Models).

Recorded as a single observation with its sample size stated — one run is an anecdote, and the
write-up must say so rather than let a clean result read as a general guarantee.

---

## 5. Out of scope (explicit)

- **`get_error_rate_metrics` (candidate B).** Deferred with a stated trigger, not vaguely
  postponed. Revisit **only if** the §4 LIVE spike shows the model using both tools purposefully
  (i.e. tool count is not already saturating its attention). If the spike instead shows the model
  burning budget on a low-value call at N=2, that is evidence **against** N=3, and this decision
  record should be closed as declined rather than left open. Its numeric-evidence grounding
  question is separately unresolved and would need its own design.
- **Any third tool, and any of §14.3's remaining designed tools.** §14.3 is an audited
  pre-implementation draft, not a backlog.
- **Tool input/output enrichment in Agent Activity** (`docs/reviews/25` §5). This milestone
  *triggers* that plan's stated condition, which makes it a real candidate — but bundling a
  presentation change into a milestone about catalog correctness is exactly the scope creep
  `CONTEXT.md`'s engineering posture rejects. It becomes a legitimately fileable follow-up issue;
  filing it is an owner decision, not an automatic consequence.
- **Making tool selection a measured/CI-gated property.** Structurally impossible under a
  fixture-driven provider (§0).
- **Any change to** `DiagnosticToolDefinition`, `InMemoryToolRegistry`, `MAX_PROVIDER_TURNS`,
  `MAX_DIAGNOSTIC_TOOL_CALLS`, the `AgentOrchestrator` contract, `EvidenceSourceTypeSchema`,
  `IncidentCategorySchema`, the database schema, or any migration. The existing abstractions are
  tool-count-neutral; this milestone fills unfilled capacity, it does not relax a constraint.
- **Wiring the new tool into `deterministic-scenario.ts`'s FAKE public-demo run.** Whether the
  public deterministic demo should script a two-tool investigation is a product-presentation
  decision with its own blast radius (it changes what every public visitor sees). Deliberately
  separated; default is no change.
- **Implementing the unwired `AGENT_MAX_*` budget settings**, including the aspirational
  "same diagnostic tool calls: 2" limit. Named here only because §2 corrects the record that it is
  unimplemented; implementing it is not this milestone's business.
- **Wiring `promptVersion` through to persistence.** §3.4 establishes that
  `AgentRun.promptVersion` is a §20.4 design target with no column, no `AgentTurnInput` field, and
  no code read — the version bump this milestone performs is a documentation-and-source-comment
  contract, not a per-run stored fact. Closing that gap is real work with its own schema
  migration; it is recorded here as a known limitation rather than folded in.

---

## 6. Proposed issue breakdown

**Issue A — the tool, the wiring reconciliation, and the version bump.** The new tool module +
fixture + catalog entry + the §2.1 production-wiring fix + every registry construction site
classified + the catalog-coverage regression test + the `v6` bump (§3.4: triggered by the catalog
entry, not by prose). Deterministic tests only. This is the milestone's load-bearing issue and
should not be merged alongside anything else.

**No prerequisite issue.** §4.1 established before filing that the four `apps/web` failures are a
local Node-version mismatch (shell default `v26.7.0` vs `.nvmrc`'s `22.21.0`), not a repository
defect: on the pinned version `agent:verify --final` returns PASS with all four steps executed.
Every verify run in this milestone must use the `.nvmrc` version.

**Issue B — evaluation coverage.** Two-tool chain cases, the `knownService: false` case,
`resolveTools`/`toolProfile` handling, dataset-validation update if a literal is added.

**Issue C — reader-visible surface and the LIVE spike.** Web UI labels, `docs/06-tool-design.md`
correction + matrix, README Roadmap entry, §14.3 audit note, and any `BASE_SYSTEM_PROMPT` prose
refinement (within `v6` if no LIVE run has yet been recorded against it; otherwise a further
bump). **Includes the `run-rag-live-spike.ts` composition-root change and its transport-level
test** (§4's procedure) — without it the spike cannot offer the second tool at all. The LIVE spike
is run and recorded here, after A and B are on `main`.

Ordering is strict: A before B (B's cases need the tool), B before C (the §20.4 before/after
regression needs the eval suite in its post-change shape, and the LIVE spike needs both on
`main`).

---

## 7. Acceptance criteria

1. `DIAGNOSTIC_TOOL_CATALOG` contains exactly two entries.
2. The production tool registry is derived from the catalog, and a test fails if any catalog entry
   is not resolvable by the production registry.
3. Every non-test `InMemoryToolRegistry` construction site is either catalog-derived or carries a
   recorded reason for being deliberately pinned.
4. `get_recent_deployments` performs no clock read, no network call, and no filesystem read;
   repeated execution with identical input yields byte-identical output.
5. `knownService: false` is distinguishable from `knownService: true` with an empty list, in the
   schema and in at least one eval case's expected outcome.
6. At least one eval case grounds a report on two distinct `TOOL_EXECUTION` locators from two
   different tools plus a `RAG_CHUNK`.
6a. **No eval case, fixture, or document in this milestone asserts a root cause grounded on
   deployment outcome.** Deployment evidence supports ruling deployment OUT, or naming it as an
   unresolved lead with the missing facts stated — never a `CONFIGURATION` assignment (§1).
6b. `deployedAt` is schema-validated as a canonical ISO-8601/RFC3339 datetime, with tests
   rejecting non-dates and invalid calendar dates.
6c. The LIVE spike's composition root (`run-rag-live-spike.ts`) offers both tools to the model and
   resolves both in its registry, proven by a transport-level test — not assumed from the catalog.
7. `agent:verify --final` returns `status: PASS` with all four ordered steps (`typecheck`, `test`,
   `build`, `@opspilot/web check:bundle`) executed — not a FAIL at step 2 that silently skips the
   last two (§4.1). The run must be on `.nvmrc`'s Node `22.21.0`; a result produced on another
   version does not count.
8. If the catalog gained an entry (i.e. always, for this milestone): `AGENT_PROMPT_VERSION`'s
   **active/default declaration** is `opspilot-agent-v6`, §20.4 carries a `v6 supersedes v5`
   paragraph, and §20.4 carries a before/after eval regression entry **including its
   fixture-driven limitation**. Historical `v1`–`v5` references in §20.4's lineage and in
   `claude-message-mapping.ts`'s cumulative version comments are **retained deliberately** — the
   check is that no *active* declaration still reads `v5`, never that the string `v5` is absent
   from the repository (round-1 independent review, MINOR — accepted; a global-absence grep would
   force erasing the lineage the versioning scheme exists to preserve).
9. `docs/06-tool-design.md` no longer claims that adding tools makes a selection metric
   informative.
10. README's Roadmap names Milestone 14.
11. One LIVE spike is recorded, with its sample size (n=1) and the limits of what it establishes
    stated in the write-up itself — not inferable only from context.
12. No document, PR body, or commit message in this milestone claims that tool-selection quality
    became a measured property.
