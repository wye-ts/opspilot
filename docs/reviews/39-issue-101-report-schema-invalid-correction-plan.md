# Issue #101 — `REPORT_SCHEMA_INVALID` kills every LIVE run with no correction path

| Field | Value |
| --- | --- |
| Scope | #101 — a schema-rejected resolution report fails the whole run. Narrow reading: change the *reaction* to a rejected report, not `ResolutionReportSchema`, not its F1/F2/F5 invariants, not the prompt. |
| Basis | Four real LIVE runs, 2026-09-14, `claude-sonnet-5`, local build (`main` @ `19af7fd` + the unmerged #99 branch), plus `docs/evidence/06d-live-report-schema-invalid-issue-80.md` and `docs/reviews/35-issue-85-…` §8 |
| Status | Plan only — no implementation |
| Branch | `fix/101-report-schema-invalid-correction` (not yet created) |
| Committed location | `docs/reviews/39-issue-101-report-schema-invalid-correction-plan.md` |
| Depends on | #99's `CorrectiveGuidanceEntry` mechanism (unmerged). See §6. |

---

## 0. Scope corrections — verified against source this session

**Correction 1 — this is not a regression from the two-tool catalog, and rolling it back does not fix it.**
The owner's first instinct was to roll back `get_recent_deployments` (9461123, 2026-09-12). Source
refutes this: issue #80 recorded the **identical F5 failure** on a real LIVE run (`31a49a83-…`,
2026-09-07) with the single-tool catalog, five days earlier, and the F5 rule itself dates to
`c1a694b` (2026-08-15) — `git merge-base --is-ancestor c1a694b 9461123` confirms it predates the
second tool by a month. A rollback returns to #80's state, which is this state.

**Correction 2 — #80 is closed, but the behaviour it recorded was never fixed.**
Commit 9cdc97e shipped a *diagnostic* fix: the persisted log previously collapsed every
`custom`-coded Zod issue to `{path, code}`, making the failing invariant unrecoverable. That is why
the messages in §1 are legible at all. No model-facing or orchestrator behaviour changed. Reading
#80 as "already fixed" would wrongly narrow this issue to "a recurrence".

**Correction 3 — the failing invariant is not one rule, it is two.**
The issue title and #80 both centre on F5 (`groundedBy ⊆ report.evidence`). Two of the four runs
observed this session failed F1/F2 instead (`ACTIONABLE requires at least one suggested action`).
A fix scoped to F5 alone would leave half the observed failures untouched. The design below is
keyed on *report rejection*, not on any single invariant.

**Correction 4 — A3 (#99's subject) never fired in any of the four runs.**
#99's corrective retry is a real mechanism but, on current evidence, a fuse that has not been
observed to blow. This issue is where that mechanism actually earns its cost. Stated here so a
future reader does not conclude #99 was wasted work — the opposite: §2 reuses it wholesale.

---

## 1. Current-state findings

| # | Finding | Source (verified this session) |
| --- | --- | --- |
| 1 | A schema-rejected report returns `failed(...)` directly out of the turn loop — no retry, no continuation | `agent-orchestrator.ts:472-481` |
| 2 | `REPORT_SUBMITTED` is emitted *before* validation, so the ledger already distinguishes "submitted then rejected" from "never submitted" | `agent-orchestrator.ts:460` |
| 3 | 4 of 4 real LIVE runs on 2026-09-14 failed `REPORT_SCHEMA_INVALID`; A3 tripped in none of them | runs `ddd6ced6`, `adf6ed24`, `402efbfb`, `b5fb71ae` |
| 4 | Two distinct invariants produced those four failures: F5 `groundedBy ⊆ evidence` (×2) and F1/F2 `ACTIONABLE requires ≥1 action` (×2) | `report_schema_invalid` log lines; `resolution-report.ts:312-325`, `:394-400` |
| 5 | 3 of 4 runs submitted the report **voluntarily on an investigation turn** (`providerCallsObserved=3`, one slot still unused); 1 submitted on the forced finalization turn (`providerCallsObserved=4`, nothing left) | `agent_runs.provider_calls_observed` + `MAX_PROVIDER_TURNS=4` |
| 6 | `submit_resolution_report` is offered on every turn, not only FINALIZATION — which is why (5) is possible at all | `agent-orchestrator.ts:407-415` comment (issue #61); `claude-llm-provider.ts:395-397` |
| 7 | The prompt already states the F5 rule imperatively, including the remedy ("if … not already an entry in evidence, add it there") | `claude-message-mapping.ts:241-249` |
| 8 | `CorrectiveGuidanceEntry` carries only `{role, text}` — nothing A3-specific in the type, the mapper case, or the exhaustiveness guard | `llm-provider.ts:62-74`; `claude-message-mapping.ts:109-121` (#99 branch) |
| 9 | `summarizeReportValidationIssues` already derives a structured, non-echoing summary of *which* invariants failed, persisted on the run. Its doc comment records that every `custom` issue on this schema is a fixed hand-written literal with no interpolated report data — which is exactly the property §2.2 depends on | `resolution-report-validation.ts:48-63`; used at `agent-orchestrator.ts:479` |
| 10 | `providerTurnsUsed` counts invocation **attempts**, recorded before delegating | `recording-provider.ts:26-32` |
| 11 | A FINALIZATION turn forces `tool_choice: {type:"tool", name: submit_resolution_report}` | `claude-llm-provider.ts:395-397` |

---

## 2. Design

### 2.1 Generalize #99's corrective re-prompt to report rejection

The defect is not detection. `ResolutionReportSchema` is correct: an action grounded in evidence the
report does not list is exactly the unreconstructable claim P2-3 forbids, and an `ACTIONABLE`
disposition with zero actions is self-contradictory. Accepting either would let an ungrounded
report into the ledger.

The defect is the **reaction** — identical in shape to #99's A3 finding. A recoverable formatting
error gets the most severe response the system has, discarding completed retrieval and completed
tool executions.

When `ResolutionReportSchema.safeParse` fails, instead of failing the run:

1. Emit `REPORT_VALIDATION_FAILED` exactly as today (unchanged — the report was genuinely rejected).
2. Append a `CorrectiveGuidanceEntry` naming the violated invariant(s) in closed, application-authored
   terms, and issue another provider turn.
3. Allow this **at most once per run**, tracked by its own flag. A second rejection fails the run
   exactly as today.
4. The corrective invocation **consumes a `MAX_PROVIDER_TURNS` slot**, like every other provider
   invocation (finding #10).
5. **Retry eligibility: only when a later turn remains** — i.e. `turnIndex < MAX_PROVIDER_TURNS - 1`.

**Why (5) is the binding constraint here, and why it is different from #99's.** #99's rule 5
reserved the *finalization* slot, so its retry window was turns `0 .. MAX_PROVIDER_TURNS - 3`. That
reasoning does not transfer: a rejected report does not need an investigation slot to retry into,
it needs a slot that can carry *another report submission* — and the forced FINALIZATION turn is
precisely such a slot (finding #11). So the window here is wider: any turn except the last.

Finding #5 is what makes this worth doing: 3 of the 4 observed runs submitted voluntarily on turn 2
of 4, leaving turn 3 free. Those three are retryable. The fourth submitted on the forced
finalization turn and is **not** — it fails exactly as today.

**Stated plainly rather than buried: this fixes at most 3 of the 4 observed failures, and the
success of even those depends on the model complying with the corrective message on its second
attempt — which this plan does not and cannot prove in advance.** See §4.

### 2.2 The corrective text must name the invariant without echoing model output

`summarizeReportValidationIssues` (finding #9) already computes a structured summary of which
invariants failed, and is already deemed safe to persist. The corrective message must be derived
from **that summary's invariant identity**, not from the raw report:

- Never include any value the model wrote (an invented `evidenceId`, a payload field, a rootCause).
- Never include a provider-controlled identifier.
- Map each violated invariant to a fixed, application-authored remedy sentence chosen from a closed
  set — the same closed-message discipline `A3_CORRECTIVE_GUIDANCE_TEXT` follows.

Concretely, the two invariants observed this session need two authored sentences: one restating
that every `groundedBy` locator must also appear as an `evidence` entry (and that adding the entry
is the remedy), and one restating the disposition↔cardinality pairing. Any invariant with no
authored sentence falls back to a generic "the submitted report failed schema validation; resubmit
a corrected report" — the retry is still attempted, but the message claims nothing specific.

**Why a closed set rather than forwarding Zod's own messages:** not safety — finding #9 records that
every `custom` issue on this schema is already a fixed hand-written literal with no interpolated
report data, so forwarding them would not leak model output. The reason is **prompt governance**:
those literals live in `resolution-report.ts` as validation-engine output, and routing them to the
provider would make every future schema-message edit a silent change to model-facing text with no
§20.4 version bump and no eval comparison. The closed set keeps prompt text where §20.4 can see it.

Because this is model-facing text, `docs/04-agent-design.md` §20.4 applies in full: a new logical
prompt version, the lineage comment, the §20.4 entry, and `docs/03-technical-design.md`'s
`AGENT_PROMPT_VERSION` default move together.

### 2.3 No new conversation variant, and the rejected attempt is NOT written to the ledger

`CorrectiveGuidanceEntry` (finding #8) is already provider-neutral and carries only closed text.
Reusing it needs no schema change, no new mapper case, and the exhaustiveness guard #99 added keeps
protecting the switch. **Adding a second, report-specific variant would be the wrong instinct** —
the variant's meaning is "application-authored corrective guidance", which is exactly what this is.

**RETRACTED — this section previously claimed the opposite, and the claim was false.** An earlier
draft asserted that this issue was in a *better* position than #99 §2.4 because `REPORT_SUBMITTED`
and `REPORT_VALIDATION_FAILED` are emitted per attempt, so a retried run would persist two of each
and make the retry directly visible. Independent review raised this as a BLOCKER against the
implementation built on it, and source confirms the claim was wrong in the most consequential
direction: the canonical lifecycle treats report events as **singletons**, and a retried stream is
rejected outright. Independently reproduced against the real reducer:

```
input:  REPORT_SUBMITTED → REPORT_VALIDATION_FAILED → REPORT_SUBMITTED → REPORT_VALIDATED
result: InvestigationEventContractError: Event at sequence 5 ("REPORT_SUBMITTED") follows a
        stage failure; only RUN_FAILED may follow a failure fact.
```

Three separate rules reject it (`investigation-stage-progress-reducer.ts`): a second
`REPORT_SUBMITTED` is a `DUPLICATE_LIFECYCLE_FACT`, a second report outcome is a
`DUPLICATE_LIFECYCLE_FACT`, and `REPORT_GENERATION_STARTED` after a submission is rejected —
so an investigation→finalization retry fails too. `investigation-event-ledger.ts` independently
treats the 9 lifecycle/report types as `(runId, eventType)` singletons for replay identity.

The consequence was worse than the bug being fixed: instead of failing, a retried run returned
persistence-unavailable and left the run `RUNNING`. The deterministic orchestrator tests did not
catch it because they use a collecting emitter that never runs the reducer — the exact failure
shape #99's own review warned about, recurring here.

**Decision: the corrected-away attempt is not written to the ledger. Only the report attempt that
determines the run's outcome is recorded.**

This is the *consistent* choice, not a concession — which is the second thing the earlier draft got
backwards. #99 emits nothing for a rejected diagnostic request: `TOOL_REQUESTED` records only
accepted requests. The ledger's existing semantics are "the accepted trajectory of a run", not
"everything that happened during it". Adding attempt tracking for reports while diagnostic requests
have none would invent an asymmetry, not repair one.

**What this narrows, stated rather than buried.** `REPORT_SUBMITTED` is currently emitted *before*
validation, deliberately, so the ledger can distinguish "submitted then rejected" from "never
submitted". That distinction still holds for every run whose outcome is decided by a rejection. It
no longer holds for an attempt that was corrected away: such an attempt leaves no ledger trace at
all. That is a real reduction in what the stream records and must be stated in the code comment and
in `docs/04-agent-design.md`, so a later reader does not assume the ledger enumerates every attempt.

**What remains recoverable.** `providerCallsObserved` still counts every invocation attempt, so a
retried run is distinguishable from an ordinary one by #99 criterion 9's arithmetic — the same
signal that issue already relies on, and the one the real-model observation in §4 uses. Retry
frequency across runs stays unmeasurable from the trace alone.

**The right fix is a separate issue.** Whether the ledger should record attempts rather than only
outcomes is now a question this project has hit twice (#99 §2.4, here). It deserves its own issue
with its own evidence, covering diagnostic requests and reports together — not a contract migration
smuggled into a public-path bug fix under time pressure.

### 2.4 Which invariants this must not weaken

- `ResolutionReportSchema` is unchanged. F1/F2/F5 are unchanged.
- A rejected report is still rejected; nothing ungrounded enters the ledger.
- `REPORT_SUBMITTED` / `REPORT_VALIDATION_FAILED` still bracket every attempt, including the first.
- The corrective message echoes nothing the model produced.
- `MAX_PROVIDER_TURNS` is unchanged, and the retry stays inside it.
- `REPORT_EVIDENCE_INVALID` (`agent-orchestrator.ts:483-497`) is **out of scope** — a separate
  check with a separate code, not observed failing in any of the four runs. Named here so a
  reviewer can see the omission is deliberate.

---

## 3. Compatibility

No persisted shape changes. A pre-change run's event stream (one `REPORT_SUBMITTED`, optionally one
`REPORT_VALIDATION_FAILED`) remains valid and readable — the retried shape is two of each, which the
existing contract already permits since neither event is declared once-per-run. No migration.

---

## 4. Verification plan — and what it cannot prove

| # | Case | Expected |
| --- | --- | --- |
| 1 | Report rejected on an investigation turn, corrected on retry | run reaches `completed`; exactly ONE `REPORT_SUBMITTED` persisted (§2.3) |
| 2 | Report rejected twice | `REPORT_SCHEMA_INVALID`, same code as today |
| 3 | Report rejected on the forced FINALIZATION turn | fails as today, no retry attempted |
| 4 | Retry + full remaining path | `providerTurnsUsed <= MAX_PROVIDER_TURNS` |
| 5 | Corrective text reaches Claude via the **real** mapper | text present in the second request's messages |
| 6 | Corrective text for each authored invariant | no model-written value, no provider identifier present |
| 7 | An invariant with no authored sentence | generic message used; retry still attempted |

Case 1 must **fail before the change** — a new test that already passes has revealed an unreachable
check, not validated one (the defect #89 hit).

**What deterministic tests cannot prove.** `FakeLlmProvider` returns authored fixtures, so a test
proving "the corrected turn is accepted" proves the *orchestrator* handles a corrected report — not
that a real model produces one when told. #85 established the shape of that limit: a prompt-adjacent
nudge measurably reduces but does not eliminate a non-deterministic model error.

**Bounded real-model observation (not a new routine paid category).** After merge, run the #99
ticket wording repeatedly against the deployed path until either (a) a run is observed reaching
`completed` whose `providerCallsObserved` exceeds what its accepted events plus the finalization
turn account for, by exactly one — #99 criterion 9's arithmetic, the retry fired and recovered — or
(b) 15 runs accumulate without one. (An earlier draft said to look for two persisted
`REPORT_SUBMITTED` events; per §2.3's retraction that stream cannot be written, so the arithmetic
is the signal.) Cost at the corrected rate (~$0.13/run, §pricing fix this session) is ≈$2 at the
15-run ceiling. Report the observed rate with its sample size; do not report a single clean run as
resolution.

---

## 5. Out of scope (explicit)

- Any change to `ResolutionReportSchema` or its invariants.
- `REPORT_EVIDENCE_INVALID` (§2.4).
- A further prompt revision of `investigationGuidance` (finding #7 — the rule is already stated
  imperatively with its remedy).
- The `PROVIDER_PROTOCOL_INVALID` observability gap (#99 §2.4).
- **Whether the canonical ledger should record report/diagnostic ATTEMPTS rather than only accepted
  outcomes** (§2.3). Hit twice now — #99 §2.4 and this issue's retracted claim — and deserves its
  own issue covering both event families together, with the schema/reducer/compatibility/UI work
  that implies. Deliberately not smuggled into a public-path bug fix.
- Model selection / cost (`claude-model.ts` pins one model by construction).

---

## 6. Sequencing

This plan **depends on #99's `CorrectiveGuidanceEntry`**, which is unmerged. Two orderings are
possible and the owner should pick one before implementation starts:

- **(a) Land #99 first**, then build this on top. Keeps each diff reviewable and keeps the
  mechanism's introduction attributable to the issue that designed it. Cost: #101 waits.
- **(b) Build both on one branch.** Faster to a deployable fix, but merges a mechanism whose own
  acceptance criteria (11/12) are still unmet with a second consumer, and produces one large diff.

Recommendation: **(a)**. #99's criteria 1-10 are implemented and verified; its 11/12 are the ones
this session showed may be unobservable in practice, and that is a documentation decision (rewriting
criterion 11), not implementation work. It can land quickly.

Then, test-first per repo convention:
1. Failing test for case 1.
2. Retry flag + eligibility rule in the orchestrator.
3. Invariant→sentence map + its closed-set test (cases 6, 7).
4. Real-mapper test (case 5).
5. Bound and late-rejection tests (cases 3, 4).
6. §20.4 prompt-version bump + `AGENT_PROMPT_VERSION` default.
7. `agent:verify --final`, review-bundle, codex-review.

---

## 7. Acceptance criteria

1. A deterministic test reproducing a schema-rejected report on an investigation turn that **fails
   before** the change.
2. A second rejection in the same run fails the run with `REPORT_SCHEMA_INVALID`.
3. A corrected retry reaches `completed` and persists **two** `REPORT_SUBMITTED` events.
4. A rejection on `turnIndex === MAX_PROVIDER_TURNS - 1` fails as today, with no retry attempted.
5. A turn-bound test asserting `providerTurnsUsed <= MAX_PROVIDER_TURNS` after a retry, counting
   attempts the way `recording-provider.ts` does.
6. A real-mapper test asserting the corrective text appears in the second request and contains no
   model-written value and no provider identifier.
7. An invariant with no authored sentence still triggers a retry, with the generic message.
8. **REVISED (§2.3 retraction).** A retried run is distinguishable from an ordinary one using only
   its own persisted facts, by #99 criterion 9's arithmetic: `providerCallsObserved` exceeds what
   its accepted events plus the finalization turn account for, by exactly one. The earlier version
   of this criterion required **two** persisted `REPORT_SUBMITTED` events; that is now forbidden,
   not merely unavailable — the canonical lifecycle rejects the stream outright, so a run must
   persist exactly one report attempt. A test asserting two would be asserting a stream that cannot
   be written.
9. §20.4 prompt-version regression complete, with the recorded before/after eval comparison stating
   its own limitation (fixtures cannot be influenced by prompt text).
10. `pnpm agent:verify --final` passes, with any pre-existing failures independently re-derived
    against unmodified `main` in a worktree rather than relayed.
11. Real-model observation per §4 recorded with its sample size, stating explicitly whether the
    retry was observed to fire and recover, or whether the ceiling was reached without one.
12. No readout, comment, or doc line added by this issue claims the failure is eliminated. The
    honest claim is bounded: a report rejected on a non-final turn gets one correction attempt.
