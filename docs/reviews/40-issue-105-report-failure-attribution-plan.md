# Issue #105 — Attribute `REPORT_SCHEMA_INVALID` to the invariant that caused it

**Status:** Plan only — not implemented.
**Issue:** https://github.com/wye-ts/opspilot/issues/105
**Baseline:** `8bd5691` (main, #101 merged)

---

## 1. Why this, and why now

`REPORT_VALIDATION_FAILED` persists only a `failureCode`. `REPORT_SCHEMA_INVALID` spans the whole
resolution-report contract, so a persisted failure cannot say which invariant the model violated.

Real evidence from 8 LIVE runs on 2026-09-14/15, after #101 merged:

- 2 `COMPLETED`, 5 `REPORT_SCHEMA_INVALID`, 1 `PROVIDER_UNAVAILABLE` (rate limiting, unrelated).
- **Only 1 of the 5 was attributable**, and only because an env-gated debug print was temporarily
  compiled in during those runs. The other 4 are permanently unattributable.

Two invariants are known to fire, with opposite implications for the next fix:

| invariant | nature | does #101's corrective retry help? |
| --- | --- | --- |
| F5 — `suggestedActions[].groundedBy entries must each appear in report.evidence.` | cross-array, character-exact consistency inside ONE payload | poorly — the retry re-rolls the same dice |
| F1/F2 — `ACTIONABLE requires at least one suggested action.` | stateless, locally fixable | yes |

The next fix's size depends on the ratio, and the ratio is currently unknowable without paid runs
carrying temporary instrumentation. Worse, it is unknowable **retroactively** — including for every
public-trial visitor failure.

### Why not go straight at F5

The strongest candidate fix is making F5 structurally unviolatable (e.g. `groundedBy` referencing
`evidence` by index). That is also the largest change available: the report contract,
read-compatibility for every persisted report, and the UI. There is currently **no evidence for how
much of the failure mass it removes**. Two cheaper remedies have already been attempted against
this same invariant without resolving it — #80 (prompt wording) and #101 (bounded retry) — so a
third guess is the pattern to break, not to continue.

Attribution needs no LIVE calls to build and converts every future failure, including production
visitor failures, into free evidence.

### Origin (verified, not assumed)

`groundedBy` and the F5 subset check entered in `c1a694b` (#60, 2026-08-15). That change's own
verification record in `docs/04-agent-design.md` states the deterministic eval "does **not** score
`groundedBy`" and "does **not** prove grounding quality." The invariant has therefore never been
validated against a real model — the eval's 15/15 pass ran on hand-authored fixtures that were
self-consistent by construction. This plan does not fix that; it makes the gap measurable.

---

## 2. Design

### 2.1 A closed, application-authored vocabulary

Add a `violatedInvariants` field to the `REPORT_VALIDATION_FAILED` payload carrying identifiers
from an application-authored enum — never raw Zod messages, never model output.

`resolution-report-validation.ts` already documents that every `custom` issue literal on this
schema is hand-written with no interpolated report data, so forwarding messages would leak nothing.
The reason for a closed set is the same one #101 recorded for its remedy map: those literals are
validation-engine output, and routing them into a persisted contract would make every future schema
message edit a silent change to a persisted vocabulary. Authoring the identifiers here keeps the
contract's surface deliberate.

An unrecognized invariant maps to an explicit `OTHER` — the mapping degrades to less specific but
never to wrong, exactly like #101's remedy fallback.

### 2.2 Terminal rejections only — no ledger-semantics change

The field is populated only when a rejection is terminal. A corrected-away attempt still emits
nothing at all (#101 §2.3, and `references/canonical-event-ledger-contract.md` §1).

This adds a field to an existing singleton event. It does **not** record attempts, does not
introduce a second report outcome, and does not touch the reducer's stage transitions — the reducer
branches on event `type` only (`investigation-stage-progress-reducer.ts:823`), so no stage logic
changes.

Restated so it cannot be misread later: **this plan does not make retried runs visible.** Whether
the ledger should record attempts rather than accepted outcomes remains the standing debt noted in
#101's plan §5.

### 2.3 Read-compatibility is required, and the precedent already exists

`ReportValidationFailedEventSchema` is `.strict()`, so the field must be added deliberately. Every
already-persisted `REPORT_VALIDATION_FAILED` row lacks it and must still parse and still reduce.

`investigation-event.ts` already separates write branches from
`INVESTIGATION_EVENT_RECORD_BRANCHES` for exactly this: `ToolRequestedRecordEventSchema` makes
`assessment` optional on read so pre-#58 rows stay readable while fresh writes carry it. This change
follows that established pattern rather than inventing one — required on write, optional on read.

---

## 3. Acceptance criteria

1. A terminal `REPORT_SCHEMA_INVALID` persists the invariant identifier(s) that caused it.
2. Both known invariants (F5 and F1/F2) map to distinct identifiers; an unmapped invariant yields
   `OTHER`.
3. A pre-change persisted event lacking the field still parses and still reduces.
4. The emitted stream is validated against the **real** `deriveExecutionStageProgress`, for both the
   terminal-rejection and the completed shapes — not only a collecting emitter. (#101's BLOCKER was
   invisible to the collecting emitter, and the orchestrator suite passed against a stream the
   reducer rejects outright.)
5. No model-produced text reaches the ledger — asserted, not assumed.
6. A corrected-away attempt still emits nothing; exactly one report outcome per run.

## 4. Verification

- Deterministic tests only. This change needs **no LIVE calls** — it is pure contract/orchestrator
  plumbing.
- Every new negative-path fixture must be probed against the real schema to confirm it trips the
  invariant it is named for, not a cheaper structural rule
  (`canonical-event-ledger-contract.md` — "A negative-path fixture must violate ONLY the invariant
  under test"). Delete probes before committing.
- Prove each new reducer test fails against the pre-change emit shape before trusting it green.

### What this plan cannot prove

It produces no failure distribution by itself. The distribution comes from running the sampled
observations **after** this ships, against instrumented persisted data. This step only makes that
sampling free and retroactive.

## 5. Out of scope

- Fixing F5 (index-based grounding), thinking policy, or `MAX_PROVIDER_TURNS` budget pressure —
  chosen *after* this yields a distribution.
- Recording attempts rather than accepted outcomes in the ledger (standing debt, #101 §5).
- Re-opening the public trial. That is gated on an end-to-end completion rate against an agreed
  threshold, not on any single invariant disappearing.
