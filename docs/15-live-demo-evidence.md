# OpsPilot — Live Demo Evidence

| Field | Value |
|---|---|
| Public URL | https://opspilot-bkdf.onrender.com |
| Verification date | 2026-08-01 |
| Verified commit SHA | `7df3d924905e18070e4d7c13c278d3709047f27f` (`7df3d92`) |
| Verifier | Claude Code, on behalf of the repository owner |
| Environment | Render free web service + Neon PostgreSQL, per deployment configuration |
| Document status | Evidence for issue [#25](https://github.com/wye-ts/opspilot/issues/25) |

## 1. Read this first

```text
The deployed browser workflow uses the deterministic FAKE provider.

The repository includes a file-backed RAG spike and evaluation path, but
retrieval is not wired into the deployed browser workflow.

Approval decisions are recorded, but approved actions are not executed.
```

The public deployment was verified end to end: the root page loads cleanly, both health
endpoints respond correctly, a normal investigation completes and reports `NOT_ELIGIBLE`
with zero suggested actions, and an approval-workflow-demo investigation produces exactly
one suggested action that a reviewer can approve. The approval decision is not restorable
through the browser after a refresh (the SPA has no router or client-side storage), but it
is independently verified as persisted server-side by reading it back through the public
API from a clean, cookie-free session. Both desktop (~1440px) and mobile (~390px) layouts
were verified against real screenshots — see §7 for the mobile/responsive results and three
honest, non-blocking observations, and note that keyboard-focus behavior (R4/R5) was **not**
tested and is not claimed as passing.

## 2. What this is

OpsPilot is a deployed, deterministic, human-in-the-loop investigation workflow: an operator
submits an issue summary, a bounded agent runtime runs a diagnostic tool and generates a
structured resolution report, and — when the report includes suggested actions — a human
reviewer approves or rejects them before anything downstream would happen. The public
deployment runs this workflow with the deterministic `FAKE` provider only.

## 3. Architecture summary

Single-origin Docker deployment on Render (free tier): a NestJS API serves both the `/v1/**`
API and the built React SPA from one origin, backed by a Neon-hosted PostgreSQL database per
deployment configuration. See [Deployment architecture](08-cicd-deployment.md) §12 for the
full request-path diagram; this document does not duplicate it.

## 4. Health-check results

```text
$ curl -isS https://opspilot-bkdf.onrender.com/v1/health/live
HTTP/2 200
content-type: application/json; charset=utf-8
{"data":{"status":"ok"}}

$ curl -isS https://opspilot-bkdf.onrender.com/v1/health/ready
HTTP/2 200
content-type: application/json; charset=utf-8
{"data":{"status":"ready"}}
```

No `set-cookie` or credential-adjacent header is present in either response; both are
unauthenticated public reads, so the commands above are reproducible verbatim.

Readiness proves that the deployed container can reach its configured PostgreSQL database at
the moment of the request. Render configuration (`render.yaml`) identifies that database as
Neon; the application itself has no way to assert the vendor. Application-data durability is
demonstrated separately in §8.

## 5. Verified walkthrough

| Check | Expected | Observed | Evidence |
|---|---|---|---|
| Root page loads | OpsPilot React app renders, no console errors | Confirmed — `<h1>OpsPilot — Agent Investigation Console</h1>`, Issue Summary form, Approval workflow demo checkbox, Run Investigation button; console tracked from a fresh load produced zero messages | §6, screenshot 1 |
| `GET /v1/health/live` | `200`, `{"data":{"status":"ok"}}` | Confirmed | §4 |
| `GET /v1/health/ready` | `200`, `{"data":{"status":"ready"}}` | Confirmed | §4 |
| Public/default flow uses FAKE provider | `PROVIDER MODE: FAKE` on every run; Live Claude option shown but disabled | Confirmed — provider selector shows "Live Claude is temporarily unavailable — the deterministic demo is always available"; every run recorded `providerMode: "FAKE"` | §6 |
| No private LIVE token required for FAKE demo | No token field or auth prompt anywhere in the flow | Confirmed — no token input exists in the public UI; no `Authorization` header used by any request observed | §6 |
| Normal investigation completes | Trace timeline renders, report generated | Confirmed — 3 trace events (`TOOL_REQUESTED`, `TOOL_COMPLETED`, `REPORT_GENERATED`), report category `UNKNOWN`, confidence 0.50 | §6, screenshot 2 |
| Report + Run Context Panel | Report visible; `NOT_ELIGIBLE`/"Not eligible" state when zero suggested actions | Confirmed — "Not eligible", "This run has no suggested actions to approve", zero Approve/Reject controls in the DOM | §6, screenshot 2 |
| Suggested actions + pending approval | Approval-demo run produces 1 suggested action, pending decision visible without scrolling | Confirmed — `TICKET-APPROVAL-DEMO` run produced exactly one `DRAFT_CUSTOMER_REPLY` suggested action; "Investigation completed. Human approval required." banner and the pending Approval panel (Reviewer name, Note, Approve, Reject) were both visible in the same viewport as the completion state, no scrolling required | §6, screenshot 3 |
| Approve/Reject recorded | Decision recorded, terminal read-only state, no edit/revoke control | Confirmed — after Approve, panel became a read-only `APPROVED` record (reviewer `Demo Reviewer`, note, `decidedAt`); no edit/revoke/resubmit control anywhere | §6, screenshot 4 |
| Decision persists after refresh | See §8 — the honest result is API-verified persistence, not a browser-restorable run | Confirmed via API, not via browser (browser has no router/client storage) | §8 |
| Desktop layout usable | Two-column layout, report dominant | Confirmed at ~1418–1440px effective width | §6, screenshots 1–4 |
| Mobile layout usable | Single-column layout below the `64rem`/1024px breakpoint | Confirmed at ~390px effective width | §6–§7, screenshots 5–8 |

## 6. Screenshot gallery

All screenshots are sanitized: content-only, no browser chrome, no other tabs, no profile
information. Visible identifiers (Ticket ID, Job ID, Run ID) are demo-generated UUIDs that
authorize nothing.

**Desktop (~1418–1440px), captured via browser automation in this session:**

1. **`01-investigation-form-desktop.png`** — the Issue Summary form filled with a neutral
   synthetic issue before submission, FAKE provider selected by default.
2. **`02-completed-investigation-desktop.png`** — an ordinary completed investigation: trace
   timeline, generated report, and a Run Context Panel reporting "Not eligible" with zero
   suggested actions and no approval controls.
3. **`03-pending-approval-desktop.png`** — the approval-workflow-demo run: "Investigation
   completed. Human approval required." banner, one `DRAFT_CUSTOMER_REPLY` suggested action,
   and the pending Approval panel (Reviewer name, Note, Approve, Reject).
4. **`04-approved-decision-desktop.png`** — the same run after approval: a read-only
   `APPROVED` record (reviewer `Demo Reviewer`, note, decision timestamp), banner gone, no
   edit/revoke/resubmit control.

**Mobile (~390×844 viewport), captured externally by the repository owner and supplied for
this document** (this session's own browser-automation environment could not reliably
reproduce a narrow viewport — repeated resize requests were not honored; see the prior
revision of this document for that now-superseded limitation). All four are from the same
approval-workflow-demo run: ticket `TICKET-APPROVAL-DEMO`, job `1535a6d2-bc36-47c5-86f5-c7f525b7b047`,
run `b8180897-caf6-4b7b-b2b2-ae4da4881d64`, started/finished 2026-08-01 12:15:11–12:15:12 PM
local time (visible in the source captures, cropped from the four kept below for brevity).

5. **`05-pending-approval-mobile-top.png`** — top of the page after the approval-demo run
   completes: header, "Investigation completed. Human approval required." notice, the
   Provider selector, and the start of the Issue Summary field, all in a single column.
6. **`06-investigation-timeline-mobile.png`** — the "Investigation completed. Human action
   required — review the proposed action." banner and the 3-step Investigation timeline,
   single column.
7. **`07-suggested-action-scroll-mobile.png`** — the "Draft customer reply" suggested-action
   card; the reply body is long enough that it scrolls **inside its own fixed-height box**
   rather than expanding the card (visible internal scrollbar) — see §7's non-blocking
   observations.
8. **`08-pending-approval-mobile.png`** — the Approval panel at mobile width: "Pending"
   status, Reviewer name and Note fields, exactly one Approve and one Reject button, no
   pinned/duplicate control.

Two additional mobile captures from the same session (the Investigation summary metadata
card, and a mid-scroll view of the report body) were reviewed and found clean, but omitted
from the gallery as redundant with the four kept above and with the desktop report evidence
in screenshots 2–3.

## 7. Mobile / responsive verification (R1–R8)

This section maps the mobile screenshots in §6 to the responsive/accessibility check IDs used
in the original PR 5D plan (`docs/reviews/17-live-demo-evidence-plan.md` §3.3), so results are
directly comparable to that matrix's naming. Checks that were not actually performed are
marked **NOT TESTED** rather than being silently assumed to pass.

| ID | Check | Result | Evidence |
|---|---|---|---|
| R1 | Desktop ≈1440×900: two-column grid, report dominant | Confirmed | §6, screenshots 1–4 |
| R2 | `64rem`/1024px breakpoint switch point | **NOT TESTED live** — no resize sweep across the breakpoint was performed in either session; confirmed only via source inspection of `apps/web/src/styles.css` (`@media (min-width: 64rem)`) | — |
| R3 | Mobile ≈375–390px: single column, banner near top, no raw Approve/Reject pinned above the full decision card | Confirmed — single column throughout; the completion banner appears near the top (screenshot 6); the Approval panel with its Approve/Reject buttons is reached by scrolling to it, not pinned above it (screenshot 8) | §6, screenshots 5–8 |
| R4 | Keyboard activation of the completion/approval banner (Tab to focus, Enter to activate) | **NOT TESTED.** This pass used static screenshots only, on both mobile and desktop; no interactive keyboard testing was performed. Not claimed as passing. | — |
| R5 | Focus lands on the Approval heading after activation | **NOT TESTED**, for the same reason as R4. | — |
| R6 | Reduced motion (`prefers-reduced-motion: reduce`) | **NOT TESTED.** No reduced-motion emulation was performed in this pass. | — |
| R7 | No horizontal overflow at mobile width | Observed, not measured — all four mobile screenshots show text wrapping within card bounds, no visible horizontal scrollbar, no clipped content. This is a visual read of static screenshots, not a `scrollWidth`/`innerWidth` measurement. | §6, screenshots 5–8 |
| R8 | Exactly one Approve and one Reject control at every viewport | Confirmed at mobile width (screenshot 8, one of each) and at desktop width (screenshot 3, one of each) | §6, screenshots 3, 8 |

### Non-blocking observations

These do not block accepting the mobile evidence but are recorded honestly rather than
smoothed over:

- **Provider-option copy is visually dense on mobile.** In the Provider fieldset, the option
  label and its helper text run together with no visual separator — e.g. "Demo —
  FAKEDeterministic, fast, no model cost." immediately followed by "Live ClaudeLive Claude is
  temporarily unavailable — the deterministic demo is always available." reads as one dense
  run-on at 390px width (screenshot 5). Legible, but a candidate for the deferred visual
  refresh (issue [#41](https://github.com/wye-ts/opspilot/issues/41)), not a defect requiring
  its own issue.
- **The long suggested-action preview uses internal scrolling.** The "Draft customer reply"
  body renders inside a fixed-height box with its own scrollbar rather than expanding to fit
  the full text (screenshot 7). Functional, but worth noting since it differs from how the
  rest of the report flows (full-height, page-scrolled).
- **Keyboard focus visibility (R4/R5) was not tested and must not be reported as passing.**
  Both this pass and the prior desktop-only pass relied on static screenshots; no Tab/Enter
  interaction or `document.activeElement` inspection was performed on any viewport. This is
  called out explicitly here, and again in §9, so it isn't mistaken for a verified pass.

## 8. Persistence verification

**Refresh (browser):** refreshing the browser on the approved run returns to the empty
investigation form. The previous run is not restored — `apps/web` has no router and no
client-side storage, so there is no URL that addresses a run and nothing persisted in the
browser. This is a known product limitation, not a persistence failure; the data itself is
verified below.

**Public API (clean session):** both endpoints are public and unauthenticated, so no header,
cookie, or credential is involved:

```text
$ curl -sS "https://opspilot-bkdf.onrender.com/v1/agent-runs/3799e25b-5907-46f3-b79c-b380459f511c"
{"data":{"job":{...,"ticketId":"TICKET-APPROVAL-DEMO",...},
         "run":{"id":"3799e25b-5907-46f3-b79c-b380459f511c","status":"COMPLETED","providerMode":"FAKE",...},
         "trace":[...], "outcome":{"type":"COMPLETED","report":{...}}}}

$ curl -sS "https://opspilot-bkdf.onrender.com/v1/agent-runs/3799e25b-5907-46f3-b79c-b380459f511c/approval"
{"data":{"runId":"3799e25b-5907-46f3-b79c-b380459f511c","status":"APPROVED",
         "reviewerName":"Demo Reviewer","note":"Reviewed for the public demo.",
         "decidedAt":"2026-08-01T18:53:55.052Z"}}
```

| Field | Browser (§6) | API (this section) |
|---|---|---|
| Run ID | `3799e25b-5907-46f3-b79c-b380459f511c` | `3799e25b-5907-46f3-b79c-b380459f511c` |
| Decision | `APPROVED` | `APPROVED` |
| Reviewer | `Demo Reviewer` | `Demo Reviewer` |
| Note | `Reviewed for the public demo.` | `Reviewed for the public demo.` |
| `decidedAt` | Aug 1, 2026, 11:53:55 AM | `2026-08-01T18:53:55.052Z` |

The decision was made in one browser session and read back by a separate shell session with
no shared storage, cookies, or credentials — the response cannot be coming from browser-local
state. Combined with §4's reachability result, this demonstrates application-data persistence
end to end without depending on a browser capability (historical-run browsing) the product
does not have.

## 9. Cold-start and warm observations

> These are observations of a **free-tier** deployment taken on one date from one network.
> They are **not a benchmark and not an SLA**. A free instance spins down when idle; the
> numbers below describe that behavior honestly rather than hiding it.

The planning agent sent no request to the public URL before the observation below.
Actual idle state was not independently confirmed in a Render dashboard before this
measurement (dashboard access was not available at that point in the session), so it is
labelled *assumed idle* rather than *known idle*.

**First request this session** (assumed idle, 2026-08-01 18:46:26 UTC):

```text
GET /v1/health/live
dns=0.036s  tcp=0.078s  tls=0.103s  ttfb=41.294s  total=41.295s  http_code=200
```

A ~41s time-to-first-byte on the very first request of the session is consistent with a
genuine Render free-tier cold start.

**Warm observations**, taken immediately after, ~2s apart (2026-08-01 18:47:16 UTC), `n=3`:

```text
GET /v1/health/live
ttfb=0.170s total=0.170s
ttfb=0.228s total=0.229s
ttfb=0.138s total=0.138s
```

min/median/max ttfb: 0.138s / 0.170s / 0.228s.

Render's current documentation states that a Free web service spins down after 15 minutes
without inbound traffic and takes about one minute to spin back up. The ~41s observation
above is a separate, this-deployment-specific measurement, consistent with that stated
behavior but not identical to it — both figures are kept distinct per the reporting
convention above, and neither is presented as a benchmark.

## 10. Known limitations

- The deployed browser workflow uses the deterministic `FAKE` provider only. A real-Claude
  provider spike and controlled LIVE validation exist and are documented separately — see §13.
- Retrieval-augmented generation exists at the repository level (`apps/worker`, evaluated
  offline) but is **not wired into** the deployed browser workflow.
- Approval decisions are recorded; approved actions are **not executed**. No execution
  endpoint exists.
- No authentication, rate limiting, or abuse protection on the public demo.
- No RBAC or multi-user support.
- No historical-run browser: a completed run is not reachable through the UI after a
  refresh; it is reachable only through the public, unauthenticated API (§8).
- Free-tier cold starts apply; see §9.
- All data in the public demo is synthetic demo data with no privacy expectation.
- **Keyboard focus visibility (R4/R5) has not been tested** on any viewport in either
  verification pass. This must not be read as a pass — see §7.
- **Breakpoint switch point (R2) has not been live-tested** — confirmed only via source
  inspection, not an observed resize sweep.
- Case-insensitive `/V1/**` routing boundary checks from the original PR 5D plan
  (`docs/reviews/17-live-demo-evidence-plan.md`) were not re-run in this pass — this
  evidence pass followed a narrower, explicitly scoped checklist (root page, health
  endpoints, provider default, one normal run, one approval-demo run, persistence, desktop
  and mobile layout). They remain an open verification item if a future pass wants full
  parity with the original plan's matrix.
- Provider-option copy density and suggested-action internal scrolling on mobile — see §7's
  non-blocking observations; neither blocks this evidence, both are candidates for the
  deferred visual refresh (issue [#41](https://github.com/wye-ts/opspilot/issues/41)).

## 11. Deployment identity

**Merging the PR that adds this document redeploys the service** (`render.yaml` sets
`autoDeployTrigger: checksPass` on `branch: main`), so the live commit will move past
`7df3d92` shortly after this document merges. The only difference between `7df3d92` and the
post-merge commit is this documentation and the sanitized image assets — no application code,
container, configuration value, or database changed.

Deployed SHA evidence (owner-provided, since no public version/commit endpoint exists in the
application by design — adding one would be a code change out of scope for an evidence-only
pass):

```text
Deployed commit SHA: 7df3d92 (7df3d924905e18070e4d7c13c278d3709047f27f)
Status: Deploy live
Deploy source: New commit via Auto-Deploy
Deploy started: August 1, 2026 at 11:50 AM
Deploy completed/live: August 1, 2026 at 11:51 AM
Visible commit message: docs: add Milestone 9 timeline roadmap (#42)
Evidence source: Render service Events/deploy list (owner-reported)
```

Cross-checked locally: `git log --oneline -1 7df3d92` and
`gh api repos/wye-ts/opspilot/commits/7df3d92` both resolve to the exact merge commit of PR
[#42](https://github.com/wye-ts/opspilot/pull/42), which was the tip of `main` at the time
this verification pass began.

## 12. Portfolio claim guidance

Accurate: "deployed full-stack, human-in-the-loop investigation workflow"; "bounded,
deterministic orchestration with a fixed step budget"; "the deployed container reaches its
configured PostgreSQL database"; "runs and approval decisions are persisted server-side and
read back through the public API from a session that never made the decision"; "backed by a
managed PostgreSQL database (Neon, per deployment configuration)"; "single-origin Docker
deployment on Render free tier"; "the deployed browser workflow uses a deterministic FAKE
provider; a real-Claude spike and controlled LIVE validation exist in the repository";
"responsive layout verified at desktop and mobile widths."

Avoid: "AI agent" implying autonomy; "production-ready" or "production-grade"; "powered by
Claude" / "live LLM inference" for the public demo; "executes approved actions"; "survives
refresh in the browser" (it does not — §8); any phrasing implying a live check identified
the database vendor (that is configuration-derived, not observed); "fully accessible" or
"keyboard accessible" (keyboard-focus behavior was not tested — §7, §10).

## 13. Related evidence

- [Initial LIVE smoke failure (`REPORT_SCHEMA_INVALID`)](evidence/06c-live-claude-smoke-failure.md)
- [Successful controlled LIVE smoke re-test](evidence/06c-live-claude-smoke-success.md)

## 14. Reproduction notes

Every command in this document is a public, unauthenticated `GET`/read against
`https://opspilot-bkdf.onrender.com`; none require a secret, token, or cookie, and none are
reproduced with any redaction beyond what's already shown above. Desktop screenshots were
captured via browser automation (Claude in Chrome) at native screenshot resolution and
converted to PNG. Mobile screenshots were captured externally by the repository owner at a
390×844 viewport and supplied for inclusion. Every screenshot — desktop and mobile — was
manually inspected (visual review plus a `strings` scan for secret-like patterns) before being
committed; none contain browser chrome, other tabs, or credentials.
