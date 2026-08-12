# OpsPilot — Web UI (Milestone 10)

| Field | Value |
|---|---|
| Document | React Timeline UI — Implementation Record |
| Status | Implemented |
| Project | OpsPilot |
| Purpose | Document the `apps/web` React UI — its scope, the one-action investigation workflow, the timeline/report rendering model, the flat 1→7 run-detail flow and approval interaction, the Milestone 10 visual system (product identity, provider cards, responsive layout), and how to run it locally |
| Related documents | `docs/12-agent-run-api.md` (the HTTP API this UI consumes), `docs/13-approval-workflow.md` (the approval semantics this UI's approval panel renders) |

---

## 1. Scope and non-goals

`apps/web` is a React SPA that supports local development and same-origin production serving through `apps/api`, consuming the existing `apps/api` HTTP API to demonstrate the OpsPilot backend end to end in a browser: describe an issue, run an investigation, read the resulting trace timeline and generated report, and — when the run produced at least one suggested action — record a human approve/reject decision against it.

**Implemented:**

```text
one-action investigation workflow (create job -> start run -> load approval)
internally generated ticket IDs — no editable Ticket ID field
read-only Investigation progress + Agent activity timelines
read-only Generated Report, including suggested-action cards
the approval demo reached via ?approval-demo=1 (no public checkbox), and its
  report-level effect
partial-failure recovery via Retry Run (FAKE) and Recover Live Run mode (LIVE)
the four-state approval panel (NOT_ELIGIBLE / PENDING / APPROVED / REJECTED)
recording an approve/reject decision, with 201/200/409 handling
a flat 1→7 run-detail flow (§15): Current investigation -> approval banner ->
  Progress + Resolution -> Suggested Actions -> Human Approval -> Agent
  Activity -> Run Details (replacing the two-column Run Context Panel layout)
a top-of-page "Action required" banner, shown only while a decision is PENDING
an accessible, wording-accurate notice for a pending decision, distinguishing
  a fresh completion/retry from an explicit refresh
the Milestone 10 visual system: OpsPilot / AI Operations Investigator product
  identity, GitHub/LinkedIn portfolio links, whole-card Demo/Live provider
  selector, progressive 15-character CTA validation, composer collapse after
  job creation, non-failure presentation of Live admission refusals, Agent
  Activity product language with a Technical details disclosure, and a
  responsive desktop (~1440px) / mobile (~390px) layout
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
    styles.css            one hand-written stylesheet, no framework (§10)
    api/
      http-client.ts       the only fetch call site
      endpoints.ts          createAgentJob / startAgentRun / getAgentRun / getApproval / recordApproval
      types.ts               type-only @opspilot/contracts reuse + local envelope types
      http-client.test.ts
    format/
      datetime.ts, datetime.test.ts
    url/
      investigation-url.ts   readApprovalDemoParam — the ?approval-demo=1 mount read (§3)
    provider/
      provider-presentation.ts, provider-presentation.test.ts
        (pure capabilities -> provider-card mapping for the Demo/Live selector —
        §13.1, Milestone 10)
    trace/
      trace-product-labels.ts, trace-product-labels.test.ts
        (pure AgentTraceEvent -> product-language mapping + Technical details
        rows — §6.2, Milestone 10)
    approval/
      approval-presentation.ts, approval-presentation.test.ts
    run/
      run-overview-presentation.ts, run-overview-presentation.test.ts
        (shared run-status badge mapping)
    investigation-progress/
      investigation-progress-stages.ts, investigation-progress-stages.test.ts
        (pure stage derivation + presentation for the Progress Timeline — §6.1)
    hooks/
      useElapsedTime.ts, useElapsedTime.test.ts
    components/
      InvestigationForm (§3/§13.1), InvestigationSummary (item 7 — Run Details,
        §19), InvestigationProgressTimeline (§6.1), CurrentInvestigation (item 1,
        §12), TraceTimeline (item 6 — "Agent activity", §6.1/§6.2), ReportPanel,
      SuggestedActionCard, StatusBadge, ErrorBanner,
      ApprovalPanel, ApprovalDecisionForm, ActionRequiredBanner,
      ProductHeader (§4), AppFooter (§4), ProviderCard (§13.1),
      TechnicalDetails (§6.2)
      (+ .test.tsx for most of the above)
    App.run-workflow.test.tsx
    App.approval.test.tsx
    App.run-context-layout.test.tsx (flat-flow ordering, Milestone 10)
    App.progress-timeline.test.tsx (§6.1)
    App.reveal-boundaries.test.tsx (§6.3)
    App.new-submission-reset.test.tsx (§6.1)
    App.live-region-text.test.tsx (§9)
    App.outcome-aware-progress.test.tsx (§6.4)
    App.header-copy.test.tsx (product identity + portfolio links, §4)
    test/setup.ts
```

---

## 3. Issue-Summary-first UX and internal ticket-ID derivation

The visible form (the "composer") contains an **Issue Summary** textarea, a
whole-card **Demo / Live** provider selector (§13.1), and a **Start
Investigation** button. There is no editable Ticket ID field anywhere in the UI,
and — since Milestone 10 — **no public "Approval workflow demo" checkbox**.

The approval demo is reached by loading the app with the query parameter
`?approval-demo=1`. `readApprovalDemoParam(window.location.search)`
(`url/investigation-url.ts`) is read **once at mount** and passed to the form as
`defaultApprovalDemo`, preselecting the demo ticket for a Demo (FAKE) run. It is
not a toggle the visitor can flip mid-session — the checkbox was removed because
a permanent demo affordance on every ordinary run misread as a product feature
rather than a reviewer-protocol test scaffold (§13.1).

`App.tsx` derives the ticket ID at submit time:

```ts
const ticketId = approvalDemo ? "TICKET-APPROVAL-DEMO" : `DEMO-${crypto.randomUUID()}`;
```

This is safe against the backend's actual constraints: `TicketContextSchema` places no uniqueness or format requirement on `ticketId`, and `docs/12-agent-run-api.md` §3 states explicitly that duplicate `ticketId` submissions are allowed and create separate jobs. The generated/internal ticket ID is displayed only as read-only metadata (`<dl>`, never a disabled `<input>`) alongside the Job ID and Run ID once a job exists.

---

## 4. One-action chained workflow

The user clicks **Start Investigation** once. `App.tsx` performs the chained request sequence:

```text
1. POST /v1/agent-jobs                        { ticketId, summary }
2. POST /v1/agent-jobs/:jobId/runs             (no body)
3. render run metadata, timeline, report, evidence, suggested actions
4. GET  /v1/agent-runs/:runId/approval
5. render the approval panel
```

Step 2 is safe to treat as complete-and-final because `POST /v1/agent-jobs/:jobId/runs` is fully synchronous — it executes the whole orchestrator loop in the request handler and returns the complete terminal projection (`docs/12-agent-run-api.md` §1). No polling or background refresh is needed anywhere in this workflow, including the approval step. The frontend still branches on the response's `outcome.type` rather than assuming COMPLETED (§6.4) — today's backend does not produce `RUNNING` in practice, but the contract allows it, and the UI honors that rather than mis-announcing success. A `RUNNING` outcome is the one case where the existing Refresh action, not a new request the initial workflow issues itself, is how the browser would ever learn the eventual result — still not polling (#38 remains out of scope).

**The approval fetch is secondary to the run result.** It never gates or unwinds the render of step 3 — the run, timeline, and report are already on the page by the time step 4 starts, and a step-4 failure leaves them exactly as they are (§8).

An explicit `phase` state (`idle | checking-availability | creating-job | running-agent | loading-approval | refreshing-run | submitting-approval`) drives the button label ("Creating investigation…" / "Agent investigation in progress…" / "Loading approval state…" / "Recording decision…" — the four request-lifecycle labels sourced from `STAGE_LABELS`, §6.1/§9) and a persistent `aria-live="polite"` progress region, and disables the form and Retry Run/Refresh/decision controls for the duration of any one workflow. Race safety comes from an `AbortController` (aborts a superseded request) plus a monotonic generation counter (discards a stale response even if abort didn't land in time). The approval fetch chained after a run reuses that same signal and generation rather than starting a new workflow.

### Partial-failure behavior

| Failure point | Behavior |
|---|---|
| Job creation fails | The safe API error is shown. **No run request is issued.** Nothing is committed to the page — no job, run, timeline, or report. |
| Job creation succeeds, run creation fails (**FAKE**) | The created job's metadata (Ticket ID, Job ID) is retained and displayed. The safe API error is shown. A **Retry Run** button appears and, when clicked, calls **only** `POST /v1/agent-jobs/:jobId/runs` for the same job, followed by the same approval fetch — a second job is never created automatically. |
| Job creation succeeds, run creation fails (**LIVE**) | Same retention, but recovery needs a credential the app deliberately no longer holds (§13.2), so there is no Retry Run button. The **form itself switches into "Recover Live Run" mode** against the retained job: the ticket, summary, and provider are shown read-only, the token field starts empty, and submitting calls `retryLiveRunWithToken`, which issues **only** `POST /v1/agent-jobs/:retainedJobId/runs` — carrying the same `Idempotency-Key` as the failed attempt, so a run the first request may already have created is returned rather than duplicated (§7.2). See §7.1. |
| Run created, approval fetch fails | The safe API error is shown, but **the run, timeline, and report stay rendered.** The run projection is the primary artifact; approval is an annotation on it (§8). |
| A new investigation starts | The prior job, run, approval, timeline, report, error, and notice state are all cleared before the new request is issued. A fresh internal ticket ID is generated unless the `?approval-demo=1` default was active at mount. |

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
| First LIVE run in flight | `false` | Ordinary busy UI — editable summary, provider radios, "Agent investigation in progress…" |
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
| `201` started | `PENDING` | *Investigation complete. Human approval required.* — same canonical wording as every other creation path (§9) |
| `201` started | anything else | *Investigation complete.* |

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

### 6.1 Two timelines, deliberately not one

Milestone 9 Phase A (#34/#35) introduced a SECOND timeline-shaped surface, and the two are kept structurally and conceptually separate rather than merged into one component:

| | **Investigation progress** | **Agent activity** |
|---|---|---|
| Component | `InvestigationProgressTimeline` (new) | `TraceTimeline` (unchanged, renamed heading only) |
| Data source | Frontend-known request-lifecycle stages (`availability`\*/`job`/`run`/`approval`), derived in `investigation-progress/investigation-progress-stages.ts` | Backend-reported `AgentTraceEvent[]` (`run.trace`) |
| Available | **Immediately** on submit, before any request has resolved | Only once `run !== null` — i.e. after the run response arrives |
| Status vocabulary | `Pending` / `Active` / `Completed` / `Failed` — never a percentage, never advanced by a timer | Ordered, completed-only steps (no live/pending concept — the whole array arrives at once) |

\* `availability` only appears for a LIVE submission.

Why two components rather than one: `TraceTimeline` already existed, tested and shipped, rendering exactly `run.trace` — a POST-HOC, backend-authored list with no notion of "pending" or "in progress" (the whole array arrives already-complete, in one response). Retrofitting frontend-known PRE-run stages into it would have meant teaching one component two unrelated data shapes and two unrelated timing models. `InvestigationProgressTimeline` sits above it in the render order instead.

Milestone 10 replaces the old two-column render order with a **flat 1→7 flow** (§15): Current investigation → (PENDING-only) approval banner → a shared row holding Progress + Resolution → Suggested actions → Human Approval → Agent Activity → Run Details. The two timelines never claim to be the same list, and the Progress Timeline's `approval` stage is what states "approval not yet loaded" while the approval fetch is still settling (§8.2).

**Why `approval` is driven by `approvalLoadStatus`, not `phase`.** The `loading-approval` phase is reused by five different code paths in `App.tsx` (`runInvestigation`, `retryRun`, `retryLiveRunWithToken`, `refreshRun`, and the approval-decision 409-conflict re-fetch), so `phase` alone cannot tell "this investigation's approval fetch" apart from "a much later manual Refresh click or decision-conflict reload". `approvalLoadStatus` (`idle`/`loading`/`loaded`/`failed`) is set exclusively by `loadApproval()` when the caller marks that request as part of the tracked workflow.

**`loadApproval(..., { trackInvestigationProgress })`.** Initial COMPLETED settlement, a COMPLETED FAKE retry, and a COMPLETED LIVE recovery pass `trackInvestigationProgress: true`. A Refresh that observes a previously RUNNING run become COMPLETED also passes `true`, because this is the first terminal settlement and first approval load for that investigation. A manual approval Refresh of an already-COMPLETED run and the 409-conflict convergence reload pass `false`: both can happen after the Progress Timeline's approval row has settled and must not rewrite it back to Active or Failed. A FAILED run never starts approval loading, including on FAILED → FAILED Refresh. Transient loading/error UI remains independent from whether the Progress Timeline records the approval request. Covered by the manual-approval-action tests in `App.progress-timeline.test.tsx` and the outcome-aware Refresh tests in `App.outcome-aware-progress.test.tsx`.

**Why a failed stage survives `phase` returning to idle.** Every error path in `App.tsx` sets `phase` back to `"idle"` — the same terminal value a SUCCESS reaches — so `phase` cannot by itself answer "did this fail, and where?" A small `failedStage: InvestigationProgressStageKey | null`, set only at the exact request boundary that failed and cleared only at the start of the next submission/retry, is the one piece of state genuinely new here; everything else about the stage list (which one is active, which are completed) is derived from state that already existed (`phase`, `job`, `run`).

**Why the previous investigation's visible result is cleared BEFORE the LIVE preflight, not after.** `beginNewSubmissionDisplay()` clears `job`/`run`/`approval`/`error`/`notice`/`ticketId`, retry/idempotency ownership, and the prior provider mode, then initializes the new snapshot/progress state in one call made immediately after the empty-token guard and before `refreshCapabilities()` is dispatched. Clearing only after a successful preflight would let a slow or refused preflight render the new availability stage next to the previous investigation's result. The helper is deliberately not used by `retryRun`/`retryLiveRunWithToken`, which resume an existing job and retain its retry ownership. Covered by `App.new-submission-reset.test.tsx`.

**Elapsed time** is two epoch-ms timestamps, `submittedAt`/`submittedFinishedAt`, not a running interval that's paused/resumed. `submittedFinishedAt` is set at the tracked flow's first terminal outcome. Usually that happens during the initial submission or retry; when the first response is RUNNING, a later user-initiated run Refresh can observe RUNNING → COMPLETED/FAILED and freeze the timer at that first terminal observation. RUNNING → RUNNING leaves it untouched, and later Refresh/approval-decision actions cannot restart or refreeze it. `useElapsedTime(startedAt, finishedAt)` (`hooks/useElapsedTime.ts`) ticks at ~1s resolution while `finishedAt` is null and freezes the moment it is set; it is rendered as plain visible text outside the `aria-live` region (§9).

**One canonical stage-label source.** `STAGE_LABELS` (`investigation-progress/investigation-progress-stages.ts`) is the ONLY place the active/completed copy for `availability`/`job`/`run`/`approval` is written. `App.tsx`'s `PHASE_LABELS` — which drives BOTH the submit button's busy text and the sole `role="status"` live region — reads its four request-lifecycle entries directly from `STAGE_LABELS`, rather than maintaining an independently-worded copy that could drift (which is exactly what had happened: the live region said "Running agent…" while the visual stage row said "Agent investigation in progress…"). `refreshing-run`/`submitting-approval`/`idle` are not "stages" and keep their own distinct text. See §9 for the terminal-success and stage-specific-failure announcement text this same module provides.

### 6.2 Agent activity (formerly "Timeline")

- **Ordering source:** array order of `trace`, exactly as the API returns it (`sequence_number ASC`, never re-sorted by the UI).
- **No per-event timestamps.** `AgentTraceEventSchema` carries no time field — `sequence_number`/`created_at` exist in the database but are never mapped into the response. The timeline therefore uses 1-based step ordinals only. Real timestamps (`startedAt`/`finishedAt`/duration) appear only in the Investigation summary panel, where they are genuine.
- **All four contract variants render:** `TOOL_REQUESTED`, `TOOL_COMPLETED`, `REPORT_GENERATED`, `RETRIEVAL_COMPLETED` (the last is currently unreachable through `apps/api`, since no retriever is wired into its tool registry — it is implemented because an exhaustive switch over the contract union requires it).
- **Unknown-event fallback:** an event type outside the current union renders the generic product phrase "Agent activity recorded" with the raw `type` string as supporting detail only, never a raw payload dump.
- **Product language, not raw event types (Milestone 10, §14).** `presentTraceProductLabel` (`trace/trace-product-labels.ts`) maps each event to readable copy deterministically: `TOOL_REQUESTED` for the grounded `get_service_status` tool renders **"Checking service status"**, `TOOL_COMPLETED` renders **"Checked service status"**, `REPORT_GENERATED` renders **"Resolution report generated"**, and `RETRIEVAL_COMPLETED` renders **"Runbook retrieval completed"** with a grounded chunk-count detail line. Only tools whose semantics are grounded in this repository have entries in the map; anything else degrades to the generic phrases above.
- **Raw identifiers live behind Technical details.** `traceTechnicalEntries` collects one sanitized row per `TOOL_REQUESTED` (tool name + call id), rendered in a `TechnicalDetails` disclosure under the timeline — never secrets, tokens, prompts, payloads, or stack traces. The primary copy stays product language.

### 6.3 Data-driven reveal boundaries

Every surface reveals strictly on real data becoming available — never on a timer, an animation delay, or a fixed pacing. `App.tsx`'s exact rules, in the flat 1→7 order (§15):

```text
job exists (job !== null)                       // item 1
  -> Current investigation renders; the composer collapses (it is only
     shown again for a new investigation, a Live retry, or a job-only resume)

approval is PENDING                             // item 2
  -> the Action required banner renders

job/run data exists                              // item 3
  -> Investigation progress renders (progressStages, derived)
run is terminal (outcome.type !== "RUNNING")
  -> Resolution report renders (ReportPanel — COMPLETED or FAILED; never RUNNING)

run is terminal, outcome is COMPLETED, and suggestedActions is non-empty  // item 4
  -> Suggested actions renders (SuggestedActionsPanel, a separate component)

approval data exists (approval !== null)         // item 5
  -> ApprovalPanel renders DIRECTLY for all four statuses (NOT_ELIGIBLE /
     PENDING / APPROVED / REJECTED). When approval is null (still loading, or
     the fetch failed) no decision surface mounts — the Progress Timeline's
     approval stage already states that truthfully.

run data exists (run !== null)                   // item 6
  -> Agent activity renders (TraceTimeline over run.trace, whatever it contains)

job exists (job !== null)                        // item 7
  -> Run details renders (InvestigationSummary)
```

**A `RUNNING` outcome never renders an empty Resolution report panel.** `ReportPanel`'s prop type is `ReportableOutcome = Exclude<AgentRunOutcomeView, { type: "RUNNING" }>` — `App.tsx` only mounts it when `run.outcome.type !== "RUNNING"`, so the invariant is checked by the type system, not merely by convention. A RUNNING run can still be refreshed via `InvestigationSummary`'s always-present Refresh button (unconditional on outcome type) — no affordance was lost by removing `ReportPanel`'s own former RUNNING-only Refresh button.

**Suggested actions is a separate, independently-gated component**, not a `<h3>` nested inside `ReportPanel`. An EMPTY `suggestedActions` array renders nothing at all — no heading, no "this run produced no suggested actions" placeholder — because `App.tsx` only mounts `SuggestedActionsPanel` when the array's length is greater than zero; there is nothing to hide with an empty-state message.

**Lifecycle surfaces are gated on `job !== null`, never on `isBusy` or `submittedSummary`.** The composer, Current investigation, and Progress Timeline all derive from `job` — the same grounded stance the other lifecycle surfaces use — so a busy spinner is never mistaken for a committed investigation and vice versa (§15).

Proven end to end by `App.reveal-boundaries.test.tsx` (six scenarios: unresolved job/run; RUNNING with real trace data; terminal with an empty-actions report; terminal with non-empty actions; an applicable approval appearing only after its load settles, positioned after Suggested actions; the full final order with a non-empty-action, approval-applicable fixture) using controlled/deferred promises throughout — never a `setTimeout` or a snapshot of only the final state.

### 6.4 Outcome-aware run progress

The run stage's status — and everything gated on it — is a function of `run.outcome.type`, never of `run !== null` alone. A run object can exist with a non-terminal (`RUNNING`) or unsuccessful (`FAILED`) outcome, and treating either as "Completed" would announce a success that never happened. `deriveInvestigationProgressStages` (`investigation-progress-stages.ts`) and `App.tsx`'s shared `settleRunOutcome()` helper both branch on the actual outcome:

| Outcome | Run progress stage | Elapsed timer | Approval load | Live-region announcement |
|---|---|---|---|---|
| `RUNNING` | **Active** — stays "Agent investigation in progress…" | Keeps ticking | Never starts | None (no terminal claim) |
| `COMPLETED` | **Completed** | Freezes | Starts, tracked | Success (`"Investigation complete."`, plus "Human approval required." if applicable) |
| `FAILED` | **Failed** | Freezes | Never starts | Stage-specific failure (`"Investigation failed while running the agent investigation."`) |

**`RUNNING` is a legitimate, possibly long-lived state, not a bug.** Polling (below, §6.5) keeps observing the run until a terminal outcome arrives, so the timeline settles automatically once the agent finishes — the user's own Refresh click is no longer the only observation mechanism. The submit button/form still unlocks once the outcome is known (RUNNING included); only the Progress Timeline's `run` row and the elapsed clock reflect "still going."

**Refresh behavior depends on the previous outcome.** `refreshRun()` captures the previous outcome before replacing the run projection. A previous RUNNING outcome routes RUNNING → RUNNING/COMPLETED/FAILED through `settleRunOutcome()`: only RUNNING → COMPLETED performs the first tracked approval load, while both terminal transitions freeze elapsed time. A previous COMPLETED outcome keeps the ordinary run-plus-approval Refresh behavior, with that approval load untracked so completed progress cannot regress. A previous FAILED outcome can only remain FAILED: terminal status is immutable in the repository, so FAILED → RUNNING and FAILED → COMPLETED are unsupported domain transitions. FAILED → FAILED refreshes the run projection without loading approval and preserves the failure announcement/report.

**A LIVE recovery reply is outcome-aware too**, with one added wrinkle: whether the server REPLAYED an existing run (`200`) is a fact about IDEMPOTENCY, independent of that run's outcome. "Recovered the original live run — no new run was started." is shown whenever `replayed` is true — including when the recovered run turns out to be `RUNNING` (a normal, correct answer for what a finalization failure leaves behind) or `FAILED` (combined with the stage-failure text) — never only for a `COMPLETED` replay.

Proven by `App.outcome-aware-progress.test.tsx` (initial RUNNING/FAILED/COMPLETED outcomes; all three Refresh transitions out of RUNNING; FAKE-retry and LIVE-recovery outcome-awareness) and the pre-existing `App.live-idempotency.test.tsx` (a RUNNING replay still announces the recovery confirmation).

### 6.5 Live investigation timeline with canonical execution stages (#38)

As of #38, the investigation progress Timeline reflects persisted server facts rather than frontend request boundaries alone. As of the Issue #41 vertical-stepper polish, the four canonical stages are not a nested breakdown under a run row — they render directly as the primary stepper, with the job/run request-lifecycle rows omitted entirely (they would otherwise just restate the first canonical stage and the run's own status):

```text
Investigation created                        Completed
Agent analysis                                Completed
  ├─ event label
  └─ event label
Diagnostic execution                          Running
Report generation                             Pending
```

**Data flow.** The shared `deriveExecutionStageProgress` reducer in `@opspilot/contracts` is the single place stage transitions are decided — React never re-derives them. The frontend wraps its output in an explicit `ExecutionStageDerivation` tri-state:

| Derivation | Job/run system rows | Primary stepper (four canonical stages) |
| --- | --- | --- |
| `legacy` | Render — today's job/run/approval stepper, unchanged | Omitted entirely |
| `canonical` | Omitted | Four reducer stages, 1:1, render directly, with observed events nested beneath each |
| `canonical-invalid`, `lastGoodStages` present | Omitted | Frozen last-good stages render directly, WITHOUT nested events |
| `canonical-invalid`, `lastGoodStages` null | Render (fallback) | Omitted; a "detail unavailable" note renders instead |

Nested event rows are attached **only** from a trusted `canonical` stream. A `canonical-invalid` stream is the very stream whose reduction just failed, so its events are never grouped beneath the frozen last-good rows — the frozen stage statuses are preserved and the invalid stream's events are simply not shown (#40 fail-closed; a corrupt stream cannot make newly-invalid detail look trustworthy). No branch infers stage status from a timer or percentage. Corrupt canonical data can never fall through to legacy rendering because `canonical-invalid` is structurally distinct from `legacy`.

**No expand/collapse state.** The four canonical stages are never collapsible — there is no disclosure control, no `runExpansionKey`, and no local "collapsed" state to reset on a new run/attempt/job. Whenever canonical children exist (`canonical`, or `canonical-invalid` with `lastGoodStages`), all four stages and any nested events they carry render in full, for the whole lifetime of the run, RUNNING or terminal alike.

**Polling.** A single `setTimeout` chain (never `setInterval`) polls `GET /v1/agent-jobs/:jobId/investigation` concurrently with the blocking run POST. Overlap is structurally impossible — the next tick is scheduled only after the previous response settles. The cadence is bounded (1s/2s/5s), transient failures use a fixed backoff (2s→4s→8s→15s→15s), and polling stops at the first terminal observation, after 6 consecutive transient failures, or after 5 minutes of continuous polling. A "Check again" button starts a fresh bounded session with all counters reset. Error classification is centralized in `poll-error-classification.ts`: `INTERNAL_DATA_INVALID` pauses immediately with zero automatic retries; `AGENT_JOB_NOT_FOUND` stops and strips `?job=`; transient 5xx/network errors retry with backoff.

**Terminal settlement coordinator.** The blocking POST and the poller are two independent observers of the same run — either may observe the terminal outcome first. `resolveTerminalObservation` (pure, in `terminal-settlement.ts`) decides whether THIS observation is the first (`"owner"`), a harmless duplicate (same identity + same terminal status), or an impossible internal-consistency failure (`"inconsistent-terminal-status"` — same identity + opposite terminal status). The consistency decision happens BEFORE any state is applied, so a contradictory second observation never overwrites the first accepted terminal outcome, never repeats side effects, and surfaces one fixed safe notice.

**URL identity and resume.** After `createAgentJob` resolves, `?job=<uuid>` is written via `replaceState` (same view gaining an identity) or `pushState` (replacing a different job). A reload mid-run picks the same job back up via mount-time resume. Navigation to a different job or to the fresh form calls `invalidateInFlightWorkflows`, which bumps the main workflow generation (aborting the in-flight POST/capability/approval fetch), clears the terminal settlement claim, and stops/invalidates polling — all BEFORE hydrating or resetting any target state. An old POST, capability response, or poll response arriving after navigation is discarded by the generation guard.

**LIVE-recovery limitation.** `liveRequestKey` lives only in memory, so a LIVE job resumed after a reload cannot offer idempotent recovery — minting a fresh key would risk a second paid run. A resumed LIVE job with no run shows "start a new investigation" instead of "Recover Live Run". Within a session, existing recovery is unaffected.

**Authoritative final read on POST-observed termination.** When the blocking run POST is the first observer to see a terminal outcome (`resolveTerminalObservation` returns `"owner"` for a `source: "post"` observation), that POST response never carries canonical `events[]`. Before permanently freezing the Timeline, `applyObservedRunOutcome` issues one additional `getInvestigationState` read and adopts its job/run/trace/outcome/events only if they match the expected job, run, attempt, and outcome type; a mismatch or a transient failure on that read falls back to the POST's own candidate data silently, so a blip never undoes the terminal outcome or repeats a side effect. Resume's own state read is already authoritative, so it skips this extra call.

**Invalidation ordering on a new submission.** `runInvestigation` calls `invalidateInFlightWorkflows()` — bumping the main generation, aborting the capability controller, stopping polling, and clearing the terminal claim — immediately after validating the submission and before resetting the display or running the LIVE preflight. This closes a window where a slow preflight or a stale poll/POST response could repopulate the freshly-reset display with the previous investigation's data.

**Current-attempt monotonicity.** `isNewerInvestigationSnapshot` rejects any incoming poll snapshot whose attempt number is below the attempt number *currently held on screen*, independent of the `minAttemptNumber` floor set at retry time. This closes a race where a late poll tick for an older attempt could still pass the floor check yet be older than what is already displayed.

**Surfacing permanent poll failures.** A `not-found` classification resets to the fresh form (exact notice, `?job=` stripped, other query params preserved, no "Check again") and invalidates in-flight workflows first. A `permanent-invalid` classification shows a fixed safe notice with no raw error text and no automatic or manual retry. Both classifications are ignored if they arrive from an already-superseded workflow generation.

**Refresh and polling coherence.** Manual Refresh stops any active poll session before re-fetching the run. If the refreshed run is still `RUNNING`, polling restarts under a new workflow generation instead of running `settleRunOutcome`; a `COMPLETED`/`FAILED` refresh result settles normally with no restart.

**Capabilities after resume.** Mount-time and `popstate` resume both call `invalidateInFlightWorkflows()`, which aborts the in-flight capability request. Each resume path also calls `refreshCapabilities()` immediately afterward, so LIVE availability is re-established without waiting for an unrelated focus or visibility event.

---

## 7. Report and suggested-action rendering

`ReportPanel` renders the `FAILED` and `COMPLETED` outcome shapes only (§6.3 — `RUNNING` is excluded at the type level and handled by the caller). For `COMPLETED`, every `ResolutionReport` field except suggested actions: category, confidence, summary, root cause, customer impact, recommended resolution, and evidence. It takes no callback props (`onRefresh` was removed — nothing in `ReportPanel` needed it once the RUNNING branch moved out).

`SuggestedActionsPanel` (a sibling component, not nested in `ReportPanel`) renders the suggested-actions list via `SuggestedActionCard`, which renders all three currently defined variants (`UPDATE_TICKET_STATUS`, `CREATE_ESCALATION`, `DRAFT_CUSTOMER_REPLY`) exhaustively. A `DRAFT_CUSTOMER_REPLY` body (up to 4000 characters) is rendered in full — `white-space: pre-wrap`, a bounded `max-height`, and vertical scrolling — never truncated.

**Verified:** an ordinary investigation (no `?approval-demo=1`) produces no Suggested actions section at all and an always-`NOT_ELIGIBLE` approval panel; loading the app with `?approval-demo=1` (ticket `TICKET-APPROVAL-DEMO`) produces a Suggested actions section with exactly one `DRAFT_CUSTOMER_REPLY` card and a `PENDING` approval panel with a decision form.

---

## 8. Run-detail flow and approval UX

### 8.1 The problem the flat flow solves

Milestone 10 replaces the two-column layout with a single **flat 1→7 flow** (§15), because a decision outstanding at the very bottom of a tall report read as "done". Every item is a full-width section in one predictable top-to-bottom order:

```text
1  Current investigation     — the compact post-job card (§12)
2  approval banner           — only while approval is PENDING
3  Progress + Resolution     — share a row on desktop; Resolution is the wider
                               column, and Progress collapses to full width when
                               it is the only child
4  Suggested actions         — only when the COMPLETED report has any
5  Human Approval            — ApprovalPanel, rendered directly for all four
                               statuses; NOTHING renders while approval is null
6  Agent Activity            — TraceTimeline with product-language labels (§6.2)
7  Run Details               — InvestigationSummary, which absorbed
                               RunOverviewPanel's unique facts (§19)
```

The backend contract is untouched: `ApprovalStatus`, `ApprovalView`, `presentApproval`'s inputs/outputs, and the `201`/`200`/`409`×2 handling are all unchanged.

### 8.2 The Progress + Resolution row and the approval gap

`.resolution-row` is a CSS grid at `64rem` (1024px) and up:

```css
grid-template-columns: minmax(15rem, 20rem) minmax(0, 1fr);
```

- **Progress** (narrow column) — `InvestigationProgressTimeline`, including the four canonical execution stages rendered directly as the primary stepper (§6.5). It is gated on `job !== null` and always renders when the composer is gone, so the reviewer always sees *something* from the moment the investigation commits.
- **Resolution** (wide column) — `ReportPanel`, gated on `run.outcome.type !== "RUNNING"`. A `RUNNING` outcome renders no placeholder — the row collapses to Progress alone via `> :only-child { grid-column: 1 / -1 }`.

Below `64rem` the row stacks to one column. **The approval gap:** while `approval === null` (loading, or the fetch failed), no decision surface mounts — the Progress Timeline's own `approval` stage already states truthfully that the approval state is pending/unknown, and no empty panel or eligibility claim is invented.

### 8.3 Item 7 — Run Details (InvestigationSummary)

`RunContextPanel` and `RunOverviewPanel` are **deleted**. `InvestigationSummary` becomes item 7. The Issue #41 polish pass (§12) matched it to the approved compact reference: four primary fields — **Provider / Model / Duration / Attempt** — with user-facing values (`Demo` for `FAKE`, `Live` for `LIVE`, never the raw enums), and **everything long/internal behind a `Technical details` disclosure**: Started, Finished, Trace-event count, Suggested-action count, Estimated cost (row hidden entirely when null — never `$0.00`, which would assert a measured free run), and the Ticket/Job/Run IDs as a read-only `<dl>` (never a disabled input). Refresh and Retry Run remain real controls but are de-emphasized as secondary actions; the "Jump to activity" / "Jump to report" links are **removed** — the flat flow is already in reading order, so in-page jumps would just duplicate the DOM order.

### 8.4 The pending-decision banner

A stateless `ActionRequiredBanner`, rendered by `App.tsx` only when `approval?.status === "PENDING"` (a condition derived from existing state — no new `useState`). **Position (§15):** item 2 of the flat flow, directly after Current investigation and before Progress + Resolution — approval-related UI stays ahead of the report reading surfaces, never buried at the bottom. It is an informational jump to the item-5 decision surface — the panel, not the banner, decides:

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
| A fresh investigation or Retry Run resolves to `COMPLETED` with `PENDING` approval | `"Investigation complete. Human approval required."` |
| A fresh investigation or Retry Run resolves to `COMPLETED` with any other approval state | `"Investigation complete."` |
| A fresh investigation or Retry Run resolves to `RUNNING` | No terminal notice; the current stage announcement clears when the request settles. |
| A fresh investigation or Retry Run resolves to `FAILED` | `"Investigation failed while running the agent investigation."` |
| Refresh observes `RUNNING → COMPLETED` | The same completion notice as initial settlement, including the approval-required suffix when applicable. |
| Refresh observes `RUNNING → RUNNING` | `"Run refreshed."` |
| Refresh observes `RUNNING → FAILED` or `FAILED → FAILED` | `"Investigation failed while running the agent investigation."` |
| An already-`COMPLETED` Refresh resolves to `PENDING` | `"Run refreshed. Human approval required."` |
| An already-`COMPLETED` Refresh resolves to any other approval state | `"Run refreshed."` |

`loadApproval()` returns the fetched `ApprovalView | null`; each settlement path chooses its notice from both the run outcome and, for `COMPLETED`, that approval result. Manual approval Refresh and 409 convergence still use the same request/race-safety machinery, but their approval reads are explicitly untracked so they cannot rewrite completed investigation progress (§6.1/§6.4).

### 8.6 Long content

A long terminal reviewer note (up to 1000 characters) is allowed to make the read-only terminal panel taller and rely on ordinary page scrolling — `white-space: pre-wrap; overflow-wrap: anywhere;` on the note `<dd>`, deliberately **not** a nested `overflow-y: auto` scroll region. The Approve/Reject button row (`.approval-decision-actions`) gains `flex-wrap: wrap` so it never overflows a narrow (mobile) panel width.

### The four statuses

| Status | Rendered | Controls |
|---|---|---|
| `NOT_ELIGIBLE` | A compact secondary status (Issue #41 polish §10) — badge + "Not eligible: this run produced no suggested actions." The panel no longer consumes a full large card for a no-op state, and no `?approval-demo=1` copy leaks into product UI: the query param remains a deterministic hidden/test entry point, never a user-facing instruction. | None |
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

If `GET .../approval` fails — after a run completes, after Retry Run, or after Refresh — the safe error is shown, but the run, timeline, report, evidence, and suggested actions **stay exactly as rendered**. Approval is an annotation on an already-successful run, not a precondition for showing one. In the flat flow this is the `approval === null` case (§8.2): no decision surface mounts and the Progress Timeline's approval stage carries the truthful "unknown yet" state — the reviewer still gets the full run, report, and activity surfaces.

### 8.7 Test coverage

Structural/DOM-order regressions are covered in `apps/web/src/App.run-context-layout.test.tsx` (banner presence per status, a flat-flow source-order check — banner precedes the Approval region, which precedes Run details, exactly one Approve/one Reject button while `PENDING`, `approval === null` rendering no eligibility claim, all three notice-wording variants, `tabindex="-1"` on the timeline/report/approval headings, and that a long reviewer note stays a single, non-duplicated `<dd>`); `apps/web/src/run/run-overview-presentation.test.ts` covers the extracted `runStatusBadge` helper's four branches. The `compareDocumentPosition()` assertions in that file are structural DOM-order regression checks on elements otherwise located by `getByRole` — not a simulation of user-perceived visual order, since jsdom has no real layout engine. Real sticky/grid behavior, real fragment scrolling/focus, and `prefers-reduced-motion` are exactly the things jsdom cannot prove; they remain open manual-verification items (§11).

**Milestone 9 Phase A (§6.1)** adds `App.progress-timeline.test.tsx` (immediate mount, job/run/approval stage transitions via deferred-promise fixtures, a failed stage surviving `phase` returning to idle, later stages staying Pending, the four `approvalLoadStatus` states, reveal order, approval-load failure not hiding a completed report, LIVE-only availability stage, single `aria-live` region, no percentage ever rendered, Retry Run resetting stage/elapsed state, and the elapsed timer stopping on both success and failure and cleaning up on unmount — `vi.useFakeTimers()` scoped to only those three tests), plus unit-level `investigation-progress/investigation-progress-stages.test.ts` and `hooks/useElapsedTime.test.ts` for the underlying pure derivation and timer hook. The five existing suites containing "Investigation timeline" text assertions (`App.live-idempotency.test.tsx`, `App.approval.test.tsx`, `App.live-retry.test.tsx`, `App.capabilities-refresh.test.tsx`, `App.run-workflow.test.tsx`) were mechanically updated to "Agent activity" — a pure text-synchronization-point rename, no behavioral assertion changed.

**Additional focused coverage** includes: `App.reveal-boundaries.test.tsx` (the six data-driven reveal-boundary scenarios, §6.3); `App.new-submission-reset.test.tsx` (new-submission ownership reset); `App.live-region-text.test.tsx` (exact live-region text and elapsed-tick isolation); and `App.outcome-aware-progress.test.tsx` (§6.4 — initial outcomes, RUNNING refresh transitions, FAILED → FAILED refresh, FAKE retry, LIVE recovery, and jump-link target integrity). `ReportPanel.test.tsx` and `SuggestedActionsPanel.test.tsx` cover their separated component responsibilities.

### 8.8 Future historical-run compatibility

Milestone 10 deleted the `RunContextPanel`/`RunOverviewPanel` wrapper, but `InvestigationSummary` (item 7 — Run Details) still renders the same run facts from `run`-scoped props and takes no router or page-level dependency. A future historical-run list's "open a run" action can re-render the flat flow for a selected run without another layout redesign. This milestone does not implement that list (out of scope), but does not foreclose it either.

---

## 9. Accessibility baseline

One `<h1>`; ordered heading levels per section, including the "Approval" `<h2>` at the same level as "Resolution report". Every control has a real, associated `<label>` — no placeholder-as-label, including the reviewer-name and note fields. Native `<button>`/`<textarea>`/`<input>` only, so keyboard operation works without a key handler. `role="alert"` for the error banner; a persistent `aria-live="polite"` region for workflow progress and notices, including the replay/decision-recorded notices and, since PR 5C, the pending-decision announcement (§8.5). `aria-busy` on both the investigation form and the decision form while their respective workflow is active. A visible `:focus-visible` outline. Status is never color-only — `StatusBadge` always renders a text label plus a glyph (`✓` approved/done, `✕` rejected/failed, `●` pending/active/in progress, `—` not eligible/pending), reused unchanged from run status and, since Milestone 9 Phase A, by the Investigation Progress stage rows (§6.1). WCAG-AA-readable contrast. No horizontal page scroll at 360px width. The timeline is `<ol>`; evidence and suggested actions are `<ul>`; identifiers, report fields, and the terminal approval record are `<dl>`. Terminal approval states are visually and structurally read-only — no button is rendered at all, so there is nothing for a screen reader to announce as an editable control.

**Still exactly one `aria-live` region.** `InvestigationProgressTimeline` deliberately does NOT add a second one. Stage transitions ride the same shared `role="status"` notice region that already exists — this preserves the pre-existing, tested invariant (`App.live-idempotency.test.tsx`, `App.progress-timeline.test.tsx`, and `App.live-region-text.test.tsx` each assert `document.querySelectorAll("[aria-live]")` has length 1, the last with the Progress Timeline actually mounted and mid-stage).

**What the live region actually announces.** It announces the CURRENT active stage and the terminal outcome — it does NOT announce every visual Completed-checkmark transition individually as its own event. Concretely, while `phase` is one of `checking-availability`/`creating-job`/`running-agent`/`loading-approval`, the region's text is exactly that stage's active label, sourced from `STAGE_LABELS` (`investigation-progress/investigation-progress-stages.ts` — the SAME source the visual Progress Timeline rows read, so the two can no longer drift the way they once did: the live region used to say "Running agent…" while the visual row said "Agent investigation in progress…"):

```text
Checking Live availability…
Creating investigation…
Agent investigation in progress…
Loading approval state…
```

On terminal SUCCESS, the region announces `"Investigation complete."` (reusing the `run` stage's own completed label), or `"Investigation complete. Human approval required."` when the result is an applicable PENDING approval. On terminal FAILURE of one of the three workflow-stopping stages, the region announces a concise, stage-specific message derived from the same `failedStage` metadata that drives the visual Failed badge — never the raw server/provider error text (that stays in the separate `role="alert"` `ErrorBanner`):

```text
Investigation failed while creating the investigation.
Investigation failed while running the agent investigation.
```

(The LIVE-availability-refusal case keeps its existing, already-specific notice — "Live is temporarily unavailable. No investigation job was created." — rather than a second, more generic phrase. Milestone 10 presents it as a **non-failure**: the phase returns to idle, no `failedStage` is set, and the composer stays visible — §9.1.) An approval-load failure does not stop the workflow (the report/trace stay visible, §6.3) and is announced only via the existing `ErrorBanner`, not a stage-specific live-region phrase. All of the above is asserted verbatim, per stage, in `App.live-region-text.test.tsx`.

**The elapsed-time counter is deliberately NOT live-announced.** It renders as plain visible text (`.investigation-progress-elapsed`) outside the `aria-live` region, updating roughly once a second. A live region re-announcing a changing number every second would be unusable with a screen reader; only the discrete stage-label text changes (already covered by the existing notice region) are announced, not the ticking clock. No CSS transition or animation runs on the numeric value itself.

**`prefers-reduced-motion`.** The one new visual transition Phase A introduces — a stage row's border-color change between Pending/Active/Completed/Failed — is disabled entirely under `prefers-reduced-motion: reduce` (`styles.css`), joining the pre-existing `scroll-behavior` guard. No stage's Pending→Active→Completed→Failed progression is itself gated on motion preference — only the visual transition between those states is.

**No stolen focus.** Mounting the Progress Timeline immediately on submit does not move focus away from the control the user just activated, consistent with the pre-existing "no focus is ever forced automatically" rule.

**Since PR 5C:** the timeline, report, and approval headings all carry `tabIndex={-1}`, making them valid native fragment-navigation targets. `html { scroll-behavior: smooth; }` is disabled under `@media (prefers-reduced-motion: reduce)`. No focus is ever forced automatically on page load or run completion — the only focus behavior is native fragment-navigation focus triggered by an explicit click on the `Action required` banner. Milestone 10 keeps the ProductHeader (`<header>`) and AppFooter (`<footer>`) as the two page landmarks, with each named card section exposing an accessible name via its labelled heading — a screen-reader user gets an independent path to the decision beyond the visual banner.

### 9.1 Non-failure presentation of a Live admission refusal

When a new LIVE submission is refused before any job exists — the capabilities
preflight declines (§13.1.1), the server rejects with 401/429/503 (§13.2), or a
public-trial visitor has no runs left (§13.1) — the refusal is a **non-failure**,
never one of the workflow-stopping `failedStage`s:

| Behavior | Rule |
| --- | --- |
| `failedStage` | **never set** — the refusal did not start a workflow, so there is nothing to fail (§9) |
| Phase | returns to `idle` |
| Composer | stays visible — the visitor can correct the Live selection or token and try again |
| Notice | the fixed string "Live is temporarily unavailable. No investigation job was created." |
| Prior investigation | untouched — an existing job's Current investigation / Progress / report stay on screen |
| LIVE selection | preserved — the Live card stays selected, so the visitor knows what was refused |

Nothing about the refusal implies the workflow failed, because nothing started.
This mirrors §6.3's reveal-on-data rule: surfaces appear only on real state, and
a refusal creates no state.

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
0. Load http://localhost:5173
   -> ProductHeader shows "OpsPilot / AI Operations Investigator" and
      "View source ↗" (https://github.com/wye-ts/opspilot); AppFooter shows
      "Built by Wenjie Ye · LinkedIn ↗"
1. Type an Issue Summary and click Start Investigation (Demo card selected)
   -> the composer collapses; Current investigation renders; the Progress
      Timeline advances; the Approval region renders NOT_ELIGIBLE with no
      controls; Run details (item 7) shows Ticket/Job/Run IDs
   -> no "Action required" banner appears
2. Reload with ?approval-demo=1 and run a Demo investigation
   -> the report shows exactly one DRAFT_CUSTOMER_REPLY suggested action
   -> the "Action required" banner appears as item 2, above Progress + Resolution
   -> the notice region reads "Investigation complete. Human approval required."
   -> the Approval region (item 5) renders PENDING with the decision form
   -> clicking the banner should scroll to and focus the Approval heading — the
      target heading is programmatically focusable (`tabIndex={-1}`) and this is
      the native fragment-link baseline; confirm the actual scroll/focus result
      in your browser, since it was not verified in this implementation session
3. Enter a reviewer name (and, optionally, a note), click Approve
   -> "Decision recorded."; the Approval region becomes the read-only APPROVED
      record; the banner disappears; no edit or revoke control exists
4. Run a fresh ?approval-demo=1 investigation and click Reject instead
   -> the symmetric terminal REJECTED state
5. Click Refresh on a PENDING run
   -> the notice region reads "Run refreshed. Human approval required." —
      never the fresh-completion wording, since the run itself was not new
6. Resize the browser between ~1440px and ~390px
   -> the Progress + Resolution row stacks below 1024px; the CTA goes full-width
      on mobile; the whole flat flow stays a single column with no horizontal
      page scroll
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

**A historical-run list** (browse past investigations, reopen an old run's report and decision) is not implemented in this milestone. §8.8 documents why the flat-flow surfaces are `run`-scoped so this future list can re-render the same flow per selected row without another layout redesign. Live-deployment evidence, screenshots, and cold-start observations for this milestone are tracked separately, not in this document.


---

## 13. PR 6B2 — provider selector, access token, and run cost

Milestone 10 re-presented the provider selector as **whole-card radios**
(`ProviderCard`) with the product identity "Demo / Live" — never "Live Claude" —
and moved the approval-demo checkbox out of the form entirely (§3).

### 13.1 Mode selector

A two-card radio group in `InvestigationForm`, defaulting to **FAKE**, built
from the pure `presentProviders(capabilities)` mapping
(`provider/provider-presentation.ts`). Each card wraps its radio input, so the
whole card is the hit target and keyboard/radio semantics come from the native
input.

| | Demo | Live |
| --- | --- | --- |
| Label | "Demo" | "Live" |
| Supporting copy | "Deterministic · Fast · No model cost" | "Real model execution" |
| Availability pill | Always "Available" (success) | "Available" / "Daily trial available" / "Daily trial used" / "Temporarily unavailable", per capabilities |
| Current-model metadata | none | `claude-sonnet-5 · Current model`, only while LIVE is genuinely available — a claim that this is the configured model, never that a model executed |
| Approval demo | chosen via `?approval-demo=1` at mount (§3) | **never** — `approvalDemo` is cleared on switching to LIVE and again at submit; a live run never uses `TICKET-APPROVAL-DEMO` |
| Access-token field | hidden | shown when the server says a token is required |
| Request body | `{"providerMode":"FAKE"}` | `{"providerMode":"LIVE"}` |

When `GET /v1/capabilities` reports `UNAVAILABLE` (or a public-trial visitor has
used their daily run), the LIVE card renders **disabled with a visible reason** —
"Temporarily unavailable — the deterministic demo is always available." (or the
trial-exhausted reason) — rather than hidden. A hidden control makes the feature
look absent rather than protected. Capabilities that have not loaded yet are
treated as unavailable, so the option is never briefly offered before the server
has said it is available.

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
| Notice | "Live is temporarily unavailable. No investigation job was created." |
| Presentation | **Non-failure (§9.1)** — the phase returns to idle, no `failedStage` is set, the composer stays visible, and the visitor's Live selection is preserved; nothing about the previous investigation (if any) is cleared |

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

> New Live runs are currently unavailable. Recovery of an existing request
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

Progressive validation guides toward the 15-character minimum without a hard
counter (Milestone 10 removed the `8 / 15` readout). The CTA stays disabled
until the **trimmed** length reaches 15; the backend remains authoritative:

| State | Helper text |
| --- | --- |
| Empty | subtle — "Describe the issue in at least 15 characters." |
| 1–14 trimmed characters | amber — "Add more detail — the issue summary needs at least 15 characters." |
| ≥ 15 trimmed characters | helper cleared; CTA enabled |

The **trimmed** length is what is measured, and submit is disabled outside
15–2000 trimmed characters.

### 13.4 Run display

Milestone 10 deleted `RunContextPanel`/`RunOverviewPanel`. `InvestigationSummary`
(item 7 — Run Details) absorbs their facts and gains three rows, all from data
the API already returns:

| Row | Source | When absent |
| --- | --- | --- |
| Provider mode | `run.providerMode` — the **persisted** value | never |
| Model | `run.modelIdentifier` | `—` for FAKE |
| Estimated cost | `run.estimatedCostUsd` (a string) | **row hidden entirely** — FAKE, unknown pricing, or a cost the API judged incomplete (§12.4 of docs/12) |

The badge renders the persisted mode verbatim; the *requested* mode is never
displayed, so a run requested as LIVE but persisted as FAKE reads FAKE. A null
cost renders nothing at all — never `$0.00`, which would assert a measured free
run.

---

## 15. Flat 1→7 run-detail flow (canonical order)

The flat 1→7 run-detail flow is the single canonical render order for every
surface beneath the composer once a job exists (`job !== null`). Milestone 10
introduced it to replace the two-column Run Context / Run Overview layout
(`RunContextPanel` / `RunOverviewPanel` deleted). `App.tsx` renders exactly
these items, top to bottom:

```text
1. Current investigation   CurrentInvestigation — eyebrow + job summary + provider
2. Action required banner  ActionRequiredBanner — ONLY while approval?.status === "PENDING" (§8.4)
3. Progress + Resolution   the shared row: Progress Timeline (narrow) | Resolution (wide)
4. Suggested actions       suggested-action cards from the report (§7)
5. Human Approval          ApprovalPanel — all four statuses (§8.5)
6. Agent Activity          TraceTimeline product language + Technical details disclosure (§6.2)
7. Run Details             InvestigationSummary — Provider/Model/Duration/Attempt + Technical details disclosure, Refresh, Retry Run (§8.3)
```

Two rendering invariants:

- **Every item is full-width, one column** at all breakpoints, except the
  item-3 Progress/Resolution row, which stacks below 1024px (§8.2). There are
  no side-by-side panels and no horizontal page scroll.
- **Items 1–7 appear only on real state** (`job !== null`), never on `isBusy`
  or `submittedSummary` (§6.3). A busy spinner is never mistaken for a
  committed investigation and vice versa.
