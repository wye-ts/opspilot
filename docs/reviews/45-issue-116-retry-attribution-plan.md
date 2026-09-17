# Issue #116 — Record whether a corrective retry preceded the deciding report submission

| | |
| --- | --- |
| Scope | #116 "A corrective retry that runs and fails to recover leaves no trace in persisted data" — attribution only, no behavior change |
| Basis | `main` @ `f379caf49acfbf3b474aa2e4643b2f4c2ffa6a06` (#115, the F5 auto-completion fix), working tree clean |
| Status | Plan only. No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/116-retry-attribution` (created, empty) |
| Committed location | `docs/reviews/45-issue-116-retry-attribution-plan.md` |

---

## 0. Scope corrections — verified against source

**0.1 The issue says "record whether a corrective retry ran". Two corrective paths exist, not
one.** `agent-orchestrator.ts:665-673` tracks `a3RetryUsed` and `reportRetryUsed` as deliberately
separate flags, and the comment there states why: a shared flag "would let an early A3 trip
silently consume the report path's only correction (or vice versa)". They can both fire in one
run. **Decision:** the recorded value must distinguish them and must express the both-fired case,
so a boolean is refused (see §Scope decision).

**0.2 The issue's phrase "the retry ran and did not help" cannot be recorded as such.** A
corrected-away attempt emits nothing, by ledger contract — `TOOL_REQUESTED` likewise omits rejected
diagnostic requests, and the reducer rejects a second `REPORT_SUBMITTED` or a second report outcome
as `DUPLICATE_LIFECYCLE_FACT`. **Decision:** record a *property of the single recorded submission*
("a correction preceded this"), never the attempt itself. Outcome is already carried by whether
`REPORT_VALIDATED` or `REPORT_VALIDATION_FAILED` follows, so "did not help" is derivable by joining
the two — no new event, no reducer change.

**0.3 The A3 retry is not report-scoped, but it is still in scope.** It fires on a diagnostic turn
(`:1121`), long before any report exists. It is recorded here because it consumed a turn from the
same `MAX_PROVIDER_TURNS` ceiling and therefore changes what the report path had available — which
is exactly the confound that made the 2026-09-16 sample unreadable. Recording only the report
retry would leave that confound in place.

---

## Scope decision

The issue's text admits three implementations:

1. **A boolean `correctedBeforeSubmission`.** Rejected: cannot distinguish which of the two
   corrective paths fired, and cannot express both. That ambiguity is the thing this issue exists
   to remove — shipping a boolean would close the issue while leaving the question unanswerable.
2. **A closed enum naming the correction history.** **Chosen.** Matches the repo's closed-vocabulary
   stance (`ReportValidationFailureCodeSchema`, `ReportInvariantSchema`) and expresses all four
   reachable states.
3. **Two independent booleans.** Rejected: representationally equivalent to (2) but allows no
   single queryable member, and doubles the write-path fixture churn for no gain.

**Decision (Mira, recorded for owner review): option 2.**

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Report retry | `agent-orchestrator.ts:899` `canRetryReport` | `!reportRetryUsed && turnIndex < MAX_PROVIDER_TURNS - 1`; once per run |
| A3 retry | `agent-orchestrator.ts:1121` `canRetry` | `!a3RetryUsed && turnIndex <= MAX_PROVIDER_TURNS - 3`; once per run |
| Flags | `agent-orchestrator.ts:665-673` | Two separate `let` flags, deliberately not shared |
| Deciding emit (accepted) | `agent-orchestrator.ts:967` | `emit({ type: "REPORT_SUBMITTED" })` then evidence check, then `REPORT_VALIDATED` |
| Deciding emit (rejected) | `agent-orchestrator.ts:948` | `emit({ type: "REPORT_SUBMITTED" })` then `REPORT_VALIDATION_FAILED` |
| Deciding emit (auto-completed) | `agent-orchestrator.ts:871` | #114's F5 auto-completion path: `REPORT_SUBMITTED` then `REPORT_VALIDATED`, returning a completed run |
| Payload schema | `investigation-event.ts:90` | `ReportSubmittedEventSchema` — `{ type }` only, `.strict()`, `.readonly()` |
| Reducer handling | `investigation-stage-progress-reducer.ts:388-391` | Maps `REPORT_SUBMITTED` to `REPORT_GENERATION`; branches on `type` alone |
| Field-addition precedent | `investigation-event.ts:169-190` | #105's `violatedInvariants`: required on write, optional on read, shared `superRefine` |

**Verified:** `REPORT_SUBMITTED` is emitted exactly once per run, on each of the **three** deciding
paths above, and never for a corrected-away attempt (`:901-917` states this explicitly). It is
therefore the only event that can carry this fact on every outcome with no ledger-semantics change.

**0.4 (added after round 1 review) — there are three deciding emit sites, not two.** The first
draft of this plan inventoried only `:948` and `:967` and told the implementer to "call it at both
deciding emits". That was wrong: #114's F5 auto-completion path emits its own `REPORT_SUBMITTED` at
`:871` and returns a completed run. Since `correctionHistory` is required on write, following the
two-site instruction would not have typechecked — and the likely repair under time pressure
(defaulting the third site to `"NONE"`) would persist *wrong* attribution for exactly the runs the
issue cares about, because auto-completion is reachable after a corrective retry. This is not
hypothetical: auto-completion decided 4 of the 10 runs in the 2026-09-16 sample. All three sites
derive the value from the same two flags.

## 2. Design

### 2.1 The vocabulary (`packages/contracts/src/investigation-event.ts`)

```
ReportCorrectionHistorySchema = z.enum([
  "NONE",                  // neither retry fired
  "REPORT_RETRY",          // reportRetryUsed only
  "DIAGNOSTIC_RETRY",      // a3RetryUsed only
  "BOTH",                  // both fired this run
])
```

All four members are write-path reachable: the two flags are independent booleans set on
independent turns, and neither excludes the other. `NONE` is a member, never an absent field —
absence means "persisted before this change", and conflating the two would make the first honest
aggregate query wrong.

Naming note: `DIAGNOSTIC_RETRY`, not `A3_RETRY`. `a3RetryUsed` is an internal reference to the
guard's plan-era label; the persisted vocabulary must describe what happened, not cite a plan
section.

### 2.2 Write schema

`ReportSubmittedEventSchema` gains `correctionHistory: ReportCorrectionHistorySchema` as a
**required** field. The object stays `.strict()` and `.readonly()`.

### 2.3 Read schema

A `ReportSubmittedRecordEventSchema` variant where `correctionHistory` is **optional**, following
`investigation-event.ts:181-190` exactly: derived from the write schema so the member list stays
single-sourced, with only the required/optional distinction differing. The read union must
reference the record variant — omitting that wiring is silent until an old row is parsed.

No `superRefine` is needed. Unlike #105's `violatedInvariants`, this field draws from one
vocabulary and pairs with no other field on the event, so there is no cross-field contradiction to
reject. Stating this explicitly because the precedent has one and a reviewer will look for it.

### 2.4 Orchestrator

A single helper derives the member from the two flags at each deciding emit:

```
correctionHistory(reportRetryUsed, a3RetryUsed): ReportCorrectionHistory
```

Called at **all three** deciding emits (`:871`, `:948`, `:967`). Nothing else changes — no new
retry, no changed eligibility, no changed guidance text.

The auto-completion site at `:871` is easy to overlook (round 1 review caught this plan doing
exactly that) and is the one where a careless `"NONE"` default would be actively wrong: a run can
be corrected by a retry and *then* auto-completed, and that run must report the retry.

### 2.5 What this deliberately does not add

No reducer case, no stage-transition change, no migration. The event payload is persisted as JSON
(`agent_trace_events.payload`), so a new optional-on-read field needs no DDL. **This must be
confirmed in source during implementation** — if any column or CHECK constraint enumerates payload
keys, this claim is wrong and the plan must be retracted rather than worked around.

## 3. Compatibility

Every `REPORT_SUBMITTED` row persisted before this change lacks the field. The read variant makes
it optional, so those rows parse; the reducer branches on `type` only, so they reduce identically.
This is the same shape #105 used for `violatedInvariants` and #58 for `assessment` — not a new
mechanism.

Queries written against the new field must treat `NULL` as "unknown, pre-#116", never as `NONE`.
This is a documentation obligation on the field's own comment, since SQL cannot enforce it.

## 4. Verification plan — and its limits

| # | Case | Expect |
| --- | --- | --- |
| 1 | Report accepted first attempt | `correctionHistory: "NONE"` persisted, field present |
| 2 | Report accepted after report retry | `"REPORT_RETRY"` |
| 3 | Report terminally rejected after report retry | `"REPORT_RETRY"` — same member, both outcomes |
| 4 | A3 retry fires, then report accepted first attempt | `"DIAGNOSTIC_RETRY"` |
| 5 | A3 retry fires, then report retry fires | `"BOTH"` |
| 5a | F5 auto-completion decides the run, first attempt | `"NONE"` |
| 5b | Report retry fires, then auto-completion decides the run | `"REPORT_RETRY"` |
| 5c | A3 retry fires, then auto-completion decides the run | `"DIAGNOSTIC_RETRY"` |
| 5d | Both retries fire, then auto-completion decides the run | `"BOTH"` |
| 6 | Write schema rejects a `REPORT_SUBMITTED` with no `correctionHistory` | parse fails |
| 7 | Read schema accepts a pre-#116 payload (no field) | parse succeeds |
| 8 | Pre-#116 stream through the real `deriveExecutionStageProgress` | same stage progress as today |
| 9 | Retried-then-completed stream through the real reducer | reduces without a contract error; `REPORT_GENERATION` is **completed** |
| 10 | Retried-then-terminally-rejected stream through the real reducer | reduces without a contract error; `REPORT_GENERATION` is **failed**, carrying the matching validation failure code |

Cases 8–10 must use `deriveExecutionStageProgress` directly. The orchestrator's own tests use a
collecting emitter that performs **no** validation, so every ordering and duplication rule is
invisible to them — this is how #101 shipped a reducer-rejected stream past a green suite.

Each of cases 2–5 must be shown to **fail** against the pre-change code before being trusted green
(flip the helper to a constant, confirm the assertion moves, restore).

**What this cannot prove:** nothing here establishes how often a corrective retry actually recovers
a run against a real model — that is the measurement this attribution exists to enable, not
something it performs. No LIVE run is needed to verify this issue, and none should be spent on it.
The first useful read of the new field comes from the next real sample, whenever that is funded.

## 5. Out of scope

- Recording the corrected-away attempt as its own event (a ledger-semantics migration; see §0.2).
- Any change to retry eligibility, the turn budget, or either corrective guidance text.
- Any fix for `ACTIONABLE_REQUIRES_ACTION` — this issue exists to make that decision
  evidence-based and must not pre-empt it.
- Any change to `recommendationDisposition` or the model/harness responsibility split at
  `resolution-report.ts:26-28`.
- Surfacing the field in `apps/web` or the Python evaluation service. It is diagnostic data for
  deciding the next fix, not reader-visible product surface; adding it to the cross-language
  contract now would widen blast radius for no current consumer.

## 6. Sequencing

1. Confirm in source that `agent_trace_events.payload` has no key-enumerating constraint (§2.5). If
   it does, stop and retract the plan.
2. Add `ReportCorrectionHistorySchema` + the write-schema field; add the read variant and wire it
   into the read union. Tests 6, 7 first.
3. Rebuild `@opspilot/contracts`, then run every dependent workspace's suite — dependents compile
   against the built package, so a green contracts-only run proves nothing about them.
4. Grep the whole repo for `REPORT_SUBMITTED` and classify every hit: **fresh write** (must gain the
   field) vs **read path / fixture** (must be left alone, to keep proving historical rows parse).
   Name the deliberately-untouched category in the commit message.
5. Add the orchestrator helper, call it at all three deciding emits (`:871`, `:948`, `:967`).
   Tests 1–5, 5a–5d. Do **not** default any site to `"NONE"` to satisfy the typechecker — every
   site derives from the two flags, and the auto-completion site must be exercised against all
   four members, not just the clean-first-attempt one.
6. Add the reducer tests 8–10.
7. Prove tests 2–5 fail against pre-change behavior, then restore.
8. `pnpm agent:verify --final`, then `pnpm test:integration:sequential` against real Postgres —
   `--final` reports `integration` under `notRun`, so it alone does not cover the persistence path.

## 7. Acceptance criteria

1. A first-attempt-accepted run persists `correctionHistory: "NONE"` — present, not absent.
2. A run accepted only after a corrective retry persists the member naming that path, recoverable
   by SQL alone with no turn-count arithmetic.
3. A run terminally rejected after a corrective retry persists the same member as (2) — the field
   describes the deciding submission's history on both outcomes.
4. A run where both retries fired persists `"BOTH"`.
4a. Each of the three deciding emit sites reports the run's actual correction history across **all
   four** members — the auto-completion site included. Rounds 1 and 3 of review caught this plan
   first omitting that site entirely, then covering only 2 of its 4 reachable states. The
   implementation must derive the value at every site from the two flags; no site may hardcode a
   constant, and the test matrix must cover all four members at the auto-completion site
   (cases 5a–5d), because that site decided 4 of the 10 runs in the 2026-09-16 sample.
5. A pre-#116 `REPORT_SUBMITTED` row still parses and still reduces to the same stage progress,
   proven against the real reducer, not against the schema alone.
6. Both new stream shapes reduce through the real reducer without a contract error, and each
   asserts the *correct* stage outcome: the completed stream leaves `REPORT_GENERATION` completed;
   the terminally-rejected stream leaves it **failed** with the matching validation failure code.
   A "no failed stage" assertion is wrong for the rejection stream — `reducer:844-848` fails that
   stage by design, and weakening it would trade truthful failure reporting for a green test.
7. No readout, comment, doc line, or commit message claims the ledger records retry *attempts*. The
   field records a property of the one recorded submission; "the retry did not help" is derived by
   joining it with the report outcome, and must be described that way wherever it is described.
8. The field's own comment states that `NULL` means "pre-#116, unknown" and must never be read as
   `NONE`.
9. `pnpm agent:verify --final` passes and `pnpm test:integration:sequential` passes against real
   Postgres.

---

See #116 for the filed issue, #105 for the field-addition precedent, #101 for the retry whose
effect is currently unobservable, and #114 for the sample that surfaced the gap.
