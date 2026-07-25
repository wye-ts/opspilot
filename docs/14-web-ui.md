# OpsPilot — Web UI (Milestone 7)

| Field | Value |
|---|---|
| Document | React Timeline UI — Implementation Record |
| Status | PR 4A: read-only investigation/timeline/report slice implemented. Approval UI is **pending PR 4B**. |
| Project | OpsPilot |
| Purpose | Document the `apps/web` React UI — its scope, the one-action investigation workflow, the timeline/report rendering model, and how to run it locally |
| Related documents | `docs/reviews/14-react-timeline-implementation-plan.md` (the approved plan this implements), `docs/12-agent-run-api.md` (the HTTP API this UI consumes), `docs/13-approval-workflow.md` (approval semantics — consumed starting in PR 4B) |

---

## 1. Scope and non-goals

`apps/web` is a local-only React SPA that consumes the existing `apps/api` HTTP API to demonstrate the OpsPilot backend end to end in a browser: describe an issue, run an investigation, and read the resulting trace timeline and generated report.

**Implemented in PR 4A:**

```text
one-action investigation workflow (create job -> start run)
internally generated ticket IDs — no editable Ticket ID field
read-only Investigation Timeline
read-only Generated Report, including suggested-action cards
the "Approval workflow demo" checkbox and its report-level effect
partial-failure recovery via Retry Run
```

**Not yet implemented — PR 4B:**

```text
GET /v1/agent-runs/:runId/approval
POST /v1/agent-runs/:runId/approval
the approval panel and decision form
```

**Non-goals for this milestone** (both PRs): authentication, RBAC, multi-user support, a job queue, SSE/WebSockets/live streaming, background polling, deployment/production observability, a design-system package, dark mode, internationalization, live LLM/embedding provider calls, editing or revoking an approval decision, executing an approved action, routing, run deep links, and browser storage.

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
    App.tsx              the only stateful component — owns the workflow (§4)
    styles.css            one hand-written stylesheet, no framework
    api/
      http-client.ts       the only fetch call site
      endpoints.ts          createAgentJob / startAgentRun / getAgentRun
      types.ts               type-only @opspilot/contracts reuse + local envelope types
      http-client.test.ts
    format/
      datetime.ts, datetime.test.ts
    trace/
      trace-presentation.ts, trace-presentation.test.ts
    components/
      InvestigationForm, InvestigationSummary, TraceTimeline, ReportPanel,
      SuggestedActionCard, StatusBadge, ErrorBanner (+ .test.tsx for the first three)
    App.run-workflow.test.tsx
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
1. POST /v1/agent-jobs               { ticketId, summary }
2. POST /v1/agent-jobs/:jobId/runs   (no body)
3. render run metadata, timeline, report, evidence, suggested actions
```

This is safe because `POST /v1/agent-jobs/:jobId/runs` is fully synchronous — it executes the whole orchestrator loop in the request handler and returns the complete terminal projection (`docs/12-agent-run-api.md` §1). No polling or background refresh is needed.

An explicit `phase` state (`idle | creating-job | running-agent | refreshing-run`) drives the button label ("Creating investigation…" / "Running agent…") and a persistent `aria-live="polite"` progress region, and disables the form and Retry Run/Refresh controls for the duration of any one workflow. Race safety comes from an `AbortController` (aborts a superseded request) plus a monotonic generation counter (discards a stale response even if abort didn't land in time).

### Partial-failure behavior

| Failure point | Behavior |
|---|---|
| Job creation fails | The safe API error is shown. **No run request is issued.** Nothing is committed to the page — no job, run, timeline, or report. |
| Job creation succeeds, run creation fails | The created job's metadata (Ticket ID, Job ID) is retained and displayed. The safe API error is shown. A **Retry Run** button appears and, when clicked, calls **only** `POST /v1/agent-jobs/:jobId/runs` for the same job — a second job is never created automatically. |
| A new investigation starts | The prior job, run, timeline, report, error, and notice state are all cleared before the new request is issued. A fresh internal ticket ID is generated unless **Approval workflow demo** is checked. |

Retry Run is offered only while a job exists with no run (i.e., only after a run-creation failure) — it is never offered after a successful run.

---

## 5. Relative `/v1` requests and the Vite proxy

Browser code calls only relative paths (`/v1/agent-jobs`, `/v1/agent-jobs/:jobId/runs`, `/v1/agent-runs/:runId`). There is **no frontend API-base environment variable** and no `.env` file for `apps/web`.

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

**Verified in PR 4A:** an ordinary investigation (unchecked demo checkbox) produces zero suggested-action cards; checking **Approval workflow demo** (ticket `TICKET-APPROVAL-DEMO`) produces exactly one `DRAFT_CUSTOMER_REPLY` card. This proves the checkbox's report-level effect even though the approval panel itself is not implemented until PR 4B.

---

## 8. Accessibility baseline

One `<h1>`; ordered heading levels per section. Every control has a real, associated `<label>` — no placeholder-as-label. Native `<button>`/`<textarea>`/`<input type="checkbox">` only, so keyboard operation (including Space on the checkbox) works without a key handler. `role="alert"` for the error banner; a persistent `aria-live="polite"` region for workflow progress and notices. `aria-busy` on the form while a workflow is active. A visible `:focus-visible` outline. Status is never color-only — `StatusBadge` always renders a text label plus a glyph. WCAG-AA-readable contrast. No horizontal page scroll at 360px width. The timeline is `<ol>`; evidence and suggested actions are `<ul>`; identifiers and report fields are `<dl>`.

---

## 9. Dependencies

`apps/web/package.json` — 14 entries total (3 `dependencies` + 11 `devDependencies`; 13 external packages + 1 workspace dependency, `@opspilot/contracts`, imported type-only):

```text
dependencies:     @opspilot/contracts (workspace:*), react ^19, react-dom ^19
devDependencies:  @testing-library/dom ^10, @testing-library/jest-dom ^6,
                   @testing-library/react ^16, @testing-library/user-event ^14,
                   @types/react ^19, @types/react-dom ^19, @vitejs/plugin-react ^6,
                   jsdom ^29, typescript ^7.0.2, vite ^8, vitest ^4.1.10
```

`@testing-library/dom` is a required peer of `@testing-library/react` v16, which does not bundle it. `typescript` and `vitest` deliberately match the root pins exactly. All majors are current and stable — nothing experimental or pre-release.

---

## 10. Running it locally

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

In the browser: type an Issue Summary and click **Run Investigation** for the ordinary path (`NOT_ELIGIBLE` once approval lands in PR 4B); check **Approval workflow demo** first to see the one `DRAFT_CUSTOMER_REPLY` suggested action.

```bash
pnpm --filter @opspilot/web run typecheck
pnpm --filter @opspilot/web run test
pnpm --filter @opspilot/web run build
pnpm --filter @opspilot/web run preview  # serves the production build at http://127.0.0.1:4173
```

---

## 11. Future direction — PR 4B

`GET`/`POST /v1/agent-runs/:runId/approval`, the four-state `ApprovalPanel` (`NOT_ELIGIBLE`/`PENDING`/`APPROVED`/`REJECTED`), the `ApprovalDecisionForm`, and the corrected browser demo walkthrough. See `docs/reviews/14-react-timeline-implementation-plan.md` §9/§14 for the full design, and `docs/13-approval-workflow.md` for the backend semantics the panel will render.
