# OpsPilot — Approval Workflow UX Plan (PR 5C)

| Field | Value |
|---|---|
| Document | Approval Workflow UX Plan — Review Artifact |
| Status | Proposed (planning only — not implemented) — Revision 3, final consistency corrections applied |
| Project | OpsPilot |
| Purpose | Fix the discovered usability bug where the Approve/Reject decision is buried at the bottom of the run-detail page, via a frontend-only two-column layout with a reusable Run Context Panel |
| Related documents | `docs/13-approval-workflow.md` (approval semantics, unchanged by this plan), `docs/14-web-ui.md` (current web UI implementation record) |
| Scope | `apps/web` only. Zero backend/API/database changes. |
| Revision note | Revision 2 resolved a `NOT_ELIGIBLE` rendering contradiction, narrowed the desktop grid so the report stays visually dominant, removed an invalid `calc()` sample, grounded the accessible-announcement claim in the real `App.tsx` notice flow, tightened the anchor/focus claim to a testable one, made the testing-strategy self-consistent, and re-scoped the sticky panel's overflow. Revision 3 makes the run-detail landmark an actual semantic `<section>` (a bare `<div aria-label>` does not reliably expose a `region` role), grounds the timeline-heading `tabIndex` fix in the real file that owns that heading (`App.tsx`, not `TraceTimeline.tsx`), replaces the inaccurate "completely unchanged" description of `ApprovalPanel` with a precise one, distinguishes the accessible-notice wording for a fresh/retried completion versus an explicit refresh of an already-pending run, and replaces an unsupported "zero regression risk" claim about the relocated status-badge helper with a grounded statement plus a new unit test. The overall architecture (top banner, reusable Run Context Panel, sticky desktop context, safe mobile navigation, frontend-only PR 5C, historical-report compatibility) is unchanged. |

## 1. Current UX problem

`apps/web` is a single-page app (`apps/web/src/App.tsx`) with no router. Once an investigation completes, the page renders — in this exact, fixed order, on every viewport width — Header → ErrorBanner/notice → InvestigationForm → InvestigationSummary → a two-column-on-desktop `.investigation-content` grid whose right-hand column stacks `ReportPanel` (category, confidence, summary, root cause, customer impact, recommended resolution, evidence list, suggested-action cards) followed by `ApprovalPanel`.

`ApprovalPanel` is the literal last DOM node on the page. This conflates two states that a reviewer needs to tell apart:

- **investigation execution completed** — the orchestrator finished, a report exists, the page has content.
- **human workflow completed** — a person has actually recorded an Approve/Reject decision.

Today, nothing distinguishes these visually. A completed run *looks* done — status badge, full report, evidence — even when it is only execution-complete and still needs a human decision (`PENDING`). The only way to discover that a decision is outstanding is to scroll past the entire report. On any viewport narrower than 1024px (the only breakpoint in the codebase) this is a single column, so the scroll distance is the full page. Even above 1024px, Approval is still always beneath the entire report within its own column — it is never beside it — so a long report still buries it.

## 2. Current repository findings

**Rendering entry point.** `apps/web/src/main.tsx` mounts a single `<App/>`; there is no `react-router` dependency and no routing of any kind. `App.tsx` is documented in its own comment as "the sole stateful component."

**Component/file map (relevant subset):**

```text
apps/web/src/
  App.tsx                          orchestration + all state + top-level JSX
  styles.css                       one hand-written stylesheet, no framework, one breakpoint (64rem)
  api/types.ts                     ApprovalStatus, ApprovalView, AgentRunDetail, AgentRunOutcomeView
  approval/approval-presentation.ts   presentApproval(status, suggestedActionCount) — pure, exhaustive over ApprovalStatus
  components/
    InvestigationForm.tsx
    InvestigationSummary.tsx       run status badge + IDs; owns a private runStatusPresentation()
    TraceTimeline.tsx              renders run.trace as an <ol>, no timestamps
    ReportPanel.tsx                renders all 3 outcome shapes (RUNNING/FAILED/COMPLETED)
    SuggestedActionCard.tsx
    ApprovalPanel.tsx              4-branch status panel (NOT_ELIGIBLE/PENDING/APPROVED/REJECTED)
    ApprovalDecisionForm.tsx       reviewer name + note + Approve/Reject buttons, double-click guard
    StatusBadge.tsx                shared tone/glyph/label badge (used by run status AND approval status)
    ErrorBanner.tsx
```

**Current state ownership.** All state lives in `App.tsx` via `useState`: `ticketId, job, run, approval, phase, error, notice`. No context, no custom hooks, no external store. `approval: ApprovalView | null` is the single source of truth the whole approval UI reads from.

**Current data flow.** `App.tsx`'s `loadApproval()` is the only function that calls `GET /v1/agent-runs/:runId/approval`. It is invoked after every run creation, Retry Run, and Refresh, and again after a `409` conflict during decision submission. By design it "never throws" — a failed approval fetch must never unwind an already-rendered run/timeline/report (this is asserted by an existing test, see below). `recordApproval()` is the only function that calls `POST .../approval`; its result replaces `approval` directly and drives a notice distinguishing a fresh `201` from an idempotent `200` replay.

**The exact current notice mechanism (grounds §4's revision below).** `App.tsx` owns `const [notice, setNotice] = useState<string | null>(null)` and computes `progressText = isBusy ? PHASE_LABELS[phase] : (notice ?? "")`, rendered in `<p className="notice-region" role="status" aria-live="polite">{progressText}</p>`. Reading every `setNotice` call site directly:

- `runInvestigation` and `retryRun`: `setNotice(null)` at the start; **no `setNotice` call at all** after `loadApproval` resolves — the function simply falls through to `setPhase("idle")`. So today, after a fresh approval-demo investigation resolves to `PENDING`, the notice region shows an **empty string**, not any statement about approval. The plan's prior revision asserted this region "already announces phase transitions" and implied it covers this moment — that claim was not backed by the actual code and is corrected in §4.
- `refreshRun`: after `loadApproval` resolves, unconditionally calls `setNotice("Run refreshed.")`.
- `recordDecision`: sets `"Decision recorded."` (201) or `"This decision was already recorded — nothing changed."` (200 replay); on a `409` in `CONFLICT_APPROVAL_ERROR_CODES`, it does not touch `notice` — the error banner (`role="alert"`) carries that message instead, and the subsequent convergence `loadApproval` call is invoked with `reportError: false` specifically so it does not clobber the 409 banner.

Grepping the whole test suite (`App.approval.test.tsx`, `App.run-workflow.test.tsx`) for `"Run refreshed"` or any `role="status"`/notice-region assertion returns **zero matches** — no existing test currently pins any notice string, so changing this text is safe against the existing suite (confirmed directly, not assumed).

**How the page decides between the four states.** The backend, not the frontend, computes eligibility (`docs/13-approval-workflow.md` §4) — the UI never derives `NOT_ELIGIBLE`/`PENDING`/`APPROVED`/`REJECTED` itself, it only renders whatever `status` the API returns. The single seam is `apps/web/src/approval/approval-presentation.ts`'s `presentApproval(status, suggestedActionCount)`, a pure, exhaustive `switch` returning `{ tone, glyph, badgeLabel, copy, hint, showsDecisionForm }`. `ApprovalPanel.tsx` derives one more boolean itself, `isTerminal = status === "APPROVED" || status === "REJECTED"`, to decide whether to show the read-only `<dl>` decision record instead of the decision form.

**Current desktop/mobile behavior — the exact CSS (`apps/web/src/styles.css`):**

```css
.investigation-content {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-5);
}
@media (min-width: 64rem) {
  .investigation-content {
    grid-template-columns: 1fr 1fr;
    align-items: start;
  }
}
.investigation-content > section { min-width: 0; }
.investigation-report-column {
  display: grid;
  gap: var(--space-5);
  align-content: start;
  min-width: 0;
}
```

Below 1024px: one column, everything stacks top to bottom (form → summary → timeline → report → approval). At/above 1024px: a 2-column, **50/50** grid — left column is the timeline `<section>`, right column is `.investigation-report-column`, itself a single-column grid stacking `ReportPanel` then `ApprovalPanel`. `align-items: start` is already set on the parent grid, which is a precondition this plan relies on (see §4) — without it, a `position: sticky` child would stretch to the row height and sticky would have no visible effect. There is no other breakpoint anywhere in the stylesheet. (The 50/50 split itself is corrected in §2 of this revision — see "Proposed information architecture" and "Responsive layout" below.)

Relevant token values from `:root` in `styles.css`: `--space-3: 0.75rem`, `--space-4: 1rem`, `--space-5: 1.5rem`, `--space-6: 2rem`. `.app-shell` has `max-width: 84rem; padding: var(--space-6) var(--space-5)`.

**No existing scroll/anchor/sticky infrastructure.** A full-tree search (`scrollIntoView`, `scrollTo`, `<a href="#`, `useNavigate`, `react-router`, `position: sticky`, `prefers-reduced-motion`) found zero matches. No `ref` is attached to a DOM node anywhere — the only `useRef` usages are an `AbortController`/generation-counter pair in `App.tsx` (race-safety, not UI) and double-click guards in `InvestigationForm.tsx`/`ApprovalDecisionForm.tsx`. `StatusBadge` is the one reusable status component, already shared between run status and approval status.

**Relevant tests (file : test count / focus):**

- `App.approval.test.tsx` (556 lines, 16 test cases) — full integration coverage of all four statuses, `201`/`200`/both `409` variants, retry/refresh interplay, double-click guard, blank-note omission. Uses `screen.findByText`/`getByRole`, never a CSS selector or DOM-position assertion — confirmed by grep, nothing here couples to `.investigation-report-column` or any class name, and nothing here pins a notice string (see above).
- `App.run-workflow.test.tsx` (435 lines) — broader job/run workflow; every test already mocks a chained approval GET.
- `components/ApprovalPanel.test.tsx` (144 lines) — per-status unit tests, decisionDisabled behavior, null-note rendering.
- `components/ApprovalDecisionForm.test.tsx` (151 lines) — validation, trim, double-click guard, an explicit named `aria-busy` regression test.
- `approval/approval-presentation.test.ts` (50 lines) — pure unit tests of all four `presentApproval` branches.
- `build-guard/forbidden-patterns.test.ts` — unrelated build-hygiene guard (no localhost/absolute API origin/backend-env leaks into the bundle); confirms nothing this plan proposes should introduce an absolute API origin.

**Critically: no existing test protects "the decision is visible without scrolling."** All existing assertions are content-presence checks via Testing Library queries, not positional or viewport checks — a DOM reorder will not break any of them.

**Accessibility already in place:** `role="status" aria-live="polite"` notice region (whose actual coverage is detailed above — it does not yet cover the PENDING-completion moment); `role="alert"` on `ErrorBanner`; `aria-labelledby` sectioning pointing at real heading ids throughout (`timeline-heading`, `report-heading`, `approval-heading`, `investigation-summary-heading`); `aria-busy` tied to the whole-workflow `disabled` flag (not just `submitting`), with an explicit regression test; `aria-hidden` on decorative glyphs since status is never color-only; global `:focus-visible` outline; `<dl>` used for label/value pairs instead of disabled `<input>` fields. No programmatic focus management exists anywhere (no `.focus()` calls), and no `prefers-reduced-motion` handling exists anywhere.

**Documentation discrepancy found:** the planning prompt asked me to inspect `docs/06-browser-demo-walkthrough.md`; no such file exists in this repository. The actual doc numbering is `docs/01` through `docs/14` plus `docs/reviews/*`; the manual browser walkthrough steps actually live in `docs/14-web-ui.md` §11, and `docs/08-cicd-deployment.md` references "completed deterministic and approval browser walkthroughs against the live URL" in prose without a dedicated walkthrough document. This plan is grounded in `docs/14-web-ui.md` §11 for the walkthrough content instead. This is a documentation-inventory note only and does not block this plan.

## 3. Proposed information architecture

**Revision 2 correction (this section resolves the `NOT_ELIGIBLE` contradiction flagged in review):** the prior revision claimed both that `ApprovalPanel` renders "whenever `approval !== null`, including all four statuses" *and* that `NOT_ELIGIBLE` renders `RunOverviewPanel` — mutually exclusive claims. There is now exactly one switch, owned entirely by `RunContextPanel`, with no ambiguity:

```text
approval === null
  → RunOverviewPanel, run facts only. Renders NO eligibility statement of any
    kind — null means "no approval data yet" (still loading, or the last fetch
    failed), never "not eligible." Conflating the two would misinform a
    reviewer into thinking a run permanently has nothing to approve when the
    real cause might be a transient fetch failure.

approval.status === "NOT_ELIGIBLE"
  → RunOverviewPanel, run facts PLUS a compact eligibility note reusing
    presentApproval("NOT_ELIGIBLE", suggestedActionCount)'s existing
    { tone, glyph, badgeLabel, copy, hint } verbatim — not a new hand-written
    string. This is the only state where RunOverviewPanel shows an
    eligibility statement at all.

approval.status === "PENDING"
  → ApprovalPanel (decision semantics unchanged), the one active decision form.

approval.status === "APPROVED" | "REJECTED"
  → ApprovalPanel (decision semantics unchanged), the read-only terminal decision record.
```

**Exact props and responsibilities:**

- **`RunContextPanel`** — `{ run: AgentRunRecordView; trace: readonly AgentTraceEvent[]; approval: ApprovalView | null; suggestedActionCount: number; decisionDisabled: boolean; submittingDecision: boolean; onDecide: (input) => void }`. Pure switch, no state of its own:
  ```tsx
  if (approval === null || approval.status === "NOT_ELIGIBLE") {
    return (
      <RunOverviewPanel
        run={run}
        trace={trace}
        eligibilityNote={approval === null ? null : presentApproval(approval.status, suggestedActionCount)}
      />
    );
  }
  return (
    <ApprovalPanel
      approval={approval}
      suggestedActionCount={suggestedActionCount}
      decisionDisabled={decisionDisabled}
      submittingDecision={submittingDecision}
      onDecide={onDecide}
    />
  );
  ```
- **`RunOverviewPanel`** — `{ run: AgentRunRecordView; trace: readonly AgentTraceEvent[]; eligibilityNote: ApprovalPresentation | null }`. Renders run status badge (via the shared `runStatusBadge`, moved out of `InvestigationSummary`), started/finished/duration, trace-event count (`trace.length`), suggested-action count, a section-nav (`#timeline-heading`, `#report-heading`), and — only when `eligibilityNote !== null` — the reused badge/copy/hint block from `presentApproval`. This is the one and only place `eligibilityNote` is rendered; `RunContextPanel` guarantees it is `null` whenever `approval === null`.
- **`ApprovalPanel`** — **behavior and decision semantics unchanged; two presentation/accessibility attributes added** (Revision 3 correction — the prior wording, "completely unchanged," was inaccurate given §4/§7 already plan a `tabIndex={-1}` on its heading and a `className="approval-note-body"` on its terminal note `<dd>`). Concretely, what stays guaranteed identical to today: exactly one active Approve button and one active Reject button whenever the decision form renders; the existing `201`/idempotent-`200`/both-`409` response handling; `ApprovalDecisionForm`'s existing double-submit guard; and the terminal (`APPROVED`/`REJECTED`) branch remaining fully read-only with zero buttons. What changes is presentational only: the two attribute additions above, plus a routing change made one level up — `RunContextPanel` now only ever mounts `ApprovalPanel` for `PENDING`/`APPROVED`/`REJECTED`, intercepting `NOT_ELIGIBLE` and `null` before `ApprovalPanel` is ever reached. `ApprovalPanel`'s own internal code does not need to "reject" `NOT_ELIGIBLE` — it is simply never handed that prop value anymore.

Because `RunOverviewPanel` calls the existing, exported `presentApproval` function directly rather than re-deriving or hand-copying its `NOT_ELIGIBLE` copy/hint, the "Approval workflow demo" checkbox hint text stays defined in exactly one place (`approval-presentation.ts`) — satisfying the "do not duplicate that copy manually" requirement.

**Visually primary state:** `PENDING` is the state this whole redesign exists to make unmissable — it gets the top-of-page banner (§4) in addition to living in the sticky context panel. `APPROVED`/`REJECTED` are visually calm (read-only record, no controls, no banner) since no action is needed. `NOT_ELIGIBLE` and "approval not yet loaded" are both low-urgency and share `RunOverviewPanel`, but are now visually and semantically distinct from each other per the corrected switch above.

## 4. Interaction design

**Top-level `Action required` treatment.** A new, prop-less, stateless component, `ActionRequiredBanner.tsx`, rendered by `App.tsx` only when `approval?.status === "PENDING"` — a **derived** condition, not new state. It renders a single in-page link:

```tsx
<a className="action-required-banner" href="#approval-heading">
  Investigation completed — action required — review proposed action
</a>
```

**"Review proposed action" navigation — tightened claim (Revision 2).** The anchor-link approach remains the chosen baseline, but the prior revision overstated it as universally guaranteed. Corrected framing:

- Native fragment navigation (`href="#approval-heading"`) is the **low-complexity baseline**: it requires no new refs, no new event handlers, degrades gracefully without JavaScript, and is trivially testable via `getByRole("link")` + an `href` assertion.
- Adding `tabIndex={-1}` to `ApprovalPanel.tsx`'s existing `<h2 id="approval-heading">` makes that heading **programmatically focusable** — a necessary precondition for focus to land there, not a guarantee that every browser will do so on every fragment navigation.
- **Real-browser verification is required, not assumed**, to confirm that the target browsers actually scroll to the section *and* place focus on it when the fragment link is activated (behavior here is standard and broadly supported, but this plan does not claim it is guaranteed without having watched it happen). This check is added explicitly to §10's manual verification list.
- **Contingency, not preemptive addition:** if real-browser verification shows focus does not move reliably, the fallback is the smallest possible explicit implementation — a click handler on the banner's `<a>` that calls `event.preventDefault()`, then `document.getElementById("approval-heading")?.focus({ preventScroll: true })` followed by `.scrollIntoView({ behavior: prefersReducedMotion ? "auto" : "smooth" })` — added only if verification proves the plain anchor insufficient, not built speculatively now. This keeps the initial diff at its current, smallest form (no new refs/handlers in `App.tsx`) unless real evidence says otherwise.

The top prompt still **navigates to the same, single decision panel** rather than duplicating Approve/Reject buttons anywhere else — satisfying the "no duplicate active controls" constraint by construction, since the banner component never imports or renders `ApprovalDecisionForm`, regardless of which navigation mechanism (plain anchor or the contingency fallback) ends up used.

**Sticky desktop panel — overflow re-scoped (Revision 2, see §7 for full reasoning).** The existing `.investigation-content` grid already sets `align-items: start` at `≥64rem`, which is the precondition sticky needs. The corrected, minimal rule — no `max-height`/`overflow-y` at the column level by default:

```css
@media (min-width: 64rem) {
  .run-context-column {
    position: sticky;
    top: var(--space-5);
  }
}
```

`RunContextPanel`'s typical content (a badge, a sentence or two of copy, and either a short form or a short `<dl>`) is a few hundred pixels tall — well within any realistic viewport height — so plain `position: sticky` with no bound is sufficient for the common case and introduces no nested scroll region. The only content that can genuinely exceed a short viewport is a long reviewer note (up to 1000 characters) inside the terminal `<dl>` record; that one element, not the whole column, gets a bounded, scrollable treatment (§7). This also removes the invalid-multiplication `calc()` sample entirely from the default rule (Revision 2's correction to §3 below).

**Decision (recorded per the plan's decision-discipline requirement):** sticky is applied uniformly to the context column regardless of which state it holds (PENDING, APPROVED/REJECTED, or the overview), not conditionally only while PENDING. Rejected alternative: gating sticky to PENDING only, via an extra conditional class. Tradeoff: a uniform rule is simpler (one CSS rule, no state-dependent class) and avoids layout jank exactly at the moment a decision is submitted and status flips PENDING → APPROVED mid-scroll; "stays visible while reading a long report" is also just good UX for the terminal/overview states, not only PENDING. Implementation impact: a single, always-on CSS rule with no JS involvement — reversible to PENDING-only with a one-line class change if the human prefers that instead.

**Mobile behavior (below 64rem, no media query, plain flow).** No raw Approve/Reject buttons are ever pinned early — the only thing that can appear before the report is `ActionRequiredBanner`, which is a link, never the decision buttons themselves. `ApprovalDecisionForm` (the only component that renders Approve/Reject) still only ever renders once, inside `ApprovalPanel`, inside the context panel, in its normal document-flow position after the main content. This satisfies "a compact prompt may navigate to the full action card; decision controls remain inside the complete approval section" by construction.

**Approve/reject loading state, success/error feedback, PENDING → terminal transition.** `App.tsx`'s `phase`/`isBusy`/`error` state, the `201`/`200`/both-`409` handling, and `ApprovalDecisionForm`'s double-click guard are untouched by this plan. The **one** deliberate behavior change (not merely a positioning change) is `notice` text after `loadApproval` resolves — see the accessible-announcement decision immediately below. Everything else about *where* these already-correct states are positioned on the page is unchanged from Revision 1's intent.

**Accessible announcement when the pending state first appears (Revision 2 — corrects an unsubstantiated claim; Revision 3 — corrects the refresh wording to preserve refresh semantics).** §2's grounded finding shows the existing notice region does *not* currently say anything when a run resolves to `PENDING` — `runInvestigation`/`retryRun` never call `setNotice` after `loadApproval`. **Option A is adopted** (updating the existing polite notice rather than adding a second live region), because it fits the existing flow without adding any new ARIA machinery. The exact text now depends on *which* flow produced the `PENDING` result, so an explicit refresh of an already-pending run is never described as if the investigation "just completed":

| Flow | Resulting `approval.status` | Notice text |
|---|---|---|
| `runInvestigation` / `retryRun` (a run just finished or was just retried) | `PENDING` | `"Investigation completed. Human approval required."` |
| `refreshRun` (an explicit refresh of an existing run) | `PENDING` | `"Run refreshed. Human approval required."` — never claims the investigation just completed, since a refresh may be reviewing a run that finished long ago |
| `refreshRun` | anything other than `PENDING` | `"Run refreshed."` (unchanged from today) |

- `loadApproval`'s return type changes from `Promise<void>` to `Promise<ApprovalView | null>` — it already computes and has `result.data` in scope; it simply returns it (or `null` on a reported or stale failure) instead of discarding it. This is the only signature change.
- In `runInvestigation` and `retryRun`, the call site captures the return value and sets the notice **only in these two flows**, immediately before `setPhase("idle")`:
  ```ts
  const loadedApproval = await loadApproval(createdRun.run.id, signal, generation, { reportError: true });
  if (isStale(generation)) return;
  if (loadedApproval?.status === "PENDING") {
    setNotice("Investigation completed. Human approval required.");
  }
  setPhase("idle");
  ```
- In `refreshRun`, the existing unconditional `setNotice("Run refreshed.")` is made conditional on a **refresh-flavored** message, not the fresh-completion one, so the more urgent "approval required" fact still takes priority without ever misrepresenting a refresh as a completion:
  ```ts
  const loadedApproval = await loadApproval(refreshedRun.run.id, signal, generation, { reportError: true });
  if (isStale(generation)) return;
  setNotice(loadedApproval?.status === "PENDING" ? "Run refreshed. Human approval required." : "Run refreshed.");
  setPhase("idle");
  ```
- `recordDecision`'s 409-convergence call site (`{ reportError: false }`) is **left exactly as is** — it does not need this check at all, because per `docs/13-approval-workflow.md`'s state machine, a `409` can only converge to `APPROVED`/`REJECTED` (from `AGENT_RUN_APPROVAL_ALREADY_DECIDED`) or `NOT_ELIGIBLE` (from `AGENT_RUN_NOT_APPROVAL_ELIGIBLE`) — it can never converge to `PENDING`, so there is no case here that this new logic would ever apply to, and no risk of it clobbering the 409 error banner's own message.

**Why Option A over Option B (giving the banner its own announcement):** a second live region announcing the same fact the notice region could just as easily say would be a duplicate/competing announcement for screen-reader users (two `aria-live` regions updating for the same event), which the prompt explicitly warns against. Updating the one existing, already-tested notice pathway is strictly additive to a mechanism that's already correct, and keeps the accessible announcement and the visual banner cleanly decoupled — the banner is a discoverability aid for sighted/pointer users, the notice text is the AT-facing correctness guarantee, and both are driven by the same underlying `approval.status === "PENDING"` fact without one depending on the other's implementation.

**Implementation impact:** one changed return type (`loadApproval`), three call sites gain a short conditional (`runInvestigation`, `retryRun`, `refreshRun`), zero new state, zero new live regions. `recordDecision` is untouched. This is a small, precise addition to `App.tsx`'s existing logic — no longer "JSX-restructure only," but still confined to `App.tsx`, still zero new dependencies, and still fully compatible with the existing race-safety mechanism (the new logic only runs after the existing `isStale(generation)` guard, exactly like every other post-await step in these functions).

**No auto-focus, no auto-scroll.** Nothing above changes the "never automatically jump or focus the user anywhere on run completion" constraint — the notice-text change is a passive announcement a screen reader will read, not a focus or scroll action, and the banner requires an explicit click to navigate anywhere.

**Layout behavior after refresh.** Refresh re-fetches the run and then approval exactly as today; since the banner and context-panel content are purely derived from `approval`/`run` state (no new state to go stale beyond the one `notice` string change above), a refresh that changes `approval.status` automatically updates both the banner's presence and the context panel's content with no extra wiring.

**Long reviewer notes / long proposed actions.** See §7 for the corrected, narrowly-scoped overflow treatment. `SuggestedActionCard`'s existing bounded, scrollable body (`max-height: 12rem; overflow-y: auto`) is unchanged and still lives in the main content column, not the context panel.

**Reduced motion.** One global CSS rule, no JS:

```css
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
}
```

## 5. Historical-report compatibility

`RunContextPanel` and `RunOverviewPanel` take only `run`/`trace`/`approval`/decision-callback props — nothing about them depends on the current single-page, no-router architecture. When a future milestone adds a historical-run list, that list's "open a run" action can render the same `.investigation-content` grid (main column + `RunContextPanel`) per selected run, unmodified. The banner and the sticky-column CSS are scoped to the run-detail page's existing markup structure and require no changes either way — a list+detail view would presumably reuse the same grid per selected row. This plan does not implement the list (explicitly out of scope), but does not foreclose it either.

## 6. Accessibility

- **Semantic structure (Revision 3 correction):** the context panel is a new `<aside aria-label="Run context">` landmark — a real semantic element, already a landmark by default, so `aria-label` on it reliably yields an accessible name. The main-content wrapper is implemented the same way, not as a bare `<div aria-label>` (which does **not** reliably expose a `region` role to assistive technology): `<section aria-label="Run detail" className="investigation-main-column">`. A native `<section>` with an accessible name is exposed with an implicit ARIA `region` role per the HTML Accessibility API Mappings spec, which is exactly what makes `getByRole("region", { name: /run detail/i })` (§9) a valid, real query rather than one that would silently fail to match anything. Existing `aria-labelledby` sectioning is preserved; `ReportPanel`'s `<h2 id="report-heading">` also gains `tabIndex={-1}` to serve as a section-nav target from the new overview panel, and so does the existing `<h2 id="timeline-heading">` — which is rendered directly in `App.tsx`'s own JSX (wrapping `<TraceTimeline trace={run.trace} />`), not inside `TraceTimeline.tsx` itself, so the `tabIndex={-1}` addition for timeline navigation lands in `App.tsx`, not a new change to `TraceTimeline.tsx` (§8).
- **Focus management:** the only new focus behavior is native browser fragment-navigation focus (via `tabindex="-1"` on the anchor target), triggered by an explicit user click on the banner link — never forced automatically on page load or run completion. Per §4's tightened claim, this is verified in a real browser, not assumed, and a small JS fallback exists as a documented contingency only.
- **`aria-live`:** no new live region is added. Per §4's corrected accessible-announcement decision, the existing `role="status" aria-live="polite"` notice region is updated with one of three exact strings depending on which flow produced a `PENDING` result — `"Investigation completed. Human approval required."` for a fresh completion or retry, `"Run refreshed. Human approval required."` for an explicit refresh of an already-pending run (never claiming the investigation "just completed" when it was merely re-fetched), and the unchanged `"Run refreshed."` for a refresh that resolves to anything else — grounded in the real `App.tsx` code paths, not asserted without evidence.
- **Reduced motion:** `prefers-reduced-motion: reduce` disables `scroll-behavior: smooth` globally, falling back to instant jump — CSS-only, as above.
- **Keyboard navigation:** the banner is a native `<a>`, focusable and activatable with Tab/Enter with no custom key handling. No behavior changes to `ApprovalDecisionForm`'s existing deliberate non-wiring of Enter-to-submit (unchanged, since the form itself is unmodified).
- **Sticky panel not obscuring content:** the default sticky rule has no `max-height`, since typical context-panel content is short; the one element that can genuinely overflow (a long reviewer note) gets its own bounded, internally-scrollable treatment instead of the whole column (§7) — so the sticky panel cannot grow to cover the main column, and there is no column-level scrollbar to conflict with page scroll.
- **Mobile controls:** unchanged from today structurally — Approve/Reject remain inside `ApprovalDecisionForm`, inside `ApprovalPanel`, reached via normal scroll or via the banner's link; never duplicated, never pinned as raw buttons ahead of the full card.
- **Terminal state announcement:** unchanged — `ApprovalPanel`'s existing terminal `<dl>` rendering (reviewer/note/decidedAt, zero buttons) is reused verbatim; `StatusBadge`'s "never color-only" glyph+text convention is preserved since `StatusBadge` itself is untouched.
- Per the prompt's explicit instruction: this plan does **not** recommend forcing focus unexpectedly (e.g., auto-focusing the panel on run completion) — focus only moves in direct response to an explicit banner click, and the new notice text is an announcement, not a focus change.

## 7. Responsive layout

**Revision 2 correction — desktop grid narrowed so the report stays visually dominant.** The prior 50/50 `1fr 1fr` split gave the context panel as much width as the report, compressing the primary reading surface. Corrected grid:

```css
@media (min-width: 64rem) {
  .investigation-content {
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
    align-items: start;
  }
}
```

- **Why the report/timeline remains the primary reading surface:** the main column is `minmax(0, 1fr)` — a flexible track that absorbs all space left over after the context column claims its own width. The context column is capped at `22rem` (352px), so on any realistically wide screen the main column keeps growing while the context column stays a fixed, readable width rather than expanding to match it.
- **Why the context column has a useful minimum and maximum:** `18rem` (288px) is enough for the reviewer-name input, the two-button Approve/Reject row, and the terminal `<dl>` without visually cramping them; `22rem` (352px) caps it so it never becomes a second dominant column, which is the exact defect being corrected here. Both bounds are chosen relative to the existing `--space-*` scale and the content this panel actually holds (a badge, a sentence or two, a short form or a short record) — not an arbitrary design-system value.
- **What happens near the existing `64rem` breakpoint:** grounded in the repository's real container math (`.app-shell`: `max-width: 84rem`, `padding: var(--space-6) var(--space-5)` = 2rem/1.5rem). At exactly a 1024px (`64rem`) viewport, content width is `1024 − 2×24px = 976px`; subtracting the grid `gap` (`var(--space-5)` = 24px) leaves 952px for both tracks. The context column resolves to its max (352px, since 952px comfortably covers it), leaving **~600px for the main column** — a large, comfortable majority-main split, in contrast to the prior 50/50 split's ~464px/~464px at the same viewport width. **No second breakpoint is introduced or needed**: this arithmetic shows no squeeze occurs right at the point the grid activates, so a second (e.g. tablet) breakpoint would be scope creep with no repository-grounded justification.
- **How long content wraps safely:** `ApprovalDecisionForm`'s `input`/`textarea` sit inside `.form-field`, a `flex-direction: column` container — flex's default `align-items: stretch` already makes them fill the column's width with no extra CSS, so they naturally narrow to fit an 18–22rem column. `.approval-decision-actions` (the Approve/Reject button row) gains `flex-wrap: wrap` so the two buttons (whose labels grow to "Approving…"/"Rejecting…" while submitting) can drop to a second line instead of overflowing at the narrow end of the column's range, rather than assuming they always fit on one line. The terminal `<dl>`'s existing `grid-template-columns: repeat(2, minmax(0, 1fr))` (defined globally for all `<dl>` elements) puts two label/value pairs per row — comfortable in a full-width report `<dl>`, but cramped for a "Decided at" timestamp or a multi-word reviewer name at 18–22rem. A scoped override, `.run-context-column dl { grid-template-columns: 1fr; }`, switches to one pair per row specifically inside the narrower context column, without touching the shared `dl` rule used elsewhere (report fields, investigation summary).

**Mobile (< 64rem):** unchanged from Revision 1 — single column, plain document flow, no sticky, `ActionRequiredBanner` (only if `PENDING`) appears above the main content, and no raw buttons are ever pinned early.

CSS additions (all reuse existing `--space-*`/`--color-*` custom-property tokens; no new tokens, no new framework, no new dependency):

```css
html { scroll-behavior: smooth; }
@media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

.investigation-content {
  display: grid;
  grid-template-columns: 1fr;
  gap: var(--space-5);
}
@media (min-width: 64rem) {
  .investigation-content {
    grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
    align-items: start;
  }
}

.investigation-main-column {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}

.run-context-column {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  min-width: 0;
}
@media (min-width: 64rem) {
  .run-context-column {
    position: sticky;
    top: var(--space-5);
  }
}

.run-context-column dl {
  grid-template-columns: 1fr;
}

.approval-decision-actions {
  flex-wrap: wrap;
}

.action-required-banner {
  display: block;
  background: var(--color-info-bg);
  color: var(--color-info-text);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: var(--space-4);
  font-weight: 600;
  text-decoration: none;
}
.action-required-banner:hover,
.action-required-banner:focus-visible {
  text-decoration: underline;
}

.run-overview-nav {
  display: flex;
  gap: var(--space-4);
  margin-top: var(--space-3);
}

/* The one narrowly-scoped overflow region — see §7's "Re-evaluate nested
   scrolling" discussion. Applied only to a long reviewer note's value, never
   to the whole sticky column. */
.approval-note-body {
  margin-top: var(--space-1);
  max-height: 12rem;
  overflow-y: auto;
  white-space: pre-wrap;
}
```

`RunOverviewPanel` needs no new card-background rule: the existing descendant selector `.investigation-content section` already styles any `<section>` nested anywhere inside `.investigation-content`, so a `<section className="run-overview-panel">` picks up the existing card look for free. **Cleanup note:** the old rule `.investigation-content > section { min-width: 0; }` becomes dead code once the timeline section is no longer a direct grid child (it will be nested one level deeper, inside `.investigation-main-column`, which now carries its own `min-width: 0`) — this selector should be deleted as part of the implementation, not left behind.

**Re-evaluate nested scrolling (Revision 2 — direct answer to the flagged risk).** The prior revision's `.run-context-column { max-height: calc(100vh - var(--space-5) * 2); overflow-y: auto; }` was wrong twice over: it used multiplication inside `calc()` (corrected form, if ever needed again, would be `calc(100vh - var(--space-5) - var(--space-5))`), and it made the *entire* context column an internally-scrollable region regardless of whether its content could ever actually overflow — creating a nested-scroll hazard (page scroll, column scroll, and the terminal record's own content potentially fighting for wheel/touch/keyboard input) for no benefit in the common case. The corrected progression, applied exactly as the review requested:

1. **Sticky, no internal scrolling, for normal content** — the default and by far the common case (badge + short copy + form, or badge + short `<dl>`). This is the rule shown above: `position: sticky; top: var(--space-5);` with nothing else.
2. **A viewport-bound max-height is applied only where content can genuinely exceed the viewport** — identified as exactly one place: the terminal decision record's `note` value (client-validated up to 1000 characters, per `RecordApprovalDecisionInputSchema`). Nowhere else in `RunOverviewPanel` or `ApprovalPanel`'s non-terminal branches has unbounded-length content.
3. **Internal scrolling is scoped to that one element**, reusing the same bounded pattern `SuggestedActionCard`'s body already uses elsewhere in this codebase (`max-height: 12rem; overflow-y: auto; white-space: pre-wrap`), given a dedicated class, `.approval-note-body`, rather than inventing a new pattern. `ApprovalPanel.tsx`'s terminal `<dl>` gains this class on the note's `<dd>` only — a one-line JSX change (`<dd className="approval-note-body">{approval.note ?? "No note provided"}</dd>`), not a CSS-only addition, since it also requires wrapping the specific `<dd>`.

**Which element owns overflow, stated exactly:** the sticky `.run-context-column` itself never scrolls internally and has no `max-height` — it can grow as tall as its content and simply stops "sticking" once its containing block's end (the bottom of the grid row, i.e. the end of the report) scrolls past, exactly like any other `position: sticky` element with no additional constraint. Only the note `<dd>` inside a terminal `ApprovalPanel` record owns its own scroll region, and only when its content is long enough to need one (`max-height: 12rem` is well above what a typical one- or two-sentence note needs, so it is invisible/inert for ordinary notes). This keeps keyboard/wheel/touch behavior unsurprising: page scroll and the (rare) note scroll are the only two active scroll regions, never three.

## 8. File-by-file implementation map

| File | Action | Notes |
|---|---|---|
| `apps/web/src/App.tsx` | **Modify** | JSX restructure: wrap timeline+report in `<section aria-label="Run detail" className="investigation-main-column">` (a real semantic landmark, not a bare `<div aria-label>` — see §6), add `<aside className="run-context-column" aria-label="Run context">` housing `RunContextPanel`, add derived `showActionRequiredBanner = approval?.status === "PENDING"` and conditional `ActionRequiredBanner`. The existing `<h2 id="timeline-heading">` — rendered directly in this file's JSX, not inside `TraceTimeline.tsx` — gains `tabIndex={-1}` alongside `ReportPanel`'s and `ApprovalPanel`'s headings, for section-nav parity. **Plus** the small, grounded logic change from §4: `loadApproval` returns `Promise<ApprovalView \| null>` instead of `Promise<void>`, and `runInvestigation`/`retryRun`/`refreshRun` each set the appropriate one of the three `PENDING`-aware notice strings after it resolves (§4's table). No changes to `phase`, race-safety, or the `201`/`200`/`409` decision-handling logic. |
| `apps/web/src/components/RunContextPanel.tsx` | **Create** | Three-way switch per §3's corrected logic: `RunOverviewPanel` for `approval === null` or `NOT_ELIGIBLE`, `ApprovalPanel` (decision semantics unchanged) for `PENDING`/`APPROVED`/`REJECTED`. |
| `apps/web/src/components/RunOverviewPanel.tsx` | **Create** | Run summary, final status, started/completed time, trace-event count, suggested-action count, section nav (`#timeline-heading`, `#report-heading`), and the optional reused `eligibilityNote` block (only for `NOT_ELIGIBLE`, never for `null`). |
| `apps/web/src/components/ActionRequiredBanner.tsx` | **Create** | Stateless anchor link to `#approval-heading`. |
| `apps/web/src/run/run-overview-presentation.ts` | **Create** | Houses `runStatusBadge(status)`, moved (intended to be behavior-identical, see the grounded note below) out of `InvestigationSummary.tsx`'s private helper so `RunOverviewPanel` can share it. |
| `apps/web/src/run/run-overview-presentation.test.ts` | **Create** | New unit test for the extracted `runStatusBadge` (§9) — covers all statuses the current private helper already handles: `"COMPLETED"`, `"FAILED"`, `"RUNNING"`, and the default/unknown-string branch. |
| `apps/web/src/components/ApprovalPanel.tsx` | **Modify** | `tabIndex={-1}` on the existing `<h2 id="approval-heading">`; the terminal note `<dd>` gains `className="approval-note-body"` (§7). These are the plan's only two changes to this component — see §3's corrected description ("behavior and decision semantics unchanged; two presentation/accessibility attributes added"). Still only ever rendered for `PENDING`/`APPROVED`/`REJECTED`. |
| `apps/web/src/components/ReportPanel.tsx` | **Modify** | One-line addition: `tabIndex={-1}` on the existing `<h2 id="report-heading">`. No other change. |
| `apps/web/src/components/InvestigationSummary.tsx` | **Modify** | Delete private `runStatusPresentation`, import shared `runStatusBadge` instead. The move is intended to be behavior-preserving, not asserted as risk-free — this component has no existing dedicated test file, so the change is covered instead by (a) the existing `App.approval.test.tsx`/`App.run-workflow.test.tsx` suites, which already render `InvestigationSummary` and assert on the run-status badge it produces, and (b) the new `run-overview-presentation.test.ts` unit test covering the extracted function directly. |
| `apps/web/src/styles.css` | **Modify** | Narrowed desktop grid, sticky rule with no column-level overflow, `.approval-note-body`, `.run-context-column dl` override, `.approval-decision-actions { flex-wrap: wrap; }`, plus deleting the now-dead `.investigation-content > section` rule. |
| `apps/web/src/App.run-context-layout.test.tsx` | **Create** | New, focused test file (see §9) — kept separate from the existing 556-line `App.approval.test.tsx` rather than growing it further. |
| `apps/web/src/App.approval.test.tsx`, `App.run-workflow.test.tsx`, `components/ApprovalPanel.test.tsx`, `components/ApprovalDecisionForm.test.tsx`, `approval/approval-presentation.test.ts` | **Untouched** | None of their ~20+ assertions depend on `ApprovalPanel`'s DOM ancestry, any class name, or any notice string — verified by grep (§2). |
| `apps/api/**`, `packages/contracts/**`, `packages/database/**`, `docs/13-approval-workflow.md` | **Untouched** | No backend/API/database/contract files are touched by this plan. |

**Backend contract confirmation:** zero backend files change. `ApprovalStatus`, `ApprovalView`, `presentApproval`'s inputs/outputs, and the `201`/`200`/`409`×2 decision-handling logic in `App.tsx` are all reused exactly as they exist today. No new dependency is added; no design system or CSS framework is introduced.

## 9. Testing strategy

**Revision 2 correction — internal consistency.** The prior revision claimed "every assertion uses role/name queries," which was contradicted by its own source-order test, which located the main-content container via a raw CSS class selector before calling `compareDocumentPosition()`. Corrected approach: give the main-content wrapper a real accessible name **on a real semantic element** (`<section aria-label="Run detail">`, §6/§8 — Revision 3 corrected this from a bare `<div aria-label>`, which would not reliably expose a `region` role and would make the query below silently fail to match) and locate **both** compared elements via `getByRole`, so the DOM-order check operates on accessibly-located elements rather than a class selector:

```ts
const banner = screen.getByRole("link", { name: /action required/i });
const runDetail = screen.getByRole("region", { name: /run detail/i });
expect(banner.compareDocumentPosition(runDetail) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
```

This query is valid specifically because the wrapper is a native `<section>` with an accessible name — per the HTML-AAM spec a `<section>` only maps to the `region` role when it has an accessible name, which `aria-label="Run detail"` provides; a bare `<div aria-label="Run detail">` has no such role mapping at all and this same query would return nothing.

This is stated plainly as what it is: `compareDocumentPosition` is a structural DOM-order regression check, not a simulation of user-perceived visual order (jsdom has no layout engine, so DOM order and visual order are related but not proven equivalent by this assertion) — it exists to catch an accidental reordering of these two elements in the JSX, not to assert anything about what a sighted user actually sees first. Every *element* referenced across this test file is located via `getByRole`/`getByLabelText`/`queryByRole`; the one `compareDocumentPosition` call is a plain DOM comparison applied to two such elements, and is called out explicitly as the file's only non-behavioral, structural assertion rather than folded silently into a blanket "every assertion is a user-behavior query" claim.

New, focused file: `apps/web/src/App.run-context-layout.test.tsx`, reusing the existing mock-`fetch`/response-builder helpers already present in `App.approval.test.tsx`'s style. Since jsdom has no real box layout, "visible without scrolling" is tested structurally, not positionally-in-pixels:

1. **Pending banner presence is state-derived:** render through to `PENDING` → `screen.getByRole("link", { name: /action required/i })` exists with `href="#approval-heading"`. Render through `NOT_ELIGIBLE`/`APPROVED`/`REJECTED` → `screen.queryByRole("link", { name: /action required/i })` is `null`.
2. **Banner precedes the main content region in source order** — the corrected, role/name-based `compareDocumentPosition` check above.
3. **No duplicate active decision controls:** at `PENDING`, assert exactly one `getAllByRole("button", { name: "Approve" })` and exactly one `"Reject"` exist anywhere in the rendered document — a direct guard against `ApprovalPanel` accidentally rendering twice.
4. **`RunContextPanel`'s corrected three-way switch:** `approval === null` (e.g. mid-`loading-approval` phase, or after a reported approval-fetch failure) → `RunOverviewPanel`'s run-facts content is present, but **no** "not eligible"/eligibility copy of any kind is present (`queryByText` for the `NOT_ELIGIBLE` hint text returns `null`) — this is the direct regression test for the contradiction this revision fixes. `NOT_ELIGIBLE` → the same run-facts content **plus** the reused eligibility badge/copy/hint (`screen.getByText` matching `presentApproval("NOT_ELIGIBLE", …).copy` exactly, proving reuse rather than a duplicated string). `PENDING`/`APPROVED`/`REJECTED` → the overview heading is absent and `ApprovalPanel`'s real content is present instead.
5. **`PENDING → APPROVED` and `PENDING → REJECTED`:** after a decision is recorded, the banner disappears (since `approval.status` is no longer `PENDING`) and the terminal `<dl>` record appears.
6. **Terminal decision view is read-only:** re-assert (in this new file, focused only on the layout aspect) zero buttons render inside the context panel once terminal.
7. **Accessible announcement, all three wordings (Revision 3 — direct test for §4's corrected three-way fix):** after `submitDemo`'s chained investigation resolves to `PENDING`, assert `screen.getByRole("status")` contains text matching `/investigation completed/i` and `/human approval required/i`. After an ordinary (`NOT_ELIGIBLE`) investigation, assert the status region does **not** contain that text. After clicking **Refresh** on an already-`PENDING` run, assert the status region shows exactly `"Run refreshed. Human approval required."` — **not** the fresh-completion wording, since a refresh must never claim the investigation "just completed" — a direct regression test for the refresh-wording correction in §4. After refreshing a `NOT_ELIGIBLE` run, assert it still shows the unchanged `"Run refreshed."`
8. **Error/retry and refresh/re-fetch behavior:** confirm the banner/overview toggling and the new notice logic still track `approval` correctly through the existing Retry Run and Refresh flows.
9. **Section-nav targets are focusable:** assert `document.getElementById("timeline-heading")`, `("report-heading")`, and `("approval-heading")` all have `tabIndex === -1` — including `timeline-heading`, whose heading element lives in `App.tsx`'s own JSX, not `TraceTimeline.tsx` (§6/§8), so this assertion is exercised against `App.tsx`'s rendered output, not a `TraceTimeline` unit test.
10. **Existing suites re-run unmodified:** `App.approval.test.tsx`, `App.run-workflow.test.tsx`, `components/ApprovalPanel.test.tsx`, `components/ApprovalDecisionForm.test.tsx`, and `approval/approval-presentation.test.ts` should all pass with zero edits — verified directly (§2's grep), not assumed.
11. **`run-overview-presentation.test.ts` (new, standalone unit test — direct response to Revision 3's "zero regression risk" correction):** covers `runStatusBadge` for all four branches the current private `InvestigationSummary.tsx` helper already supports — `"COMPLETED"` → `{ tone: "success", glyph: "✓" }`, `"FAILED"` → `{ tone: "danger", glyph: "✕" }`, `"RUNNING"` → `{ tone: "info", glyph: "●" }`, and an unrecognized string → the default `{ tone: "neutral", glyph: "—" }`. This test exists specifically so the helper relocation is verified, not merely asserted to be safe.

**Explicitly requires real-browser/manual verification — jsdom cannot prove any of these:**

- Actual `position: sticky` behavior (jsdom has no layout engine at all; sticky positioning cannot be exercised or asserted in a unit test).
- No-scroll initial visibility of the pending decision on a real viewport (a pixel/viewport fact, not a DOM-structure fact).
- Real fragment scrolling and focus landing on `#approval-heading` when the banner is activated (per §4's tightened claim — this is the actual thing being verified, not assumed).
- `prefers-reduced-motion`-driven instant vs. smooth scroll (CSS media feature with no jsdom equivalent).
- The note's nested-overflow behavior under real keyboard/wheel/touch input (§7) — confirming the one narrow scroll region behaves predictably and doesn't fight the page scroll.

## 10. Manual verification plan

Performed in a real browser (`pnpm --filter @opspilot/web run dev`), not just via automated tests, because jsdom cannot render real box layout, real `position: sticky`, or real `prefers-reduced-motion`:

- **Desktop wide viewport (e.g. 1440×900):** run an approval-demo investigation; confirm the Approve/Reject decision form is visible without scrolling once the run completes, that the report column is visibly the dominant reading surface (not a 50/50 split), and that the context panel stays visible (sticky) while scrolling the report beside it.
- **Narrow/mobile viewport (e.g. 375×812):** confirm the `Action required` banner is visible near the top without scrolling; confirm no raw Approve/Reject button is visible without deliberately scrolling or tapping the banner.
- **Normal (non-demo) run:** confirm the overview panel renders run facts with no eligibility statement while `approval` is still loading, then the reused `NOT_ELIGIBLE` badge/copy/hint appears once it resolves; confirm no banner appears at any point; confirm the "Approval workflow demo" checkbox hint text is intact (unchanged copy, reused from `presentApproval`).
- **Pending approval run:** confirm the notice region announces completion and required approval (read it with a screen reader, not just visually); confirm banner → click → smooth scroll (or instant, under reduced motion) lands on and focuses the "Approval" heading — and if it does not focus reliably, note this as the trigger for the documented JS-fallback contingency (§4).
- **Refresh of an already-pending run:** confirm the notice reads `"Run refreshed. Human approval required."`, not the fresh-completion wording — a real-browser sanity check for §4's refresh-wording correction, alongside the automated test in §9.
- **Approved run / Rejected run:** confirm the terminal record renders read-only in the context panel, no banner, no buttons.
- **Long timeline/report:** confirm the sticky panel (no `max-height` in the default case) never grows to obscure content or collide with the viewport edge under ordinary content lengths.
- **Long reviewer note (near 1000 characters):** confirm the note's own `.approval-note-body` scroll region behaves predictably with keyboard, mouse wheel, and touch, and does not create a confusing double-scroll interaction with the page.
- **Keyboard-only use:** Tab to the banner, press Enter, confirm focus visibly lands on the "Approval" heading (real browser `tabindex="-1"` fragment-focus behavior — the actual thing §4 requires verifying rather than assuming).
- **Reduced-motion setting:** toggle OS-level "reduce motion," confirm the banner's jump becomes instant instead of smooth.
- **Live deployed verification after merge:** repeat the pending-approval-run walkthrough against the real deployed URL as part of PR 5D (out of scope for this PR, listed here only for continuity).

## 11. PR boundary

**PR 5C (this plan) — frontend approval/run-detail UX only:**
- New: `RunContextPanel.tsx`, `RunOverviewPanel.tsx`, `ActionRequiredBanner.tsx`, `run-overview-presentation.ts`, `run-overview-presentation.test.ts`, `App.run-context-layout.test.tsx`.
- Modified: `App.tsx` (JSX restructure — including the real semantic `<section aria-label="Run detail">` wrapper and the `timeline-heading` `tabIndex` fix, since that heading lives here, not in `TraceTimeline.tsx` — plus the small, grounded `loadApproval`/three-way-notice-text change from §4), `ApprovalPanel.tsx` (behavior and decision semantics unchanged; two presentation/accessibility attributes added — `tabIndex` on its heading, `className` on the note `<dd>`), `ReportPanel.tsx` (one attribute), `InvestigationSummary.tsx` (helper relocation, covered by existing App-level tests plus the new unit test), `styles.css` (narrowed grid, sticky rule, scoped overrides, one dead-rule removal).
- One active Approve button, one active Reject button, existing `201`/idempotent-`200`/`409` handling unchanged, existing double-submit protection unchanged, backend/API/database untouched, no historical list, no live-deployment evidence, no deployed-RAG claim.

**PR 5D (separate, not started here):**
- Real public URL walkthrough evidence, screenshots, cold-start observations, portfolio-ready documentation. Does not touch application code. Must not be mixed with this PR's frontend diff, and must not claim the deployed browser flow performs RAG.

## 12. Risks and alternatives

| Alternative | Verdict | Why |
|---|---|---|
| **Sticky context panel + top banner (chosen)** | Selected | Banner solves discoverability the instant the run completes; sticky solves staying-visible while the reviewer reads a long report. They address different moments and are not redundant with each other. |
| **Top banner only, no sticky** | Rejected | Gets the user to the panel once, but scrolling further to re-read the report loses the controls again — a milder recurrence of the original bug. |
| **Duplicated Approve/Reject controls (top and bottom)** | Rejected | Explicitly forbidden by the product direction; also creates a real hazard for an irreversible decision. |
| **Modal/drawer for the decision form** | Rejected | Blocks side-by-side reading of the report while deciding; adds focus-trap/dismiss complexity and is a materially larger diff for no stated benefit. |
| **Accordion / collapsed-by-default decision section** | Rejected | Contradicts "must expose an obvious... prompt" — requires an extra click just to discover a decision is even needed. |
| **Automatic scroll-to-bottom on run completion** | Rejected | Explicitly forbidden by the product direction. |
| **50/50 desktop grid split (prior revision)** | Rejected in this revision | Gave contextual controls as much width as the primary reading surface, compressing the report/timeline; replaced with `minmax(0,1fr) minmax(18rem,22rem)` (§7). |
| **Whole-column sticky overflow with `max-height`/`overflow-y: auto` (prior revision)** | Rejected in this revision | Created an unnecessary nested-scroll region for the common (short-content) case and relied on an invalid `calc()` multiplication; replaced with plain sticky by default and a narrowly-scoped scroll region on just the long-note element (§7). |
| **A second (tablet) breakpoint for the grid** | Rejected | The `64rem`-viewport arithmetic in §7 shows no squeeze occurs right at the point the grid activates — no repository-grounded need for one. |

## 13. Acceptance criteria

- [ ] A pending decision is visible without scrolling to the bottom (banner on all viewports; sticky panel on desktop).
- [ ] The user can tell "investigation complete" apart from "human action still pending" — both visually (banner + context-panel state) and for assistive technology (the grounded notice-text change, §4).
- [ ] Active decision buttons exist in exactly one location — guarded by an explicit test.
- [ ] The report/timeline remains the visually dominant reading surface on desktop (narrowed grid, §7), while the decision context remains available (sticky context column).
- [ ] Mobile users can reach the full action safely, with no raw buttons pinned before review.
- [ ] Terminal decisions render read-only (unchanged `ApprovalPanel` terminal branch, reused verbatim).
- [ ] `approval === null` is never presented as "not eligible" — the two are visually and textually distinct (§3).
- [ ] Zero backend/API/database contract changes.
- [ ] The existing normal (non-demo) investigation flow is unaffected.
- [ ] The layout generalizes to a future historical-run list without another redesign.
- [ ] No `calc()` multiplication anywhere in the stylesheet; no unscoped nested-scroll region.
- [ ] Tests are internally consistent about which queries are role/name-based versus the one documented structural DOM-order check; accessibility coverage and manual verification are explicit, including exactly what jsdom cannot prove (§9, §10).
- [ ] The run-detail landmark is a real semantic element with an accessible name (`<section aria-label="Run detail">`), not a bare `<div aria-label>` that would not reliably expose a `region` role (§6, §9).
- [ ] The accessible notice text is contextually accurate: a fresh completion/retry says the investigation completed, while an explicit refresh of an already-pending run says the run was refreshed — never the reverse (§4).
- [ ] `ApprovalPanel` is described accurately as behavior/decision-semantics-unchanged with two named presentation/accessibility attributes added, not as "completely unchanged" (§3).
- [ ] The `runStatusBadge` helper relocation is verified by a dedicated unit test, not asserted as risk-free by the absence of an existing test file (§9).

## Decision log (grounded choices made without escalating to the human)

- **Sticky applies uniformly across all context-panel states, not gated to `PENDING` only.** Rejected alternative: PENDING-only sticky via a conditional class. Recorded as a one-line-reversible judgment call in case the human prefers PENDING-only.
- **`RunOverviewPanel`'s presentation logic reuses `presentApproval` directly for its `NOT_ELIGIBLE` note, rather than either duplicating its copy or extending `presentApproval`'s own contract.** Reason: keeps the "Approval workflow demo" hint text defined in exactly one place, and keeps `presentApproval`'s 4-branch, fully-exhaustive `ApprovalStatus` contract clean rather than growing it to also describe run-summary facts it has no need to know about.
- **Anchor-link (`href="#approval-heading"` + `tabIndex={-1}`) chosen as the baseline, with an explicit, non-preemptive JS-fallback contingency.** Reason: zero new refs/handlers unless real-browser verification proves the native behavior insufficient — avoids speculative complexity while leaving a concrete, small fallback ready to add if evidence calls for it.
- **No second (tablet) breakpoint introduced.** Reason: the exact container-width arithmetic at `64rem` (§7) shows no squeeze at the point the grid activates.
- **Overflow ownership narrowed from the whole context column to just the terminal note's value.** Reason: avoids an unnecessary nested-scroll region for the common (short-content) case; the one place content can genuinely exceed a short viewport is a long reviewer note, so only that element gets a bounded scroll region, reusing the same pattern `SuggestedActionCard` already established elsewhere in this codebase.
- **Accessible-announcement change (Option A) is confined to `runInvestigation`/`retryRun`/`refreshRun`, and explicitly excluded from `recordDecision`'s 409-convergence path.** Reason: a `409` can only converge to `APPROVED`/`REJECTED`/`NOT_ELIGIBLE` per the documented state machine, never `PENDING` — the new logic has no case to apply to there, and leaving that path untouched avoids any risk of it interfering with the existing 409 error-banner messaging.
- **The refresh flow gets its own notice wording (`"Run refreshed. Human approval required."`) rather than reusing the fresh-completion string.** Reason (Revision 3): a refresh can be triggered on a run that finished long ago — reusing "Investigation completed" would misrepresent an explicit refresh as a fresh completion event.
- **The run-detail landmark is a native `<section aria-label="Run detail">`, not a bare `<div aria-label>`.** Reason (Revision 3): only an element with an implicit or explicit landmark/region-eligible role picks up `aria-label` as an accessible name that maps to a `region` role — a plain `<div>` does not, which would have made the plan's own `getByRole("region", …)` test silently match nothing.
- **The `timeline-heading` `tabIndex={-1}` fix lands in `App.tsx`, not `TraceTimeline.tsx`.** Reason (Revision 3): the heading element (`<h2 id="timeline-heading">`) is rendered directly in `App.tsx`'s JSX, wrapping the `<TraceTimeline>` component — `TraceTimeline.tsx` itself never renders that heading, so adding it to the modified-file map would misdescribe where the real change happens.
- **The relocated `runStatusBadge` helper gets a dedicated new unit test (`run-overview-presentation.test.ts`) rather than relying on an unsupported "zero regression risk" claim.** Reason (Revision 3): the absence of an existing component test for `InvestigationSummary` is a gap, not a safety guarantee — a same-file unit test covering all four status branches makes the "behavior-preserving" claim verifiable instead of asserted.

## Remaining owner questions

None are blocking. Two judgment calls are recorded above in case the product owner wants a different default: (1) sticky scope (uniform vs. `PENDING`-only), and (2) whether the anchor-link baseline should ship with the JS-fallback focus/scroll handler from day one rather than only after real-browser verification flags a need for it.
