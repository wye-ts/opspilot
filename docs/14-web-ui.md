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
partial-failure recovery via Retry Run (FAKE) and Recover Live Run mode (LIVE)
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
| Job creation succeeds, run creation fails (**FAKE**) | The created job's metadata (Ticket ID, Job ID) is retained and displayed. The safe API error is shown. A **Retry Run** button appears and, when clicked, calls **only** `POST /v1/agent-jobs/:jobId/runs` for the same job, followed by the same approval fetch — a second job is never created automatically. |
| Job creation succeeds, run creation fails (**LIVE**) | Same retention, but recovery needs a credential the app deliberately no longer holds (§13.2), so there is no Retry Run button. The **form itself switches into "Recover Live Run" mode** against the retained job: the ticket, summary, and provider are shown read-only, the token field starts empty, and submitting calls `retryLiveRunWithToken`, which issues **only** `POST /v1/agent-jobs/:retainedJobId/runs` — carrying the same `Idempotency-Key` as the failed attempt, so a run the first request may already have created is returned rather than duplicated (§7.2). See §7.1. |
| Run created, approval fetch fails | The safe API error is shown, but **the run, timeline, and report stay rendered.** The run projection is the primary artifact; approval is an annotation on it (§8). |
| A new investigation starts | The prior job, run, approval, timeline, report, error, and notice state are all cleared before the new request is issued. A fresh internal ticket ID is generated unless **Approval workflow demo** is checked. |

Retry Run is offered only while a job exists with no run (i.e., only after a run-creation failure) — it is never offered after a successful run.

### 7.1 LIVE recovery mode

A LIVE partial failure used to be a **false instruction**. The page said to
re-enter the token and try again, but the only submit control was the ordinary
new-investigation form, which generates a fresh ticket ID and POSTs a **new**
`AgentJob`. Retrying therefore created a duplicate job, stranded the original,
bypassed the retained job's per-job live attempt history, and consumed a fresh
daily reservation under a different job.

The form now has an explicit second mode, entered whenever a job exists with no
run and the last submission was LIVE:

**Entered only on a CONFIRMED failure.** `job !== null && run === null &&
activeProviderMode === "LIVE"` is true in two different situations: a LIVE run
that was **refused**, and a LIVE run that is still **in flight** — the window
between `setJob(createdJob)` and the run request resolving. Deriving retry mode
from those fields alone told the user "the live run could not be started" while
that run was still going, and cleared the token field mid-request.

An explicit `liveRetryPending` flag now separates them. It is set **only** where a
rejection is actually observed, so:

| Situation | `liveRetryPending` | What the form shows |
|---|---|---|
| First LIVE run in flight | `false` | Ordinary busy UI — editable summary, provider radios, "Running agent…" |
| First LIVE run refused | `true` | Recover Live Run mode |
| Recovery in flight | `true` | Recover Live Run mode, busy — it does **not** snap back to creation mode |
| Recovery refused again | `true` | Recover Live Run mode, token cleared for re-entry |
| Recovery succeeded | `false` | The run, rendered normally |
| Start new investigation | `false` | The ordinary creation form, fully reset |

An aborted or superseded request never sets it: a cancelled request is not a
refusal.

| Property | Recover Live Run mode |
|---|---|
| Job | The **retained** job. `retryLiveRunWithToken` closes over `job.id` and never calls `createAgentJob` — the retained id is the only job identifier in scope. |
| Ticket + summary | Rendered read-only as facts about a committed row, in a `<dl>` rather than disabled inputs. The editable summary field is **hidden**, so the UI never implies a retry could change the investigation. |
| Provider mode | Fixed to LIVE. The radio group is not rendered, so a retry cannot become a FAKE run. |
| Approval demo | Unavailable, as for any live run. |
| Token | Field starts **empty** and is cleared again on every terminal outcome. |
| Request identity | The **same** `Idempotency-Key` the failed attempt sent — see §7.2. This is what makes recovery safe rather than expensive. |
| Availability | **Not consulted.** There is no capability preflight: availability governs starting a NEW paid run, not recovering one that may already exist — and the request being recovered is very often what closed it. See §13.1.1. |
| Repeated failure | The same job is retained and stays recoverable. A `LIVE_RUN_ATTEMPT_LIMIT` rejection is the safeguard working — it proves the server counted *this* job's live runs. |
| Escape | A **Start new investigation** button clears the retained partial workflow **and the form's own state** — summary, provider (back to FAKE), approval-demo, token, and the double-submit ref — by remounting the form on a changed `key`. Local state only: it issues no request, creates no replacement job, and deletes nothing on the server. |

FAKE is untouched: it keeps the Retry Run button, and no code path can attach a
token header or an idempotency key to a FAKE request (§13.2, §7.2).

---

### 7.2 The client request key

**Why "recover" and not "retry".** The failure that puts the form into this mode
is ambiguous. `startAgentRun` throwing does not prove that no run was created:
finalization can fail *after* the provider executed and after the budget was
reconciled (the API answers `PERSISTENCE_UNAVAILABLE`, which it also uses for a
pre-run outage), and a successful response can simply be lost in transit. The tab
used to offer recovery for all of these, and that recovery was a second paid
execution.

No allowlist of error codes could have fixed it — a transport failure has no code
at all. What distinguishes "the same request again" from "a new request" is
something the client carries, so the client carries it: one UUID per LIVE
investigation, sent as `Idempotency-Key` (`docs/12-agent-run-api.md` §10.6).

**The rule, in one sentence:** a new key is generated only when a new `AgentJob`
is, never because a request failed.

| Event | Key |
|---|---|
| A LIVE investigation is submitted | Freshly generated, before the job is created |
| The first run request fails, however | **Kept** — this is precisely the ambiguous case |
| A recovery is submitted | The **same** key, alongside a freshly typed token |
| A recovery fails again | **Kept** |
| A run body is rendered (`201` or `200`) | Cleared — there is no ambiguity left to resolve |
| **Start new investigation** | Cleared — a new investigation is a new request |
| A FAKE run | Never generated |

**Key and token have opposite lifetimes, on purpose.** The token authorizes one
run, lives only as a function argument, and must be retyped after any outcome.
The key names one request, is ordinary component state, and *survives* failure so
it can be repeated. They are never stored together, and the key is not a
credential: it authorizes nothing.

**What the user sees.** A `200` response means the server recognized the key and
returned a run an earlier request had already created. The page says so — *"Recovered
the original live run — no new run was started."* — and renders that run, exiting
recovery mode. A replayed run may still be `RUNNING`, which is the normal residue
of a failed finalization; the Refresh control observes its later state. A `201`
means the recovery genuinely started the run, and no such notice appears.

**The notice is composed ONCE, after approval loads.** The flow used to announce
the replay and then load approval, which announced its own thing — so a `PENDING`
approval silently overwrote the one message explaining why no second paid attempt
was consumed. The two facts do not compete; both are true. `replayed` is
therefore carried through the approval step and a single message is emitted:

| Run response | Approval result | Notice |
|---|---|---|
| `200` replayed | `PENDING` | *Recovered the original live run — no new run was started. Human approval required.* |
| `200` replayed | anything else | *Recovered the original live run — no new run was started.* |
| `200` replayed | the approval GET **failed** | the replay confirmation, unchanged — the approval error renders separately in the error banner |
| `201` started | `PENDING` | *Investigation completed. Human approval required.* — unchanged from every other creation path |
| `201` started | anything else | unchanged |

The replay confirmation survives an approval-load failure deliberately: "no
second paid attempt was consumed" is a fact about the run, and a failed GET
cannot unmake it. No second live region is introduced — two polite
announcements racing each other is how this went wrong in the first place, so
the fix composes one message inside the existing `notice` region (§9).

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


---

## 13. PR 6B2 — provider selector, access token, and run cost

Deliberately minimal and additive. The approval UI, trace timeline, report
panel, and layout are untouched.

### 13.1 Mode selector

A two-option radio group in `InvestigationForm`, defaulting to **FAKE**.

| | Demo — FAKE | Live Claude |
| --- | --- | --- |
| Copy | "Deterministic, fast, no model cost." | "Real `claude-sonnet-5`. Protected by availability and usage limits." |
| Approval-demo checkbox | shown | **hidden**, and `approvalDemo` is cleared on switching |
| Access-token field | hidden | shown when the server says a token is required |
| Request body | `{"providerMode":"FAKE"}` | `{"providerMode":"LIVE"}` |

When `GET /v1/capabilities` reports `UNAVAILABLE`, the LIVE option renders
**disabled with a visible reason** — "Live Claude is temporarily unavailable —
the deterministic demo is always available" — rather than hidden. A hidden
control makes the feature look absent rather than protected. Capabilities that
have not loaded yet are treated as unavailable, so the option is never briefly
offered before the server has said it is available.

A live run never uses `TICKET-APPROVAL-DEMO`: the deterministic approval
scenario has no meaning for a live provider, so `approvalDemo` is cleared both
on switching to LIVE and again at submit.

#### 13.1.1 Capabilities are a dynamic, fail-closed hint

`GET /v1/capabilities` answers a question whose truth **changes on its own**:
another client reserves or reconciles a LIVE run, the daily count or the observed
estimate reaches its limit, unknown pricing closes the gate, an unreconciled
reservation latches the UTC day shut (§25.2.3 of docs/08), midnight opens a fresh
budget row, an operator flips the kill switch, or a database outage clears.

Reading it once at mount therefore went stale for the tab's whole lifetime:

```text
initially UNAVAILABLE -> server becomes AVAILABLE -> tab stays disabled
                         until the user reloads
initially AVAILABLE   -> server becomes UNAVAILABLE -> tab still offers LIVE
                         -> createAgentJob succeeds -> startAgentRun refused
                         -> an avoidable retained partial workflow
```

It is now refreshed at six points, all event-driven — there is **no polling**, so
a backgrounded tab wakes no database:

| Trigger | Why |
| --- | --- |
| Mount | The initial answer. |
| Before a new LIVE investigation | Preflight — see below. |
| After every terminal LIVE outcome, **including a recovery** | The run itself likely changed the answer. Best-effort reporting; it never decides whether a request may be sent. |
| `window` focus / `visibilitychange` when visible | The user came back to a tab that may have been idle for hours. |
| After **Start new investigation** | The form is back at the start; it should reflect the server now. |

A retained-job recovery deliberately has **no** preflight — see §13.1.1.

**Race and abort ownership.** The refresh has its own `AbortController` and its
own generation counter, deliberately separate from the investigation's. Sharing
them would mean starting an investigation cancels a capability read and — far
worse — that a background focus refresh aborts a run the user is waiting on. Each
refresh aborts only the previous refresh and bumps its own generation; a response
whose generation is no longer current is discarded, so two refreshes resolving
out of order cannot leave the older answer on screen. Unmount aborts the
outstanding read and removes both listeners.

**Fail closed.** Any failure — including an abort — leaves `null`, which the form
treats as LIVE unavailable. A transient error can only ever hide the LIVE option,
never offer one the server would refuse. A refresh failure never replaces the run
result or the error already on screen, and nothing about the response is logged.

**Preflight.** Before a new LIVE investigation generates a ticket ID or calls
`createAgentJob`, the capabilities are refreshed and must report `AVAILABLE` +
`TOKEN_REQUIRED`. If they do not:

| | New LIVE investigation |
| --- | --- |
| Ticket ID generated | no |
| `createAgentJob` sent | **no** |
| `startAgentRun` sent | **no** |
| Silent FAKE fallback | **never** |
| Notice | "Live Claude is temporarily unavailable. No investigation job was created." |

**The preflight is advisory, not atomic.** The **backend admission path remains
authoritative** — the token check, rate limit, budget gate, concurrency lease,
and the reservation transaction all still run, and all still decide. The
preflight cannot close the window between the check and the request, so a race
can still be rejected server-side; that outcome is exactly the retained partial
workflow §7.1 already handles. What it removes is the *avoidable* case, where the
tab could have known and created an AgentJob row anyway.

No capability reason and no budget figure is ever exposed: the response is the
same opaque `UNAVAILABLE` / `NOT_APPLICABLE` body whichever condition closed the
day.

### 13.1.1 Recovery is NOT gated on capabilities

A retained-job recovery ran the same preflight, and that was wrong.

```text
capabilities            ->  may a NEW paid live run be started?
retained-key recovery   ->  return the run an earlier request may already have
                            created — no new spend admission
```

`/v1/capabilities` reports `UNAVAILABLE` when the day's allowance is used up and
when an unreconciled reservation has latched the day (`docs/12-agent-run-api.md`
§10.1.1). Those are the states the request being recovered most often
**created** — the original attempt consumes the day's final reservation, its
answer is lost, and the tab then refuses to send the one request that would hand
that run back. The browser was enforcing a rule the server does not have, against
the exact case the retained key exists for.

The server now answers a retained key from an authenticated, locked replay lookup
that runs **before** any spend gate (`docs/12-agent-run-api.md` §10.1.0), so the
request is worth sending whatever the last capability read said.

**Recovery submits when all four are true**, and nothing else is consulted:

```text
a retained job exists
a retained Idempotency-Key exists
a freshly typed, non-empty token
no investigation request already in flight
```

| | Retained-job LIVE recovery |
| --- | --- |
| Capability preflight | **none** |
| Submits while capabilities is `UNAVAILABLE` or `null` | **yes** |
| `createAgentJob` sent | **never** — no second job, no second ticket id |
| `Idempotency-Key` | the **same** one the failed attempt sent |
| Access token | **freshly typed**, never retained (§13.2) |
| Capability refresh | **after** the outcome, best-effort; never a gate |

**A token is still required.** Availability was never what made one necessary —
the protected path requires authentication unconditionally, so the button stays
disabled until the field is non-empty regardless of the snapshot.

**When new runs are closed, the recovery banner says so** rather than leaving the
user to reconcile a live button with a disabled LIVE option elsewhere:

> New Live Claude runs are currently unavailable. Recovery of an existing request
> is still allowed.

It promises nothing about the outcome, deliberately. The server may still refuse
for provider configuration, the kill switch, an invalid token, a persistence
failure, or because no run was ever created for this key — in which case the
ordinary new-run rules apply and may reject it.

**If the server does refuse**, the retained job and the same request key are both
**kept**, the form stays in recovery mode, the token is cleared through the
existing terminal transition, the server's own rejection is what the user sees,
and there is **no** new key and **no** FAKE fallback.

### 13.2 Access token — memory only

| Rule | How it is enforced |
| --- | --- |
| Held in React component state only | plain `useState`; no storage call exists anywhere in `apps/web` |
| Never in `localStorage` / `sessionStorage` | asserted by a test spying on `Storage.prototype.setItem`, **and** by a production bundle-guard rule (`web-storage-write`) that fails the build on any such access |
| Never in a URL, query string, or hash | asserted after typing |
| Never persisted server-side | no DTO or column carries it |
| Sent only on LIVE, via `X-OpsPilot-Demo-Token` | asserted on both branches; a FAKE request omits the header entirely, even if a token is somehow present |
| Cleared on reload | in-memory state, by construction |
| Cleared when switching back to FAKE | explicit reset in `selectMode` |
| Never copied into parent/app state | `App` keeps only `activeProviderMode`; the token reaches `startAgentRun` as a local argument and goes out of scope when the workflow returns |
| Cleared on every terminal outcome | the form clears the field on the busy→idle edge, so success, failure, and cancellation all end the same way |
| Not reusable for a recovery | a failed LIVE run offers no **Retry Run** button — there is no token to retry with. The form's Recover Live Run mode (§7.1) takes a freshly typed token as a function argument, never from state. The idempotency key is the deliberate opposite: reused, and never stored beside the token (§7.2) |
| Rendered as `type="password"` | asserted |
| Never echoed in an error | the 401 message is the fixed catalog string |

A backend rejection (401/429/503) surfaces as an error banner. There is **no
silent retry and no fallback to FAKE** — a refused live run stays refused.

### 13.3 Summary affordance

```text
Describe the issue in at least 15 characters.
8 / 15
```

The counter measures the **trimmed** length, and submit is disabled outside
15–2000 trimmed characters. Affordance only: the backend remains authoritative.

### 13.4 Run display

`RunOverviewPanel` gains three rows, all from data the API already returns:

| Row | Source | When absent |
| --- | --- | --- |
| Provider mode | `run.providerMode` — the **persisted** value | never |
| Model | `run.modelIdentifier` | `—` for FAKE |
| Estimated cost | `run.estimatedCostUsd` (a string) | **row hidden entirely** — FAKE, unknown pricing, or a cost the API judged incomplete (§12.4 of docs/12) |

The badge renders the persisted mode verbatim; the *requested* mode is never
displayed, so a run requested as LIVE but persisted as FAKE reads FAKE. A null
cost renders nothing at all — never `$0.00`, which would assert a measured free
run.
