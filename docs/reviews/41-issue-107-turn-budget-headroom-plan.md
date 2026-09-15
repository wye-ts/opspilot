# Issue #107 — Turn-budget headroom requires decoupling the report-start fact from turn position

| Field | Value |
| --- | --- |
| Scope | #107 — "a corrective retry cannot fire when all diagnostic calls are spent". **Corrected scope** (§0): raising `MAX_PROVIDER_TURNS` alone breaks the canonical event ledger. The deliverable is the orchestrator/reducer re-alignment that makes the raise safe, then the raise. |
| Basis | `main` @ `8507ec7` (#108 merged), working tree clean. Deterministic probes with `FakeLlmProvider` + the real reducer — **zero paid provider calls**. |
| Status | Plan only — no implementation, no commit, no provider/LIVE request. |
| Branch | `fix/107-turn-budget-headroom` (created, empty) |
| Committed location | `docs/reviews/41-issue-107-turn-budget-headroom-plan.md` |
| Owner decision on record | The ~25% per-run cost increase (~$0.13 → ~$0.16) was approved before the defect below was found. The corrected scope does not change that cost figure. |

---

## 0. Scope correction — the issue's proposed change is not implementable as written

The issue proposes: *raise `MAX_PROVIDER_TURNS` from 4 to 5, leaving `MAX_DIAGNOSTIC_TOOL_CALLS` at
3*, and lists acceptance criteria consisting of a regression test plus doc updates.

**That change, applied alone, corrupts the canonical event ledger.** Verified deterministically
before any implementation began; recorded on the issue as
[comment 5676160860](https://github.com/wye-ts/opspilot/issues/107#issuecomment-5676160860).

### 0.1 The reproduction

Constant flipped to 5, `@opspilot/contracts` rebuilt, then the *intended success path* driven
through the real orchestrator: all 3 diagnostic calls spent on turns 0-2, then a **fully valid**
report submitted on turn 3. The emitted stream was fed to the real reducer
(`deriveExecutionStageProgress`):

```
constants: { MAX_PROVIDER_TURNS: 5, MAX_DIAGNOSTIC_TOOL_CALLS: 3 }
orchestrator status: completed
emitted: AGENT_STARTED -> TOOL_REQUESTED -> TOOL_COMPLETED -> TOOL_REQUESTED -> TOOL_COMPLETED
         -> TOOL_REQUESTED -> TOOL_COMPLETED -> REPORT_SUBMITTED -> REPORT_VALIDATED
REDUCER: REJECTED -> MISSING_LIFECYCLE_FACT
```

### 0.2 The mechanism

| Side | Location | Condition |
| --- | --- | --- |
| Orchestrator emits `REPORT_GENERATION_STARTED` | `agent-orchestrator.ts:499` | iff `phase === "FINALIZATION"`, i.e. `turnIndex === MAX_PROVIDER_TURNS - 1` |
| Reducer requires it | `investigation-stage-progress-reducer.ts:806` | whenever `toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS` |

The two conditions coincide **only** under `MAX_DIAGNOSTIC_TOOL_CALLS === MAX_PROVIDER_TURNS - 1`
— today's equality, which `agent-run-bounds.test.ts` pins and `docs/04-agent-design.md` §7 records
as "equality holds today". The issue's stated goal is to make that bound *slack*; the slack is
precisely what separates "diagnostic budget exhausted" from "last turn" and splits the two
conditions apart.

### 0.3 Why this outranks the bug it was meant to fix

A reducer-rejected stream does not fail the run cleanly. Per
`references/canonical-event-ledger-contract.md` and the reducer's own contract, the persistence path
returns unavailable and the run is left **`RUNNING`**. The status quo produces an honest
`REPORT_SCHEMA_INVALID`; the naive change would convert a subset of those into stuck runs.

### 0.4 Why the existing suite does not catch it

| Suite | Result at `MAX_PROVIDER_TURNS = 5` |
| --- | --- |
| `@opspilot/contracts` | 342 of 343 pass. The sole failure is `agent-run-bounds.test.ts`'s hard-coded `expect(MAX_PROVIDER_TURNS).toBe(4)`. Every reducer test passes. |
| `@opspilot/agent-runtime` | 13 fail — **none** a reducer rejection. Orchestrator tests use a collecting emitter that performs no validation. |

The issue's filed acceptance criteria would therefore have been fully satisfied by a ledger-breaking
change. This is the structural gap §2.3 closes.

### 0.5 Inverted incentive (same probe, correction path)

```
--- all diagnostics spent, report REJECTED then corrected ---
emitted: ... TOOL_COMPLETED -> REPORT_GENERATION_STARTED -> REPORT_SUBMITTED -> REPORT_VALIDATED
REDUCER: ACCEPTED
```

Turn 4 is still `FINALIZATION`, so the corrected path emits the fact and survives. The naive change
makes a first-time-correct report fail while a wrong-then-corrected one succeeds — the exact
opposite of the issue's intent.

### 0.6 Second defect at the same turn

`claude-llm-provider.ts:391` offers diagnostic tools whenever `phase === "INVESTIGATION"`, with
`tool_choice: auto`. At `MAX_PROVIDER_TURNS = 5`, turn 3 is an INVESTIGATION turn with
`diagnosticCallsRemaining === 0`. A model that takes an offered tool there trips the
`toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS` guard and fails `PROVIDER_PROTOCOL_INVALID` — a guard
whose own comment (`agent-orchestrator.ts:761`) currently documents it as unreachable *because of
the same equality*. The raise makes a documented-unreachable failure path reachable and pays a
provider turn to reach it.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Turn/tool ceilings | `packages/contracts/src/agent-run-bounds.ts:11-12` | `MAX_PROVIDER_TURNS = 4`, `MAX_DIAGNOSTIC_TOOL_CALLS = 3`. Compile-time, code-reviewed; deliberately not env knobs. |
| Equality pinned | `packages/contracts/src/agent-run-bounds.test.ts:30-34` | Asserts `MAX_PROVIDER_TURNS` is literally `4` and the bound holds at equality. |
| Phase derivation | `agent-orchestrator.ts:474-475` | `FINALIZATION` iff `turnIndex === MAX_PROVIDER_TURNS - 1`; purely positional. |
| Report-start emission | `agent-orchestrator.ts:499-501` | Emitted iff `phase === "FINALIZATION"`. |
| Reducer's requirement | `investigation-stage-progress-reducer.ts:796-812` | Requires the fact once `toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS`. |
| Defense-in-depth guard | `agent-orchestrator.ts:758-772` | Rejects a request past the tool bound; comment states it is unreachable under the current equality. |
| Tool offering | `claude-llm-provider.ts:388-397` | Offers diagnostic tools + `tool_choice: auto` on every INVESTIGATION turn, regardless of remaining budget. |
| Budget field | `agent-orchestrator.ts:547-550` | `Math.min(MAX_DIAGNOSTIC_TOOL_CALLS - toolCallCount, MAX_PROVIDER_TURNS - 1 - turnIndex)` — already correct under the raise; #99 made the second ceiling explicit. |
| A3 retry window | `agent-orchestrator.ts:843` | `turnIndex <= MAX_PROVIDER_TURNS - 3` |
| Report retry window | `agent-orchestrator.ts:621` | `turnIndex < MAX_PROVIDER_TURNS - 1` |
| Characterization tests | `packages/agent-runtime/src/agent/turn-budget-pressure.test.ts` | #108. Explicitly anticipates the flip: "If #107 raises MAX_PROVIDER_TURNS, the third test below is expected to flip." |

---

## 2. Design

### 2.1 Derive the report-start fact from the reducer's own condition, not from turn position

Replace the positional emission with the disjunction the reducer actually encodes:

> emit `REPORT_GENERATION_STARTED` before a provider call when **the diagnostic budget is exhausted**
> (`toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS`) **or** the turn is the forced finalization turn.

Under today's equality the two are the same set of turns, so **the emitted stream for every
currently-possible run is byte-identical** — the same compatibility property #101 §2.3 established
for its own emission move. Under the raise, turn 3 correctly announces the report stage.

**Rejected alternative — relax the reducer instead.** The reducer's rule is what makes a voluntary
early report distinguishable from a forced finalization report in persisted data; weakening it to
accept an unannounced submission at the bound would erase that distinction for every historical row
as well. The orchestrator is the side holding the accidental assumption, so the orchestrator is the
side that changes.

**Explicitly NOT in scope:** changing `phase` itself. Phase governs `tool_choice` and prompt
selection; turn 3 under the raise is genuinely still an investigation turn for prompt purposes. Only
the report-start fact is decoupled.

### 2.2 Stop offering diagnostic tools when the budget is spent

`claude-llm-provider.ts` selects tools on `phase` alone. Extend the condition to also require
`input.diagnosticCallsRemaining > 0`. `AgentTurnInput` already carries the field (§1), so no
contract change is needed.

This keeps §0.6's newly-reachable guard unreachable in practice, and keeps the guard itself as
defense-in-depth. It also removes the misleading offer — a model told it has 0 calls remaining
should not simultaneously be handed the tools.

**Prompt-version consequence.** Per `references/prompt-version-and-tool-contract.md`, the offered
tool set changing on a turn is a model-facing contract change and requires a logical prompt-version
bump. The current version is `opspilot-agent-v8` (`docs/04-agent-design.md` §20.4 fenced literal
line 1023; `docs/03-technical-design.md:1237`), so this becomes `opspilot-agent-v9` — narrowing
*when* the catalog is offered is an offered-set change of the same kind as the v6 bump, even though
no prose in `claude-message-mapping.ts` moves. Four sites move together; see §6.

### 2.3 A test that runs the emitted stream through the REAL reducer

The gap that made this defect invisible (§0.4). Add, in `agent-runtime`, a test that takes the
payloads the orchestrator actually emitted and feeds them to `deriveExecutionStageProgress`, for
both shapes:

1. all diagnostics spent → valid report on the first available turn;
2. all diagnostics spent → report rejected → corrected → accepted on the finalization turn.

Each must be proven to fail against the pre-fix emission rule before being trusted green.

### 2.4 Only then, raise the constant

`MAX_PROVIDER_TURNS = 5`, `MAX_DIAGNOSTIC_TOOL_CALLS` unchanged at 3. The documented bound
`MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1` becomes genuinely slack (`3 <= 4`).

Retry windows need no edit — both are expressed relative to `MAX_PROVIDER_TURNS` and widen
correctly. The `diagnosticCallsRemaining` expression likewise already carries the explicit
turn-based ceiling #99 added.

---

## 3. Compatibility

- **Emitted streams for existing runs are unchanged.** Under the equality that holds before §2.4
  lands, §2.1's disjunction selects exactly the turns the positional rule selected.
- **No persisted data migrates.** No event type, payload field, or failure code is added or altered.
- **No reducer change**, so every already-persisted stream keeps reading identically.
- **Cost envelope moves** and every derived figure must move with it — see §6 step 6.

---

## 4. Verification plan — and its explicit limit

| # | Case | Expected |
| --- | --- | --- |
| 1 | All diagnostics spent, valid report on the first available turn, stream → real reducer | ACCEPTED |
| 2 | Same, but report rejected then corrected on the finalization turn | ACCEPTED |
| 3 | Case 1 against the pre-fix positional emission rule | REJECTED with `MISSING_LIFECYCLE_FACT` (proves the test discriminates) |
| 4 | Turn with `diagnosticCallsRemaining === 0` | Provider offers `submit_resolution_report` only |
| 5 | Correction fires after all 3 diagnostic calls are spent | `correctiveTurns > 0` — #108's third characterization test flips, as it predicted |
| 6 | Full run within the new ceiling | `providerTurnsUsed <= MAX_PROVIDER_TURNS` |
| 7 | `agent-run-bounds.test.ts` | Updated to `5`/slack; the `<=` invariant assertion unchanged |

**What this cannot prove.** All of the above is mechanism. Whether a real model, given a turn it
previously did not have, actually produces a *valid* corrected report is a model-behavior question
that only real LIVE runs can answer — and #109's evidence (3 of 3 failures submitted
`evidence: []` with 2 diagnostic calls used, i.e. with a correction slot already available) suggests
this issue **will not** materially raise the completion rate on its own. That is the honest expected
outcome, and it must not be reported as "the live path is fixed".

Per the repo's split-reporting rule, the PR body, the issue comment, and the acceptance criteria all
state mechanism and model-compliance as two separate verdicts.

---

## 5. Out of scope (explicit)

- **#109's empty-evidence failure.** Independent; the dominant cause of current LIVE failures.
- **Changing `MAX_DIAGNOSTIC_TOOL_CALLS`.** Stays 3.
- **Relaxing the reducer** (rejected, §2.1).
- **Making `phase` non-positional** (§2.1).
- **Recording corrected-away attempts in the ledger.** Still owed its own issue (#101 §5).
- **Any LIVE run.** Nothing here requires one; the raise's behavioral payoff is measured with #109.

---

## 6. Sequencing (test-first)

1. Add the real-reducer tests (§2.3); confirm case 1 fails against unmodified code with
   `MISSING_LIFECYCLE_FACT`.
2. Implement §2.1's emission condition; tests go green; confirm the byte-identity claim in §3 by
   running the existing orchestrator suite unchanged.
3. Implement §2.2's tool-offering condition + its unit test.
4. Bump the logical prompt version to `opspilot-agent-v9` across all four sites
   (`claude-message-mapping.ts` lineage comment, `docs/04-agent-design.md` §20.4 literal +
   supersedes paragraph, `docs/03-technical-design.md` `AGENT_PROMPT_VERSION` default), stating the
   bump is offered-set-driven with no prose change.
5. Raise the constant (§2.4); update `agent-run-bounds.test.ts` and let #108's characterization test
   flip.
6. Sweep every `4`-derived figure by grep, not memory: `docs/04-agent-design.md` §7 bound table and
   its "equality holds today" note, `docs/06-tool-design.md:53`,
   `docs/16-investigation-event-contract.md`, `README.md:156-158` and
   `docs/08-cicd-deployment.md:876` (both encode the daily output envelope
   `3072 × 4 × 1 × 10 = 122,880`, which becomes `3072 × 5 × 1 × 10 = 153,600`),
   `apps/worker/src/smoke/claude-live-smoke.ts` paid-call disclosure, and
   `apps/worker/src/evaluation/dataset-validation.ts` rule 14.
7. `pnpm agent:verify --final`, then the review bundle and an independent `agent:codex-review` round.

---

## 7. Acceptance criteria

1. A test feeds the orchestrator's **emitted stream** to the real reducer for both §2.3 shapes, and
   both are accepted.
2. That test is proven to fail against the pre-fix emission rule, with `MISSING_LIFECYCLE_FACT`.
3. `REPORT_GENERATION_STARTED` is emitted whenever the diagnostic budget is exhausted or the turn is
   the forced finalization turn.
4. The provider offers no diagnostic tool on a turn with `diagnosticCallsRemaining === 0`.
5. `MAX_PROVIDER_TURNS === 5`, `MAX_DIAGNOSTIC_TOOL_CALLS === 3`, and the `<=` invariant assertion
   still passes while the equality assertion is replaced by a slack assertion.
6. #108's "correction CANNOT fire" characterization test is updated to reflect that it now can, with
   `correctiveTurns > 0`.
7. The logical prompt version is bumped at all four sites with an offered-set-driven rationale.
8. Every `MAX_PROVIDER_TURNS`-derived figure found by the §6 step 6 grep is updated, including both
   daily-output-envelope statements.
9. `pnpm agent:verify --final` passes.
10. The PR body and an issue comment state mechanism and model-compliance as **separate verdicts**,
    and explicitly do **not** claim this issue raises the LIVE completion rate. Closing #107 with
    the stronger claim is prohibited.
