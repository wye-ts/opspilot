# Issue #55 — Structured, Per-Claim Evidence Contract (narrow scope)

| | |
| --- | --- |
| Scope | #55 "Upgrade evidence into a structured, traceable contract" — **narrow scope only** (see Scope decision below) |
| Basis | `main` @ `0515aaf5f77b734665ff61bb2394b9b5ca93bd75` (#68, the #59 merge), working tree clean |
| Status | Implemented and verified. `pnpm agent:verify --final` passes (typecheck/build clean; test suites pass except 4 pre-existing apps/web localStorage-environment failures confirmed present on unmodified `main`, unrelated to this change). Independent Codex review (`pnpm agent:codex-review`): `READY_FOR_OWNER_REVIEW`, zero findings. Not yet committed, pushed, merged, or deployed — that decision is the owner's. No provider/LIVE request made. |
| Branch | `feat/55-structured-evidence-contract` (created, empty) |
| Committed location | `docs/reviews/24-issue-55-structured-evidence-plan.md` |

---

## Scope decision (made before this plan, recorded here for the record)

Issue #55's own scope section, read literally, permits an evidence representation that traces
"back to the source (tool call, retrieval, or observed fact)" with no explicit requirement to
expose the *raw* tool/RAG payload. Two materially different implementations both satisfy that
text:

- **Narrow**: keep the existing evidence locator (`evidenceId` + `sourceType`, already validated
  against real tool-execution/RAG-chunk identity by `findInvalidEvidence` since #58) and add a
  field-level link from each evidence entry to the specific report claim(s) it backs. No new
  persistence.
- **Wide**: additionally persist and expose the actual tool return value / RAG chunk content
  behind each locator, so a user can open an evidence entry and see the raw underlying data —
  today `TOOL_COMPLETED` trace events deliberately do not persist the tool's return value at all
  (`apps/api/src/execution/deterministic-scenario.ts` comment: "the report also must not claim the
  actual status value can be recovered from the persisted trace/evidence — it cannot").

**Decision (owner, this session): narrow scope.** Rationale: the wide option opens an unrelated
decision surface (how much raw operational data is safe to surface to an end user, new
persistence, new schema evolution cost) that #55 did not ask for and that deserves its own issue
if a real need for it appears. This matches `CONTEXT.md`'s "prefer the smallest demonstrably
sufficient design" / "a technically possible edge case is not automatically a required fix."
Everything below is the narrow-scope design only.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Locator primitive | `packages/contracts/src/evidence.ts` `EvidenceLocatorSchema` | `{ evidenceId, sourceType: RAG_CHUNK\|TOOL_EXECUTION }`, strict, no superRefine. `countDistinctEvidenceLocators` is the shared distinctness rule. |
| Report evidence entry | `packages/contracts/src/resolution-report.ts` `EvidenceReferenceSchema` | `EvidenceLocatorSchema.extend({ finding: string })`. Built via `.extend()` deliberately, per the #58 comment, to stay byte-identical and safe to extend again. |
| Report shape | `resolution-report.ts` `RESOLUTION_REPORT_SHAPE` / `applyReportEvidenceInvariants` | `evidence: EvidenceReferenceSchema[]` (max 10) sits alongside `rootCause` (nullable), `customerImpact`, `recommendedResolution`, `evidenceState`. A dense set of superRefine invariants already exists (one-way rootCause-vs-evidenceState rule, conditional cardinality, legacy-read compatibility) — any new field must be threaded through this exact function, not bolted on separately. |
| Runtime grounding check | `packages/agent-runtime/src/agent/agent-orchestrator.ts` `findInvalidEvidence` | Already rejects a fabricated `evidenceId` — RAG ids must be in the retrieved set, TOOL_EXECUTION ids must match a real successful tool call. Proven adversarially by `evidence-grounding-cases.ts` (fabricated RAG citation, fabricated tool citation, prompt-injection-planted id — all three must fail `REPORT_EVIDENCE_INVALID`). **This layer needs no change.** |
| LLM tool schema | `packages/provider-claude/src/claude-tool-schemas.ts` `SUBMIT_RESOLUTION_REPORT_TOOL` | Derives Claude's strict `input_schema` from `ResolutionReportSchema` via `toStrictInputSchema` (structural, not hand-duplicated) and carries a hand-written natural-language `description` that already teaches the model today's rules (e.g. "rootCause must be null whenever evidenceState is not SUFFICIENT", groundedBy-subset rule for suggested actions). A new field needs the same treatment: it flows into `input_schema` for free via the shared schema, but the natural-language instruction must be added by hand. |
| Provider→orchestrator split | `packages/provider-claude/src/claude-response-normalization.ts` | Passes `rawInput`/`rawAssessment` through unvalidated; authoritative validation happens once in the orchestrator. No change needed — a new evidence field rides through this layer automatically. |
| UI render | `apps/web/src/components/ReportPanel.tsx` | Five independent `<dl>` fields (Summary, Root cause, Customer impact, Recommended resolution, Evidence). `report.evidence` renders as one flat `<ul>` at the end; nothing connects it to the four fields above it. |
| Evaluation | `apps/worker/src/evaluation/cases/evidence-grounding-cases.ts` | Scripted `rawInput` fed through FAKE-mode scenarios; proves orchestrator-side grounding rejection. Structurally **cannot** prove a live model reliably picks the *correct* claim to link an evidence entry to — that is a live-model behavior question, not a deterministic-plumbing one (see §4). |

---

## 2. Design

### 2.1 New field: `EvidenceReference.supports`

```ts
export const EvidenceClaimSchema = z.enum([
  "ROOT_CAUSE",
  "CUSTOMER_IMPACT",
  "RECOMMENDED_RESOLUTION",
]);

export const EvidenceReferenceSchema = EvidenceLocatorSchema.extend({
  finding: z.string().min(1).max(500),
  supports: z.array(EvidenceClaimSchema).max(3),
});
```

`supports` is a **set**, not a list: each evidence entry's `supports` values must be distinct
(`["ROOT_CAUSE", "ROOT_CAUSE"]` is rejected). Enforced as a superRefine addition alongside the
other per-entry checks in §2.2, following the same `addIssue`-based style already used for
`groundedBy` duplicate detection — not a chained `.refine()` on the array in isolation, to stay
consistent with how every other cross-field/set invariant in this file is expressed. Applies to
new writes; a legacy row with no `supports` key still normalizes to `[]` under §2.3 and is
trivially non-duplicate.

**Decision (HQ recommendation, owner-confirmed): `summary` is NOT a linkable claim.** It restates
the other fields rather than standing as an independent conclusion; letting evidence link to it
would only add redundant "this entry supports both summary and rootCause" noise with no
information gain for the reader.

**Decision (HQ recommendation, owner-confirmed): `supports: []` is valid on write.** `evidence`
itself already carries no `.min(1)` requirement for a truthful zero-evidence report (#58 P1-3);
forcing every entry to name a claim would impose a stricter rule on this one field than the rest
of the contract uses anywhere else, and would penalize honestly-contextual evidence that doesn't
back one specific claim.

### 2.2 New superRefine invariants (structural, not semantic — see framing below)

`applyReportEvidenceInvariants` already enforces: non-SUFFICIENT `evidenceState` ⇒ `rootCause` must
be `null`. Two new rules are added, both a mechanical extension of that existing pattern:

**2.2a — negative direction (unchanged from the prior revision of this plan): no evidence entry
may declare `supports: ["ROOT_CAUSE"]` when `report.rootCause === null`** — citing support for a
claim that does not exist is exactly the kind of fabricated-grounding case #58/#60 already treat
as fail-closed.

**2.2b — positive direction (added, closes a real gap the prior revision left open): on new
writes only, when `report.rootCause !== null`, at least one distinct `report.evidence` entry must
include `"ROOT_CAUSE"` in its `supports` array.** Without this, a report could assert a definitive
root cause while every evidence entry carries `supports: []` — schema-valid, but the new per-claim
contract would be silently optional and the UI could reproduce today's unlinked-root-cause
behavior exactly. This closes that gap.

**Write-only scoping is load-bearing, not a style choice — a second independent-review finding
caught this plan getting it wrong once already.** `applyReportEvidenceInvariants` is the one
function both `ResolutionReportSchema` (write) and `StoredResolutionReportSchema` (read) share,
already parameterized by `requireGroundedActions` to differentiate write-strict from
read-compatible behavior. 2.2b **must** be threaded through that same parameter (e.g.
`requirePositiveRootCauseSupport: boolean`, `true` only for the write schema), never applied
unconditionally inside the shared function body. Reason: every pre-#58 legacy stored report with a
non-null `rootCause` has evidence entries with no `supports` key at all — §2.3 normalizes those to
`supports: []` on read — and an unconditional 2.2b would then reject every one of those historical
rows as failing `StoredResolutionReportSchema`, making them unreadable through the API/UI. That
would directly contradict this plan's own compatibility goal (§3) and the repo's established
read-side fail-open posture for purely additive fields. 2.2a has no equivalent hazard (a `null`
rootCause is representable on both legacy and modern rows identically), so only 2.2b needs this
scoping.

**Required test, not optional:** parse a realistic legacy-shaped report — non-null `rootCause`,
evidence entries with no `supports` key — through `StoredResolutionReportSchema` and assert it
succeeds with every `supports` normalized to `[]`, specifically to prove 2.2b is NOT enforced on
read.

**Framing — this stays a structural Harness invariant, not semantic entailment.** The Harness does
**not** decide whether the cited evidence actually *proves* the root cause — that judgment remains
the model's and, ultimately, the reader's. It only requires that the model explicitly identify at
least one already-validated evidence item as the one it is relying on for a root cause it chose to
assert. This is the same responsibility split the rest of the file already uses (e.g.
`recommendationDisposition` is model-declared; the Harness validates cardinality against it, never
parses `recommendedResolution` prose).

**Deliberately not added in this issue:** an equivalent mandatory-support requirement for
`CUSTOMER_IMPACT` or `RECOMMENDED_RESOLUTION`. Both are broader impact/action reasoning that can
legitimately synthesize multiple pieces of context or general operational judgment; forcing a
direct 1:1 evidence citation for every such statement would over-constrain the narrow design this
issue is scoped to. `ROOT_CAUSE` is different: it is the one field the codebase already treats as
requiring the strongest evidentiary standard (the existing one-way nullability rule exists for
exactly this reason), so extending that same standard to "must be traceable to cited evidence" is
consistent with how the rest of the contract already singles it out — not a new precedent.

**Known, accepted edge case (raised by a second-round independent Codex review, adjudicated here,
not fixed):** a `SUFFICIENT`/`ADVISORY` report with `rootCause: null`, one or more evidence
entries, and every entry's `supports: []` is schema-valid under this design, and in that specific
case the new claim-grouped UI has nothing to group — the affected entries render exactly as they
do today, under a flat "Other evidence" section. This is a real, named gap in how much of the
report space the new UI improvement actually reaches, not a defect: it does not fabricate,
mislink, or hide anything, and `supports: []` for genuinely general-context evidence is the
correct, honest declaration under §2.1's decision. Codex's independent review proposed closing it
with a broader invariant ("a report with `evidenceState: SUFFICIENT` and non-empty evidence must
have at least one non-empty `supports` array"); that proposal is **not adopted**, because it
reopens the same "deliberately not added" decision immediately above from a different angle — it
would still be forcing at least one evidence-to-claim link on `CUSTOMER_IMPACT`/
`RECOMMENDED_RESOLUTION`-shaped reports whenever nothing causal is being asserted, which this plan
has twice now decided is out of scope for the narrow design. Consistent with #58 P1-3's precedent
of accepting a truthful zero-evidence report as valid rather than papering over it, a truthful
zero-claim-linkage report is accepted here rather than forced into a link that isn't real. If this
proves to materially undercut the UI improvement in practice (e.g., most real reports end up in
this shape), that is a signal for a future issue, not a reason to widen this one's scope now.

### 2.3 Read-side (`StoredResolutionReportSchema`)

Same normalization pattern already used for `groundedBy` on suggested actions: a legacy stored row
(pre-this-change) has no `supports` key at all. Read schema:

```ts
supports: z.array(EvidenceClaimSchema).max(3).default([]),
```

so a pre-existing row deserializes as "no claim links recorded" rather than failing to read — this
must not become a second fail-closed migration the way `groundedBy` was for #60, because that
was a deliberate, reviewed decision (Issue #60 §4a-c) about actionable-action safety, not a
precedent to reflexively repeat for a purely additive display field.

**This is exactly why 2.2b must be write-only (see §2.2's write-only scoping note): a legacy row
with non-null `rootCause` normalizes every evidence entry's `supports` to `[]` here, and if 2.2b
ran on read, every such row would then fail the very schema this section exists to keep readable.**
2.2a (the negative rule) has no such conflict and stays enforced on both read and write, unchanged
from the prior revision.

### 2.4 LLM tool schema / prompt

Two separate prompt surfaces teach the model today's evidence rules, and **both** need the new
field — a gap the initial draft of this plan missed by touching only the first:

**(a) `SUBMIT_RESOLUTION_REPORT_TOOL.description`** (`claude-tool-schemas.ts`) gets one added
sentence, following the file's existing style exactly (plain imperative instruction, no markdown):

> "For each evidence entry, declare `supports`: the closed set of report claims it backs
> (`ROOT_CAUSE`, `CUSTOMER_IMPACT`, `RECOMMENDED_RESOLUTION`), or an empty array if the entry is
> general context that does not directly back a specific claim. `supports` values must be
> distinct. Never declare `ROOT_CAUSE` support when `rootCause` is null. When `rootCause` is
> non-null, at least one evidence entry must declare `ROOT_CAUSE` support."

`input_schema` picks up the new field automatically via `toStrictInputSchema(ResolutionReportSchema)`
— no hand-duplicated JSON Schema to maintain.

**(b) `REPORT_FIELD_BOUNDS`** (`claude-message-mapping.ts`) is a **second, independent** place the
same bounds must be restated, and this plan's initial draft failed to touch it — a real gap, not a
style nit. This constant exists specifically because Anthropic's strict tool-use JSON Schema subset
silently strips `maxItems`/length bounds from `input_schema` (see `toStrictInputSchema`'s
`UNSUPPORTED_KEYS`), so `REPORT_FIELD_BOUNDS`'s prose is — per the file's own comment — "the only
remaining place these bounds reach the model." Its evidence-entry bullet today reads:

```text
Each entry:
- evidenceId: 1-128 characters.
- sourceType: exactly "RAG_CHUNK" or "TOOL_EXECUTION".
- finding: 1-500 characters.
```

Left unchanged, a real model could submit `supports` with more than 3 entries, or with duplicates,
and the tool call itself would look structurally valid to Claude — only failing later at
`ResolutionReportSchema.safeParse` as an avoidable `REPORT_SCHEMA_INVALID`, exactly the failure
category this constant exists to prevent. Add a fourth bullet:

```text
- supports: an array of 0 to 3 entries, each exactly one of ROOT_CAUSE, CUSTOMER_IMPACT, or
  RECOMMENDED_RESOLUTION, with no duplicate values. Never include ROOT_CAUSE when rootCause is
  null. When rootCause is non-null, at least one evidence entry's supports must include
  ROOT_CAUSE.
```

**The three worked JSON examples in this same constant must also be updated — a second gap found
by independent review, distinct from adding the bullet above.** `REPORT_FIELD_BOUNDS` doesn't just
state bounds in prose; it ends with three complete example report objects the model is shown
directly. All three predate `supports` and would, unchanged, teach the model an invalid shape (the
first example is even a causal `rootCause`-non-null case, which under 2.2b would be actively
wrong — an unwitting model could copy it and produce a report failing its own new required
invariant):

- **Causal ACTIONABLE example** (`rootCause` non-null): its one `TOOL_EXECUTION` evidence entry
  must gain `"supports": ["ROOT_CAUSE"]` — this is the example the model is most likely to pattern
  after for any causal report, so it must satisfy 2.2b itself.
- **Non-causal SUFFICIENT/ADVISORY example** (`rootCause: null`): its evidence entry gains
  `"supports": []` or `"supports": ["CUSTOMER_IMPACT"]` if the finding text plausibly backs that
  claim — never `"ROOT_CAUSE"`, which 2.2a forbids here.
- **INSUFFICIENT/ACTIONABLE example** (`rootCause: null`): same treatment as above — `supports`
  present and never citing `ROOT_CAUSE`.

`claude-message-mapping.test.ts` gets an assertion that every worked example, parsed as JSON and
validated against `ResolutionReportSchema`, actually passes — not just that the prompt string
contains certain substrings. This directly prevents the failure mode independent review flagged:
an example that reads as plausible prose but is not itself a schema-valid report.

`claude-message-mapping.test.ts` (or wherever `REPORT_FIELD_BOUNDS`/`buildSystemPrompt` is
currently tested) gets an assertion that the full system prompt string contains the `supports`
bound and both root-cause rules — the same kind of prompt-content test this file's existing bounds
already have, per the "missing test" pattern Codex's independent review flagged.

### 2.5 UI (`ReportPanel.tsx`)

Group `report.evidence` by claim instead of rendering one flat list: each of Root cause / Customer
impact / Recommended resolution gets its own "Evidence" sub-list of entries whose `supports`
includes that claim; entries with `supports: []` remain in a final unchanged "Evidence" section
(or a renamed "Other evidence" section — copy detail, not architecture). No entry is duplicated
silently without indication if it supports more than one claim — it appears under each claim it
declares, which is the honest rendering of a many-to-many relationship the model itself declared.

### 2.6 Persistence / API

No schema/migration change: `evidence` is already stored as JSON on `agent_trace_events`/report
persistence and a new key on each array element requires no column change. API DTOs
(`apps/api/src/agent-jobs/dto/agent-job-response.mapper.ts` and equivalents) pass the parsed
`StoredResolutionReport` through structurally — verify no field allowlist manually drops unknown
keys (a quick grep-and-read step in implementation, not expected to require a code change based on
today's structural-passthrough pattern seen elsewhere in that file).

---

## 3. Compatibility

Both the write-schema addition (`supports` required in shape, defaultable in practice since `[]` is
a valid array literal a producer can always supply) and the read-schema default (`.default([])`)
follow the exact `groundedBy` precedent from #60 — no new compatibility mechanism is invented.

---

## 4. Verification plan — and an explicit limit of what it can prove

**Unit / contract tests** (`resolution-report.test.ts`, extend existing suite) must prove exactly
this table:

| Case | Expected |
| --- | --- |
| `rootCause != null` + one grounded evidence entry supports `ROOT_CAUSE` (write) | PASS |
| `rootCause != null` + evidence exists, none supports `ROOT_CAUSE` (write) | FAIL (new 2.2b) |
| `rootCause == null` + any evidence entry supports `ROOT_CAUSE` (write or read) | FAIL (2.2a, unchanged) |
| `supports` contains a duplicate claim value (write or read) | FAIL (new distinctness rule) |
| Legacy stored row, no `supports` key, non-null `rootCause` (read) | **PASS** — 2.2b must NOT apply on read; normalizes to `supports: []` (BLOCKER fix, see §2.2/§2.3) |
| `evidenceId`/`sourceType` grounding (fabricated tool/RAG id) | FAIL — unchanged, still enforced by `findInvalidEvidence`; this plan does not touch that function unless implementation inspection proves it necessary |

**Evaluation cases** (`apps/worker/src/evaluation/cases/`, new file alongside
`evidence-grounding-cases.ts`): scripted `rawInput` proving the orchestrator correctly propagates
`supports` through to the persisted/API shape, and that both 2.2a and 2.2b fail closed the same
way the existing fabricated-evidence cases do. Same FAKE-mode, scripted-input style already in
use — deterministic, no live call.

**Gap in that plan, found by independent Codex review and confirmed by inspection — a real
coverage hole, not a style suggestion.** `buildObservedFacts`
(`apps/worker/src/evaluation/observed-facts.ts`) is the sole boundary the evaluation harness reads
report facts through, and its `ReportFacts.evidence` projection is:

```ts
evidence: agentResult.report.evidence.map((entry) => ({
  evidenceId: entry.evidenceId,
  sourceType: entry.sourceType,
})),
```

This already drops `finding` today, and would drop `supports` the same way. An evaluation case
built the way §158-162 originally proposed can pass in full even if `supports` is silently dropped
anywhere between the orchestrator and the database/API — because the evaluation harness itself
never looks at that field. Evaluation cases prove the orchestrator *received and validated* the
right input; they do not prove persistence or API serialization preserved it.

**Fix:** the evaluation cases stay (they are still the right tool for proving 2.2a/2.2b/distinctness
reject and accept correctly at the orchestrator boundary), but two more test layers are added,
each proving a different hop of the same round trip:

1. A database mapper test (alongside the existing `packages/database/src/mappers.test.ts` pattern
   used for `groundedBy`/`recommendationDisposition`): write a report with non-empty `supports`
   through the real write path, read it back through `StoredResolutionReportSchema`, assert the
   exact `supports` values survive unchanged.
2. An API response-mapper test (alongside `apps/api/src/agent-jobs/dto/agent-job-response.mapper.ts`'s
   existing test coverage): supply a stored report with non-empty `supports` and assert the
   serialized API response preserves it — closing the "passes through structurally" assumption in
   §2.6, which this plan asserted from reading the file's pattern but had not yet proven with a
   test.

Only with all three layers (evaluation case + mapper test + API test) is the full
orchestrator-to-UI round trip actually verified, rather than merely the orchestrator's own input
validation.

**What deterministic verification cannot prove, stated honestly:** none of the above establishes
that a real model, given a real ticket, reliably chooses the *correct* claim(s) to link an
evidence entry to — only that it cannot submit a schema-valid report while bypassing the
traceability requirement entirely. That remaining question is a live-model behavioral one.

**Revised rollout recommendation:**

```text
deterministic verification (contract tests + evaluation cases)
→ independent review, if warranted
→ deploy
→ exactly one controlled LIVE observation
```

The LIVE observation is **not** a CI gate, is not run repeatedly, and does not automatically
trigger code changes on its own. Its sole purpose is to eyeball, on one or two representative real
report shapes via the real Claude tool-use path (same category as
`apps/worker/src/smoke/claude-live-smoke.test.ts`):

- a non-null root cause has at least one `ROOT_CAUSE`-supporting evidence entry (structurally
  guaranteed already, but worth confirming the real model satisfies it naturally rather than by
  accident);
- the claim links it chooses look plausible on human inspection;
- the report still validates end-to-end;
- the UI's claim-grouped rendering looks coherent against real model output, not just fixtures.

This replaces the prior revision's "(a) ship with no LIVE check" recommendation. No routine
paid-provider tests are added — this is one bounded, one-time observation, not a new ongoing test
category.

---

## 5. Out of scope (explicit)

- Any change to `findInvalidEvidence` / evidence-identity validation — untouched.
- Any change to `groundedBy` / suggested-action grounding (#60) — untouched, unrelated field.
- Raw tool-output / RAG-chunk-content persistence or display (wide scope, rejected above).
- `docs/06-tool-design.md` / `docs/04-agent-design.md` updates beyond what documents this exact
  change — no broader evidence-architecture rewrite.

---

## 6. Sequencing

1. Contracts: `EvidenceClaimSchema`, `EvidenceReferenceSchema.supports`, §2.2a/§2.2b/distinctness
   superRefine additions, `StoredResolutionReportSchema` read-normalization. Unit tests first
   (TDD, per repo convention seen in `resolution-report-validation.test.ts`).
2. LLM schema/prompt: `claude-tool-schemas.ts` description update (schema itself needs no manual
   change).
3. Evaluation cases: new scripted cases proving orchestrator-boundary plumbing + both new
   invariants + distinctness.
3a. Database mapper test proving `supports` survives write/read normalization unchanged.
3b. API response-mapper test proving `supports` survives serialization unchanged.
4. UI: `ReportPanel.tsx` grouping + `ReportPanel.test.tsx` updates.
5. `pnpm agent:verify --focused`, then `--final` before review-bundle.
6. Deploy, then exactly one controlled LIVE observation per §4.

---

## 7. Acceptance criteria

Issue #55 (narrow scope) is complete only when all of the following are true:

1. Per-evidence `supports` field exists with the closed claim vocabulary (`ROOT_CAUSE`,
   `CUSTOMER_IMPACT`, `RECOMMENDED_RESOLUTION`).
2. `supports` values are distinct within each evidence entry.
3. `rootCause == null` forbids any evidence entry from declaring `ROOT_CAUSE` support (2.2a, read
   and write).
4. `rootCause != null` requires at least one evidence entry declaring `ROOT_CAUSE` support on new
   writes (2.2b) — **and legacy stored rows with non-null `rootCause` and no `supports` key remain
   readable** (2.2b is write-only; this is the BLOCKER fix from independent review, not optional).
5. Legacy stored rows with no `supports` key remain readable, normalized to `[]`.
6. The provider tool contract's natural-language instructions AND worked JSON examples state/satisfy
   all four rules (closed vocabulary, distinctness, 2.2a, 2.2b) in **both** prompt surfaces —
   `SUBMIT_RESOLUTION_REPORT_TOOL.description` and `REPORT_FIELD_BOUNDS` (prose bullets and all
   three worked examples) — not just the schema shape.
7. The UI groups displayed evidence by declared claim.
8. Deterministic contract-test, evaluation-case, database-mapper, and API-mapper coverage (§4's
   table plus the round-trip tests) is green.
9. Exactly one controlled post-deploy LIVE observation has been completed and its outcome
   recorded (even if the outcome is "looked fine, no action needed").

**Explicitly still out of scope** (unchanged from §5): raw tool-output/RAG-content persistence,
claim graphs, a citation engine, approval-workflow changes, new database tables, and any change to
`findInvalidEvidence` or `groundedBy`/#60 suggested-action grounding.
