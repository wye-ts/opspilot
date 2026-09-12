# Issue #99 — `NO_EVIDENCE_YET` Residual Failure Rate on the Public LIVE Path

| Field | Value |
| --- | --- |
| Scope | #99 — the A3 run-state-consistency guard kills an entire run on turn 0 when a real model misclaims `NO_EVIDENCE_YET` after RAG retrieval. Narrow reading: change the *reaction* to a tripped A3 guard, not the guard, the schema, or the prompt. |
| Basis | Real deployed LIVE run `855ceaf4-d3a3-46b6-b9e2-778d2413c830` (2026-09-12, `claude-sonnet-5`), its Render `provider_turn` log line, and `docs/reviews/35-issue-85-no-evidence-yet-consistency-guard-plan.md` §8's recorded post-fix residual rate |
| Status | Plan only — no implementation |
| Branch | `fix/99-no-evidence-yet-residual-rate` |
| Committed location | `docs/reviews/38-issue-99-no-evidence-yet-residual-rate-plan.md` |

---

## 0. Scope decision — and the two candidate directions source evidence rules out

#99's discussion listed three candidate directions. Two are refuted by source, and recording why
matters more than the one that survives: both *sound* cleaner than the surviving option, and a
future session re-reading this issue will propose them again.

**Rejected — "don't charge a visitor's daily quota for a run that failed this way."**
Mechanically impossible without redesigning the public-trial reservation. The quota is not a
counter decremented after a run resolves; the `(visitor_id, usage_date)` primary key *is* the gate
(`agent-run-repository.ts` step 5), reserved inside the same transaction that inserts the run —
explicitly *"before the provider is ever constructed by the caller."* A refund would mean deleting
the usage row after a failure, which reintroduces exactly the double-spend the key exists to
prevent: two concurrent requests could each see an absent row. Not worth weakening a hard gate to
soften a soft failure.

**Rejected — "narrow the guard so `NO_EVIDENCE_YET` is legal when only RAG evidence exists."**
This reading assumed the guard's `||` conflates two things the contract ought to separate. It does
not. `ContinuationReasonSchema` already carries the correct vocabulary, and the distinction is
written into the enum itself:

```ts
"NO_EVIDENCE_YET",   // nothing has been gathered at all — no tool result, no RAG chunk
"STATUS_UNRESOLVED", // gathered evidence (tool and/or contextual) did not establish the needed fact
```

`STATUS_UNRESOLVED` *is* the reason for "runbooks exist, I have gathered nothing myself, I still
need a tool call." There is no missing state. Worse, the schema enforces the pairing structurally:
`NO_EVIDENCE_YET` requires `supportedBy: []`, and every other reason requires ≥1 locator. Making
`NO_EVIDENCE_YET` legal alongside retrieved chunks would either permit an assessment that cites no
evidence while evidence exists (an unreconstructable claim — the exact thing P2-3 forbids) or force
`supportedBy` to be non-empty under a reason whose own definition says nothing was gathered. The
model is simply wrong when it picks `NO_EVIDENCE_YET` here, and `docs/reviews/35` §8 already reached
the same conclusion: *"relaxing the schema's own NO_EVIDENCE_YET requires zero locators invariant
(out of scope, not what's broken)."* Re-verified against source; that judgment holds.

**Rejected — a third prompt revision.** The current `investigationGuidance` already addresses this
case in explicit, targeted prose — an entire paragraph naming the exact misclaim, including *"even
before your very first diagnostic tool call, that runbook evidence already EXISTS."* #85 shipped
that text and measured the result: 3 of 4 post-fix live runs passed, 1 re-tripped. Adding a fourth
paragraph restating what two existing paragraphs already say is not a plan; it is a hope, and each
attempt costs a billed LIVE run to evaluate against a non-deterministic baseline.

**Selected — change what happens when A3 trips, not whether it trips.** `docs/reviews/35` §8
rejected this as *"model-side retry/self-correction logic (a materially larger, unscoped change)."*
That rejection was for **scope**, not correctness, and it was made before the failure had been
observed on the public path. This plan scopes it narrowly enough to be proportionate.

### The framing this plan rests on

The defect is not detection. A3 is correct: the model's assessment genuinely contradicts the run's
evidence state, and accepting it would let an ungrounded claim into the ledger.

The defect is the **reaction**. A recoverable, documented-as-occasional model formatting error gets
the most severe response the system has: the entire investigation is abandoned on turn 0 of 4, with
3 unused provider turns and 3 unused diagnostic calls still budgeted. Nothing irreversible had
happened — no tool had executed, no report existed, the ledger held one `RETRIEVAL_COMPLETED` event.

`docs/reviews/35` §8 accepted the residual rate in the context of a live-spike script, where a
failure costs a re-run. On the public trial the same event costs a visitor their single daily run
and shows them `PROVIDER_PROTOCOL_INVALID`. Same mechanism, materially different cost — and that
change of context, not any new defect, is what reopens the decision.

---

## 1. Current-state findings

| # | Finding | Source (verified this session) |
| --- | --- | --- |
| 1 | A3 guard fires when `claimsNoEvidenceYet === hasRunEvidence`, where `hasRunEvidence = successfulToolExecutionIds.size > 0 \|\| allowedRagChunkIds.size > 0` | `agent-orchestrator.ts:582-590` |
| 2 | A tripped A3 returns `failed(...)` directly out of the turn loop — no retry, no continuation | `agent-orchestrator.ts:586-590` |
| 3 | The failing run died on turn 0 of `MAX_PROVIDER_TURNS = 4`, with `MAX_DIAGNOSTIC_TOOL_CALLS = 3` unused | run `855ceaf4…` trace: 1 event, no `TOOL_REQUESTED` |
| 4 | The provider layer succeeded — all 5 `provider-claude` protocol_error branches passed | Render log: `normalizedResultType: "diagnostic_tool_request"` |
| 5 | `PROVIDER_PROTOCOL_INVALID` has 12 trigger sites (5 in `provider-claude`, 7 in `agent-orchestrator`); only `failure_code` is persisted, so no record identifies which fired | `grep` both packages; `agent_runs` schema; `failure-messages.ts` is a static read-time map |
| 6 | `STATUS_UNRESOLVED` is the already-correct reason for this state; no vocabulary gap exists | `evidence-assessment.ts:20-25` |
| 7 | Schema structurally pairs `NO_EVIDENCE_YET` ⟺ `supportedBy: []` in both directions | `evidence-assessment.ts:77-93` |
| 8 | `investigationGuidance` already contains a dedicated paragraph naming this exact misclaim | `claude-message-mapping.ts:366-377` |
| 9 | Post-#85 measured residual: 3 of 4 live re-runs passed A3, 1 re-tripped (Scenario D attempt 1) | `docs/reviews/35` §8 |
| 10 | Visitor quota is reserved by PK insert inside the run-creation transaction, before provider construction | `agent-run-repository.ts` step 5 + header comment |
| 11 | `FakeLlmProvider` turns come from authored fixtures, so `continuationReason` cannot be model-produced | `fake-llm-provider.ts`; `docs/reviews/35` §8's own limitation note |
| 12 | `providerTurnsUsed` counts provider invocation **attempts**, recorded before delegating — a thrown or rejected call still consumes one | `recording-provider.ts:26-32`; `observed-facts.ts:247` |
| 13 | `bounds-respected` fails with `TURN_BOUND_EXCEEDED` when `providerTurnsUsed > maxProviderTurns` | `evaluation-evaluator.ts:714-726` |
| 14 | `AgentConversationMessage` is a 4-variant union, mapped by a non-exhaustive `switch` on `entry.role` — a new unmapped variant is silently dropped, not a compile error | `llm-provider.ts:62-66`; `claude-message-mapping.ts:19-20` |

---

## 2. Design

### 2.1 One bounded corrective re-prompt on a tripped A3 guard

When A3 trips on an investigation turn, instead of failing the run:

1. Do **not** emit `TOOL_REQUESTED` (unchanged — the request was never accepted).
2. Append a corrective message to the conversation naming the violated invariant in closed,
   non-provider-controlled terms, and issue another provider turn.
3. Allow this **at most once per run**. A second A3 trip fails the run exactly as today.
4. The corrective invocation **consumes a `MAX_PROVIDER_TURNS` slot**, like every other provider
   invocation. The run therefore has one fewer investigation turn after a retry, and the forced
   finalization turn is still preserved.

**The retry is not free, and an earlier draft of this plan was wrong to say it was.** That draft
proposed not charging the retry a turn slot, reasoning that a rejected turn "produced nothing."
Independent review raised this as a BLOCKER and source confirms it: `providerTurnsUsed` counts
provider **invocation attempts**, not accepted results — `recording-provider.ts` records the turn
*before* delegating, explicitly so that "a call that throws is still an attempt the orchestrator
made." A free retry would therefore allow 5 real paid invocations under a documented bound of 4,
failing the evaluator's own `bounds-respected` metric with `TURN_BOUND_EXCEEDED`
(`evaluation-evaluator.ts:725`) and raising maximum spend past every budget warning derived from
`MAX_PROVIDER_TURNS` — including README's daily output-token envelope, which multiplies by exactly
4. Charging the slot keeps the bound honest; the once-per-run limit in (3), not the turn budget, is
what prevents an unbounded loop.

Consequence worth stating plainly rather than burying: after a retry the run has 2 investigation
turns left instead of 3, so a run that needed all 3 diagnostic calls can no longer make them. That
is a real reduction in investigative depth, and it is the correct trade — an honest bound with less
headroom beats a silently exceeded one.

### 2.2 The corrective message must reach the provider, and the design must say how

A corrective entry is useless if the model never sees it. `AgentConversationMessage` is a 4-variant
union (`TicketContextEntry | DiagnosticToolRequestEntry | DiagnosticToolResultEntry |
RagContextMessage`, `llm-provider.ts:62-66`) and `buildClaudeMessages` maps it with a `switch` on
`entry.role` (`claude-message-mapping.ts:19-20`). Adding a 5th variant without adding its `case`
would **silently drop it** — the corrective text would never reach Claude, while `FakeLlmProvider`
returns its scripted corrected turn regardless, so every deterministic test in §3 could pass
against a mechanism that does nothing on the real path. Independent review raised this as a MAJOR
and it is confirmed: the mapper's switch is not exhaustiveness-checked against a `never` default.

Therefore the design must specify both halves:

1. A new provider-neutral `AgentConversationMessage` variant for the corrective entry, carrying
   only closed, application-authored text — no provider-controlled identifier, no echoed value, no
   part of the rejected assessment.
2. Its `buildClaudeMessages` serialization (a `user`-role text message), plus — to stop this class
   of bug recurring for the next variant — an exhaustiveness guard on that switch so a future
   unmapped variant is a compile error rather than a silent drop.

Because this is prompt-adjacent model-facing text, it falls under `docs/04-agent-design.md` §20.4:
a new logical prompt version, the lineage comment, the §20.4 entry, and
`docs/03-technical-design.md`'s `AGENT_PROMPT_VERSION` default all move together.

### 2.3 Which invariants this must not weaken

- The assessment that rides `TOOL_REQUESTED` is still only ever the **validated** one (§9.4).
- A3 still rejects the bad assessment; nothing ungrounded enters the ledger.
- The corrective message must not echo any provider-controlled identifier or value — same closed-
  message discipline the existing `failed(...)` calls already follow.
- `EvidenceAssessmentSchema` is unchanged. `ContinuationReasonSchema` is unchanged.
- `MAX_PROVIDER_TURNS` / `MAX_DIAGNOSTIC_TOOL_CALLS` are unchanged — and the retry stays inside
  `MAX_PROVIDER_TURNS` rather than beside it (§2.1).

### 2.4 Ledger visibility — needs a contract decision

A retry that leaves no trace would make the ledger claim a clean turn-0 where a rejected assessment
actually occurred, which is the kind of quiet approximation this repo's semantic-honesty bar
rejects. But adding a new event type touches `docs/16-investigation-event-contract.md`'s canonical
13-type vocabulary and every reducer/UI consumer keyed on it.

Recommendation: emit a new canonical event for the rejected-and-retried assessment, rather than
hiding it. It is a real thing that happened, it is exactly the signal needed to measure whether the
residual rate is improving, and a reader of a trace that shows one should be able to see it. This
needs verification against the event contract's read-compatibility rules before the plan is
implemented — **unresolved, flagged deliberately, not assumed.**

### 2.5 Deliberately out of scope

- The observability gap (12 trigger sites, one persisted code). Real, deserves its own issue, not a
  prerequisite here.
- Any change to the public trial's quota or admission path (see §0's rejection).
- Scenario E's confidence-calibration question and the two `REPORT_SCHEMA_INVALID` observations
  `docs/reviews/35` §8 filed separately.

---

## 3. Acceptance criteria

1. A deterministic test reproducing the exact state: RAG evidence present, zero tool executions,
   first diagnostic request, assessment claims `NO_EVIDENCE_YET`. It must **fail before** the change
   (proving it exercises the real path, not a tautology — see `references/plan-integrity.md`).
2. A deterministic test that a **second** A3 trip in the same run fails the run, with the same
   `PROVIDER_PROTOCOL_INVALID` code as today.
3. A deterministic test that a run whose retried turn returns a valid assessment proceeds to
   `TOOL_REQUESTED` and can reach `completed`.
4. **A turn-bound test.** Trip A3, correct it, then drive the maximum remaining diagnostic path plus
   forced finalization, and assert the run completes with `providerTurnsUsed <= MAX_PROVIDER_TURNS`.
   This is the criterion that would have caught the free-retry design error in §2.1, and it must
   count invocations the way `recording-provider.ts` does — attempts, not accepted results.
5. **A provider-mapping test using the real Claude mapper**, asserting the corrective text appears in
   the second request's messages and that no provider-controlled identifier or value is included.
   Criteria 1–3 can all pass against a corrective variant that `buildClaudeMessages` silently drops
   (§2.2), so without this one the deterministic suite proves nothing about the real path.
6. `pnpm agent:verify --final` passes, with any pre-existing failures independently re-derived
   against unmodified `main` in a worktree rather than relayed. Note that the harness's own
   `scripts/agent/*.test.ts` e2e suites are load-flaky locally (a *different* test times out per
   run) — CI's `Verify` job is the authority.
7. **At least one real LIVE run** observed reaching past the guard, run id recorded.
8. The report of (7) states the sample size and what it does **not** establish. One passing LIVE run
   does not prove the residual rate is gone — the baseline behavior is non-deterministic, and
   reporting a single clean run as resolution is precisely how #85 reached an accepted-residual state
   that later surfaced in public. If the retry is exercised in that run, say so; if the model simply
   got it right the first time, say that instead — **a run that never trips A3 does not test the
   retry at all**, and must not be reported as evidence that it works.

---

## 4. Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Don't charge the visitor quota for this failure | The `(visitor_id, usage_date)` PK *is* the gate, reserved pre-provider in the run-creation transaction; a refund reintroduces double-spend (§0) |
| Narrow A3 to ignore RAG-only evidence | `STATUS_UNRESOLVED` already covers this state; the schema pairs `NO_EVIDENCE_YET` ⟺ empty `supportedBy` in both directions, so the change would permit an ungrounded claim (§0) |
| Third prompt revision | Two revisions of targeted prose already exist; #85 measured the result at 3/4. Each attempt costs a billed run to evaluate against a non-deterministic baseline (§0) |
| Relax the schema's `NO_EVIDENCE_YET` invariant | `docs/reviews/35` §8 rejected it; re-verified against `evidence-assessment.ts` — the invariant is not what is broken |
| Unbounded retry until the model complies | Unbounded provider spend on a model that may never comply; (3)'s once-per-run bound is the whole safety property |
| A corrective retry that does not consume a provider-turn slot | Raised as a BLOCKER by independent review on this plan's first draft, and confirmed against source: `providerTurnsUsed` counts invocation *attempts* (`recording-provider.ts`), so 5 paid calls would run under a documented bound of 4, failing `bounds-respected` with `TURN_BOUND_EXCEEDED` and exceeding every spend figure derived from `MAX_PROVIDER_TURNS` (§2.1) |
