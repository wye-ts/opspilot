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
The quota is not a counter decremented after a run resolves; the `(visitor_id, usage_date)` primary
key *is* the gate, reserved inside the same transaction that inserts the run
(`agent-run-repository.ts` step 5) — explicitly *"before the provider is ever constructed by the
caller."* A refund therefore means deleting that row after a failure.

An earlier draft rejected this by claiming a deleted row would let two concurrent requests each
reserve the same key. **That claim was false and is withdrawn.** The reservation is
`INSERT … ON CONFLICT (visitor_id, usage_date) DO NOTHING … RETURNING`, which is atomic: exactly one
of two racing inserts returns a row, and the loser raises `LIVE_RUN_VISITOR_QUOTA_EXHAUSTED`. The
primary-key gate is not defeated by an absent row. Independent review caught this as a fabricated
architectural constraint, and recording the correction matters more than the conclusion — a false
reason would have foreclosed a viable mitigation for future work.

The real reasons to reject it here are policy and scope, not mechanism:

- **It does not fix the failed investigation.** The visitor still gets no report. A refund converts
  "one wasted run" into "two chances at a run that may fail the same way," which is a spend decision,
  not a correctness one.
- **It needs a failure-classification policy this issue does not have.** Refunding requires deciding
  *which* failure codes are refundable. `PROVIDER_PROTOCOL_INVALID` covers 12 distinct trigger sites
  (finding #5), and the ledger cannot currently distinguish them — so "refund only A3 misclaims" is
  not expressible against persisted state today.
- **It adds a delete path to a table that currently has none**, on the public spend gate, to soften a
  failure the selected option removes outright.

If the retry proves insufficient and the residual rate stays visible to visitors, revisit this —
with its real tradeoffs (cleanup timing, recovery after an ambiguous commit, repeated spend), not the
withdrawn concurrency argument.

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
5. **Retry eligibility: only when another INVESTIGATION slot would remain.** If the first A3 trip
   happens on the last investigation turn (`turnIndex === MAX_PROVIDER_TURNS - 2`), the run fails as
   today — no retry.

**Why (5) exists.** Phase is derived purely from position: `turnIndex === MAX_PROVIDER_TURNS - 1`
⇒ `FINALIZATION`, everything earlier ⇒ `INVESTIGATION` (`agent-orchestrator.ts:349-350`). On a
`FINALIZATION` turn the Claude adapter forces `tool_choice: { type: "tool", name:
submit_resolution_report }` (`claude-llm-provider.ts:395-397`), so that slot structurally cannot
carry a corrected diagnostic request. An A3 trip on turn 2 of 4 therefore has nowhere to retry *to*:
the only remaining slot is the forced finalization turn. An earlier draft promised "one corrective
turn whenever A3 trips during investigation" while also preserving the finalization slot — raised as
a MAJOR by independent review, and confirmed: those two guarantees are incompatible at
`turnIndex = 2`, and an implementation following that draft would have silently picked one.

Stated as the rule an implementer can follow without inferring: the retry is available on
investigation turns `0 .. MAX_PROVIDER_TURNS - 3` (turns 0 and 1 at current constants). A late A3
trip is a genuinely unrecoverable run, and failing it is honest — the run had already spent its
investigation budget.

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

### 2.4 Ledger visibility — decided: no new event type

An earlier draft left this as a recommendation to emit a new canonical event, flagged "unresolved."
Independent review raised that as a MAJOR: the plan recommended a contract change without naming the
event, its payload, its permitted transition, its reducer behavior, or its consumers — and an
implementer following it would produce either a rejected write or an unreadable stream. Leaving a
contract decision open is not the same as scoping it out. Verified against source and now decided.

**Decision: do not add an event type. Emit nothing for the rejected assessment in this issue.**

The cost of the alternative is concrete, not speculative. The write contract is a strict discriminated
union of 12 payload branches (`investigation-event.ts`), and
`investigation-stage-progress-reducer.ts` dispatches on each type explicitly across ~470 lines, with
`investigation-lifecycle-compatibility.ts` and the web timeline's label vocabulary keyed on the same
set. A 13th type means: a new schema branch, a reducer case with a defined stage transition, a
compatibility-layer decision, a label in `trace-product-labels.ts`, and read-compatibility for every
already-persisted stream. That is a larger change than the retry itself, and it would bury a narrow
recoverability fix inside an event-contract migration.

**What makes the omission honest rather than a silent approximation.** Nothing is misrepresented:
the rejected request was never accepted, `TOOL_REQUESTED` is correctly absent, and the ledger's
claim — "no diagnostic request was accepted on this turn" — is true. The run's
`providerCallsObserved` still counts the extra invocation, so the spend is visible and reconcilable
even though the reason is not. This is the same standing limitation as the other 11 A3-adjacent
protocol failures, which also leave no per-guard record (finding #5).

**What this costs, stated rather than hidden:** there is no per-guard marker in the ledger, so *why*
a retry happened is not recoverable from persisted data — only *that* an extra provider invocation
occurred. Retry frequency across many runs therefore stays unmeasurable from the trace alone. That
is a real gap and it belongs to the same observability issue as finding #5 — the right place to add a
per-guard record is that issue, once, for all 12 trigger sites, rather than here for one.

**What remains recoverable, and why it is enough for acceptance.** A completed run persists both
`providerCallsObserved` (every invocation attempt) and its accepted `TOOL_REQUESTED` events. For an
ordinary run these are related by a fixed arithmetic: every investigation turn either produces an
accepted `TOOL_REQUESTED` or is the voluntary-report turn, plus the finalization turn. A retried run
has exactly one invocation that produced neither — so `providerCallsObserved` exceeds the count the
accepted events account for, by exactly one. That inequality is a run-correlated fact derived from
the run's own persisted row and its own ledger, not a log line that has to be attributed across
concurrent runs. §3's criterion 9 uses it.

If a future session concludes the retry needs ledger visibility, it should be a deliberate
event-contract change with its own plan, not an addendum to this one.

### 2.5 Deliberately out of scope

- The observability gap (12 trigger sites, one persisted code). Real, deserves its own issue, not a
  prerequisite here.
- Any change to the public trial's quota or admission path (see §0's rejection).
- Scenario E's confidence-calibration question and the two `REPORT_SCHEMA_INVALID` observations
  `docs/reviews/35` §8 filed separately.

---

## 3. Acceptance criteria

1. A deterministic test reproducing the exact state: RAG evidence present, zero tool executions,
   first diagnostic request, assessment claims `NO_EVIDENCE_YET`. It must **fail before** the change,
   proving it exercises the real path rather than passing against unmodified code — a new guard test
   that already passes has not validated anything, it has revealed the check is unreachable (the
   defect Issue #89 hit).
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
6. **A late-trip test.** First A3 violation on `turnIndex === MAX_PROVIDER_TURNS - 2` (the last
   investigation turn) fails the run with `PROVIDER_PROTOCOL_INVALID`, no retry attempted, forced
   finalization slot not consumed by a diagnostic request (§2.1 rule 5).
7. **A ledger test** that a retried run's persisted event stream contains no event for the rejected
   assessment and still validates against the existing write contract — i.e. §2.4's decision holds in
   practice and no unknown event type reaches persistence.
8. `pnpm agent:verify --final` passes, with any pre-existing failures independently re-derived
   against unmodified `main` in a worktree rather than relayed. Note that the harness's own
   `scripts/agent/*.test.ts` e2e suites are load-flaky locally (a *different* test times out per
   run) — CI's `Verify` job is the authority.
9. **A retry-detectability test**, proving a completed retried run is distinguishable from an ordinary
   multi-tool run using only the run's own persisted facts: `providerCallsObserved` exceeds what its
   accepted `TOOL_REQUESTED` events plus the finalization turn account for, by exactly one. This is
   what criterion 11 relies on, so it must be proven deterministically before the LIVE run — an
   earlier draft instead pointed at the server log's `provider_turn` lines, which independent review
   correctly rejected: those lines carry no `runId` and no `turnIndex`, and an A3-rejected response
   logs the *identical* `normalizedResultType: "diagnostic_tool_request"` as an accepted one, so they
   cannot establish the retry fired — especially under concurrent runs.
10. **The §20.4 prompt-version regression.** The corrective message is model-facing text, so
    `docs/04-agent-design.md` §20.4 applies in full: a new logical prompt version, the lineage
    comment, the §20.4 entry, `docs/03-technical-design.md`'s `AGENT_PROMPT_VERSION` default, **and**
    a recorded before/after agent-eval comparison run from an isolated worktree at the pre-change
    baseline. The recorded entry must state the limitation rather than let identical counts imply more
    than they prove: the eval drives `FakeLlmProvider` from typed fixtures, so prompt text cannot
    influence those results at all — identical BEFORE/AFTER counts prove no break in the existing
    evaluation contract, not that real model behavior changed.
11. **At least one real LIVE run** observed reaching past the guard, run id recorded.
12. The report of (11) states the sample size and what it does **not** establish. One passing LIVE run
    does not prove the residual rate is gone — the baseline behavior is non-deterministic, and
    reporting a single clean run as resolution is precisely how #85 reached an accepted-residual state
    that later surfaced in public. Use criterion 9's arithmetic to say which of two things the run
    shows: the retry fired and recovered, or the model simply got it right the first time. **A run
    that never trips A3 does not test the retry at all** and must not be reported as evidence that it
    works.

---

## 4. Rejected alternatives

| Alternative | Why rejected |
| --- | --- |
| Don't charge the visitor quota for this failure | Rejected on policy/scope, not mechanism: it does not fix the failed investigation, it needs a refundable-vs-not failure classification the ledger cannot express today (12 trigger sites, one code), and it adds a delete path to the public spend gate. An earlier draft rejected it with a *false* concurrency claim, now withdrawn — `INSERT … ON CONFLICT DO NOTHING … RETURNING` is atomic and an absent row does not permit two winners (§0) |
| Narrow A3 to ignore RAG-only evidence | `STATUS_UNRESOLVED` already covers this state; the schema pairs `NO_EVIDENCE_YET` ⟺ empty `supportedBy` in both directions, so the change would permit an ungrounded claim (§0) |
| Third prompt revision | Two revisions of targeted prose already exist; #85 measured the result at 3/4. Each attempt costs a billed run to evaluate against a non-deterministic baseline (§0) |
| Relax the schema's `NO_EVIDENCE_YET` invariant | `docs/reviews/35` §8 rejected it; re-verified against `evidence-assessment.ts` — the invariant is not what is broken |
| Unbounded retry until the model complies | Unbounded provider spend on a model that may never comply; (3)'s once-per-run bound is the whole safety property |
| A corrective retry that does not consume a provider-turn slot | Raised as a BLOCKER by independent review on this plan's first draft, and confirmed against source: `providerTurnsUsed` counts invocation *attempts* (`recording-provider.ts`), so 5 paid calls would run under a documented bound of 4, failing `bounds-respected` with `TURN_BOUND_EXCEEDED` and exceeding every spend figure derived from `MAX_PROVIDER_TURNS` (§2.1) |
| Retry on any investigation turn, including the last one | Incompatible with preserving the forced-finalization slot: phase is positional, and a `FINALIZATION` turn forces `tool_choice` to `submit_resolution_report`, so it cannot carry a corrected diagnostic request. Raised as a MAJOR on draft 2; retry is now bounded to turns `0 .. MAX_PROVIDER_TURNS - 3` (§2.1 rule 5) |
| A new canonical event for the rejected-and-retried assessment | Recommended by draft 2 and reversed in draft 3. A 13th write type requires a schema branch, a reducer case with a defined stage transition, a compatibility-layer decision, a UI label, and read-compatibility for every persisted stream — a larger change than the fix, and it would bury a narrow recoverability fix in an event-contract migration. The omission is honest (nothing is misrepresented) but does cost retry-frequency measurability; that belongs to the observability issue covering all 12 trigger sites (§2.4) |
