# Issue #114 — Auto-complete evidence for real observations the model already cited via `groundedBy`

| | |
| --- | --- |
| Scope | #114 "GROUNDED_BY_NOT_IN_EVIDENCE (F5) still unfixed after #109's direction was refuted" — close the dominant F5 failure shape (a real, harness-known observation cited via `groundedBy` but never independently listed in `evidence`) at the point the harness can prove the omission is real, not fabricated |
| Basis | `main` @ `4140561` (PR #113 merged), working tree clean |
| Status | Plan only, REVISED after round 1 `agent:codex-review` (2 BLOCKER + 2 MAJOR, all reproduced — see §0.1). No repository source modified, no migration, no commit, push, PR, merge, or deploy. No provider/LIVE request. |
| Branch | `feat/114-conditional-evidence-nonempty` (created, empty) |
| Committed location | `docs/reviews/44-issue-114-conditional-evidence-nonempty-plan.md` |

---

## 0. What this issue is, and isn't

`REPORT_SCHEMA_INVALID`'s `GROUNDED_BY_NOT_IN_EVIDENCE` invariant (F5) remains live: the model omits
a real observation from `report.evidence` while still citing it via a suggested action's
`groundedBy`. #109 exhausted the schema-narrowing direction (three encodings, three refutations
against the real Anthropic API — `docs/reviews/43-issue-109-closing-report-direction-refuted.md`).
This issue implements a run-scoped, harness-side mechanism: when the ONLY reason a report is
rejected is that its `groundedBy` cites locators the harness can independently confirm are real
(genuinely retrieved chunks, genuinely completed tool calls) but the model forgot to duplicate into
`evidence`, the harness completes the omission itself before persistence, rather than relying on the
model to self-correct via a prose-guided retry — the same class of remedy (#80's prose, #101's
retry) already shown twice not to generalize.

**This closes the dominant, attributable F5 shape (#109's own words: "`GROUNDED_BY_NOT_IN_EVIDENCE`
accounted for 4 of 6 attributed report-contract failures").** It does **not** close every empty-
evidence shape: #109's captured samples 1 and 2 (`evidence: [] groundedBy: []` — the model apparently
dropped a suggested action, or reported no findings at all, with nothing anywhere pointing at which
real observation it considered relevant) leave the harness with no signal for WHICH of the run's
real observations, if any, the model meant to cite. Auto-completing ALL of them regardless is the
exact failure round 1 of this plan's own review caught (§0.1, MAJOR 3): it penalizes a model that
legitimately cites only the relevant subset of several retrieved chunks. That residual shape is
named explicitly in §5 as a known, un-closed gap — a different defect (apparent suppression of
findings/actions to evade a requirement) that deserves its own investigation, not a forced-coverage
rule bolted onto this issue.

### 0.1 Revision note — round 1 review findings, reproduced and acted on

The first draft of this plan proposed a **post-Zod, full-coverage check** (`findOmittedObservation`):
reject any accepted report whose `evidence` did not list every id in `allowedRagChunkIds` /
`successfulToolExecutionIds`, backed by a new failure code and invariant. `agent:codex-review`
returned `NEEDS_FIXES` with 2 BLOCKER + 2 MAJOR findings, every one independently reproduced against
source before acting on it (per this repo's "verify every finding" discipline):

1. **BLOCKER — unreachable for F5's dominant shape.** A report whose `evidence: []` but whose
   `suggestedActions[].groundedBy` cites a real locator is rejected by `ResolutionReportSchema`'s
   OWN `GROUNDED_BY_NOT_IN_EVIDENCE` structural check (`resolution-report.ts:394-402`) before
   `safeParse` ever succeeds — the post-Zod check never runs. Confirmed by reading
   `resolution-report.ts` directly: this is exactly #109's decisive sample 3.
2. **BLOCKER — new terminal failure code requires DB migration.** `agent_runs_failure_code_chk` is a
   Postgres CHECK constraint widened by a dedicated migration every time a new orchestrator failure
   code is added (confirmed: `20260817120000_add_provider_output_truncated_failure_code`). The
   original design proposed a new code with no migration step, which would compile but fail
   finalization against a real database.
3. **MAJOR — full coverage over-rejects legitimate reports.** Production always retrieves `topK=3`
   chunks before the first turn; a report that honestly cites only the one relevant chunk and
   ignores two irrelevant ones would have been rejected by the original design, forcing fabricated
   or low-content findings for irrelevant context — the opposite of what P1-3 exists to prevent.
4. **MAJOR — self-contradictory retry recommendation.** The original draft's "owner decision point"
   suggested a retry for the new omission check while requiring `findInvalidEvidence` (fabrication)
   to stay fail-closed, without stating which check takes precedence when both fire on the same
   report.

**What replaces it, and why it is a smaller change, not a bigger one:** §2 below intercepts at the
Zod-rejection boundary itself, reading `groundedBy` (what the model already flagged as
evidence-worthy) rather than the full run-observation universe. Because the fix only ever adds
entries the model's OWN citation already named, and only when independently confirmed real by the
exact same source-aware check `findInvalidEvidence` already trusts, it needs **no new failure code,
no new invariant, no migration** — findings 1 and 2 above are eliminated by construction, not
patched. Finding 3 is eliminated because the new mechanism never looks at the full observation
universe, only at what `groundedBy` already cites. Finding 4 is eliminated because
`findInvalidEvidence`'s fail-closed, no-retry behavior is completely untouched — the new mechanism
runs strictly before it, on a disjoint case (real citations, not fabricated ones).

### 0.2 Revision note — round 2 review findings, reproduced and fixed

Round 2 `agent:codex-review` on the redesigned mechanism returned `NEEDS_FIXES` with 1 BLOCKER + 1
MAJOR, both precision bugs in the redesign rather than a design-level refutation — both reproduced
against source and fixed in place:

1. **BLOCKER — the probe schema rejected the exact non-empty-evidence shape it exists to handle.**
   `EvidenceLocatorSchema` is `.strict()` (`evidence.ts:14-19`), and a real `EvidenceReference`
   always carries `finding`/`supports` on top of it via `.extend()` (`resolution-report.ts:63`). The
   original `GroundedByProbeSchema` used `EvidenceLocatorSchema.partial()` with no `.passthrough()`,
   so any report with a pre-existing, non-empty `evidence` array would fail the probe itself (the
   real fields would read as "unrecognized keys") and fall through to the unmodified existing path
   — leaving the common case (some evidence already present, one groundedBy citation still omitted)
   unfixed, not just the fully-empty case. Fixed in §2.3 by adding `.passthrough()` to the partial
   locator.
2. **MAJOR — the planned "co-occurring invariant" test case was unconstructible.** The original §4
   row paired F5 with `ACTIONABLE_REQUIRES_ACTION`, but that invariant requires
   `suggestedActions.length === 0` while F5 requires a suggested action carrying the omitted
   `groundedBy` locator — mutually exclusive preconditions. Fixed by pairing F5 with
   `ADVISORY_FORBIDS_ACTIONS` instead (`recommendationDisposition: "ADVISORY"` with a non-empty,
   groundedBy-bearing `suggestedActions`), which is actually reachable.

Neither finding changed the mechanism's shape (§2.1–2.7, §0.1's reasoning for why this design
eliminates round 1's four findings, are unaffected) — both are localized to the probe schema
definition and one test-case table row.

### 0.3 Revision note — round 3 review findings, reproduced and fixed

Round 3 `agent:codex-review` returned `NEEDS_FIXES` with 2 MAJOR, both real gaps in the mechanism's
edges rather than a design-level refutation:

1. **MAJOR — auto-completion could turn a retryable F5 rejection into an unannounced terminal
   failure.** The confirmation gate (§2.4) originally checked only the `missing` locators for
   realness. A report can be F5-only at Zod (correctly eligible per §2.2) while its EXISTING
   `evidence` array separately contains a fabricated locator Zod cannot see. Auto-completing anyway
   would re-parse successfully and only then hit `findInvalidEvidence`, converting today's F5
   rejection-with-retry into an immediate `REPORT_EVIDENCE_INVALID` terminal failure — the opposite
   of "strictly additive." Fixed in §2.4: the confirmation gate now checks realness of BOTH
   `missing` and every pre-existing `evidence` entry before proceeding.
2. **MAJOR — the planned audit log had no defined data path.** `agent-orchestrator.ts` never has a
   `runId` (bound only in `agent-run-service.ts`), and neither `AgentOrchestratorResult` nor any
   existing hook carries an auto-completion signal. Fixed in §2.6 by following the exact
   `onReportSchemaInvalid`/`onEventEmissionFailure` precedent already established in
   `agent-run-service.ts`: a new result field plus a new best-effort, non-throwing caller hook bound
   to `runId` at the service layer, with a new `apps/api` logger mirroring
   `report-validation-log.ts`.

Both fixes are additive to the mechanism described in §0.1/§0.2 — no change to the core "intercept
before the retry decision, confirm every locator against run-state, auto-complete or bail out
entirely" shape.

### 0.4 Revision note — round 4 review findings, reproduced and fixed

Round 4 `agent:codex-review` returned `NEEDS_FIXES` with 1 MAJOR, a verification-plan precision gap
rather than a mechanism defect: the original acceptance criterion 5 required `pnpm agent:verify
--final` to cover `test:integration` against real Postgres. Confirmed against source
(`scripts/agent/verify.ts:260-264`, `scripts/agent/README.md:126-147`): final mode's `notRun` is
UNCONDITIONALLY `["integration", "docker-smoke"]` — it never runs Postgres-backed tests, by design,
regardless of the diff. The criterion as written was unsatisfiable and could have created false
assurance that the write-side path was verified against a real database when it was not. Fixed in
§7 (criterion 5): require `pnpm agent:verify --final` AND, separately, `pnpm
test:integration:sequential` (the repo's actual real-Postgres command, `package.json:27`) against a
provisioned test database, both results recorded independently — matching this skill's own
documented "`agent:verify --final` is not actually CI-equivalent for write-side schema changes"
warning, which this plan should have applied from the first draft.

### 0.5 Revision note — round 5 review findings, reproduced and fixed

Round 5 `agent:codex-review` returned `NEEDS_FIXES` with 1 MAJOR + 1 MINOR:

1. **MAJOR — the fixed finding string cannot serve as a provenance marker.** `finding` is
   model-controllable free text (`.min(1).max(500)`, no other constraint —
   `resolution-report.ts:64`), so a model whose context includes untrusted ticket/runbook content
   could in principle produce its OWN evidence entry whose `finding` collides with
   `EVIDENCE_AUTO_COMPLETION_FINDING` verbatim — at which point the plan's proposed audit signal
   (a count) cannot tell which entry the harness actually synthesized, silently misattributing
   model-authored content as harness-authored or vice versa. Fixed in §2.5/§2.6: the fixed string is
   now documented as presentation text only; provenance is tracked structurally by carrying the
   exact synthesized `EvidenceLocator[]` (not a count) through `AgentOrchestratorResult`, the new
   `onEvidenceAutoCompleted` hook, and the new logger.
2. **MINOR — the append-only repair has an unstated boundary at the evidence cap.** `evidence` is
   `.max(10)` (`resolution-report.ts:236`); a report already at 10 entries whose only fault is one
   additional real `groundedBy` citation cannot be healed by appending an 11th — re-parse fails on
   cardinality, not F5, and the mechanism correctly falls through to the existing path per §2.5's
   already-stated "any doubt, behavior is identical to today" rule. This was a real gap in what
   acceptance criterion 1 claimed, not in the mechanism itself. Fixed in §2.5 (explicit dual-cause
   fallback) and §7 (qualified criterion 1).

Neither finding changes §2's control-flow shape — both are precision corrections to what is
persisted/observed (finding 1) and what the coverage claim states (finding 2).

### 0.6 Revision note — round 6 review finding, scoped rather than fixed by widening

Round 6 `agent:codex-review` returned `NEEDS_FIXES` with 1 MAJOR: the `onEvidenceAutoCompleted`
hook/log introduced in round 5 (§2.6) is best-effort, swallowed-on-throw telemetry that never
reaches the database — yet the plan called its locator list "the authoritative record," which a
committed report's actual persisted state does not back. Two possible responses were weighed with
the owner directly (this repo's plan-integrity discipline: when independent review finds a claim is
stronger than the mechanism proves, narrow the claim rather than either defending it or silently
widening scope to rescue it):

- **Harden**: persist the synthesized locator list durably (new DB column/table, new migration).
  Rejected — this reopens exactly the migration cost §0.1's redesign was chosen specifically to
  avoid, turning a deliberately small, migration-free fix back into a larger one for a provenance
  guarantee this issue does not need to make.
- **Narrow the claim** (chosen, owner-confirmed): state plainly that the hook/log is best-effort
  observability, not a durable audit trail — see §2.6's explicit limit — and that the fixed
  `EVIDENCE_AUTO_COMPLETION_FINDING` string inside the persisted report is the one signal that
  survives in the data, read as a hint given the model-collision caveat already recorded in §0.5,
  not a guarantee. No DB schema change, no migration.

This is the last review round for this plan (owner decision after 6 consecutive rounds, each
narrowing from design-level findings toward precision/documentation gaps — a converging pattern,
not an open-ended one). Implementation proceeds against this plan as revised through §0.6.

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Run-scoped observation sets | `agent-orchestrator.ts:402,452` | `allowedRagChunkIds` (retrieved chunk ids) and `successfulToolExecutionIds` (completed tool-call ids), built and updated as the run progresses; both in scope at the `report_submission` branch. |
| F5 itself | `resolution-report.ts:370-403` | For every parsed `suggestedActions[]` entry, `groundedBy` locators not present in `report.evidence` (by `sourceType:evidenceId`) trip `GROUNDED_BY_NOT_IN_EVIDENCE` — a Zod `superRefine`, unconditional, with **no visibility into run state** (it only compares two arrays within the same payload). This runs **before** `safeParse` can succeed, so it always fires ahead of any post-Zod check. |
| Existing run-scoped evidence check | `agent-orchestrator.ts:733-754`, `findInvalidEvidence` (`:210-220`) | Runs AFTER Zod acceptance. Rejects a report citing a locator absent from BOTH `allowedRagChunkIds` and `successfulToolExecutionIds` (fabrication/staleness). Fails closed, no retry. `REPORT_EVIDENCE_INVALID` / `EVIDENCE_NOT_AVAILABLE_IN_RUN`, pinned 1:1 by `refineInvariantPairing`. |
| Existing corrective retry for schema rejections | `agent-orchestrator.ts:640-708` (`canRetryReport`/`reportRetryUsed`), `REPORT_INVARIANT_REMEDIES` (`:284-314`) | Already has a specific remedy string for `"suggestedActions[].groundedBy entries must each appear in report.evidence."` — i.e., the existing mechanism for this exact rejection is a generic corrective RETRY (prose), which #109's 3-of-3 sample confirms is not reliably followed. This retry path is UNCHANGED by this plan — it remains the fallback for cases the new mechanism (§2) cannot auto-heal. |
| P1-3 anti-fabrication guarantee | `resolution-report.ts:227-236,443-460` | `evidence` carries no `.min(1)` — a truthful `INSUFFICIENT` report with nothing gathered must be able to submit `evidence: []`. Must not be weakened; untouched by this design (auto-completion only ever fires on a report that already failed the schema, never on an accepted empty-evidence report). |
| `agent_runs_failure_code_chk` | `packages/database/prisma/migrations/*/migration.sql` | Postgres CHECK constraint over `failure_code`, widened by a dedicated migration each time a new `AgentOrchestratorErrorCodeSchema` member is added. **This plan adds no new failure code, so no migration is needed** — confirmed as the deciding reason to prefer this design. |
| `result.rawInput` availability | `agent-orchestrator.ts:634-642` | Already fully in memory at the `report_submission` branch (used today only to derive `receivedType` via `reportInput: true`); nothing new needs to be threaded in to read it more deeply. |

## 2. Design

### 2.1 Where this runs

Immediately after `ResolutionReportSchema.safeParse(result.rawInput, { reportInput: true })` fails,
and BEFORE the existing `canRetryReport` decision (`agent-orchestrator.ts:663`). This is a new
branch inserted between "parse failed" and "decide retry-or-terminal" — the existing retry/terminal
logic is reached completely unchanged whenever auto-completion does not apply or does not succeed.

### 2.2 Eligibility — narrow on purpose

Auto-completion is attempted only when `classifyReportInvariants(issues)` (already computed for the
existing retry-guidance path) returns **exactly** `["GROUNDED_BY_NOT_IN_EVIDENCE"]` — a single
violated invariant, no others. Any co-occurring invariant (e.g. a cardinality violation, a duplicate
locator) bails out to the existing, unmodified failure/retry path. This keeps the mechanism from
ever entangling with an invariant it was not built to reason about.

### 2.3 Extracting the candidate locators — a permissive probe schema, not hand-rolled duck-typing

Define a small, permissive Zod schema whose only job is to pull the two locator sets out of a
payload that has already failed the STRICT schema — built from the existing, refinement-free
`EvidenceLocatorSchema` (`evidence.ts:14-19`) so it cannot itself drift from the locator shape both
strict schemas already use:

```ts
// EvidenceLocatorSchema is `.strict()`, and a real EvidenceReference always
// carries `finding`/`supports` on top of it (resolution-report.ts:63,
// `.extend()`) — `EvidenceLocatorSchema.partial()` alone would reject those
// as unrecognized keys, incorrectly refusing to probe a NON-empty evidence
// array (caught by round-2 codex-review, reproduced: a report with one real
// evidence entry plus one groundedBy-only omission would fall through to the
// existing retry path instead of being auto-completed). `.passthrough()` on
// the partial locator keeps the shape check (evidenceId/sourceType typed
// when present) while tolerating every other real EvidenceReference field.
const GroundedByProbeSchema = z
  .object({
    evidence: z.array(EvidenceLocatorSchema.partial().passthrough()).optional(),
    suggestedActions: z
      .array(z.object({ groundedBy: z.array(EvidenceLocatorSchema).optional() }).passthrough())
      .optional(),
  })
  .passthrough();
```

If this probe itself fails to parse `result.rawInput` (the payload is too malformed even to locate
these two arrays), bail to the existing failure path unchanged — auto-completion never attempts to
repair something this broken.

From a successful probe: `cited` = the deduplicated `(sourceType, evidenceId)` set across every
`suggestedActions[].groundedBy`; `present` = the set already in `evidence` (partial entries whose
`sourceType`/`evidenceId` are both defined). `missing = cited - present`.

If `missing` is empty, the eligibility check at §2.2 was a false positive relative to this
extraction (should not happen if `GROUNDED_BY_NOT_IN_EVIDENCE` fired) — bail out defensively to the
existing failure path rather than assume anything.

### 2.4 The confirmation gate — reuses `findInvalidEvidence`'s own source-aware logic, checked against BOTH arrays

For every locator in `missing`, confirm it is REAL using the exact same per-source check
`findInvalidEvidence` already applies: a `RAG_CHUNK` id must be in `allowedRagChunkIds`; any other
`sourceType` id must be in `successfulToolExecutionIds`. Factor this per-locator predicate out of
`findInvalidEvidence` into a small shared helper (`isKnownRunObservation`) used by both, rather than
duplicating the source-type branch.

**Critically, this confirmation check must run against `missing` AND every locator already present
in the probe's `evidence` array — not `missing` alone.** A report can be F5-only at the Zod layer
(its sole violated invariant) while its EXISTING `evidence` array separately contains a fabricated
locator that `findInvalidEvidence` would reject post-Zod; Zod's `GROUNDED_BY_NOT_IN_EVIDENCE` has no
visibility into run state and cannot see this. If auto-completion proceeded anyway, the augmented
report would re-parse successfully and only THEN hit `findInvalidEvidence`, converting what is
today an F5 rejection carrying a corrective RETRY into an immediate terminal
`REPORT_EVIDENCE_INVALID` — the branch would no longer be strictly additive, and a run that
currently gets one more chance to fix both problems would lose it. Confirmed by round-3
`agent:codex-review` as a real, reproducible MAJOR.

- **`missing` all confirmed real, AND every pre-existing `evidence` entry also confirmed real** →
  proceed to auto-completion (§2.5).
- **Any entry in `missing` NOT confirmed real, OR any pre-existing `evidence` entry not confirmed
  real** → bail out entirely, unchanged existing path (the existing corrective retry, or terminal
  failure on the final turn, exactly as today — including for the pre-existing-fabrication case,
  which now gets its ordinary retry chance rather than an unannounced escalation to a different
  terminal code).

### 2.5 Auto-completion

Build one harness-authored `EvidenceReference` per entry in `missing`:

```ts
{
  evidenceId, sourceType,       // from the confirmed-real locator
  finding: EVIDENCE_AUTO_COMPLETION_FINDING,  // fixed literal, PRESENTATION text only —
                                               // see §2.6's provenance-tracking correction:
                                               // this string is NOT the audit mechanism
  supports: [],                                // never invents a claim link
}
```

`EVIDENCE_AUTO_COMPLETION_FINDING` is a single exported constant (e.g. "Cited by a suggested
action's grounding; not independently described by the model this run."), never derived from
anything model-authored — same no-echo convention as `A3_CORRECTIVE_GUIDANCE_TEXT` and
`REPORT_INVARIANT_REMEDIES`. **It is display text only, not a provenance discriminator** — `finding`
is model-controllable free text up to 500 characters (`resolution-report.ts:64`, `.min(1).max(500)`,
no other constraint), and a report built from untrusted ticket/runbook content could in principle
produce a model-authored entry whose `finding` happens to equal this exact literal. Provenance is
tracked structurally instead — see §2.6.

Append these to the ORIGINAL `rawInput.evidence` array (or `[]` if absent) and re-run
`ResolutionReportSchema.safeParse` on the augmented payload:

- **Re-parse succeeds** → proceed exactly as today's "accepted" path (`agent-orchestrator.ts:730`
  onward): run the existing `findInvalidEvidence` run-availability check against the augmented
  `evidence` (trivially passes for the synthesized entries; unchanged for the model's own), then
  emit `REPORT_SUBMITTED` → `REPORT_VALIDATED`, using the AUGMENTED parsed report as the run's
  result. No new event type, no new failure code.
- **Re-parse still fails** — this includes both (a) a rare interaction with another refinement not
  visible at the original single-invariant classification, and (b) the evidence-capacity boundary:
  `evidence` is capped at `.max(10)` (`resolution-report.ts:236`), so a report already carrying 10
  entries whose only fault is one additional real `groundedBy` citation cannot be healed by
  appending — the augmented array has 11 entries and re-parse fails on cardinality, not on F5. In
  EITHER case, discard the auto-completion attempt entirely and fall through to the EXISTING
  failure/retry path using the ORIGINAL `parsedReport`/`issues` — never a second, different failure
  surfaced from the augmented attempt. This keeps the auto-completion branch strictly additive: on
  any doubt, behavior is identical to today. (This means acceptance criterion 1's "every F5-only
  report is healed" claim has one narrow, intentional exception — see the qualified criterion in
  §7.)

### 2.6 Observability and provenance, since the persisted report can now differ from the model's literal output

This is a new precedent worth stating plainly: today, whatever is persisted as `report.evidence` is
always byte-identical to the model's own validated payload. After this change, an accepted report
MAY contain harness-synthesized entries. **The fixed `EVIDENCE_AUTO_COMPLETION_FINDING` string is
presentation text, not a reliable provenance marker** — it is written into a model-controllable free
-text field (`finding`, `.min(1).max(500)`, no other constraint), and a model whose context includes
untrusted ticket/runbook content could in principle emit an entry whose own `finding` collides with
this exact literal, making two entries indistinguishable by string comparison alone. Track
provenance structurally instead:

- `AgentOrchestratorResult`'s accepted-report variant carries a new field naming the EXACT locators
  synthesized this run (e.g. `autoCompletedEvidence: readonly EvidenceLocator[]`, not merely a
  count) — the in-process record for THIS run's execution.
- `agent-run-service.ts` adds a new caller-supplied hook (`onEvidenceAutoCompleted?: (diagnostic: {
  runId: string; locators: readonly EvidenceLocator[] }) => void`), invoked at the same point
  `onReportSchemaInvalid` is (`:912`), wrapped in the identical try/catch-swallow pattern — "a
  caller-supplied hook throwing must never change what this method returns." A new `apps/api` logger
  (`evidence-auto-completion-log.ts`, mirroring `report-validation-log.ts`'s shape/pattern exactly,
  including its own non-throwing try/catch) wires the hook at the API composition root, logging the
  full locator list (safe: these are HARNESS-derived ids already known to be real, never
  model-authored content) rather than only a count.
- The fixed `EVIDENCE_AUTO_COMPLETION_FINDING` string remains as a human-readable hint inside the
  persisted report itself.

**Explicit, honest limit (round-6 correction): this is best-effort observability, not a durable
audit trail.** The locator list lives only in the transient hook/log — it is never persisted to the
database alongside the report. Three consequences, stated rather than papered over:

- If `onEvidenceAutoCompleted` is omitted, throws, or the process crashes between the hook firing
  and finalization committing, the locator list is lost; nothing in the persisted row can recover it.
- If finalization itself fails/rolls back after the hook already logged, the log describes a report
  that was never actually persisted — a false positive in the log, not in the data.
- **A later read, replay, or database query cannot reliably reconstruct which entries were
  synthesized** — only a log line contemporaneous with the run can, and only if it was captured.

**Why this is the right scope boundary, not a gap to close in this issue:** making the locator list
durably queryable from the persisted row would require a new database column/table and a migration
— reopening exactly the DB-migration cost this design was chosen specifically to avoid (§0.1,
BLOCKER 2). That is a real, separable piece of scope (persisted provenance for harness-modified
reports in general), not intrinsic to closing F5's dominant failure shape. If durable, queryable
provenance is later needed, it is a follow-up issue with its own migration, not a silent scope
increase here. The fixed `EVIDENCE_AUTO_COMPLETION_FINDING` string inside the persisted report
remains the one signal that survives in the data itself — read as a hint, not a guarantee, given the
model-collision caveat above.

Document the behavior itself (not just the log) in `docs/16-investigation-event-contract.md` and/or
`docs/04-agent-design.md`, since "the persisted report is always exactly what the model returned" is
presumably stated or assumed somewhere in the existing docs and would otherwise go stale silently.

### 2.7 What is explicitly NOT changed

- `findInvalidEvidence` / `EVIDENCE_NOT_AVAILABLE_IN_RUN` — untouched, still fail-closed, still no
  retry. The new mechanism runs on a disjoint case (confirmed-real citations only) and never
  competes with it for precedence, since a report reaching `findInvalidEvidence` has, by
  construction, already passed Zod (with or without auto-completion).
- The existing generic corrective retry (`canRetryReport`/`REPORT_INVARIANT_REMEDIES`) for every
  `GROUNDED_BY_NOT_IN_EVIDENCE` case auto-completion does not resolve.
- No new `ReportInvariantSchema` member, no new `ReportValidationFailureCodeSchema` member, no
  database migration.
- No prompt-version bump: no model-facing prose changes (the existing remedy text is unchanged; the
  new corrective content — if any is added to it, see §5 residual — would be evaluated separately).

## 3. Compatibility

- No wire-shape change to `ResolutionReportSchema`/`StoredResolutionReportSchema`.
- No new persisted enum values anywhere — fully additive at the application layer only.
- Pre-existing persisted rows are entirely unaffected (this only changes behavior at report-
  acceptance time, going forward).

## 4. Verification plan — and an explicit limit of what it can prove

| Case | Setup | Expected |
| --- | --- | --- |
| F5 dominant shape (auto-healed) | `evidence: []`, one suggested action's `groundedBy` cites a real tool-execution id | Auto-completed; accepted; persisted `evidence` contains the synthesized entry with the fixed finding string; the `onEvidenceAutoCompleted` hook fires with exactly that one locator |
| Multiple real citations | `groundedBy` across two actions cites two distinct real locators (one RAG, one tool), `evidence: []` | Both auto-completed; accepted; hook fires with both locators |
| Evidence-cap boundary (round-5 fix) | `evidence` already has 10 real entries; one real locator is cited only via `groundedBy` and omitted | NOT auto-completed — augmented array would have 11 entries, exceeding `.max(10)`; re-parse fails on cardinality, falls through to the existing F5 retry/terminal path unchanged |
| Collision on the marker string (round-5 fix) | A pre-existing, real, MODEL-authored evidence entry's `finding` happens to equal `EVIDENCE_AUTO_COMPLETION_FINDING` verbatim, plus a separate real `groundedBy` omission | Auto-completion still succeeds (the collision does not block the mechanism); the `onEvidenceAutoCompleted` hook's locator list correctly names only the ACTUALLY-synthesized entry, not the pre-existing one with the colliding string |
| Mixed real + fabricated (in `groundedBy`) | `groundedBy` cites one real id and one id absent from both run sets | NOT auto-completed; falls through unchanged to existing `GROUNDED_BY_NOT_IN_EVIDENCE` retry/terminal path |
| Pre-existing fabrication alongside a real omission | F5 is the sole Zod violation; `evidence` already contains one entry with a locator absent from both run sets, AND a separate `groundedBy` cites a real omitted locator | NOT auto-completed (confirmation gate checks pre-existing `evidence` too, per §2.4/round-3 fix); falls through to the existing F5 retry/terminal path unchanged — must NOT surface as `REPORT_EVIDENCE_INVALID` |
| Co-occurring invariant | `recommendationDisposition: "ADVISORY"` with a non-empty `suggestedActions` (triggers `ADVISORY_FORBIDS_ACTIONS`), where that action's `groundedBy` also cites a real id omitted from `evidence` (triggers F5 too) — reachable per round-2 review's correction: `ACTIONABLE_REQUIRES_ACTION` cannot co-occur with F5 since the former needs zero actions and the latter needs a groundedBy-bearing action | NOT auto-completed (not a sole-invariant case); existing path unchanged |
| Malformed payload | `result.rawInput` fails even the permissive probe schema | NOT auto-completed; existing path unchanged |
| Legitimate partial citation (regression pin for round-1 MAJOR 3) | 3 real retrieved chunks, report cites only 1 relevant one via `evidence`, no `groundedBy` referencing the other two | Accepted as today — auto-completion never fires because there is no Zod rejection to intercept |
| Truthful empty, nothing gathered | No tool run, no chunk retrieved, `evidence: []`, no actions | Accepted — unchanged (P1-3 regression pin) |
| Fabrication still fails closed | Report passes Zod (with or without auto-completion) but cites a locator absent from both run-state sets in `evidence` itself | `findInvalidEvidence` still rejects with `REPORT_EVIDENCE_INVALID` / `EVIDENCE_NOT_AVAILABLE_IN_RUN`, unchanged |

**What this cannot prove**: whether a real model's rate of hitting `GROUNDED_BY_NOT_IN_EVIDENCE` at
all changes (auto-completion fixes the OUTCOME of this specific rejection shape, not the model's
tendency to omit in the first place — that tendency is unmeasurable by `FakeLlmProvider`, since
`evaluation-runner.ts` scripts every provider turn). Close this with ONE controlled LIVE observation:
re-run a scenario shaped like #109's captured sample 3 against the fixed build. Report mechanism
(deterministic tests above) and model outcome (the LIVE run now completing instead of failing
`REPORT_SCHEMA_INVALID`) as two separate, explicitly labeled verdicts.

## 5. Out of scope

- **The `evidence: [] AND groundedBy: []` residual (#109 samples 1/2).** No `groundedBy` signal
  exists to tell the harness which, if any, real observation the model meant to cite — auto-
  completing the full observation set regardless is exactly round 1's refuted full-coverage design
  (§0.1, MAJOR 3). If a real LIVE observation (§4) shows this residual shape still dominates
  post-fix, it is a different defect (apparent action/finding suppression to evade grounding) and
  warrants its own issue, not a retrofit here.
- Option (1) from #109/#114 (full harness-supplied observation set / annotate-only wire shape) — a
  larger, separate issue, only if warranted after this narrower fix is observed in production.
- Any change to `groundedBy ⊆ evidence` (F5's cross-array subset rule) itself — it remains exactly
  as strict; this issue changes what happens BEFORE that rule's rejection becomes terminal, not the
  rule.
- Any change to `EVIDENCE_NOT_AVAILABLE_IN_RUN`'s fail-closed, no-retry behavior.
- Any schema-narrowing / per-run generated grammar approach (refuted by #109; not re-attempted).
- A mixed real+fabricated `groundedBy` getting anything beyond the existing generic retry.

## 6. Sequencing (test-first)

1. `agent-orchestrator.ts`: factor `isKnownRunObservation` out of `findInvalidEvidence` (pure
   refactor, existing tests must still pass unmodified — confirms no behavior change).
2. `GroundedByProbeSchema` + `EVIDENCE_AUTO_COMPLETION_FINDING` + the extraction/confirmation-gate
   helpers, unit-tested standalone against: well-formed candidate (empty and non-empty pre-existing
   `evidence`), malformed payload, empty missing set, mixed real/fabricated in `groundedBy`,
   fabricated PRE-EXISTING `evidence` entry alongside a real omission (round-3 fix).
3. Wire the new branch into the `report_submission` handling, test-first against the REAL
   `deriveExecutionStageProgress` reducer (not a collecting emitter — per this skill's ledger-
   contract warning; #101's own BLOCKER was missed exactly this way).
4. `AgentOrchestratorResult`'s new field naming the exact synthesized locators (not a count — round-5
   fix), the new `onEvidenceAutoCompleted` hook on `agent-run-service.ts` (mirroring
   `onReportSchemaInvalid`'s binding and non-throwing try/catch exactly), and the new `apps/api`
   `evidence-auto-completion-log.ts` (round-3/round-5 fixes).
5. Full case table from §4 as orchestrator-level integration tests.
6. Docs: `docs/16-investigation-event-contract.md` / `docs/04-agent-design.md` note on
   harness-synthesized evidence entries.
7. One real LIVE observation; record mechanism vs. outcome verdicts separately, in the PR body AND
   a comment on #114 itself.

## 7. Acceptance criteria

1. A report whose ONLY schema violation is `GROUNDED_BY_NOT_IN_EVIDENCE`, where every missing
   locator is confirmed real against the run's own `allowedRagChunkIds`/`successfulToolExecutionIds`,
   is accepted with those entries auto-completed, carrying the fixed
   `EVIDENCE_AUTO_COMPLETION_FINDING` string and `supports: []` — **except when the augmented
   `evidence` array would exceed `.max(10)`** (round-5 fix), in which case it falls through to the
   existing failure/retry path unchanged, exactly as today.
2. A report with any fabricated/unconfirmed missing locator, any fabricated/unconfirmed
   PRE-EXISTING `evidence` entry, or any co-occurring invariant, falls through to the existing,
   byte-for-byte unchanged failure/retry behavior — never escalating to a different terminal code
   than today's.
3. A report legitimately citing only a relevant subset of several available real observations
   (nothing in `groundedBy` naming the rest) is accepted unchanged — no forced full coverage.
4. `findInvalidEvidence`/`EVIDENCE_NOT_AVAILABLE_IN_RUN`'s existing fail-closed, no-retry behavior is
   unchanged, and its existing test coverage passes unmodified.
5. No new database migration is required; `pnpm agent:verify --final` passes — noting it always
   reports `integration` under `notRun` and never runs Postgres-backed tests
   (`scripts/agent/verify.ts:260-264`, confirmed by round-4 `agent:codex-review`) — AND, separately,
   with the test database provisioned, `pnpm test:integration:sequential` passes, exercising the
   real persisted-outcome path for any touched write-side fixture.
6. Docs updated to state that persisted `report.evidence` may contain harness-synthesized entries.
   The fixed finding-string constant is documented as a hint, not a guarantee (a model-collision is
   possible per §0.5). The `onEvidenceAutoCompleted` hook/log is documented explicitly as
   best-effort observability, not a durable audit trail — it is never persisted to the database, and
   nothing in this issue makes synthesized-entry provenance durably queryable from a stored run
   (round-6 scope decision, §0.6).
7. One real LIVE run against a scenario shaped like #109's sample 3 is recorded, with mechanism and
   model-outcome verdicts reported separately — in the PR body and as a comment on #114.
