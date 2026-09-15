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

### 2.1 Derive the report-stage transition from the reducer's own condition, not from turn position

Replace the positional rule with a **once-per-run** report-stage transition, keyed on the condition
the reducer actually encodes:

> the report stage has begun when **the diagnostic budget is exhausted**
> (`toolCallCount >= MAX_DIAGNOSTIC_TOOL_CALLS`) **or** the turn is the forced finalization turn.

Two things derive from that single condition, and both must move together (§2.1a):

1. `REPORT_GENERATION_STARTED` is emitted on the **first** turn that satisfies it, and never again.
2. `activeStage` resolves to `REPORT_GENERATION` on every turn that satisfies it.

Under today's equality the condition first holds exactly on the forced finalization turn, so **the
emitted stream for every currently-possible run is byte-identical** — the same compatibility
property #101 §2.3 established for its own emission move. Under the raise, turn 3 correctly
announces the report stage, exactly once.

**Rejected alternative — relax the reducer instead.** The reducer's rule is what makes a voluntary
early report distinguishable from a forced finalization report in persisted data; weakening it to
accept an unannounced submission at the bound would erase that distinction for every historical row
as well. The orchestrator is the side holding the accidental assumption, so the orchestrator is the
side that changes.

**Explicitly NOT in scope:** changing `phase` itself. Phase governs `tool_choice` and prompt
selection; turn 3 under the raise is genuinely still an investigation turn for prompt purposes. Only
the report-stage transition is decoupled.

### 2.1a Both halves of the transition move together — independently verified

Independent review (round 1) raised two BLOCKERs against an earlier draft of §2.1 that specified
only the *emission* half and left `activeStage` positional. Both were reproduced against the real
reducer before acceptance; neither is hypothetical.

**(a) The singleton would be emitted twice.** An earlier draft said "emit when the budget is
exhausted **or** the turn is the forced finalization turn", evaluated per turn. With bounds 5/3 and
a report rejected on turn 3, turn 3 satisfies the exhausted-budget clause and turn 4 satisfies both
— so the event fires on each:

```
--- report-start emitted on BOTH turn 3 and turn 4 ---
REDUCER: REJECTED -> DUPLICATE_LIFECYCLE_FACT
  REPORT_GENERATION_STARTED occurs more than once (sequence 10).
```

`investigation-stage-progress-reducer.ts:732-738` rejects the second outright. This would have
broken the *correction* path — the very path the issue exists to enable — and in the same stuck-run
class §0.3 describes. Hence "first qualifying turn, never again".

**(b) A failure on the announced turn would name the wrong stage.** `activeStage`
(`agent-orchestrator.ts:486-491`) is `phase === "FINALIZATION" ? "REPORT_GENERATION" : toolCallCount
> 0 ? "DIAGNOSTIC_EXECUTION" : "AGENT_ANALYSIS"`. With the emission fix alone, turn 3 announces the
report stage while a provider failure there still reports `DIAGNOSTIC_EXECUTION`:

```
--- provider failure on the announced turn, failedStage DIAGNOSTIC_EXECUTION ---
REDUCER: REJECTED -> FAILED_STAGE_NOT_TRUTHFUL
  RUN_FAILED at sequence 10 names stage "DIAGNOSTIC_EXECUTION", but the currently active
  stage is "REPORT_GENERATION"; a run fails in the stage it was executing.

--- control: the same stream naming REPORT_GENERATION ---
REDUCER: ACCEPTED
```

So an ordinary provider timeout on the new headroom turn would also strand the run. The control run
confirms the fix direction: `activeStage` must be derived from the same shared condition, not from
`phase`.

The lesson generalizes beyond this issue and is why §2.3 exists: **`REPORT_GENERATION_STARTED` is
not merely a log line — emitting it transitions the reducer's active stage**, so anything derived
from "which stage is running" must move with it.

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

The gap that made this defect invisible (§0.4), and the only thing that would have caught either
BLOCKER in §2.1a. Add, in `agent-runtime`, a test that takes the payloads the orchestrator actually
emitted and feeds them to `deriveExecutionStageProgress`, for three shapes:

1. all diagnostics spent → valid report on the first available turn;
2. all diagnostics spent → report rejected → corrected → accepted on the finalization turn,
   asserting the stream carries **exactly one** `REPORT_GENERATION_STARTED`;
3. all diagnostics spent → provider failure on the first announced turn → `RUN_FAILED` appended from
   the orchestrator's own result, asserting the reducer accepts it with
   `failedStage: "REPORT_GENERATION"`.

**Baseline expectations against the pre-fix positional rule** (measured, §2.1a and §0.5 — not
assumed): case 1 is **rejected** with `MISSING_LIFECYCLE_FACT`, which is what proves the test
discriminates. Cases 2 and 3 are **accepted** under the pre-fix rule at today's constants, so they
are green regression guards rather than red-first tests; requiring them to fail first would be
unsatisfiable. Record these three expectations explicitly in the test file so a later reader does
not "fix" a passing baseline.

### 2.4 Only then, raise the constant

`MAX_PROVIDER_TURNS = 5`, `MAX_DIAGNOSTIC_TOOL_CALLS` unchanged at 3. The documented bound
`MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1` becomes genuinely slack (`3 <= 4`).

Retry windows need no edit — both are expressed relative to `MAX_PROVIDER_TURNS` and widen
correctly. The `diagnosticCallsRemaining` expression likewise already carries the explicit
turn-based ceiling #99 added.

---

## 3. Compatibility

- **Emitted streams for existing runs are unchanged.** Under the equality that holds before §2.4
  lands, §2.1's condition first holds exactly on the forced finalization turn — the same single turn
  the positional rule selected — so both the emission and the `activeStage` value are identical.
- **No persisted data migrates.** No event type, payload field, or failure code is added or altered.
- **No reducer change**, so every already-persisted stream keeps reading identically.
- **Cost envelope moves** and every derived figure must move with it — see §6 step 6.

---

## 4. Verification plan — and its explicit limit

| # | Case | Expected |
| --- | --- | --- |
| 1 | All diagnostics spent, valid report on the first available turn, stream → real reducer | ACCEPTED |
| 2 | Same, but report rejected then corrected on the finalization turn | ACCEPTED, and the stream carries **exactly one** `REPORT_GENERATION_STARTED` |
| 3 | All diagnostics spent, provider failure on the first announced turn, `RUN_FAILED` → real reducer | ACCEPTED with `failedStage: "REPORT_GENERATION"` (§2.1a(b)) |
| 4 | Case 1 against the pre-fix positional rule | REJECTED with `MISSING_LIFECYCLE_FACT` — proves the test discriminates |
| 5 | Cases 2 and 3 against the pre-fix positional rule at today's constants | ACCEPTED — recorded as measured baselines, **not** required to fail first (§2.3) |
| 6 | Turn with `diagnosticCallsRemaining === 0` | Provider offers `submit_resolution_report` only |
| 7 | Correction fires after all 3 diagnostic calls are spent | `correctiveTurns > 0` — #108's third characterization test flips, as it predicted |
| 8 | Full run within the new ceiling | `providerTurnsUsed <= MAX_PROVIDER_TURNS` |
| 9 | `agent-run-bounds.test.ts` | Updated to `5`/slack; the `<=` invariant assertion unchanged |

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
- **Making `phase` non-positional** (§2.1) — `phase` still governs `tool_choice` and prompt
  selection; only the report-stage transition is decoupled from it.
- **Recording corrected-away attempts in the ledger.** Still owed its own issue (#101 §5).
- **Any LIVE run.** Nothing here requires one; the raise's behavioral payoff is measured with #109.

---

## 6. Sequencing (test-first)

1. Add the real-reducer tests (§2.3); confirm case 1 fails against unmodified code with
   `MISSING_LIFECYCLE_FACT`, and record cases 2 and 3 as already-accepted baselines.
2. Implement §2.1's shared report-stage condition — **both** the once-per-run emission and the
   `activeStage` derivation (§2.1a). Tests go green; confirm the byte-identity claim in §3 by running
   the existing orchestrator suite unchanged.
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

1. A test feeds the orchestrator's **emitted stream** to the real reducer for all three §2.3 shapes,
   and all three are accepted after the fix.
2. Case 1 of that test is proven to fail against the pre-fix positional rule, with
   `MISSING_LIFECYCLE_FACT`. Cases 2 and 3 are recorded as measured pre-fix baselines that already
   pass (§2.3) — no criterion requires them to fail first.
3. `REPORT_GENERATION_STARTED` is emitted on the **first** turn where the diagnostic budget is
   exhausted or the turn is the forced finalization turn, and **never more than once per run**.
4. `activeStage` resolves to `REPORT_GENERATION` on every turn satisfying that same condition, so a
   provider failure on an announced non-final turn persists `failedStage: "REPORT_GENERATION"` and
   is accepted by the reducer (§2.1a(b)).
5. The provider offers no diagnostic tool on a turn with `diagnosticCallsRemaining === 0`.
6. `MAX_PROVIDER_TURNS === 5`, `MAX_DIAGNOSTIC_TOOL_CALLS === 3`, and the `<=` invariant assertion
   still passes while the equality assertion is replaced by a slack assertion.
7. #108's "correction CANNOT fire" characterization test is updated to reflect that it now can, with
   `correctiveTurns > 0`.
8. The logical prompt version is bumped at all four sites with an offered-set-driven rationale.
9. Every `MAX_PROVIDER_TURNS`-derived figure found by the §6 step 6 grep is updated, including both
   daily-output-envelope statements.
10. `pnpm agent:verify --final` passes.
11. The PR body and an issue comment state mechanism and model-compliance as **separate verdicts**,
    and explicitly do **not** claim this issue raises the LIVE completion rate. Closing #107 with
    the stronger claim is prohibited.
