# OpsPilot — Web UI (Milestone 7)

| Field | Value |
|---|---|
| Document | React Timeline UI — Implementation Record |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Document the `apps/web` React UI — its scope, the one-action investigation workflow, the timeline/report rendering model, the two-column run-detail layout and approval interaction, and how to run it locally |
| Related documents | `docs/12-agent-run-api.md` (the HTTP API this UI consumes), `docs/13-approval-workflow.md` (the approval semantics this UI's approval panel renders) |

---

## 1. Scope and non-goals

`apps/web` is a React SPA that supports local development and same-origin production serving through `apps/api`, consuming the existing `apps/api` HTTP API to demonstrate the OpsPilot backend end to end in a browser: describe an issue, run an investigation, read the resulting trace timeline and generated report, and — when the run produced at least one suggested action — record a human approve/reject decision against it.

**Implemented:**

```text
one-action investigation workflow (create job -> start run -> load approval)
internally generated ticket IDs — no editable Ticket ID field
read-only Investigation Timeline
read-only Generated Report, including suggested-action cards
the "Approval workflow demo" checkbox and its report-level effect
partial-failure recovery via Retry Run
the four-state approval panel (NOT_ELIGIBLE / PENDING / APPROVED / REJECTED)
recording an approve/reject decision, with 201/200/409 handling
a reusable two-column run-detail layout (PR 5C): a flexible main reading
  surface (timeline + report) beside a constrained, sticky Run Context Panel
a top-of-page "Action required" banner, shown only while a decision is PENDING
an accessible, wording-accurate notice for a pending decision, distinguishing
  a fresh completion/retry from an explicit refresh
```

**Non-goals for this milestone:** authentication, RBAC, multi-user support, a job queue, SSE/WebSockets/live streaming, background polling, deployment/production observability, a design-system package, dark mode, internationalization, live LLM/embedding provider calls, editing or revoking a recorded approval decision, **executing an approved action**, routing, run deep links, and browser storage.

**Approval decisions are recorded, never executed.** Checking "Approve" persists a human decision against the run; it does not trigger `UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, or `DRAFT_CUSTOMER_REPLY` against any downstream system — no such execution path exists anywhere in OpsPilot today (`docs/13-approval-workflow.md` §1).

---

## 2. Package layout

```text
apps/web/
  package.json        14 dependency entries — see §9
  tsconfig.json        extends ../../tsconfig.base.json; adds DOM lib, JSX, bundler resolution
  vite.config.ts        React plugin, relative /v1 dev+preview proxy, Vitest jsdom config
  index.html
  src/
    main.tsx            createRoot bootstrap
    App.tsx              the only stateful component — owns the workflow (§4, §8)
    styles.css            one hand-written stylesheet, no framework
    api/
      http-client.ts       the only fetch call site
      endpoints.ts          createAgentJob / startAgentRun / getAgentRun / getApproval / recordApproval
      types.ts               type-only @opspilot/contracts reuse + local envelope types
      http-client.test.ts
    format/
      datetime.ts, datetime.test.ts
    trace/
      trace-presentation.ts, trace-presentation.test.ts
    approval/
      approval-presentation.ts, approval-presentation.test.ts
    run/
      run-overview-presentation.ts, run-overview-presentation.test.ts
        (shared run-status badge mapping — PR 5C, moved out of
        InvestigationSummary so RunOverviewPanel can share it verbatim)
    components/
      InvestigationForm, InvestigationSummary, TraceTimeline, ReportPanel,
      SuggestedActionCard, StatusBadge, ErrorBanner,
      ApprovalPanel, ApprovalDecisionForm,
      RunContextPanel, RunOverviewPanel, ActionRequiredBanner (PR 5C)
      (+ .test.tsx for most of the above)
    App.run-workflow.test.tsx
    App.approval.test.tsx
    App.run-context-layout.test.tsx (PR 5C)
    test/setup.ts
```

---

## 3. Issue-Summary-first UX and internal ticket-ID derivation

The visible form contains only an **Issue Summary** textarea, an **Approval workflow demo** checkbox, and a **Run Investigation** button. There is no editable Ticket ID field anywhere in the UI.

`App.tsx` derives the ticket ID at submit time:

```ts
const ticketId = approvalDemo ? "TICKET-APPROVAL-DEMO" : `DEMO-${crypto.randomUUID()}`;
```

This is safe against the backend's actual constraints: `TicketContextSchema` places no uniqueness or format requirement on `ticketId`, and `docs/12-agent-run-api.md` §3 states explicitly that duplicate `ticketId` submissions are allowed and create separate jobs. The generated/internal ticket ID is displayed only as read-only metadata (`<dl>`, never a disabled `<input>`) alongside the Job ID and Run ID once a job exists.

---

## 4. One-action chained workflow

The user clicks **Run Investigation** once. `App.tsx` performs the chained request sequence:

```text
1. POST /v1/agent-jobs                        { ticketId, summary }
2. POST /v1/agent-jobs/:jobId/runs             (no body)
3. render run metadata, timeline, report, evidence, suggested actions
4. GET  /v1/agent-runs/:runId/approval
5. render the approval panel
```

Step 2 is safe to treat as complete-and-final because `POST /v1/agent-jobs/:jobId/runs` is fully synchronous — it executes the whole orchestrator loop in the request handler and returns the complete terminal projection (`docs/12-agent-run-api.md` §1). No polling or background refresh is needed anywhere in this workflow, including the approval step.

**The approval fetch is secondary to the run result.** It never gates or unwinds the render of step 3 — the run, timeline, and report are already on the page by the time step 4 starts, and a step-4 failure leaves them exactly as they are (§8).

An explicit `phase` state (`idle | creating-job | running-agent | loading-approval | refreshing-run | submitting-approval`) drives the button label ("Creating investigation…" / "Running agent…" / "Loading approval…" / "Recording decision…") and a persistent `aria-live="polite"` progress region, and disables the form and Retry Run/Refresh/decision controls for the duration of any one workflow. Race safety comes from an `AbortController` (aborts a superseded request) plus a monotonic generation counter (discards a stale response even if abort didn't land in time). The approval fetch chained after a run reuses that same signal and generation rather than starting a new workflow.

### Partial-failure behavior

| Failure point | Behavior |
|---|---|
| Job creation fails | The safe API error is shown. **No run request is issued.** Nothing is committed to the page — no job, run, timeline, or report. |
| Job creation succeeds, run creation fails | The created job's metadata (Ticket ID, Job ID) is retained and displayed. The safe API error is shown. A **Retry Run** button appears and, when clicked, calls **only** `POST /v1/agent-jobs/:jobId/runs` for the same job, followed by the same approval fetch — a second job is never created automatically. |
| Run created, approval fetch fails | The safe API error is shown, but **the run, timeline, and report stay rendered.** The run projection is the primary artifact; approval is an annotation on it (§8). |
| A new investigation starts | The prior job, run, approval, timeline, report, error, and notice state are all cleared before the new request is issued. A fresh internal ticket ID is generated unless **Approval workflow demo** is checked. |

Retry Run is offered only while a job exists with no run (i.e., only after a run-creation failure) — it is never offered after a successful run.

---

## 5. Relative `/v1` requests and the Vite proxy

Browser code calls only relative paths (`/v1/agent-jobs`, `/v1/agent-jobs/:jobId/runs`, `/v1/agent-runs/:runId`, `/v1/agent-runs/:runId/approval`). There is **no frontend API-base environment variable** and no `.env` file for `apps/web`.

`vite.config.ts` proxies `/v1` to `http://127.0.0.1:3000` in both `server` (dev, port 5173) and `preview` (port 4173). Because every browser request is same-origin, **no CORS configuration is required or was added to `apps/api`**.

---

## 6. Timeline rendering model

- **Ordering source:** array order of `trace`, exactly as the API returns it (`sequence_number ASC`, never re-sorted by the UI).
- **No per-event timestamps.** `AgentTraceEventSchema` carries no time field — `sequence_number`/`created_at` exist in the database but are never mapped into the response. The timeline therefore uses 1-based step ordinals only. Real timestamps (`startedAt`/`finishedAt`/duration) appear only in the Investigation summary panel, where they are genuine.
- **All four contract variants render:** `TOOL_REQUESTED`, `TOOL_COMPLETED`, `REPORT_GENERATED`, `RETRIEVAL_COMPLETED` (the last is currently unreachable through `apps/api`, since no retriever is wired into its tool registry — it is implemented because an exhaustive switch over the contract union requires it).
- **Unknown-event fallback:** an event type outside the current union renders its `type` string only, never a raw payload dump.

---

## 7. Report and suggested-action rendering

`ReportPanel` renders all three outcome shapes (`RUNNING`, `FAILED`, `COMPLETED`) and, for `COMPLETED`, every `ResolutionReport` field: category, confidence, summary, root cause, customer impact, recommended resolution, evidence, and suggested actions.

`SuggestedActionCard` renders all three currently defined variants (`UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, `DRAFT_CUSTOMER_REPLY`) exhaustively. A `DRAFT_CUSTOMER_REPLY` body (up to 4000 characters) is rendered in full — `white-space: pre-wrap`, a bounded `max-height`, and vertical scrolling — never truncated.

**Verified:** an ordinary investigation (unchecked demo checkbox) produces zero suggested-action cards and an always-`NOT_ELIGIBLE` approval panel; checking **Approval workflow demo** (ticket `TICKET-APPROVAL-DEMO`) produces exactly one `DRAFT_CUSTOMER_REPLY` card and a `PENDING` approval panel with a decision form.

---

## 8. Run-detail layout and approval UX

### 8.1 The problem this layout solves

Before PR 5C, `ApprovalPanel` was the literal last DOM node on the run-detail page, stacked below the entire report in a 50/50-width column. A completed run looked finished — full report, status badge — even when it was only *execution*-complete and still needed a human decision (`PENDING`). Discovering that a decision was outstanding meant scrolling past the whole report. PR 5C fixes this without touching the backend contract at all: `ApprovalStatus`, `ApprovalView`, `presentApproval`'s inputs/outputs, and the `201`/`200`/`409`×2 handling described below are all unchanged from Milestone 7.

### 8.2 Two-column run-detail layout

At the existing `64rem` (1024px) breakpoint, `.investigation-content` becomes a 2-column grid:

```css
grid-template-columns: minmax(0, 1fr) minmax(18rem, 22rem);
```

- **Main reading surface** (`role="region" aria-label="Run detail"`, a `<div>` — not a `<section>`, so it does not itself pick up the `.investigation-content section` card-styling rule that its nested timeline/report sections already use) — flexible, visually dominant, holds the unchanged `TraceTimeline` and `ReportPanel`.
- **Run Context Panel** (`<aside aria-label="Run context">`) — constrained to 18–22rem so it never competes with the report for width, and `position: sticky; top: var(--space-5)` on desktop so it stays visible while the reviewer scrolls a long report. Below `64rem` it returns to plain document flow (no sticky, single column).

### 8.3 The reusable Run Context Panel

`RunContextPanel` is a thin, stateless switch — not an approval-only component — so it can host a future historical-run detail view unmodified:

| Input | Rendered |
|---|---|
| `approval === null` | `RunOverviewPanel` — run facts only (status, started/finished, duration, trace-event count, suggested-action count, jump links to the timeline/report sections). **No eligibility claim of any kind** — `null` means "no approval data yet" (still loading, or the last fetch failed), never "not eligible," and conflating the two would misinform a reviewer. |
| `approval.status === "NOT_ELIGIBLE"` | The same `RunOverviewPanel` run facts, **plus** the reused `presentApproval("NOT_ELIGIBLE", …)` badge/copy/hint — the exact same "Approval workflow demo" hint text as before, not a duplicated string. |
| `approval.status === "PENDING"` | `ApprovalPanel`, whose decision semantics remain unchanged, showing the one active decision form. |
| `approval.status === "APPROVED"` / `"REJECTED"` | `ApprovalPanel`, whose decision semantics remain unchanged, showing the read-only terminal record. |

`ApprovalPanel` itself needed only two small additions for this PR — `tabIndex={-1}` on its heading (§8.5) and a `className` on the terminal note `<dd>` for safe wrapping (§8.6) — its decision semantics, `201`/`200`/`409` handling, and double-submit guard are exactly as documented below, unchanged.

### 8.4 The pending-decision banner

A stateless `ActionRequiredBanner`, rendered by `App.tsx` only when `approval?.status === "PENDING"` (a condition derived from existing state — no new `useState`), appears between the Investigation summary and the run-detail grid:

```tsx
<a className="action-required-banner" href="#approval-heading">
  Investigation completed. Human action required — review the proposed action.
</a>
```

It is a native in-page link to `#approval-heading` — never a duplicate of the Approve/Reject buttons, and never rendered on mobile as anything but this same link. `ApprovalPanel`'s existing `<h2 id="approval-heading">` gained `tabIndex={-1}`, making it programmatically focusable — the native fragment link is the baseline mechanism, requiring zero JavaScript. Real-browser confirmation that activating it both scrolls to and visibly focuses the heading remains a manual verification item (§11), not yet performed as of this implementation session. The banner never triggers a scroll or focus change automatically on its own — it only navigates in direct response to an explicit click.

### 8.5 Accessible pending announcement

The existing `role="status" aria-live="polite"` notice region (§4, §9) is the only live region — no second one was added. Its exact text depends on which flow produced a `PENDING` result, so an explicit refresh is never described as if the investigation just completed:

| Flow | Resulting notice |
|---|---|
| A fresh investigation or Retry Run resolves to `PENDING` | `"Investigation completed. Human approval required."` |
| An explicit Refresh resolves to `PENDING` | `"Run refreshed. Human approval required."` |
| An explicit Refresh resolves to anything else | `"Run refreshed."` (unchanged) |

`loadApproval()` returns the fetched `ApprovalView | null` (previously `void`); `runInvestigation`/`retryRun`/`refreshRun` each choose the right notice text from that return value, immediately before returning to `idle`. This is the only behavior change in `App.tsx` beyond the JSX restructure — the `phase`/race-safety/`409`-convergence logic is untouched.

### 8.6 Long content

A long terminal reviewer note (up to 1000 characters) is allowed to make the read-only terminal panel taller and rely on ordinary page scrolling — `white-space: pre-wrap; overflow-wrap: anywhere;` on the note `<dd>`, deliberately **not** a nested `overflow-y: auto` scroll region, since a decision is read-only once terminal and a second, internally-scrollable region inside an already-sticky column would need its own focus/keyboard handling to stay accessible for no real benefit. The Approve/Reject button row (`.approval-decision-actions`) gains `flex-wrap: wrap` so it never overflows the panel's 18–22rem width.

### The four statuses

| Status | Rendered | Controls |
|---|---|---|
| `NOT_ELIGIBLE` | Badge + "This run has no suggested actions to approve." + the eligibility rule + a hint naming the **Approval workflow demo** checkbox (never a ticket ID) | None |
| `PENDING` | Badge + "This run has N suggested action(s) awaiting a decision." (N is `report.suggestedActions.length`, since the approval read model itself carries no count) + `ApprovalDecisionForm` | Approve / Reject |
| `APPROVED` | Badge + reviewer name + note (or "No note provided") + formatted `decidedAt` | None |
| `REJECTED` | Identical shape with the rejected badge | None |

`APPROVED` and `REJECTED` are terminal and render **zero** buttons — no edit, revoke, or resubmit control exists anywhere, because no such endpoint exists (`docs/13-approval-workflow.md` §5).

### `ApprovalDecisionForm`

A required **Reviewer name** input (`maxLength 100`) and an optional **Note** textarea (`maxLength 1000`), mirroring `RecordApprovalDecisionInputSchema` exactly (`packages/contracts/src/agent-run-approval.ts`). Two named buttons, **Approve** and **Reject** — not a radio group plus one submit — since the decision *is* the clicked action. Both buttons disable and the active one shows a pending label while submitting; the form carries `aria-busy="true"`. A rapid double-click issues exactly one request (the same synchronous-ref pattern `InvestigationForm` uses). The trimmed note is **omitted from the request body entirely** when blank — never sent as `""` or `null` — since the schema requires `.min(1)` when present and rejects `null` under `.strict()`.

### `201` vs `200`, and both `409`s

| Response | UI behavior |
|---|---|
| `201 Created` | "Decision recorded." — the panel replaces its state from the response body and becomes terminal and read-only. |
| `200 OK` (idempotent replay) | "This decision was already recorded — nothing changed." Treated as **success**, not an error; `decidedAt` is unchanged by definition. |
| `409 AGENT_RUN_APPROVAL_ALREADY_DECIDED` | The server's error message is shown, then the UI automatically re-fetches `GET .../approval` so the panel converges on the real terminal state instead of stranding the reviewer on a stale form. |
| `409 AGENT_RUN_NOT_APPROVAL_ELIGIBLE` | Same pattern — banner, then an automatic refetch that resolves to `NOT_ELIGIBLE`. |
| `400` / `404` / `503` / network failure | The safe error is shown; no state is invented, no automatic refetch happens, and the form stays available for retry. |

`201` and `200` are distinguishable **only** by `response.status`, which `http-client.ts`'s `request<T>()` already returns alongside the parsed body (unchanged from PR 4A — no transport modification was needed).

### Approval-fetch failure

If `GET .../approval` fails — after a run completes, after Retry Run, or after Refresh — the safe error is shown, but the run, timeline, report, evidence, and suggested actions **stay exactly as rendered**. Approval is an annotation on an already-successful run, not a precondition for showing one. In the run-detail layout, this is also the case where `RunContextPanel` falls back to `RunOverviewPanel` with `eligibilityNote={null}` (§8.3) — the reviewer still gets useful run context even when the approval fetch itself failed.

### 8.7 Test coverage

Structural/DOM-order regressions are covered in `apps/web/src/App.run-context-layout.test.tsx` (banner presence per status, the banner-precedes-Run-detail-region source-order check, exactly one Approve/one Reject button while `PENDING`, the `RunContextPanel` three-way switch, all three notice-wording variants, `tabindex="-1"` on the timeline/report/approval headings, and that a long reviewer note stays a single, non-duplicated `<dd>`); `apps/web/src/run/run-overview-presentation.test.ts` covers the extracted `runStatusBadge` helper's four branches. The one `compareDocumentPosition()` assertion in that file is a structural DOM-order regression check on two elements otherwise located by `getByRole` — not a simulation of user-perceived visual order, since jsdom has no real layout engine. Real `position: sticky` behavior, no-scroll initial visibility on a real viewport, real fragment scrolling/focus, and `prefers-reduced-motion` are exactly the things jsdom cannot prove; they remain open manual-verification items (§11), not yet performed as of this implementation session, and are recorded here as such rather than assumed or claimed as done. All pre-existing suites (`App.approval.test.tsx`, `App.run-workflow.test.tsx`, `components/ApprovalPanel.test.tsx`, `components/ApprovalDecisionForm.test.tsx`, `approval/approval-presentation.test.ts`) pass unmodified — none of their assertions depend on `ApprovalPanel`'s DOM ancestry, any CSS class name, or the notice-region's exact text.

### 8.8 Future historical-run compatibility

`RunContextPanel` and `RunOverviewPanel` take only `run`/`trace`/`approval`/decision-callback props — nothing about them depends on the current single-page, no-router architecture. A future historical-run list's "open a run" action can render the same `.investigation-content` grid (main region + Run Context Panel) per selected run, unmodified. This PR does not implement that list (out of scope), but does not foreclose it either.

---

## 9. Accessibility baseline

One `<h1>`; ordered heading levels per section, including the "Approval" `<h2>` at the same level as "Generated report". Every control has a real, associated `<label>` — no placeholder-as-label, including the reviewer-name and note fields. Native `<button>`/`<textarea>`/`<input>` only, so keyboard operation works without a key handler. `role="alert"` for the error banner; a persistent `aria-live="polite"` region for workflow progress and notices, including the replay/decision-recorded notices and, since PR 5C, the pending-decision announcement (§8.5). `aria-busy` on both the investigation form and the decision form while their respective workflow is active. A visible `:focus-visible` outline. Status is never color-only — `StatusBadge` always renders a text label plus a glyph (`✓` approved, `✕` rejected, `●` pending, `—` not eligible), reused unchanged from run status. WCAG-AA-readable contrast. No horizontal page scroll at 360px width. The timeline is `<ol>`; evidence and suggested actions are `<ul>`; identifiers, report fields, and the terminal approval record are `<dl>`. Terminal approval states are visually and structurally read-only — no button is rendered at all, so there is nothing for a screen reader to announce as an editable control.

**Since PR 5C:** two named landmarks structure the run-detail page — `role="region" aria-label="Run detail"` (main reading surface) and `<aside aria-label="Run context">` (the Run Context Panel), giving screen-reader users a second, independent path to the decision beyond the visual banner. The timeline, report, and approval headings all carry `tabIndex={-1}`, making them valid native fragment-navigation targets. `html { scroll-behavior: smooth; }` is disabled under `@media (prefers-reduced-motion: reduce)`. No focus is ever forced automatically on page load or run completion — the only new focus behavior is native fragment-navigation focus triggered by an explicit click on the `Action required` banner.

---

## 10. Dependencies

`apps/web/package.json` — 14 entries total (3 `dependencies` + 11 `devDependencies`; 13 external packages + 1 workspace dependency, `@opspilot/contracts`, imported type-only):

```text
dependencies:     @opspilot/contracts (workspace:*), react ^19, react-dom ^19
devDependencies:  @testing-library/dom ^10, @testing-library/jest-dom ^6,
                   @testing-library/react ^16, @testing-library/user-event ^14,
                   @types/react ^19, @types/react-dom ^19, @vitejs/plugin-react ^6,
                   jsdom ^29, typescript ^7.0.2, vite ^8, vitest ^4.1.10
```

`@testing-library/dom` is a required peer of `@testing-library/react` v16, which does not bundle it. `typescript` and `vitest` deliberately match the root pins exactly. All majors are current and stable — nothing experimental or pre-release. **No new dependency was added for the approval interaction** — it reuses the existing HTTP client, form, and badge patterns.

---

## 11. Running it locally

```bash
pnpm install
cp .env.example .env            # if not already present
pnpm infra:up
pnpm db:test:ensure
pnpm db:migrate:deploy
pnpm db:generate
pnpm --filter @opspilot/api run build
pnpm --filter @opspilot/api run start     # Terminal A — blocks; http://127.0.0.1:3000
```

```bash
pnpm --filter @opspilot/web run dev       # Terminal B — blocks; http://127.0.0.1:5173
```

In the browser:

```text
1. Type an Issue Summary and click Run Investigation (checkbox unchecked)
   -> the Run Context Panel renders NOT_ELIGIBLE, with no controls
   -> no "Action required" banner appears
2. Check "Approval workflow demo" and click Run Investigation again
   -> the report shows exactly one DRAFT_CUSTOMER_REPLY suggested action
   -> the "Action required" banner appears above the run-detail grid
   -> the notice region reads "Investigation completed. Human approval required."
   -> the Run Context Panel renders PENDING with the decision form, sticky on
      a desktop-width viewport
   -> clicking the banner should scroll to and focus the Approval heading — the
      target heading is programmatically focusable (`tabIndex={-1}`) and this is
      the native fragment-link baseline; confirm the actual scroll/focus result
      in your browser, since it was not verified in this implementation session
3. Enter a reviewer name (and, optionally, a note), click Approve
   -> "Decision recorded."; the panel becomes the read-only APPROVED record
   -> the banner disappears; no edit or revoke control exists
4. Run a fresh "Approval workflow demo" investigation and click Reject instead
   -> the symmetric terminal REJECTED state
5. Click Refresh on a PENDING run
   -> the notice region reads "Run refreshed. Human approval required." —
      never the fresh-completion wording, since the run itself was not new
6. Resize the browser below 1024px width
   -> the layout collapses to a single column; the banner still appears near
      the top when PENDING, but no raw Approve/Reject button is ever pinned
      before the full decision card
```

```bash
pnpm --filter @opspilot/web run typecheck
pnpm --filter @opspilot/web run test
pnpm --filter @opspilot/web run build
pnpm --filter @opspilot/web run preview  # serves the production build at http://127.0.0.1:4173
```

---

## 12. Future direction

**Executing an approved action** — actually performing `UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, or `DRAFT_CUSTOMER_REPLY` against a real downstream system once a decision is `APPROVED` — is unbuilt anywhere in OpsPilot, not only in `apps/web`. It would need its own design: target systems, credentials, retry/idempotency semantics, and an audit trail distinct from the approval record itself, none of which this milestone specifies. Editing or revoking a terminal decision remains an explicit non-goal (§1) for the same reason `docs/13-approval-workflow.md` §5 gives: there is no product requirement motivating it yet, and adding one silently would let a "decision" stop meaning what an auditor expects it to mean.

**A historical-run list** (browse past investigations, reopen an old run's report and decision) is not implemented in PR 5C. §8.8 documents why the Run Context Panel's props were deliberately kept generic (`run`/`trace`/`approval`/decision-callback only) so this future list can reuse the same run-detail grid per selected row without another layout redesign. Live-deployment evidence, screenshots, and cold-start observations for this milestone are tracked separately (PR 5D), not in this document.
