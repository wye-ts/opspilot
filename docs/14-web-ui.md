# OpsPilot — Web UI (Milestone 7)

| Field | Value |
|---|---|
| Document | React Timeline UI — Implementation Record |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Document the `apps/web` React UI — its scope, the one-action investigation workflow, the timeline/report rendering model, the approval interaction, and how to run it locally |
| Related documents | `docs/reviews/14-react-timeline-implementation-plan.md` (the approved plan this implements), `docs/12-agent-run-api.md` (the HTTP API this UI consumes), `docs/13-approval-workflow.md` (the approval semantics this UI's approval panel renders) |

---

## 1. Scope and non-goals

`apps/web` is a local-only React SPA that consumes the existing `apps/api` HTTP API to demonstrate the OpsPilot backend end to end in a browser: describe an issue, run an investigation, read the resulting trace timeline and generated report, and — when the run produced at least one suggested action — record a human approve/reject decision against it.

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
    components/
      InvestigationForm, InvestigationSummary, TraceTimeline, ReportPanel,
      SuggestedActionCard, StatusBadge, ErrorBanner,
      ApprovalPanel, ApprovalDecisionForm (+ .test.tsx for most of the above)
    App.run-workflow.test.tsx
    App.approval.test.tsx
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

## 8. Approval UX

`ApprovalPanel` renders in the report column, below the report's suggested actions, driven entirely by the `status` returned from `GET`/`POST /v1/agent-runs/:runId/approval`. **The UI never computes eligibility itself** — it only presents whatever status the backend returns (`docs/13-approval-workflow.md` §4 owns the eligibility rule: a run is approvable only once it is `COMPLETED` and has at least one suggested action).

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

If `GET .../approval` fails — after a run completes, after Retry Run, or after Refresh — the safe error is shown, but the run, timeline, report, evidence, and suggested actions **stay exactly as rendered**. Approval is an annotation on an already-successful run, not a precondition for showing one.

---

## 9. Accessibility baseline

One `<h1>`; ordered heading levels per section, including the "Approval" `<h2>` at the same level as "Generated report". Every control has a real, associated `<label>` — no placeholder-as-label, including the reviewer-name and note fields. Native `<button>`/`<textarea>`/`<input>` only, so keyboard operation works without a key handler. `role="alert"` for the error banner; a persistent `aria-live="polite"` region for workflow progress and notices, including the replay/decision-recorded notices. `aria-busy` on both the investigation form and the decision form while their respective workflow is active. A visible `:focus-visible` outline. Status is never color-only — `StatusBadge` always renders a text label plus a glyph (`✓` approved, `✕` rejected, `●` pending, `—` not eligible), reused unchanged from run status. WCAG-AA-readable contrast. No horizontal page scroll at 360px width. The timeline is `<ol>`; evidence and suggested actions are `<ul>`; identifiers, report fields, and the terminal approval record are `<dl>`. Terminal approval states are visually and structurally read-only — no button is rendered at all, so there is nothing for a screen reader to announce as an editable control.

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
   -> the approval panel renders NOT_ELIGIBLE, with no controls
2. Check "Approval workflow demo" and click Run Investigation again
   -> the report shows exactly one DRAFT_CUSTOMER_REPLY suggested action
   -> the approval panel renders PENDING with the decision form
3. Enter a reviewer name (and, optionally, a note), click Approve
   -> "Decision recorded."; the panel becomes the read-only APPROVED record
   -> no edit or revoke control exists
4. Run a fresh "Approval workflow demo" investigation and click Reject instead
   -> the symmetric terminal REJECTED state
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
