# Milestone 9 Phase A — Implementation Plan for #34 and #35

| | |
| --- | --- |
| Document | Milestone 9 Phase A — Investigation Timeline UX (planning artifact) |
| Scope | #34 "Show immediate frontend-known investigation stages", #35 "Progressively reveal report, actions, and approval after execution" |
| Status | Plan only. No code, branch, commit, push, GitHub state change, Render change, or LIVE/Claude request. |
| Milestone | Milestone 9 — Live Investigation Timeline & Progress UX |
| Repository inspection basis | `main` (frontend: `apps/web`), read-only exploration only |
| Open owner questions | 5 — see final section |

**This is a planning-only deliverable.** No files were modified, no branch was created, no GitHub state
changed, and no Claude/LIVE request was made while producing this plan. This document is itself the
requested output (the ten-section format from the prompt) and is also kept as the session's live plan
artifact at `/Users/wye/.claude/plans/fizzy-crafting-rainbow.md`.

## Context

Milestone 9's umbrella issue (#40) wants the Investigation Timeline to become a live progress surface
instead of a post-completion audit trail. That end state depends on a backend event contract (#36),
incremental persistence (#37), and polling/resume (#38) — none of which exist yet. #34 is deliberately
scoped as the first slice that needs **zero backend changes**: make the *existing* synchronous
request/response cycle feel alive using only what the browser already knows. #35 (which may land in the
same PR) defines how the report/actions/approval reveal once that request finally resolves. The owner
asked for a plan, not code — this document exists so an implementer (or the owner) can approve scope
before anything is written.

---

## 1. Current lifecycle

Single stateful component `App.tsx` owns the whole flow; `InvestigationForm.tsx` is a dumb controlled
component that calls `onSubmit(submission)` and nothing else.

`runInvestigation()` (`apps/web/src/App.tsx:320-473`), FAKE mode:

```
click → beginWorkflow() (new AbortController + generation bump)
      → setPhase("creating-job")
      → await createAgentJob()         POST /v1/agent-jobs
      → setJob(job)
      → setPhase("running-agent")
      → await startAgentRun()          POST /v1/agent-jobs/{jobId}/runs   ← the long call; the entire
                                                                             agent investigation (retrieval,
                                                                             tool calls, report generation/
                                                                             validation) runs synchronously
                                                                             inside this one HTTP round trip
      → setRun(run)                    → Timeline(trace)+Report+RunContext all mount together, right here
      → setPhase("loading-approval")
      → await loadApproval()           GET /v1/agent-runs/{runId}/approval
      → setPhase("idle")
```

LIVE mode prepends `setPhase("checking-availability")` + `await refreshCapabilities()` (`GET
/v1/capabilities`) before `beginWorkflow()`.

**Where the UI is frozen today:** between click and `job` being set, the DOM below the form is empty —
`InvestigationSummary`, `TraceTimeline`, `ReportPanel`, and `RunContextPanel` are all gated on `job !==
null` / `run !== null` (`App.tsx:857-892`). The only feedback is (a) the submit button's label cycling
through `PHASE_LABELS` text, (b) one shared `role="status" aria-live="polite"` notice line
(`App.tsx:841-843`), and (c) the whole form disabled via `fieldset disabled` + `aria-busy`. There is no
spinner anywhere in the codebase and no progressive reveal — once `run` is set, Timeline, Report, and the
approval column all mount in the same render.

Three sequential, fully-awaited fetches for FAKE (four for LIVE) — never parallel, never polled.

---

## 2. UX gap

1. Nothing renders between click and `job` being set — for the two short calls (job creation, approval
   fetch) this is a minor gap, but `startAgentRun` is the dominant-duration call and the user sees only a
   static button label for its entire length.
2. Report, Timeline, and the approval column currently appear **simultaneously**, all gated on the same
   `run !== null` check — there's no deliberate sequencing (this is exactly #35's gap).
3. Double-submission is already guarded (`submittingRef` in `InvestigationForm`, plus `disabled={isBusy}`)
   — this part of #34's acceptance criteria is **already satisfied**, not a gap.
4. There is no elapsed-time display anywhere today.

---

## 3. Proposed truthful stage mapping

**Important finding:** the six labels given in the prompt (`Creating investigation`, `Investigation
created`, `Starting agent analysis`, `Waiting for investigation result`, `Loading approval state`,
`Completing investigation`) do not map 1:1 onto six independent frontend-observable events. There are
only **three real awaited calls** in FAKE mode (four in LIVE). Forcing six flat rows would either invent
timers to make short/zero-duration rows visible (explicitly forbidden) or produce rows that flash by
instantly with no real "active" moment. Two of the proposed six labels are better modeled as the
**active/completed label pair of a single stage**, not as separate stages. This distinction matters
because #40's *future* canonical list (`Creating investigation → Starting agent analysis → Running
diagnostics → Generating resolution report → Validating report → Completing investigation`) requires
backend events from #36/#37 that don't exist yet — Phase A must not simulate that granularity.

Recommended model — an ordered list of stages, each tied to one real request/response pair, each with a
distinct **active** label and **completed** label:

| # | Stage key | Active label | Completed label | Starts (real event) | Completes (real event) | Only when |
|---|---|---|---|---|---|---|
| 0 | `availability` | "Checking availability…" | "Availability confirmed" | `refreshCapabilities()` dispatched | resolves | LIVE only |
| 1 | `job` | "Creating investigation…" | "Investigation created" | `createAgentJob()` dispatched | `setJob` fires | always |
| 2 | `run` | "Waiting for investigation result…" | "Investigation complete" | `startAgentRun()` dispatched | `setRun` fires | always |
| 3 | `approval` | "Loading approval state…" | "Approval state loaded" | `getApproval()` dispatched | `loadApproval` settles | always |

Notes on the two proposed labels that were **dropped as separate rows**:

- **"Starting agent analysis"** — this and "Waiting for investigation result" both describe the *same*
  outstanding `startAgentRun` call; there is no distinguishable intermediate event between them (the
  request either hasn't been sent, is in flight, or has resolved). Recommend using only "Waiting for
  investigation result" as stage 2's active label — it is the state that actually holds for virtually the
  entire visible duration. If product wants the "Starting…" framing preserved, it can be shown for a
  single synchronous render (the tick where the fetch is dispatched, before the promise has had a chance
  to settle) — not a timer, just the literal first state — but this buys nothing observable and adds a
  stage-copy branch for no user-visible benefit. Recommend dropping it.
- **"Completing investigation"** — there is no real call or event here; `setPhase("idle")` fires
  synchronously in the same tick `loadApproval` settles. Recommend **not** rendering it as its own
  Pending→Active→Completed row (it would have zero observable duration). Instead, "all stages Completed"
  *is* the "completing investigation" signal — if a final checkmark/summary line is wanted, it can be
  derived text ("Investigation complete") shown once stage 3 completes, not a row with its own lifecycle.
  Flagged as an open question at the end of this document.

Each stage's terminal state is **Completed** on success or **Failed** on error — never a percentage.
Pending stages (not yet reached) render as Pending. This matches #40's stated status vocabulary
(Completed/Active/Pending/Failed) even though #40 itself is out of scope.

---

## 4. Proposed state model

Consistent with the existing codebase convention (plain `useState`, no reducer/state-machine library
anywhere in the repo — confirmed via grep) — recommend **not** introducing `useReducer` or a new
dependency; a small derived-state model fits the existing `phase`-driven pattern in `App.tsx`.

`App.tsx` already has everything needed to *derive* stage state — it does not need new imperative stage
tracking:

- **Active stage** = derived from existing `phase` (a pure function `stageForPhase(phase, providerMode):
  StageKey | null`). No new state variable needed for "which stage is active."
- **Completed stages** = derived from existing nullable state: `job !== null` → stage 1 done; `run !==
  null` → stage 2 done; `approval !== null || approvalLoadAttempted` → stage 3 done. (`approval` can
  legitimately stay `null` after a swallowed fetch failure, per `loadApproval`'s current behavior — see
  §6 — so a stage-3-attempted flag may be needed if "Failed" must be distinguishable from "still
  Pending".)
- **Elapsed time**: genuinely new state — a single `submittedAt: number | null` timestamp set in
  `beginWorkflow()`, plus a ticking display value. Recommend a small dedicated hook (e.g.
  `useElapsedTime(active: boolean, since: number | null)`) using `setInterval`/`requestAnimationFrame` at
  ~1s resolution, cleaned up on stage completion/unmount — this is the only piece of genuinely new
  imperative state, and it must respect `prefers-reduced-motion` (§7) by avoiding any animated transition,
  not by disabling the timer itself (the timer is data, not motion).
- **Submitted issue/provider snapshot**: `InvestigationForm` already resets via the `formResetKey` remount
  trick; the "preserve submitted issue/provider summary" requirement needs the *submitted* values
  captured into `App` state before the form is allowed to reset/clear, e.g. `submittedSummary: {
  summary: string; providerMode: ProviderMode } | null`, set once in `runInvestigation()` before the
  first await, cleared on `startNewInvestigation()`. (Today `job`/`run` carry ticket/provider info
  post-hoc; a pre-`job` snapshot is new.)
- **Progressive reveal (for #35)**: derive `revealStage: "timeline" | "report" | "actions" | "approval"`
  purely from `run`/`approval` state — no separate state variable, just render-time sequencing logic
  gating what's shown, consistent with the codebase's stated preference for "derived booleans over stored
  state that can go stale" (`App.tsx:123-139` precedent).
- **Idle/success/failure/retry**: already fully modeled by existing `phase` + `error` + the existing
  `showRetryRun`/`liveRetryPending` machinery — no changes needed here, per #34's explicit requirement
  that "existing idempotent recovery behavior is unchanged."

Net new state in `App.tsx`: `submittedAt`, `submittedSummary` (or a combined snapshot object), and
whatever minimal flag resolves the stage-3-attempted vs stage-3-failed ambiguity from §6. Everything else
is derived from state that already exists.

---

## 5. #34/#35 scope decision

**Recommendation: C — implement #34 first, land it, then implement #35 immediately after as a
follow-up PR**, not A alone and not bundled into one PR.

Rationale:

- #34 and #35 have independently testable, non-overlapping acceptance criteria (per both issues) — #34 is
  about the *pre-terminal* experience (immediate Timeline, elapsed time, no duplicate submission), #35 is
  about the *post-terminal* reveal choreography and its accessibility requirements (reduced motion,
  screen-reader behavior, non-color status, ordered reveal). Splitting keeps each PR small and each set of
  acceptance criteria independently verifiable, which the prompt itself asks the plan to weigh
  ("testability, and PR size").
- #35 carries real accessibility design work (prefers-reduced-motion behavior, screen-reader behavior,
  reveal ordering) that deserves its own focused review rather than being folded into #34's fetch-sequencing
  changes.
- #34 alone is enough to unblock #39 (public LIVE trial's stated blocker), so landing it first has
  standalone value even if #35 slips.
- Landing #34 first also surfaces the real component boundary question from this plan (new progress-stage
  component vs. reusing `TraceTimeline`) for review before #35 has to build the reveal sequencing on top of
  it.

If #34 lands alone first, what remains open in #35: the deliberate report → actions → approval reveal
ordering, the "Timeline stays dominant during execution" layout requirement, and all of #35's explicit
accessibility acceptance criteria (color-independent status, reduced-motion, screen-reader behavior) —
today's simultaneous mount of Timeline+Report+RunContext (confirmed at `App.tsx:857-892`) would still be
in place until #35 lands.

---

## 6. Failure behavior

| Failure point | Existing behavior (unchanged) | Stage Timeline behavior (new) |
|---|---|---|
| Capability preflight (LIVE) | `setError`, `phase → idle`, no job/run attempted | Stage `availability` → Failed; stages 1-3 remain Pending (never reached) |
| Job creation (`createAgentJob`) | `setError`, `phase → idle`, no run attempted | Stage `job` → Failed; stages 2-3 remain Pending |
| Run creation/execution (`startAgentRun`) | `setError`, `phase → idle`; for LIVE ambiguous failures, existing `liveRetryPending` recovery path activates | Stage `run` → Failed; stage `approval` remains Pending. Existing retry/recovery UI (`ActionRequiredBanner`-adjacent "Retry Run" / live recovery) is unaffected — the stage Timeline is a read-only reflection of `phase`/`error`, not a new control surface |
| Approval fetch (`loadApproval`) | Swallows the error internally (`reportError` flag), keeps `run`/report/trace visible; sets `error` only when asked to report it | Stage `approval` → Failed *only if* the fetch genuinely errored, distinguished from "still Pending" — requires the small new flag noted in §4, since `approval === null` today is otherwise ambiguous between "not yet fetched" and "fetch failed but swallowed" |
| Final rendering (React render error) | Out of scope — no existing error boundary around this tree | Not addressed by #34/#35; flagged as a pre-existing gap, not introduced by this work |

General rule: whichever stage's underlying call actually failed becomes Failed; every stage after it stays
Pending (never marked Failed by association) — this directly satisfies #34's and #35's shared "failure
clearly identifies the exact stage that stopped" criterion.

---

## 7. Accessibility

- **Focus**: no new forced focus. Consistent with the existing documented rule ("no focus is ever forced
  automatically," `docs/14-web-ui.md` §9) — the Timeline mounting immediately should not steal focus from
  the form/textarea the user just interacted with.
- **Disabled Run button messaging**: already handled — `PHASE_LABELS[phase]` already becomes the button's
  own label while busy (`InvestigationForm.tsx` submitLabel wiring); no separate messaging needed.
- **Live-region behavior**: the codebase has a deliberate, tested constraint of **exactly one**
  `aria-live` region in the whole app (`App.tsx:841-843`, asserted by
  `App.live-idempotency.test.tsx:529`), with an explicit comment rejecting a second one ("two polite
  announcements racing each other is how this went wrong in the first place"). The new stage Timeline
  must **not** add a second live region — stage transitions should be reflected by updating the existing
  shared notice-region text (already effectively true, since `PHASE_LABELS[phase]` drives both the button
  label and the notice line), not by giving the Timeline list its own `aria-live`.
- **Reduced-motion handling**: the only existing motion is `scroll-behavior: smooth`, already gated by
  `prefers-reduced-motion` (`styles.css:82-90`). Any new stage-transition visual (e.g. a Completed
  checkmark fade-in) must ship a `prefers-reduced-motion: reduce` fallback with no transition — this is
  squarely #35's territory (explicit acceptance criterion) but #34's elapsed-timer display must also avoid
  any animated tick effect, just numeric text updates.
- **Avoiding timer announcements**: the elapsed-time counter must **not** be inside the `aria-live`
  region — a live region re-announcing every second would be unusable with a screen reader. Elapsed time
  should be plain visible text, not live-announced; only stage *transitions* (already covered by the
  existing shared notice text) are announced.
- **Status text/icons beyond color**: existing precedent is `StatusBadge.tsx` (always pairs an
  `aria-hidden` glyph with a real text label) — the new stage rows (Pending/Active/Completed/Failed)
  should follow the same pattern, not color alone. This is explicitly #35's acceptance criterion but #34's
  stage rows should be built with it in mind from the start to avoid rework.
- **Heading order**: existing single `<h1>`, sibling `<h2>` panels (`timeline-heading`, `report-heading`,
  etc.), each `tabIndex={-1}` for fragment-nav. A new progress-stage section, if it gets its own heading,
  should follow the same `<h2>` + `tabIndex={-1}` convention rather than introducing a new hierarchy
  level.

---

## 8. Test strategy

Existing test infrastructure to reuse (no new tooling): `vi.stubGlobal("fetch", vi.fn())` +
`mockResolvedValueOnce`/`mockImplementationOnce`, and the repo's established **hand-rolled deferred-promise
pattern** (`{ promise, resolve }`, already used in `App.run-workflow.test.tsx`,
`App.live-retry.test.tsx`, `App.capabilities-refresh.test.tsx`) for asserting mid-flight UI state — this
is exactly the "deferred promises, not real sleeps" requirement from the prompt, and it's already the
house style.

Test files to add or modify:

- **`apps/web/src/App.run-workflow.test.tsx`** (extend) — add cases for: Timeline visible immediately
  after submit with `job`/`run` both still pending (using a deferred `createAgentJob` promise); stage
  `job` shows Active then Completed as the deferred promise resolves; no Report/Approval panel rendered
  before `run` exists; existing "no empty panels" behavior for `TraceTimeline`/`ReportPanel` mount timing
  should be asserted explicitly (today it's implicit).
- **New: `apps/web/src/components/InvestigationProgressTimeline.test.tsx`** (or similar name per §9) —
  unit tests for the new stage-list component in isolation: renders Pending/Active/Completed/Failed
  correctly from props; never renders a percentage; elapsed time text updates; stage order is fixed;
  LIVE-only `availability` stage only appears for LIVE submissions.
- **`apps/web/src/components/InvestigationForm.test.tsx`** (extend or confirm) — duplicate-submission
  prevention is already tested (line ~107) — confirm it still passes unchanged; add a case for "submitted
  issue/provider summary remains visible and unchanged while a run is active" if that snapshot moves into
  a new component.
- **Delayed/failure fixture tests** — using the existing deferred-promise pattern, extend
  `App.run-workflow.test.tsx` (or a new `App.progress-timeline.test.tsx`) with: a "delayed" fixture
  (deferred `startAgentRun`) asserting stage `run` shows Active with a non-zero elapsed time before
  resolving; a "failure" fixture per call site (job/run/approval) asserting exactly the failed stage shows
  Failed and later stages remain Pending, matching §6's table.
- **Elapsed timer cleanup** — a test asserting the interval/timer started on submit is cleared on
  unmount and on reaching terminal state (no lingering timer after `phase` returns to `idle`), likely via
  `vi.useFakeTimers()` scoped only to this test (the codebase doesn't use fake timers elsewhere, but
  timer-cleanup assertions are a reasonable, narrow exception).
- **Retry/reset behavior** — confirm `retryRun()`/`startNewInvestigation()` correctly reset stage/elapsed
  state (new `submittedAt`/snapshot fields), reusing the existing `formResetKey` remount test pattern.
- For #35 specifically (if implemented in the same or a follow-up PR): extend
  `App.run-context-layout.test.tsx` (already the most relevant file — it tests reveal ordering/DOM order
  today) with assertions for report → actions → approval sequencing after terminal state, and a
  reduced-motion test (mock `matchMedia`) confirming no transition class/timer is applied.

---

## 9. Files likely to change

*(Descriptions only — no changes made as part of this plan.)*

- **`apps/web/src/App.tsx`** — add `submittedAt`/submitted-snapshot state (or equivalent), derive
  active/completed stage list from existing `phase`/`job`/`run`/`approval` state, mount the new progress
  component immediately after the form (before the current `job !== null` gate), thread it through
  `beginWorkflow()`/`startNewInvestigation()` for reset.
- **New file — `apps/web/src/components/InvestigationProgressTimeline.tsx`** (name to be confirmed with
  owner, see final section) — the actual new component: renders the ordered stage list
  (Pending/Active/Completed/Failed) and the elapsed-time text. **Not** a modification of
  `TraceTimeline.tsx` — confirmed via direct read that `TraceTimeline` renders only `run.trace`
  (`AgentTraceEvent[]`, a backend-reported, post-hoc, 4-variant discriminated union with no timestamps)
  and is a structurally different data source from frontend-known request-lifecycle stages.
  Reusing/renaming `TraceTimeline` would conflate two different concepts; a new component sitting *above*
  it in the render tree is the correct shape for Phase A.
- **`apps/web/src/components/InvestigationForm.tsx`** — likely unchanged for #34 itself (double-submit
  guard and disabled-while-busy already exist), but may need the submitted-summary value threaded out if
  the plan owner wants the snapshot captured here rather than in `App.tsx`.
- **A new small hook, e.g. `apps/web/src/hooks/useElapsedTime.ts`** — isolates the timer logic (start,
  tick, stop/cleanup) so it's independently testable and keeps `App.tsx` from absorbing more imperative
  logic than necessary.
- **`apps/web/src/styles.css`** — new styles for stage rows (Pending/Active/Completed/Failed visual
  states, using existing tokens `--color-*`/`--space-*`/`--radius`), guarded by the existing
  `prefers-reduced-motion` pattern for any transition.
- **`docs/14-web-ui.md`** — §6 ("Timeline rendering model") currently describes only `TraceTimeline`;
  needs a new subsection describing the progress-stage Timeline and how it relates to (but differs from)
  the trace Timeline, plus an update to §9 (Accessibility baseline) covering the elapsed-timer and
  live-region decisions from §7 above.
- **For #35 (if bundled or immediately following):** `App.tsx` render section (`App.tsx:857-892`) changes
  from "everything mounts together on `run !== null`" to sequenced reveal; likely a small new derived
  `revealStage` value and conditional rendering changes in `ReportPanel`/`RunContextPanel` mount points —
  no new component files anticipated here, mostly render-order logic in `App.tsx`.

---

## 10. Risks and non-goals

- **Risk: implying fake backend progress.** Mitigated by §3's design — every stage is tied to a real
  request/response pair; no stage advances on a timer, and no percentage is ever rendered. The dropped
  "Starting agent analysis" / "Completing investigation" rows were specifically rejected because they had
  no real signal to tie to.
- **Risk: duplicate paid runs.** Out of scope for changes here — existing `submittingRef` +
  `disabled={isBusy}` guard is confirmed present and already tested; this plan does not propose touching
  that mechanism, only reading from `phase` to drive stage display.
- **Risk: stale state between retries.** The new `submittedAt`/snapshot state must be reset in the same
  places `job`/`run`/`error` are already reset (`beginWorkflow()`, `startNewInvestigation()`) — called out
  explicitly in §4/§8 so it isn't missed.
- **Timer cleanup.** Called out in §8 as an explicit test requirement — an elapsed-time interval that
  outlives its stage is a real risk given the existing `AbortController`/generation-counter pattern exists
  specifically to prevent this class of bug elsewhere in `App.tsx`.
- **Approval fetch failure ambiguity.** Flagged in §4/§6 — `approval === null` is currently overloaded
  (not-yet-fetched vs. fetched-and-swallowed-error). Needs either a new boolean or reusing/exposing
  `loadApproval`'s internal error signal; small but real scope not mentioned in the original issue text.
- **Mobile layout.** Not separately researched in this pass; the new stage-list component should follow
  existing responsive patterns already validated in `docs/15-live-demo-evidence.md`'s R1-R8 results (same
  card/spacing tokens, no fixed-width assumptions) — recommend a mobile-viewport visual check before
  merging, consistent with how the rest of the app has been validated.
- **Preserving existing idempotency behavior.** No changes proposed to `createAgentJob`/`startAgentRun`
  request logic, headers, or idempotency-key handling — the stage Timeline is purely a read layer over
  existing state transitions.
- **Non-goal reminder:** #36/#37/#38 (backend event contract/persistence/polling), #39 (public LIVE
  trial), #41 (visual refresh) are all explicitly out of scope and untouched by this plan.

---

## Recommended implementation order

1. `useElapsedTime` hook (isolated, easy to unit test first).
2. `InvestigationProgressTimeline` component (pure, prop-driven, testable in isolation against the §3
   stage table).
3. Wire into `App.tsx`: new state (`submittedAt`, submitted snapshot, approval-attempted flag), derive
   stage list from existing `phase`/`job`/`run`/`approval`, mount the new component, reset it alongside
   existing reset points.
4. Extend `App.run-workflow.test.tsx` + new component tests per §8.
5. Docs update (`docs/14-web-ui.md`).
6. Ship #34 as its own PR; start #35 as a follow-up once #34 is merged (§5).

## Open questions requiring owner approval

1. **Naming**: is `InvestigationProgressTimeline` an acceptable name, or does the owner want the existing
   "Investigation timeline" heading/copy repurposed/renamed to disambiguate from the trace Timeline that
   will now sit below it?
2. **"Completing investigation" row**: confirmed-drop (fold into "all stages Completed"), or does the
   owner still want a zero-duration final checkmark row for visual completeness? (§3)
3. **"Starting agent analysis" row**: confirmed-drop in favor of a single "Waiting for investigation
   result" label for the whole `startAgentRun` span, or does the owner want the one-tick "Starting…" flash
   kept anyway for narrative completeness? (§3)
4. **Approval-fetch-failure stage state**: acceptable to add the small new "attempted" flag described in
   §4/§6, or should approval-fetch failures simply never show as a Failed stage (always Pending until it
   succeeds, with the existing `ErrorBanner` doing all the failure communication)?
5. **#34/#35 PR split (§5)**: confirm sequential two-PR approach (C) rather than bundling both in one PR
   (B).

```text
Ready to implement: NO — plan requires owner sign-off on the five open questions above, per this session's
planning-only scope (no code, branch, commit, or GitHub state change permitted in this task).
Recommended PR scope: #34 alone first (InvestigationProgressTimeline + useElapsedTime + App.tsx wiring +
tests + docs), #35 as an immediate follow-up PR.
```
