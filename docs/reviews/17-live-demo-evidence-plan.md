# OpsPilot — PR 5D Live Demo Evidence Plan

| Field | Value |
|---|---|
| Document | PR 5D — Live Deployment Evidence and Portfolio Readiness (implementation plan) |
| Status | Plan — nothing in this document has been executed |
| Revision | v1.2 — Phase 0 corrections applied at execution start (see "Revision note" below) |
| Tracking issue | [#25](https://github.com/wye-ts/opspilot/issues/25) — "Capture live deployment evidence and finalize portfolio documentation" |
| Branch | `docs/live-demo-evidence` (already created, at `origin/main` = `00522bd`) |
| Public URL | `https://opspilot-bkdf.onrender.com` (owner-provided) |
| Planned on | 2026-07-28 |
| Artifact status | **Review artifact — do not commit with PR 5D**, same as `docs/reviews/15-*` and `docs/reviews/16-*` |

> **Revision note (v1.1).** Eight corrections applied: the browser-only persistence path was replaced
> with an API-based one (the UI has no router and no client-side storage, so a refresh *cannot* restore
> a prior run — §3.2 B7/B8, and `persistence-after-refresh.png` is withdrawn); the final-review diff now
> uses a staged workflow instead of `git diff main...HEAD` (§11.3); `exiftool` now uses
> `-overwrite_original` and a `_original` sweep (§9.2); the cold-start protocol is closed as three
> distinct idle cycles rather than an execution-time choice (§5.3); P4 gains the case-insensitive
> `/V1` production checks (§3.1); readiness is no longer described as proving Neon persistence, only
> that the container reaches its configured database (§3.1 P3, §3.1 P7, §6, §8, §13); and `render.yaml`
> moves from "untouched" to a **comment-only** change (§7.5, §10.2).

> **Revision note (v1.2).** Four further corrections applied immediately before live execution, as
> Phase 0 of the execution prompt: (A) §16's "roughly 50 seconds" cold-start figure was itself stale —
> Render's current documentation states about one minute, not 50 seconds; the figure is corrected and
> kept explicitly attributed, separate from this deployment's own measurement (C6, §5.7). (B) Cycle C's
> timing claim was overclaiming — external timing cannot isolate agent execution time from wake-up,
> connection, orchestration, and serialization; the language now describes TTFB/total as an external
> end-to-end observation only, compared against warm totals solely to estimate combined cold-start
> overhead (§5.3 Cycle C). (C) B8's persistence claim ("the only place the data can be coming from is
> the server's database") was an unsupported absolute; it is now grounded in a new repository finding,
> **F23**, which traces both read paths to Prisma-backed queries with no in-memory cache (§2.1, §3.2
> B8). (D) §5.4's warm page-load table now states explicitly that all three warm observations use
> **cache disabled**, matching the Cycle B cold observation, so the two are comparable.

> **Scope of this document.** This is the plan for PR 5D, written after inspecting the repository and
> before touching the live deployment. No screenshot has been captured, no measurement has been taken,
> and **no request has been sent to the public URL** — see §5.1 for why that matters.

---

## 1. Objective and PR boundary

### 1.1 What PR 5D is

```text
live verification + evidence + documentation only
```

PR 5D verifies the already-merged `main` against the real Render + Neon deployment, captures sanitized
evidence of what it actually does, measures cold-start and warm behavior honestly, and corrects every
committed claim that live deployment has made stale. It changes **no application code**.

The single exception to "documentation only" is a **comment-only** correction in `render.yaml` (§7.5)
— no YAML value changes, no deployment behavior changes.

### 1.2 What PR 5D explicitly excludes

| Excluded | Why it stays excluded |
|---|---|
| Live Claude/OpenAI provider integration | The deployment is FAKE-provider-only by design (`docs/08` §7, §22); adding a provider is a separate milestone with its own cost, key-management, and evaluation implications. |
| Browser/API RAG wiring | `apps/api` wires no retriever and `runbooks/` is excluded from the image (`.dockerignore`); wiring it is a feature milestone, not an evidence milestone. |
| Action execution after approval | No execution endpoint exists (`docs/13` §5). Recording a decision and performing it are different systems. |
| Authentication, RBAC, multi-user | `docs/08` §22 defers these deliberately; adding them changes the security model and every API contract. |
| Historical-run browsing | `docs/14` §8.8 keeps the door open; opening it is a feature PR. Its absence is instead **documented as a limitation** (§3.2 B7). |
| Backend / API / database contract changes | Any such change breaks the "documentation-only" property that makes this PR safe to review quickly. |
| AWS deployment | Out of scope per issue #25. |
| Redesigning PR 5C UX | PR 5C shipped and merged; PR 5D verifies it, it does not revise it. |

### 1.3 The one escape hatch

If live verification reveals an application defect, PR 5D records the observed behavior honestly in
`docs/15-live-demo-evidence.md` as a limitation and opens a **separate** issue. It does not fix
application code inline. A verification PR that also changes behavior can no longer be trusted as
verification of the thing it changed.

---

## 2. Current repository and deployment findings

### 2.1 Verified repository facts

Every row below was read out of the repository at `00522bd`.

| # | Fact | Source |
|---|---|---|
| F1 | Working branch `docs/live-demo-evidence` exists and is **exactly** at `origin/main` = `00522bd` — `git rev-list --left-right --count origin/main...HEAD` → `0 0`. PR 5C is merged (PR #24, `f448e08` + merge commit `00522bd`) and `main` is synchronized. | `git` |
| F2 | The tracking issue already exists: **#25**, open, labelled `documentation`. | `gh issue list` |
| F3 | Health endpoints are **`GET /v1/health/live`** and **`GET /v1/health/ready`** — *not* `/health/live` / `/health/ready`. `HealthController` is `@Controller("health")` and `main.ts` sets `app.setGlobalPrefix("v1")`. | `apps/api/src/health/health.controller.ts:10`, `apps/api/src/main.ts:69` |
| F4 | `live` is process-only and never queries the database; `ready` runs ``SELECT 1`` through the single process-owned Prisma handle and, on failure, throws the fixed `PERSISTENCE_UNAVAILABLE` (503) catalog entry — which is already tested against leaking connection strings or raw Postgres errors. **`ready` proves the container can reach its configured database; it says nothing about which vendor hosts it and nothing about application-data durability** (see P3). | `health.controller.ts:17-35`, `docs/08` §15 |
| F5 | Success envelopes are `{"data":{"status":"ok"}}` and `{"data":{"status":"ready"}}`. | `health.controller.ts:18-31` |
| F6 | Single-origin serving is real: `requestIdMiddleware` → conditional `useStaticAssets(webDistDir)` → conditional SPA fallback → 32 KB JSON parser → parser-error normalizer → Nest `/v1/**`. Static handling runs before body parsing and before Nest. | `main.ts:48-69`, `docs/08` §12 |
| F7 | The SPA fallback has three guards: non-GET/HEAD falls through; a **case-insensitively** matched `/v1` or `/v1/…` path falls through; any path with a file extension falls through. So `/v1/nope` returns a JSON error envelope, `/missing.js` returns 404, and — because Express routing is case-insensitive by default — `/V1/health/live` must reach the API while `/V1abc` must reach the SPA. This is the exact failure mode `docs/10` Challenge 5 exists to prevent, and P4 verifies it in production. | `apps/api/src/common/spa-fallback.middleware.ts:22-50`, `docs/08` §12 |
| F8 | Asset caching: `/assets/*` → `public, max-age=31536000, immutable`; `index.html` and the fallback → `no-cache`. | `main.ts:53-61`, `spa-fallback.middleware.ts:45` |
| F9 | **There is no version or commit-SHA endpoint.** `HealthController` exposes only `live` and `ready`. The deployed commit therefore cannot be resolved from the running service — it must come from the Render dashboard, cross-checked against `git`/`gh`. Adding such an endpoint is a code change and is out of scope (§1.2). | `health.controller.ts` (whole file) |
| F10 | `render.yaml` pins `plan: free`, `branch: main`, `autoDeployTrigger: checksPass`, `healthCheckPath: /v1/health/ready`, `HOST=0.0.0.0`, `AGENT_RUN_PROVIDER_MODE=FAKE`, and `DATABASE_URL` with `sync: false` (the only secret, entered by hand). **Render configuration is what identifies the database as Neon** — the application has no way to assert that. | `render.yaml`, `docs/08` §17 |
| F11 | CI has three jobs — `verify`, `integration`, `docker-smoke`. `checksPass` means Render deploys `main` only after all three go green. | `.github/workflows/ci.yml`, `docs/08` §20 |
| F12 | **`docs` is excluded from the Docker build context.** Committing PNGs under `docs/assets/` cannot bloat the runtime image or invalidate its build cache. `/*.diff` and `/*-review-summary.txt` are excluded too, so the PR 5D review artifacts are already covered. | `.dockerignore` |
| F13 | `.gitignore` excludes `.DS_Store` (relevant — `docs/assets/live-demo/` will be created on macOS) but nothing image-related. `docs/assets/live-demo/*.png` commits cleanly. **No `.gitignore` change is needed.** | `.gitignore` |
| F14 | `docs/assets/` **does not exist**. There is no prior screenshot or image convention anywhere in the repository to follow — PR 5D establishes it. | `ls docs/` |
| F15 | The UI renders Ticket ID, Job ID, and Run ID as read-only `<dd className="mono">` metadata in `InvestigationSummary`. An ordinary run's ticket ID is generated internally as `DEMO-<uuid>`. | `apps/web/src/components/InvestigationSummary.tsx:88-97`, `README.md:127` |
| F16 | The two-column run-detail grid and `position: sticky` context panel activate at `@media (min-width: 64rem)` (1024px). `@media (prefers-reduced-motion: reduce)` disables `scroll-behavior: smooth`. | `apps/web/src/styles.css:86,278,288`; `docs/14` §8.2, §9 |
| F17 | The `Action required` banner is a native `<a href="#approval-heading">`; `ApprovalPanel`'s `<h2 id="approval-heading">` carries `tabIndex={-1}` so it is a valid fragment-focus target. No JavaScript is involved. | `docs/14` §8.4 |
| F18 | The approval demo is opt-in in the browser via the **Approval workflow demo** checkbox, which routes the exact ticket ID `TICKET-APPROVAL-DEMO`; an ordinary run always yields `NOT_ELIGIBLE` because it produces zero suggested actions. | `README.md:117,127`, `docs/14` §11 |
| F19 | Root `package.json` provides every verification script issue #25 lists, including `test:integration:sequential` and `db:migrate:drift`; `check:bundle` exists as `apps/web`'s `tsx scripts/check-bundle.ts`. | `package.json`, `apps/web/package.json:13` |
| **F20** | **`apps/web` has no router and no client-side persistence — zero matches for `react-router`, `pushState`, `window.location`, `localStorage`, or `sessionStorage` across the entire `src` tree.** A browser refresh therefore returns to the empty investigation form; the previous run is **unreachable through the UI**. Any "refresh and the decision is still there" claim would be false. This is what forces the API-based persistence proof in §3.2 B7/B8. | `grep` over `apps/web/src/**`; `docs/14` §8.8 |
| **F21** | Job creation and run execution are **separate** public calls: `POST /v1/agent-jobs` (body `{ ticketId, summary }`) returns a job with an id, and `POST /v1/agent-jobs/:jobId/runs` executes the run with no body. This is exactly what makes cold-start Cycle C possible — a job can be created while warm and its run started later as the first request after idle. | `apps/api/src/agent-jobs/agent-jobs.controller.ts:15`, `apps/api/src/agent-runs/agent-runs.controller.ts:22`, `apps/web/src/api/endpoints.ts:9-19` |
| **F22** | `GET /v1/agent-runs/:runId` and `GET /v1/agent-runs/:runId/approval` are public, unauthenticated reads. They are the persistence-verification path (§3.2 B8). | `agent-runs.controller.ts:58`, `agent-run-approvals.controller.ts:45` |
| **F23** | The run and approval `GET` paths retrieve their records through the Prisma-backed persistence layer rather than process-local memory. `AgentRunsController.getAgentRun` calls `AgentRunService.getAgentRun`, which delegates to `dbGetAgentRun(prisma, runId)`; that function runs a `prisma.$transaction` against `packages/database`'s repository. `AgentRunApprovalService.getApprovalDecision` is a direct pass-through to `getApprovalDecision(prisma, runId)` in the same package, which likewise opens a `prisma.$transaction` and issues a raw `SELECT` against `agent_runs` plus `prisma.agentRunApproval.findUnique`. Neither path holds any in-memory cache — every read is a fresh database round trip. This is what makes B8's clean-session comparison meaningful: the second read cannot be served from anything the first request left behind. | `apps/api/src/agent-runs/agent-runs.controller.ts:58-66`, `packages/agent-runtime/src/persistence/agent-run-service.ts:6,45,118`, `apps/api/src/agent-run-approvals/agent-run-approval.service.ts:20-25`, `packages/database/src/repositories/agent-run-repository.ts:251`, `packages/database/src/repositories/agent-run-approval-repository.ts:102-115` |

### 2.2 Owner-provided deployment facts (not verifiable from the repository)

These are taken on the owner's word and must be labelled as such in `docs/15` until the live
verification in §3 confirms each one:

- The public URL is `https://opspilot-bkdf.onrender.com`.
- A Render web service exists, is running the blueprint in `render.yaml`, and tracks `main`.
- A Neon PostgreSQL database exists and `DATABASE_URL` is set in the Render dashboard. **This is the
  only basis for calling the database "Neon"** (F10) — no live check can establish the vendor.
- Deployment boundaries: deterministic FAKE provider only; no real provider credentials in the
  deployed browser flow; repository-level RAG exists but retrieval is not wired into the deployed
  browser flow; approval decisions are recorded but approved actions are not executed; no
  authentication, RBAC, multi-user support, or historical-run browser.

After §3, most of these move from "owner-stated" to "verified" — that transition is itself part of the
evidence, and `docs/15` should show which is which. The Neon-vendor attribution never moves; it stays
configuration-derived.

### 2.3 Current public-demo documentation, and why it is now wrong

This is the substance of PR 5D. The repository currently asserts, in committed text, the opposite of
reality.

| # | Location | Current text | Problem |
|---|---|---|---|
| C1 | `README.md:56-59` | "**This configuration exists and is CI-verified; it has not yet been deployed.** There is no live URL in this document, and none should be inferred — a Render service and Neon database have not been created yet." | Factually false as of today. |
| C2 | `README.md:61` | "**Public-demo limitations, once deployed:** …" | Conditional tense; the limitations are now live, present-tense facts. |
| C3 | `README.md:64-68` | The retrieval-scope paragraph | Substantively correct and must be **preserved**; only the "once deployed" framing around it changes. |
| C4 | `docs/08-cicd-deployment.md:5` | `Status \| **CI implemented (PR 5A). Deployment configuration implemented (PR 5B). Not yet deployed.**` | Stale status field. |
| C5 | `docs/08-cicd-deployment.md:12-26` | The Feature Complete vs Portfolio Ready scope note: "this document contains **no live URL** and makes **no claim** that a public deployment currently exists. That evidence is PR 5C's job." | Stale, **and** off by one — the doc's "PR 5C" is what actually became PR 5D. PR 5C shipped the approval-workflow UX instead. |
| C6 | `docs/08-cicd-deployment.md:606-610` (§16) | "The free plan spins down after roughly 15 minutes of idle traffic and takes roughly **50 seconds** to cold-start" | Stated as if it were still Render's current documented behavior, without attribution, and never measured. Render currently states a Free web service spins down after 15 minutes without inbound traffic and takes **about one minute** to spin back up — not 50 seconds. PR 5D corrects the figure, attributes it explicitly to Render's current documentation, and prints this deployment's own measurement beside it, kept clearly separate (§5.7). |
| C7 | `docs/08-cicd-deployment.md:768-770` (§24) | "**No live deployment exists yet.** Everything in §12–§23 describes configuration proven by `docker-smoke` … not an observed production system." | Factually false. |
| C8 | `docs/14-web-ui.md:194` (§8.4) | "Real-browser confirmation that activating it both scrolls to and visibly focuses the heading remains a manual verification item (§11), **not yet performed as of this implementation session.**" | PR 5D can now close this honestly — in whichever direction the observation goes. |
| C9 | `docs/14-web-ui.md:245` (§8.7) | "Real `position: sticky` behavior, no-scroll initial visibility on a real viewport, real fragment scrolling/focus, and `prefers-reduced-motion` are exactly the things jsdom cannot prove; they remain open manual-verification items (§11), **not yet performed**…" | Same. |
| C10 | `docs/14-web-ui.md:306-309` (§11 step 2) | "confirm the actual scroll/focus result in your browser, since it was not verified in this implementation session" | Same. |
| C11 | `render.yaml:5-8` (comment) | "PR 5B ships this configuration… Applying this blueprint and setting `DATABASE_URL` in the Render dashboard is **PR 5C's job**." | Stale comment, same off-by-one as C5. **Corrected in PR 5D as a comment-only change** — see §7.5. |

### 2.4 A real deployment property worth stating honestly

`render.yaml` sets `autoDeployTrigger: checksPass` on `branch: main` (F10, F11). Therefore:

**Merging PR 5D itself triggers a new Render deployment**, and the deployed commit SHA moves past the
one PR 5D documents as verified.

This is not a defect and must not be papered over. `docs/15` will state it directly:

> Verified against commit `<sha>` on `<date>`. Merging this documentation PR redeploys the service
> from a later commit whose only difference from `<sha>` is documentation, image assets, and one
> `render.yaml` comment — no application code, container, configuration value, or database change.

A useful corollary: because the merge redeploys regardless of its contents, including the `render.yaml`
comment fix (§7.5) costs **no additional deploy cycle**. That is why it belongs here rather than in a
separate PR.

This is the standing candidate for a new engineering-challenges entry (§7.4), pending whether the live
verification turns it into a decision that actually had to be made.

### 2.5 Exact files likely to change

See §10 for the authoritative list. In one line: `docs/15-live-demo-evidence.md` and
`docs/assets/live-demo/*.png` are created; `README.md`, `docs/08-cicd-deployment.md`,
`docs/14-web-ui.md`, and `render.yaml` (comment only) are edited; `docs/10-engineering-challenges.md`
is edited only if justified; nothing else is touched.

---

## 3. Live verification matrix

Every check below specifies **precondition / steps / expected result / evidence / failure handling**.

Universal failure handling, applied to every check unless overridden: record the actual observed
behavior in `docs/15` (§6, "Verified walkthrough") with an `observed` note rather than a pass mark; if
it is an application defect, open a separate issue and reference it; **never** silently drop a failing
check from the matrix, and never soften the corresponding portfolio claim's evidence column to cover
for it.

Secrets note for every `curl` in this section: no `Authorization` header, no cookie, and no
`DATABASE_URL` is involved anywhere — these are unauthenticated public requests, so the commands can be
pasted into `docs/15` verbatim.

### 3.1 Platform checks

#### P1 — Root React page

- **Precondition:** the §5 cold measurements are already complete — this check must not be the request
  that wakes the service.
- **Steps:** open `https://opspilot-bkdf.onrender.com/` in a clean Chrome profile.
- **Expected:** the OpsPilot React app renders — one `<h1>`, the Issue Summary form, the
  **Approval workflow demo** checkbox, and the **Run Investigation** button. No console errors, no
  MIME-type errors, no blank shell.
- **Evidence:** noted in `docs/15` §5; the page itself becomes the basis for the screenshots in §4.
- **Failure handling:** a blank page with a MIME error would mean the static mount or the extension
  guard (F7) misbehaved in production — record it and stop; that is a real defect and PR 5D would
  become a bug report instead.

#### P2 — `GET /v1/health/live`

- **Precondition:** service warm.
- **Steps:**
  ```bash
  curl -isS https://opspilot-bkdf.onrender.com/v1/health/live
  ```
- **Expected:** `200`, `content-type: application/json`, body exactly `{"data":{"status":"ok"}}` (F5).
- **Evidence:** command + status line + body pasted into `docs/15` §4. Response headers are safe to
  include *after* confirming no `set-cookie` is present (§9).
- **Failure handling:** a non-200 here means the process is not serving; record and stop.

#### P3 — `GET /v1/health/ready`

- **Precondition:** as P2.
- **Steps:**
  ```bash
  curl -isS https://opspilot-bkdf.onrender.com/v1/health/ready
  ```
- **Expected:** `200` with `{"data":{"status":"ready"}}`.
- **What this does and does not prove — use this wording:**

  > Readiness proves that the deployed container can reach its configured PostgreSQL database. Render
  > configuration identifies that database as Neon, while the run and approval API checks prove
  > application-data persistence.

  Concretely: `ready` executes ``SELECT 1`` through the live Prisma handle (F4), so a `200` establishes
  **connectivity at the moment of the request** and nothing more. It does not identify the vendor —
  that comes from `render.yaml` and the dashboard `DATABASE_URL` (F10, §2.2) — and it does not
  demonstrate that any row survives anything. Durability is proven by B7/B8.
- **Evidence:** as P2, with the qualifying sentence above beside it in `docs/15` §4.
- **Failure handling:** a `503 PERSISTENCE_UNAVAILABLE` most likely means the database auto-suspended;
  wait ~10 s and retry up to three times, recording each attempt. If it persists, record it as an
  observed limitation with timestamps — that is honest evidence about a free-tier database, not a
  reason to hide the check. Confirm the error body contains no connection string (it cannot, by F4,
  but verify).

#### P4 — Same-origin `/v1/**` boundary, including the case-insensitive prefix

- **Precondition:** as P2.
- **Steps:**
  ```bash
  # Lowercase baseline — the three SPA-fallback guards
  curl -isS https://opspilot-bkdf.onrender.com/v1/nope        # JSON error envelope, not the app shell
  curl -isS https://opspilot-bkdf.onrender.com/missing.js     # 404, not the app shell
  curl -isS https://opspilot-bkdf.onrender.com/some/route     # index.html (SPA fallback)

  # Case-insensitive prefix — the load-bearing checks
  curl -isS https://opspilot-bkdf.onrender.com/V1/health/live # API JSON 200
  curl -isS https://opspilot-bkdf.onrender.com/V1/nope        # API JSON error
  curl -isS https://opspilot-bkdf.onrender.com/V1abc          # React SPA shell
  ```
  Plus, in Chrome DevTools during a live investigation, confirm every XHR target is a **relative**
  `/v1/...` path on the same origin — no absolute API host, no second origin, no CORS preflight.
- **Expected:**
  ```text
  /v1/nope        → API JSON error envelope
  /missing.js     → 404
  /some/route     → index.html
  /V1/health/live → API JSON 200
  /V1/nope        → API JSON error
  /V1abc          → React SPA shell
  ```
  and zero `OPTIONS` preflights anywhere in the network log, confirming the no-CORS single-origin
  design end to end.
- **Why the uppercase checks are load-bearing:** Express's router is case-insensitive by default and
  case-sensitive routing is enabled nowhere in this app, so a real request to `/V1/health/live` reaches
  the same Nest route `/v1/health/live` does. If the SPA fallback compared the raw path instead of a
  lowercased copy, it would intercept that request first and silently return `index.html` in place of
  the API response — an API outage that looks like a working page. The middleware lowercases for the
  comparison only (F7), and `/V1abc` confirms the other half of that logic: a prefix *lookalike* must
  still fall through to the SPA. `docs/10` Challenge 5 documents this reasoning; `docker-smoke` covers
  it in CI. **P4 is the first time it is exercised against the real deployment**, where a proxy, a
  CDN-ish edge layer, or a platform-level redirect could normalize or rewrite the path before the
  application ever sees it.
- **Evidence:** the six status lines quoted in `docs/15` §4; a one-sentence statement that the DevTools
  network log showed only same-origin relative requests and zero preflights.
- **Failure handling:** if `/v1/nope` or `/V1/nope` returns `index.html`, the SPA fallback is shadowing
  the API in production — a serious defect. Record and stop. If `/V1abc` returns an API error instead
  of the shell, the fallback is over-excluding — less severe, but record it precisely.

#### P5 — Deployed commit SHA

- **Precondition:** owner logged into Render.
- **Steps:** owner opens the service's **Events**/deploy list, identifies the live deploy, and records
  the commit SHA, commit message, status, and timestamp. Then, locally:
  ```bash
  git log --oneline -1 <sha>
  gh api repos/wye-ts/opspilot/commits/<sha> --jq '.sha, .commit.message' | head -3
  ```
- **Expected:** the Render SHA resolves to a commit on `main` at or after `00522bd`, and its CI run is
  green.
- **Evidence:** the cropped `render-deployment-status.png` (§4) **and** the written SHA plus the two
  commands above (owner's choice: both). Two independent forms, so the claim survives if either is
  later dropped.
- **Failure handling:** if Render's live commit is *behind* `00522bd`, a deploy did not fire —
  investigate before capturing anything else, because every screenshot would then be evidence of the
  wrong build.
- **Note:** this cannot be automated from the service (F9). Do not add a version endpoint to make it
  automatable — that is a code change (§1.2).

#### P6 — Render deployment status

- **Precondition:** as P5.
- **Steps:** owner confirms the service shows `Live`/`Deployed`, notes the plan (`free`), and — for each
  of the three cold cycles in §5.3 — confirms whether the instance is spun down **immediately before**
  that measurement.
- **Expected:** status `Live`, plan `free`, autodeploy from `main`.
- **Evidence:** the same cropped screenshot as P5, plus the per-cycle idle confirmations recorded in
  `docs/15` §8.
- **Failure handling:** record any `Deploy failed` history honestly if it is relevant to the cold-start
  narrative; otherwise crop to the live deploy only.

#### P7 — Database reachability and application-data persistence

- **Precondition:** P3 passing; B7 and B8 complete.
- **Steps:** none of its own — P7 is the summary check that ties the two distinct claims together.
- **Expected, stated as two separate claims:**
  1. **Reachability** — P3's `200 ready` proves the deployed container can reach its configured
     PostgreSQL database. Render configuration identifies that database as Neon (F10); the application
     never asserts the vendor.
  2. **Application-data persistence** — **B8**'s API reads prove that a run and its approval decision
     survive independently of any browser session. (Not B6, which is only the rejected-decision UI
     flow, and not a UI refresh, which cannot restore a prior run at all — F20.)
- **Evidence:** P3's response body, plus B8's two JSON payloads with the field-by-field comparison.
- **Failure handling:** if reachability holds but B8's data does not match, persistence is broken and
  PR 5D becomes a bug report. If P3 fails intermittently while B8 succeeds, that is a free-tier
  auto-suspend observation, not a persistence failure — record it as such.

### 3.2 Browser flow checks

All browser flows are performed at 1440×900 in a clean Chrome profile unless stated otherwise. The
reviewer name used in every decision is the neutral placeholder **`Demo Reviewer`** — never a real
person's name (§9).

#### B1 — Ordinary run reaches `NOT_ELIGIBLE`

- **Precondition:** P1 passing; **Approval workflow demo** checkbox **unchecked**.
- **Steps:** type a neutral Issue Summary (e.g. `Checkout API returning intermittent 500s`) → click
  **Run Investigation** → wait for completion.
- **Expected:** run completes; the trace timeline renders as an ordered `<ol>`; the generated report
  renders; the Run Context Panel shows `NOT_ELIGIBLE` with the eligibility rule and the hint naming
  the **Approval workflow demo** checkbox; **no** `Action required` banner appears anywhere; **no**
  Approve or Reject control exists in the DOM.
- **Evidence:** `normal-run-not-eligible.png`.
- **Failure handling:** an `Action required` banner on an ordinary run would contradict F18 and
  `docs/14` §8.3 — record and open an issue.

#### B2 — Pending approval

- **Precondition:** B1 done; a **fresh** run with **Approval workflow demo** checked.
- **Steps:** check the box → **Run Investigation** → wait for completion → **do not scroll**.
- **Expected:** the `Action required` banner appears between the Investigation summary and the
  run-detail grid; the pending decision form is visible in the desktop Run Context Panel **without
  scrolling**; the notice region reads `Investigation completed. Human approval required.`; the report
  shows exactly one `DRAFT_CUSTOMER_REPLY` suggested action.
- **Evidence:** `pending-approval-desktop.png`, captured before any scrolling.
- **Failure handling:** if the form requires scrolling to reach, PR 5C's central claim (`docs/14` §8.1)
  is not met on a real viewport — record it prominently; do not soften `docs/14`.

#### B3 — Exactly one Approve and one Reject control

- **Precondition:** B2's run still `PENDING`.
- **Steps:** in DevTools, `document.querySelectorAll('button')` and count controls whose accessible
  name is Approve or Reject; visually confirm no duplicate pinned control on any viewport.
- **Expected:** exactly one of each — the jsdom assertion in `App.run-context-layout.test.tsx` now
  confirmed on a real page.
- **Evidence:** stated in `docs/15` §5; visible in `pending-approval-desktop.png`.
- **Failure handling:** any duplicate is a defect.

#### B4 — Sticky context panel

- **Precondition:** B2's run still `PENDING`, viewport ≥1024px wide.
- **Steps:** scroll the main reading surface through the full report while watching the Run Context
  Panel.
- **Expected:** the panel remains visible (`position: sticky; top: var(--space-5)`, F16) for the
  duration of a long report scroll.
- **Evidence:** a sentence in `docs/15` §5 stating it was confirmed; this is what closes `docs/14`
  §8.7's open item (C9). The sticky state is also implicitly visible in `pending-approval-desktop.png`.
- **Failure handling:** record the actual behavior and leave `docs/14` §8.7's caveat in place, revised
  to say it was verified and did **not** hold.

#### B5 — Approved terminal run

- **Precondition:** B2's run, still `PENDING`.
- **Steps:** enter reviewer `Demo Reviewer`, a short neutral note (e.g. `Reviewed for the public demo.`),
  click **Approve**. **Record the Run ID from the Investigation summary before moving on** — B7/B8
  depend on it, and once the page is refreshed there is no way to recover it from the UI (F20).
- **Expected:** notice reads `Decision recorded.`; the panel becomes the read-only `APPROVED` record
  showing reviewer, note, and formatted `decidedAt`; the `Action required` banner disappears; **zero**
  buttons render in the terminal panel — no edit, revoke, or resubmit control anywhere.
- **Evidence:** `approved-decision.png`; the recorded `runId`, `decidedAt`, reviewer, and note,
  transcribed for the B8 comparison.
- **Failure handling:** any surviving control contradicts `docs/14` §8 and `docs/13` §5 — defect.

#### B6 — Rejected terminal run (separate fresh run)

- **Precondition:** a **new** approval-demo run — never the one already approved.
- **Steps:** check the box → **Run Investigation** → enter `Demo Reviewer` and a neutral note → click
  **Reject**.
- **Expected:** the symmetric terminal `REJECTED` record; banner gone; no controls.
- **Evidence:** `rejected-decision.png`.
- **Failure handling:** as B5.
- **Note:** B6 is a *UI flow* check only. It is **not** persistence evidence — that is B8's job.

#### B7 — Browser refresh: what it actually does

- **Precondition:** B5 complete; its `runId` recorded.
- **Steps:** refresh the browser on the approved run.
- **Expected:** the app returns to the **empty investigation form**. The previous run is *not*
  restored, because `apps/web` has no router and no client-side storage (F20) — there is no URL that
  addresses a run and nothing is persisted in the browser.
- **What to record — honestly:**

  > Refreshing the browser does not restore the previous run. The UI is a single-page application with
  > no router and no historical-run browser, so a completed run is not reachable through the interface
  > once the page reloads. This is a known product limitation (`docs/14` §8.8), not a persistence
  > failure — the data itself is verified in B8.

- **Evidence:** the statement above in `docs/15` §7 and §9. **No screenshot** — a picture of an empty
  form proves nothing and invites misreading.
- **Failure handling:** if the run *is* somehow restored, F20 is wrong; re-inspect and correct this plan
  before continuing, and reconsider whether a browser-path persistence screenshot is warranted after
  all (§4.2's note).
- **Explicitly:** a UI refresh proves **nothing** about persistence in either direction. It is recorded
  because the limitation is worth documenting, not because it is evidence.

#### B8 — Persistence verified through the public API

- **Precondition:** B5's `runId`, decision, reviewer, note, and `decidedAt` recorded.
- **Steps:**
  ```bash
  # 1. From the working shell
  curl -sS "https://opspilot-bkdf.onrender.com/v1/agent-runs/<runId>"
  curl -sS "https://opspilot-bkdf.onrender.com/v1/agent-runs/<runId>/approval"

  # 2. Repeat both from a clean shell (new terminal session, no shell history,
  #    no cookies, no shared state) — or an incognito browser tab
  ```
  Both endpoints are public and unauthenticated (F22), so no header, cookie, or credential is involved
  in either invocation — which is precisely why the repeat from a clean session is meaningful.
- **Expected:** both invocations return identical payloads, and the following five fields match what
  B5 recorded in the browser:

  | Field | Source in B5 | Source in B8 |
  |---|---|---|
  | Run ID | Investigation summary | `data.id` on the run response |
  | decision | `APPROVED` badge | `data.status` on the approval response |
  | reviewer | `Demo Reviewer` | `data.reviewer` |
  | note | the note text | `data.note` |
  | `decidedAt` | formatted timestamp in the panel | `data.decidedAt` |

- **Why this is the real proof:** the decision was made in one browser session, and it is being read
  back by a different client with no shared storage, no cookies, and no session of any kind — so the
  response cannot be coming from browser-local state. The clean client rules out browser-local state;
  repository inspection (F23) shows that these endpoints read persisted records through the
  Prisma-backed PostgreSQL path rather than any process-local or in-memory cache, so the matching API
  responses provide evidence of server-side application-data persistence. Combined with P3's
  reachability, that is application-data persistence demonstrated end to end — and it does not depend
  on a UI capability the product does not have.
- **Evidence:** both JSON payloads (secrets-free by construction) and the five-field comparison table,
  in `docs/15` §7. The exact `curl` commands are reproducible by any reader — which is a stronger
  artifact than a screenshot, since anyone can re-run them.
- **Failure handling:** any mismatch means persistence is broken — PR 5D becomes a bug report. A `404`
  on a `runId` that the browser just displayed is the same conclusion.

### 3.3 Responsive and accessibility checks

#### R1 — Desktop ≈1440×900

- **Steps:** DevTools device toolbar at 1440×900 with a `PENDING` run.
- **Expected:** two-column grid; report dominant; context panel constrained to 18–22rem; sticky.
- **Evidence:** the desktop screenshots.
- **Failure handling:** record.

#### R2 — The `64rem` / ≈1024px breakpoint

- **Steps:** resize across 1023px → 1024px → 1025px.
- **Expected:** the layout switches from single column to two columns exactly at 1024px; below it the
  panel returns to normal document flow with no sticky positioning (F16, `docs/14` §8.2).
- **Evidence:** a sentence in `docs/15` §5 recording the observed switch point.
- **Failure handling:** record the actual switch point.

#### R3 — Mobile ≈375×812

- **Steps:** DevTools at 375×812 with a `PENDING` run.
- **Expected:** single column; the `Action required` banner still appears near the top; **no raw
  Approve/Reject button is pinned above the full decision card** — the banner is only ever the link
  (F17, `docs/14` §8.4).
- **Evidence:** `pending-approval-mobile.png`.
- **Failure handling:** record.

#### R4 — Keyboard activation of `Action required`

- **Steps:** from the top of a `PENDING` page, press `Tab` until the banner has focus (confirm a
  visible `:focus-visible` outline), then press `Enter`.
- **Expected:** the page navigates to `#approval-heading`.
- **Evidence:** stated in `docs/15` §5; this and R5 together close `docs/14` §8.4 (C8).
- **Failure handling:** record what actually happened.

#### R5 — Focus lands on the Approval heading

- **Steps:** immediately after R4, evaluate `document.activeElement` in the DevTools console and read
  its `id` and `textContent`.
- **Expected:** `approval-heading` — the `tabIndex={-1}` fragment target actually receives focus, not
  just scroll (F17).
- **Evidence:** the recorded `activeElement` id in `docs/15` §5.
- **Failure handling:** if the browser scrolls but does not focus, say exactly that. `docs/14` §8.4
  becomes "verified: scrolls, does not move focus in Chrome <version>" rather than being deleted — a
  precise, honest downgrade is more valuable than an unverified claim.

#### R6 — Reduced motion

- **Steps:** DevTools → Rendering → *Emulate CSS media feature `prefers-reduced-motion: reduce`*, then
  repeat R4. Cross-check with the OS-level setting if convenient.
- **Expected:** the jump to the Approval heading is instant, with no smooth-scroll animation (F16).
- **Evidence:** stated in `docs/15` §5; closes `docs/14` §8.7's reduced-motion item.
- **Failure handling:** record.

#### R7 — No horizontal overflow

- **Steps:** at 375px and again at 360px (the width `docs/14` §9 already claims), check
  `document.documentElement.scrollWidth <= window.innerWidth`, and visually scan for a horizontal
  scrollbar. Repeat with a terminal record containing a long note, since `docs/14` §8.6 makes a
  specific wrapping claim (`overflow-wrap: anywhere`, `flex-wrap: wrap`).
- **Expected:** no horizontal page scroll at either width, long note or not.
- **Evidence:** the recorded `scrollWidth`/`innerWidth` pair in `docs/15` §5.
- **Failure handling:** record.

#### R8 — Exactly one Approve and one Reject while pending, on every viewport

- **Steps:** repeat B3's count at 1440, 1024, and 375.
- **Expected:** one of each, at every width.
- **Evidence:** stated in `docs/15` §5.
- **Failure handling:** any duplicate is a defect.

---

## 4. Screenshot evidence plan

### 4.1 Conventions this PR establishes

`docs/assets/` does not exist yet (F14), so PR 5D sets the convention:

```text
docs/assets/live-demo/<kebab-case-behavior>.png
```

- **PNG**, no lossy artifacts on text.
- **Content-only** for all product screenshots — no browser chrome, no URL bar, no tab strip, no
  bookmarks bar, no extension icons, no profile avatar, no OS menu bar, no notifications. Chrome adds
  no information about the product and is the single largest accidental-disclosure surface (other
  tabs, other accounts).
- One exception: the Render screenshot is a **tight crop** of a dashboard row (§4.3).
- Clean Chrome profile, default zoom, light theme, no dev tools panel visible in the capture.
- Captured via the claude-in-chrome tooling at exact viewport sizes, except the Render one.

### 4.2 Product screenshots

Five images. Persistence is proven by API output (B8), not by a picture — see the note below.

| File | Viewport | Must be visible | Must be hidden / cropped out | Caption |
|---|---|---|---|---|
| `normal-run-not-eligible.png` | 1440×900 | Trace timeline, generated report, Run Context Panel showing `NOT_ELIGIBLE` with its eligibility rule and hint; visible absence of any banner | Any Approve/Reject control (none exists); browser chrome | "An ordinary investigation completes with zero suggested actions, so the Run Context Panel reports `NOT_ELIGIBLE` and no approval controls are rendered at all." |
| `pending-approval-desktop.png` | 1440×900 | The `Action required` banner **and** the pending decision form, both visible without scrolling; the one `DRAFT_CUSTOMER_REPLY` suggested action | Browser chrome | "The approval-workflow demo run: the pending decision is visible without scrolling past the report — the banner at the top and the decision form in the sticky Run Context Panel." |
| `approved-decision.png` | 1440×900 | Read-only `APPROVED` record — reviewer `Demo Reviewer`, the note, the formatted decision timestamp; the banner gone; the **Run ID visible**, since it is the value B8 reads back | Browser chrome; any edit/revoke control (none exists) | "After approval the panel becomes a read-only record. No edit, revoke, or resubmit control exists — the API has no such endpoint. The Run ID shown here is the one queried in §7." |
| `rejected-decision.png` | 1440×900 | The symmetric read-only `REJECTED` record on a separate run | As above | "A separate run rejected: the same terminal, read-only shape." |
| `pending-approval-mobile.png` | 375×812 | Single-column layout, the `Action required` banner near the top, the full decision card below | Browser chrome; any horizontal scrollbar | "At 375 px the layout collapses to a single column. The banner is still a link to the decision — no raw Approve/Reject button is ever pinned above the full decision card." |

> **`persistence-after-refresh.png` is withdrawn.** The original plan assumed a browser session could
> navigate back to a completed run. It cannot: `apps/web` has no router and no client-side storage
> (F20), so a refresh returns to an empty form. A screenshot of an empty form is not evidence, and one
> captioned as persistence proof would be actively misleading. Persistence is instead demonstrated by
> B8's API reads, whose output is quoted as text in `docs/15` §7 — a stronger artifact anyway, because
> any reader can re-run the two `curl` commands themselves. If execution reveals a real supported
> browser path to a prior run (contradicting F20), reinstate a screenshot then — not before.

**On identifiers:** Ticket ID, Job ID, and Run ID (F15) remain **visible** — owner's decision, and the
right one. They are demo-data UUIDs generated by the deployment itself and they authorize nothing. The
Run ID visible in `approved-decision.png` is the same one B8 queries, so the screenshot and the API
output corroborate each other; redacting it would sever that link to prevent no actual risk.

**On the reviewer name:** always the placeholder `Demo Reviewer`. Never a real name, never an email.

### 4.3 Render screenshot

`render-deployment-status.png` — captured by the owner.

- **Must be visible:** the live deploy row only — commit SHA, commit message, deploy status
  (`Live`/`Deployed`), and timestamp.
- **Must be cropped out:** account email, user avatar, organization/team switcher, billing or plan-
  upgrade banners, the Environment/Environment Variables pane, the Logs pane, the Shell tab, any
  connection string, any service-settings pane, and any other service in the account list.
- **Browser chrome:** none — crop to the dashboard row.
- **Caption:** "The Render deploy that served every observation in this document, deployed from `main`
  after CI passed (`autoDeployTrigger: checksPass`)."
- **If the crop cannot exclude account details cleanly:** drop the screenshot and fall back to the
  written SHA plus the `git`/`gh` confirmation in P5. The written proof is sufficient; the image is a
  credibility bonus, not a requirement.

### 4.4 Deliberately not captured

- **No Neon dashboard screenshot.** It would expose project name, branch names, region, compute size,
  and billing state. It is also not needed for either claim: reachability is established by P3, and
  application-data persistence by B8's API reads. A dashboard screenshot would show that a database
  exists in an account — which is not the same as showing that this deployment's data survives — while
  adding real exposure.
- **No `persistence-after-refresh.png`** (§4.2).
- **No DevTools panels, no network waterfalls, no terminal scrollback screenshots.** Where those
  observations matter, they are transcribed as text into `docs/15` (§9 requires transcription rather
  than raw pastes).
- **No video or GIF** — see §14.

---

## 5. Cold-start and warm measurement protocol

### 5.1 Why this is step one, and what "idle" actually means

The only genuine cold-start observation available is the **first** request after a real idle period.
Any earlier request — a curiosity check, a quick health poll, a screenshot — wakes the instance and
destroys that cycle.

Two statements, both required verbatim in `docs/15` §8 and both true:

```text
The planning agent sent no request to the public URL.
Actual idle state must still be confirmed in Render immediately before each cold measurement.
```

The first does **not** imply the second. The service is public and unauthenticated; other traffic — a
crawler, a previous manual visit, an uptime probe — may have woken it at any time. **Do not claim the
service is idle merely because this plan avoided touching it.** Idle state is a fact to be confirmed
in the Render dashboard immediately before each cycle, and each observation is labelled *known idle*
(dashboard-confirmed) or *assumed idle* (no traffic sent for N minutes, unverified) accordingly.

### 5.2 Tools

```bash
# API timing — one line per request, no body written to disk
curl -o /dev/null -sS \
  -w 'dns=%{time_namelookup} tcp=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total}\n' \
  https://opspilot-bkdf.onrender.com/v1/health/live
```

Page loads are measured in the Chrome DevTools Network panel (DOMContentLoaded and Load), with the
cache disabled for the cold observation. Both tools are ubiquitous and reproducible, which matters more
here than precision.

### 5.3 Three distinct idle cycles

Each cold observation gets its own idle cycle. This is decided here, not at execution time: a single
cycle can produce exactly **one** cold number, because the measuring request is itself the wake-up.

#### Cycle A — cold health observation

1. Confirm in the Render dashboard that the service is spun down.
2. Send `GET /v1/health/live` as **the first request**.
3. Record the full `curl -w` line (`dns`, `tcp`, `tls`, `ttfb`, `total`).
4. Immediately after, send `GET /v1/health/ready` and record it too — now warm, but the `live`→`ready`
   delta at this moment is the most informative database-wake signal available (§5.5).

#### Cycle B — cold page-load observation

1. Wait for the service to spin down again; confirm idle in Render.
2. Open `https://opspilot-bkdf.onrender.com/` as **the first request**, DevTools open, cache disabled.
3. Record DOMContentLoaded, Load, and the document request's TTFB.

#### Cycle C — cold investigation observation

1. **While warm**, create a job without starting its run (F21) and record the returned `jobId`:
   ```bash
   curl -sS -X POST https://opspilot-bkdf.onrender.com/v1/agent-jobs \
     -H 'content-type: application/json' \
     -d '{"ticketId":"TICKET-APPROVAL-DEMO","summary":"Cold-start measurement run"}'
   ```
   (`TICKET-APPROVAL-DEMO` makes the run approval-eligible, so the cold measurement exercises the same
   path the demo does. Any ticket ID works if a plain run is preferred — state which was used.)
2. Wait for the service to spin down; confirm idle in Render.
3. Send, as **the first request**:
   ```bash
   curl -o /dev/null -sS -w '<same -w format>' \
     -X POST https://opspilot-bkdf.onrender.com/v1/agent-jobs/<jobId>/runs
   ```
4. Record TTFB and total request duration as **external end-to-end observations only**. Do **not**
   claim that agent execution time was isolated — the request is a single synchronous round trip, and
   from outside the container there is no way to separate container wake-up, application startup,
   database connection establishment, orchestration, report generation, and response serialization
   from one another. `ttfb` and `total` are reported as two numbers on the same external timeline, not
   as a decomposition of the run into its internal stages.

This ordering is deliberate: creating the job while warm means the cold request measures **run
execution after wake-up**, not job creation. Reversing it would conflate the two. Comparison against
the warm investigation totals (§5.4 W4) is used only to **estimate the combined cold-start overhead** —
the difference between the cold and warm totals — while stating plainly that the components of that
overhead cannot be separated externally.

### 5.4 Warm observations

Three observations each, ~30 s apart, taken while the service is known warm:

| ID | What |
|---|---|
| W1 | `GET /v1/health/live` ×3 |
| W2 | `GET /v1/health/ready` ×3 |
| W3 | Root page load ×3, **cache disabled** for all three, same as the Cycle B cold observation — so the cold and warm page-load numbers are directly comparable rather than one being flattered by a cached response |
| W4 | Investigation — `POST /v1/agent-jobs` then `POST /v1/agent-jobs/<jobId>/runs` ×3 |

Warm results are reported as **min / median / max**, never collapsed into a single averaged headline.
Cold results are single observations, labelled `n=1`.

### 5.5 What is recorded for every observation

- UTC date and local time.
- Whether the idle state was **known** (Render-confirmed) or **assumed** (§5.1).
- Render status at the time of the observation.
- The exact command or DevTools metric used.
- Network context: connection type and approximate geographic region of the client.

### 5.6 Separating wake-up from application and database latency

Two independent decompositions, both available without any code change:

1. **Within one request.** `tcp`/`tls` (`time_connect`, `time_appconnect`) versus the remainder of
   `ttfb`. Render's proxy terminates TLS and holds the connection while the instance spins up, so a
   large `ttfb - tls` gap on a cold request points at container start plus application boot, while
   large `tcp`/`tls` points at edge/proxy behavior.
2. **Between two endpoints.** `/v1/health/live` is process-only and never touches the database (F4);
   `/v1/health/ready` executes ``SELECT 1``. The **delta between them** isolates database connection
   establishment — including the managed database's own free-tier auto-suspend, which `docs/08` §17
   notes is normally absorbed by the entrypoint's migration retry at container start but is observable
   here at request time. Cycle A step 4 captures exactly this pair.

Where the split is not cleanly attributable — and on a shared free tier it often will not be — say so
explicitly. "The 4.1 s gap could not be attributed between container start and database wake-up from
outside the service" is a better sentence than a confident wrong one.

### 5.7 Reporting rules

- Wording: "single observation", "n=3", "environment-specific", "measured from <region> on <date>".
- Required disclaimer, in `docs/15` §8, in its own callout:

  > These are observations of a **free-tier** deployment taken on specific dates from a specific
  > network. They are **not a benchmark and not an SLA**. A free instance spins down when idle; the
  > numbers below describe that behavior honestly rather than hiding it.

- Never convert an observation into a percentile, a "typical" figure, or a p95.
- **Vendor-stated behavior stays separate from measured observations, and must itself be current.**
  `docs/08` §16 previously stated "roughly 50 seconds" — that number is stale; Render's own current
  documentation states:

  > Render currently states that a Free web service spins down after 15 minutes without inbound
  > traffic and takes about one minute to spin back up. The measurements below are separate
  > observations of this deployment.

  Use this wording verbatim (in `docs/08` §16 and in `docs/15` §8), attributed explicitly to Render's
  documentation, with this deployment's own measurement printed immediately beside it and clearly
  labelled as a separate observation. Never merge the two into one unattributed number, and never
  silently carry forward an outdated vendor figure without checking it against Render's current
  documentation at execution time.

---

## 6. `docs/15-live-demo-evidence.md` design

### 6.1 Structure

| § | Section | Contents | Notes |
|---|---|---|---|
| — | Header table | Public URL, verification date, verified commit SHA, verifier, environment (Render free + Neon per configuration), document status | Same table style as `docs/08` and `docs/14` |
| 1 | Read this first | The three mandatory statements (§6.2), then the one-paragraph honest summary | **Before any screenshot.** A reader who stops here must already have an accurate picture. |
| 2 | What this is | One paragraph: a deployed, deterministic, human-in-the-loop investigation workflow | |
| 3 | Architecture summary | ~6 lines + a link to `docs/08` §12 | Do **not** duplicate the ASCII diagram — link it |
| 4 | Health-check results | P2/P3/P4 commands and exact responses, including the six case-sensitivity lines and P3's qualifying sentence | Secrets omitted; all requests are unauthenticated |
| 5 | Verified walkthrough | The §3 matrix as a results table: check / expected / observed / evidence | Every check appears, including any that failed |
| 6 | Screenshot gallery | The five product images with the §4.2 captions | Inline, in walkthrough order |
| 7 | Persistence verification | B7's honest refresh note, then B8's two `curl` commands, both JSON payloads, and the five-field comparison table | Split explicitly into *reachability* (P3) and *application-data persistence* (B8) |
| 8 | Cold-start and warm observations | The three cycles from §5.3, the warm tables, the §5.1 verbatim pair, and the not-an-SLA callout; vendor-stated figures kept separate | |
| 9 | Known limitations | The full boundary list, unhedged — including "no historical-run browser; a completed run is reachable only via the API" | |
| 10 | Demo script | **Two clearly separated tracks** (§6.3) | |
| 11 | Troubleshooting | §6.4 | |
| 12 | Portfolio claim matrix | §8 of this plan, filled in | |
| 13 | Reproduction notes | Every command used, secrets omitted; the deployed-SHA caveat from §2.4 | |

### 6.2 Mandatory verbatim statements

These appear in §1, before any screenshot, exactly as written:

```text
The deployed browser workflow uses the deterministic FAKE provider.

The repository includes a file-backed RAG spike and evaluation path, but
retrieval is not wired into the deployed browser workflow.

Approval decisions are recorded, but approved actions are not executed.
```

§9 expands them with the rest of the boundary: no authentication, rate limiting, or abuse protection;
no RBAC or multi-user support; **no historical-run browser — a completed run cannot be reopened in the
UI after a refresh and is reachable only through the API**; free-tier cold starts; all data is demo
data with no privacy expectation; `apps/worker` is not deployed; `runbooks/` is excluded from the image.

### 6.3 Demo script — two tracks

Owner's decision: both, clearly separated.

**Track A — 2-minute walkthrough (non-engineer).** Numbered clicks with, after each, one line on what
it demonstrates: open the URL (note the first load may be slow — free tier); type an issue summary; run
it; read the timeline and report; check **Approval workflow demo** and run again; see the
`Action required` banner; approve; watch it become a read-only record. Closes with one sentence on what
the demo deliberately does not do — including that there is no way to browse past runs in the UI.

**Track B — engineer walkthrough.** `curl` both health endpoints and explain the live/ready split and
what readiness does *not* prove; show `/v1/nope`, `/missing.js`, `/V1/health/live`, and `/V1abc`
proving the case-aware single-origin boundary; show the DevTools network log with only relative
same-origin requests and zero CORS preflights; run the approval flow while narrating `PENDING` →
`APPROVED` and the `201` vs `200` idempotent-replay distinction and the two `409`s; then read the run
and approval back through the public API from a clean shell as the persistence proof; discuss the
cold-start decomposition from §5.6; close on the deliberate limits and why each was a scope decision
rather than an oversight.

### 6.4 Troubleshooting notes

| Symptom | Explanation | Action |
|---|---|---|
| First request takes tens of seconds | Render free-tier spin-down (`docs/08` §16, vendor-stated) | Wait; subsequent requests are warm (§8 has this deployment's numbers) |
| `/v1/health/ready` returns 503 `PERSISTENCE_UNAVAILABLE` | Managed-database auto-suspend, or a transient connection loss (`docs/08` §17) | Retry after ~10 s; the error deliberately carries no connection details |
| Blank page after a deploy | Stale cached `index.html` | Hard-refresh; `index.html` is served `no-cache` (F8), assets are content-hashed and immutable |
| An ordinary run shows no approval controls | Correct and intended — ordinary runs produce zero suggested actions (F18) | Check **Approval workflow demo** to exercise the approval path |
| **Refreshing loses the run I was looking at** | **Expected.** There is no router and no historical-run browser (F20, `docs/14` §8.8) | Note the Run ID before refreshing, then `GET /v1/agent-runs/<runId>` and `.../approval` |

---

## 7. Documentation update map

### 7.1 `README.md`

- **Section:** *Deployment* (lines ~49–68).
- **Add:** the public URL as a prominent live-demo line; "verified `<date>` against commit `<sha>`";
  a link to `docs/15-live-demo-evidence.md`; one sentence with the measured cold-start observation,
  attributed as an observation.
- **Link, don't duplicate:** the measurement tables, the walkthrough, the screenshots, the claim matrix
  — all live in `docs/15`.
- **Remove or soften:** C1 in full ("has not yet been deployed… no live URL… have not been created
  yet"); C2's "once deployed" → present tense.
- **Preserve verbatim in substance:** C3, the retrieval-scope paragraph. It is correct and is exactly
  the kind of honesty this PR is protecting. Only the surrounding tense changes.
- **Public URL belongs here:** yes — it is the first thing a portfolio reader sees.
- **Cold-start observation belongs here:** one sentence with a number, linking onward. Not the tables.

### 7.2 `docs/08-cicd-deployment.md`

- **Status table (line 5):** → CI implemented (PR 5A); deployment configuration implemented (PR 5B);
  **deployed and verified (PR 5D)**, with the date.
- **Scope note (lines 12–26):** rewrite so the Feature Complete vs Portfolio Ready distinction is
  **retained as history** — it is good engineering writing and deleting it would erase the reasoning —
  but marked satisfied, with each of its five conditions now pointing at its evidence in `docs/15`.
  Correct the off-by-one: the evidence was PR **5D**'s job, not PR 5C's.
- **§16:** keep the vendor-stated figures attributed and print this deployment's observation beside
  them (§5.7).
- **§17:** no change to the Neon design content, but ensure nothing in the updated text implies a live
  check confirmed the vendor — configuration does (F10).
- **§24 first bullet:** replace "No live deployment exists yet" with a live-verified bullet that keeps
  every free-tier limitation intact.
- **New §25 — Live deployment verification:** short. What was verified, when, against which commit, and
  a link to `docs/15`. Explicitly not a copy of it.
- **Public URL belongs here:** yes. **Measurement tables:** no — link them.

### 7.3 `docs/14-web-ui.md`

Three admissions to close, in whichever direction the observations actually go:

- **§8.4 (C8):** the banner scroll/focus claim → what R4/R5 actually observed, dated, linking to
  `docs/15`.
- **§8.7 (C9):** sticky behavior, no-scroll initial visibility, fragment focus, and reduced motion →
  what B2/B4/R5/R6 actually observed.
- **§11 step 2 (C10):** "confirm in your browser, since it was not verified in this implementation
  session" → the verified result.
- **§9:** add the reduced-motion confirmation **only if** R6 genuinely passed.
- **§8.8:** optionally add one sentence noting that the absence of historical-run navigation was
  observed live and is documented in `docs/15` §9 — the section already anticipates the feature, and
  B7 turned it from a design note into an observed limitation.

**Hard rule:** if any behavior did not hold, record the precise downgrade ("verified: scrolls, does not
move focus in Chrome `<version>`") rather than deleting the caveat or upgrading the claim. No URL and no
cold-start data belong in this document.

### 7.4 `docs/10-engineering-challenges.md`

**Default: no new challenge.** Live verification that simply confirms the design is not an engineering
challenge, and this document's value comes from its selectivity.

Add **Challenge 9** only if verification surfaces a real problem that required a decision. The standing
candidate is §2.4: `autoDeployTrigger: checksPass` means the documentation PR that records a verified
SHA is itself the deploy that invalidates it — an evidence-freshness versus continuous-deployment
tension, resolved by scoping the claim ("verified against `<sha>`; the redeploy differs only in
documentation") rather than by pinning deploys or adding a version endpoint. Whether that clears the bar
depends on whether it forced a real decision during execution; decide **after** §3, not before.

If added: follow the §2 entry template exactly (Context / Problem / Why It Is Difficult / Failure Modes
/ Decision / Alternatives Considered / Tradeoffs / Implementation Notes / Testing Strategy /
Observability / Interview Explanation), bump `Version` 1.10 → 1.11, and extend the `Revision note`
field in the established style.

### 7.5 `render.yaml` — comment-only correction

The header comment (C11) still says applying the blueprint "is PR 5C's job", which is stale and carries
the same off-by-one as `docs/08`'s scope note. PR 5D corrects it, under strict rules:

- **Comment lines only.** The prose in lines 5–8 is rewritten to say the blueprint was applied and the
  deployment verified in PR 5D, with a pointer to `docs/15-live-demo-evidence.md`.
- **No YAML value changes.** `type`, `name`, `runtime`, `dockerfilePath`, `dockerContext`, `plan`,
  `branch`, `autoDeployTrigger`, `healthCheckPath`, and every `envVars` entry are byte-identical
  before and after.
- **No deployment behavior change.** Because no value changes, Render's blueprint sync is a no-op.
- **Verification:** `git diff --cached render.yaml` must show only comment lines (`#`-prefixed) as
  changed. If any non-comment line appears in that diff, revert the file and drop this change.
- **Costs no extra deploy.** Merging PR 5D redeploys regardless (§2.4), so folding the fix in here is
  strictly cheaper than a separate PR — which is why no separate issue or PR is opened for it.
- **Staging:** include `render.yaml` in the §11.3 staging list **only if** the comment was actually
  updated.

---

## 8. Portfolio claim matrix

Filled with real evidence references in `docs/15` §12. Shape and rules:

| Claim | Evidence | Allowed wording | Forbidden wording | Source |
|---|---|---|---|---|
| Deployed full-stack AI-agent-style workflow | Live URL; P1; B1–B6 | "deployed full-stack **AI-agent-style** workflow"; "human-in-the-loop investigation workflow" | "AI agent" implying autonomy; "autonomous agent"; "self-healing" | `docs/15` §5 |
| Bounded deterministic orchestration | Deterministic FAKE provider enforced at DI time; `docs/08` §7 | "bounded, deterministic orchestration with a fixed step budget" | "reasoning engine"; "adaptive planning" | `docs/04`, `docs/08` §7 |
| Database reachability | P3 | "the deployed container reaches its configured PostgreSQL database (`/v1/health/ready`)" | "readiness proves Neon"; "readiness proves persistence" | `docs/15` §4 |
| Persisted runs / traces / reports / approvals | **B8** (API reads from a clean session), corroborated by P3 | "runs and approval decisions are persisted server-side and read back through the public API from a session that never made the decision" | "durable at scale"; "highly available"; "survives refresh in the browser" (the UI cannot restore a run at all — F20) | `docs/15` §7 |
| Managed PostgreSQL on Neon | `render.yaml` + the dashboard `DATABASE_URL` (F10) | "backed by a managed PostgreSQL database (Neon, **per deployment configuration**)" | any phrasing implying a live check identified the vendor | `docs/08` §17, `docs/15` §3 |
| Responsive approval UI | R1–R8; the screenshots | "responsive React approval UI verified at 1440 / 1024 / 375"; "keyboard-activable, reduced-motion-aware" | "WCAG compliant"; "fully accessible" (no audit was performed) | `docs/15` §5, `docs/14` §9 |
| Single-origin, case-aware API boundary | P4, including the three `/V1` checks | "single origin, no CORS; the API prefix guard is case-aware and verified in production" | "hardened routing"; "WAF-protected" | `docs/15` §4, `docs/08` §12 |
| CI and Docker smoke | `.github/workflows/ci.yml`; `docs/08` §20 | "three-job CI: typecheck/unit/build, PostgreSQL integration + migration drift, and a full container smoke test" | "comprehensive test coverage"; "battle-tested" | `docs/08` §1–§11, §20 |
| Render deployment | P5, P6; `render.yaml`; `render-deployment-status.png` | "single-origin Docker deployment on Render **free tier**" | "production infrastructure"; "cloud-native platform" | `docs/15` §4, `docs/08` §12–§17 |
| Repository-level RAG spike and evaluation | `apps/worker`; `docs/05`; `docs/reviews/05-*`; `evals/` | "retrieval-augmented generation implemented and evaluated **offline, at repository level**, with a live provider spike" | "deployed RAG"; "the demo retrieves runbooks"; "RAG-powered demo" | `docs/05`, `docs/08` §23 |
| Live provider status | `AGENT_RUN_PROVIDER_MODE=FAKE`; no key in the image or in Render | "the deployed browser workflow uses a **deterministic FAKE provider**; a real-Claude spike exists in the repository" | "powered by Claude"; "live LLM inference"; "GPT-backed" | `docs/15` §1 |
| Deployed RAG status | `apps/api` wires no retriever; `runbooks/` excluded from the image | "retrieval is **not wired into** the deployed browser workflow" | any phrasing implying the demo retrieves | `docs/08` §23 |
| Action-execution status | No execution endpoint; `docs/13` §5; B5/B6 show read-only terminal records | "approval decisions are **recorded**; approved actions are **not executed**" | "executes approved actions"; "automated remediation"; "closes tickets" | `docs/15` §1 |
| Production / security scale | `docs/08` §22; B7 | "**demo** deployment: no authentication, rate limiting, or abuse protection; no historical-run browser; free tier; all data is demo data" | "production-ready"; "production-grade"; "secure"; "multi-tenant"; "enterprise" | `docs/08` §22, `docs/15` §9 |

---

## 9. Secret and privacy review (pre-commit checklist)

Run in order, immediately before staging (§11.3).

1. **Screenshots — visual.** Open every PNG at full size. Confirm: no browser chrome in product shots;
   no other tabs, bookmarks, extensions, profile avatar, or OS menu bar; no notification popups; no
   DevTools panel; reviewer name is the `Demo Reviewer` placeholder; the Render crop shows the deploy
   row and nothing else.
2. **Image metadata — strip safely.** ExifTool's default behavior is to preserve the untouched original
   alongside the stripped file as `<name>.png_original`. Those backups still contain everything that
   was just removed, and a careless `git add docs/assets/live-demo/*` or a later glob could commit
   them. Use `-overwrite_original`, then prove no backup survives:
   ```bash
   exiftool -overwrite_original -all= docs/assets/live-demo/*.png
   exiftool docs/assets/live-demo/*.png
   find docs/assets/live-demo -name '*_original' -print
   ```
   **The third command must produce no output.** If it prints anything, delete those files before
   continuing. (macOS screenshots can carry capture-context metadata; re-encoding is an acceptable
   alternative if `exiftool` is unavailable — apply the same "no leftover backup" check.)
3. **Browser UI.** Confirmed by (1). Captures are content-only by construction.
4. **Render dashboard.** No account email, org/team switcher, billing banner, plan-upgrade prompt,
   Environment Variables pane, Logs pane, Shell tab, or other services in the account list.
5. **Neon dashboard.** Not captured at all (§4.4).
6. **Environment variables.** No `.env`, no `DATABASE_URL`, no database endpoint host, no `npg_` token,
   no `sslmode=require` connection string anywhere in the diff. Verified by (10).
7. **Logs.** No Render log output is pasted. If a log line is genuinely needed to explain a failure, it
   is re-typed with hostnames and identifiers redacted, never pasted from the dashboard.
8. **Request/response captures.** Only the unauthenticated public requests in §3 and §5. The B8 JSON
   payloads are demo data — confirm they contain only the run, trace, report, and approval fields, with
   no environment or connection detail. Response headers are included only after confirming no
   `set-cookie` and no auth-adjacent header is present.
9. **Terminal output.** Every command block in `docs/15` is re-typed or reviewed line by line, never a
   raw scrollback paste (scrollback carries shell prompts, directory paths, and prior commands).
10. **Staged-diff sweep.** Run against the **staged** set, after `git add` and before writing the diff
    (§11.3). Report matches, never print values:
    ```bash
    git diff --cached | grep -nEi \
      'postgres(ql)?://|sslmode=|DATABASE_URL=|sk-[A-Za-z0-9]|ANTHROPIC_API_KEY|VOYAGE_API_KEY|Bearer |Authorization:|-----BEGIN|npg_|Set-Cookie|@neon\.tech|\.render\.com/[a-z0-9]{8}'
    ```
    Repeat over `docs/15-live-demo-evidence.md` alone. Any hit is triaged before the diff is written.
11. **Staging hygiene.** After `git add` and before writing the diff, confirm via `git diff --cached --stat`
    that **none** of the following appears:
    ```text
    docs/reviews/17-live-demo-evidence-plan.md
    pr5d-final-review.diff
    pr5d-final-review-summary.txt
    ```
    plus no `.env`, no `*_original`, no `.DS_Store`, and no earlier PR's review artifacts. `render.yaml`
    appears **only** if §7.5's comment-only change was made.

---

## 10. File-by-file implementation plan

### 10.1 Create

| Path | Committed? | Notes |
|---|---|---|
| `docs/15-live-demo-evidence.md` | ✅ | Structure per §6 |
| `docs/assets/live-demo/normal-run-not-eligible.png` | ✅ | |
| `docs/assets/live-demo/pending-approval-desktop.png` | ✅ | |
| `docs/assets/live-demo/approved-decision.png` | ✅ | Run ID must be legible — B8 reads it back |
| `docs/assets/live-demo/rejected-decision.png` | ✅ | |
| `docs/assets/live-demo/pending-approval-mobile.png` | ✅ | |
| `docs/assets/live-demo/render-deployment-status.png` | ✅ | Owner-captured; dropped if it cannot be cropped safely (§4.3) |
| `docs/reviews/17-live-demo-evidence-plan.md` | ❌ | This document — review artifact, never staged |
| `pr5d-final-review.diff` | ❌ | Already covered by `.dockerignore` `/*.diff` |
| `pr5d-final-review-summary.txt` | ❌ | Already covered by `.dockerignore` `/*-review-summary.txt` |

**Not created:** `persistence-after-refresh.png` — withdrawn (§4.2).

### 10.2 Modify

| Path | Change | Conditional? |
|---|---|---|
| `README.md` | Deployment section per §7.1 | No |
| `docs/08-cicd-deployment.md` | Status table, scope note, §16, §17 wording, §24, new §25 per §7.2 | No |
| `docs/14-web-ui.md` | §8.4, §8.7, §11 (and §9 if R6 passed, §8.8 optionally) per §7.3 | No |
| `render.yaml` | **Comment lines only** per §7.5 — no YAML value changes, no behavior change | **Yes** — include in staging only if actually changed |
| `docs/10-engineering-challenges.md` | Challenge 9 + version/revision-note bump per §7.4 | **Yes** — only if justified |

### 10.3 Leave untouched — confirmed

| Area | Confirmation |
|---|---|
| `apps/api/**`, `apps/web/**`, `apps/worker/**` | No code change is required for any check in §3. F9 (no SHA endpoint) and F20 (no router) are the two temptations, and both are refused (§1.2). |
| `packages/**`, including all Prisma schema and migrations | No schema or contract change; `db:migrate:drift` must stay clean. |
| `scripts/**`, `evals/**`, `runbooks/**` | Unrelated. |
| Tests | Nothing behavioral changes, so no test can meaningfully change. A documentation PR that edits tests is a red flag. |
| `Dockerfile`, `docker/`, `.dockerignore`, `docker-compose.yml` | `docs` is already excluded (F12); no image change is needed or wanted. |
| `.github/workflows/ci.yml` | CI is green and unchanged. |
| `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.nvmrc` | No dependency change. |
| `.gitignore` | Verified unnecessary (F13). |
| `.env.example` | No new variable. |

> `render.yaml` is **no longer** in this list — it moved to §10.2 as a comment-only change (§7.5).

---

## 11. Verification and review strategy

### 11.1 Live / manual verification

Everything in §3 (platform, browser flows, responsive/accessibility), §4 (screenshots), and §5
(cold/warm, three idle cycles). Results are recorded in `docs/15` §5 **whether they pass or fail**.

### 11.2 Repository checks

```bash
git diff --check
pnpm db:generate
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @opspilot/web run check:bundle
pnpm test:integration:sequential     # needs local Postgres: pnpm infra:up && pnpm db:migrate:test
pnpm db:migrate:drift
```

**Is the full suite necessary for a documentation-only change?** Strictly, no — the change set is
Markdown, PNGs, and one YAML comment (§10), and `docs/` is outside the Docker build context (F12), so
none of these checks can regress. Run them anyway, **once**, before generating the review artifacts, for
two reasons: CI runs all three jobs on the PR regardless, so a local failure is cheaper to find than a
red PR; and `render.yaml`'s `checksPass` means a red CI run **blocks the deploy** that the merged
documentation describes.

`git diff --check` (and its staged form below) is the one genuinely load-bearing check for this PR — it
catches whitespace damage in heavily edited Markdown.

**Rerun condition:** only if a verification failure forces a source change — which, per §1.3, moves
that fix out of PR 5D into its own reviewed PR, at which point the suite runs there instead.

### 11.3 Review artifacts — staged workflow

`git diff main...HEAD` is **wrong here** and must not be used: before the commit exists it compares
committed history only, so it silently excludes every working-tree edit and — critically — every
untracked screenshot. It would produce a review diff that omits the entire evidence set.

Stage the intended change set explicitly, diff the index, then unstage:

```bash
git add \
  README.md \
  docs/08-cicd-deployment.md \
  docs/14-web-ui.md \
  docs/15-live-demo-evidence.md \
  docs/assets/live-demo/*.png

# Conditionally — only if these files were genuinely changed:
git add docs/10-engineering-challenges.md      # only if Challenge 9 was justified (§7.4)
git add render.yaml                            # only if the comment was updated (§7.5)

git diff --cached --check                      # whitespace damage, on exactly what will be committed
git diff --cached --binary > pr5d-final-review.diff
git diff --cached --stat                       # human-readable inventory; verify the exclusion list
git reset                                      # unstage; the real commit happens afterwards
```

`--binary` is required so the PNGs are represented rather than reduced to a `Binary files differ`
placeholder. `--stat` is the readable inventory a reviewer scans first, and it is where §9.11's
exclusion check is performed.

Explicitly verify these are **not** in `git diff --cached --stat`:

```text
docs/reviews/17-live-demo-evidence-plan.md
pr5d-final-review.diff
pr5d-final-review-summary.txt
```

Run §9's privacy sweep against the staged set **before** `git reset` — that is the only point at which
the exact commit contents are inspectable.

Then write `pr5d-final-review-summary.txt` covering: what was verified live and when; the deployed SHA
and how it was confirmed; every claim corrected, quoting the old text; the evidence set; the cold/warm
observations across the three cycles with their uncertainty; every check that failed or was downgraded;
whether `render.yaml`'s comment was touched and proof the diff is comment-only; and the privacy
checklist result. Neither artifact is committed (§10.1).

Because the diff is binary-heavy and the PNGs are not human-readable in it, the summary must list the
images and their captions in text so a reviewer can assess the evidence set without opening the diff.

---

## 12. Execution order

| # | Step | Blocking on |
|---|---|---|
| 0 | Confirm PR 5C merged and `main` synced | **Already verified** (F1) — `docs/live-demo-evidence` is at `origin/main` = `00522bd` |
| 1 | **Cycle A** — confirm idle in Render, then cold `/v1/health/live` (+ immediate `ready`) | Owner confirms idle |
| 2 | **Cycle B** — wait for spin-down, confirm idle, then cold root page load | Owner confirms idle |
| 3 | **Cycle C step 1** — while warm, `POST /v1/agent-jobs`, record `jobId` | Step 2 |
| 4 | **Cycle C steps 2–4** — wait for spin-down, confirm idle, then cold `POST /v1/agent-jobs/<jobId>/runs` | Owner confirms idle |
| 5 | Warm observations W1–W4 | Step 4 |
| 6 | Confirm Render status + deployed SHA (P5, P6); cross-check with `git`/`gh` | Owner |
| 7 | Platform checks P1–P4 (including the three `/V1` checks) | Step 5 |
| 8 | Browser walkthrough B1–B6 + the five product screenshots; **record B5's Run ID** | Step 7 |
| 9 | B7 (refresh observation) and **B8** (API persistence proof, twice, second time from a clean shell); then P7 summary | Step 8 |
| 10 | Responsive/accessibility R1–R8 | Step 8 |
| 11 | Owner captures and crops `render-deployment-status.png` | Step 6 |
| 12 | Draft `docs/15-live-demo-evidence.md` | Steps 1–11 |
| 13 | Update `README.md`, `docs/08`, `docs/14`; `render.yaml` comment (§7.5); decide on `docs/10` | Step 12 |
| 14 | Stage the change set (§11.3 `git add`) | Step 13 |
| 15 | Secret and privacy review (§9) **against the staged set** | Step 14 |
| 16 | `git diff --cached --check`, write `pr5d-final-review.diff`, inspect `--stat`, `git reset` | Step 15 |
| 17 | Repository checks (§11.2) | Step 16 |
| 18 | Write `pr5d-final-review-summary.txt`; commit, push, open PR referencing issue **#25** | Step 17 |

Steps 1, 2, and 4 each consume an idle cycle and are irreversible per cycle. Everything else is
repeatable. The three cold cycles are the schedule-driving constraint — plan for roughly 20–30 minutes
of idle between each.

---

## 13. Acceptance criteria

From issue #25:

- [ ] PR 5C is merged and the live deployment contains that commit.
- [ ] Root page, liveness, readiness, and same-origin API are verified.
- [ ] Normal, pending, approved, and rejected live flows are verified.
- [ ] Approval persistence is verified — **through the public API, from a clean session** (B8), with
      the browser-refresh limitation recorded honestly (B7).
- [ ] Desktop, breakpoint, mobile, keyboard, focus, and reduced-motion behavior are verified.
- [ ] Screenshots contain no secrets or private account data.
- [ ] Cold-start and warm behavior are measured and described as observations, not an SLA.
- [ ] `docs/15-live-demo-evidence.md` exists with the public URL, deployed SHA, evidence, limitations,
      and demo script.
- [ ] README and deployment/UI docs link to the evidence document without duplicating it excessively.
- [ ] The FAKE-only, no-browser-RAG, and no-action-execution limitations are explicit.
- [ ] No backend feature, authentication, historical-run list, or real provider integration is added.
- [ ] CI remains green.
- [ ] Final review artifacts exclude secrets and untracked planning files.

Added by this plan:

- [ ] Health endpoints are documented at their **real** paths, `/v1/health/live` and
      `/v1/health/ready` (F3) — not `/health/*`.
- [ ] The case-insensitive `/V1` boundary is verified in production: `/V1/health/live` → API JSON 200,
      `/V1/nope` → API JSON error, `/V1abc` → SPA shell (P4).
- [ ] **Readiness is never described as proving Neon or proving persistence.** Reachability (P3),
      vendor attribution (configuration, F10), and application-data persistence (B8) are three
      separate claims, worded distinctly in `docs/15` §4/§7, the claim matrix, and P7.
- [ ] The absence of a historical-run browser is recorded as an explicit limitation in `docs/15` §9,
      and no artifact claims a browser refresh restores a prior run.
- [ ] Cold-start uses **three distinct, individually idle-confirmed cycles** (§5.3); vendor-stated
      free-tier figures remain separate from measured observations.
- [ ] Both §5.1 statements appear verbatim in `docs/15` §8, and no observation claims idle state that
      was not confirmed in Render.
- [ ] Every stale claim C1–C11 in §2.3 is corrected, and none is corrected by deletion alone where a
      revised, still-honest statement is possible.
- [ ] `docs/14`'s three "not yet performed" manual-verification admissions (C8–C10) are closed with
      what was actually observed, in whichever direction.
- [ ] Any check that failed is recorded as an observed limitation, not omitted.
- [ ] The deployed-SHA-versus-auto-deploy caveat (§2.4) appears in `docs/15`.
- [ ] `render.yaml`'s diff, if present, contains **only** comment lines — verified with
      `git diff --cached render.yaml`.
- [ ] All source, tests, workflow, and container files are untouched (§10.3).
- [ ] The review diff is produced from the **staged index** with `--binary`, not `git diff main...HEAD`.
- [ ] `docs/reviews/17-live-demo-evidence-plan.md` is **not** staged or committed.
- [ ] Image metadata is stripped with `-overwrite_original`, and
      `find docs/assets/live-demo -name '*_original'` produces no output.
- [ ] `docs/10` gains a new challenge only if one is genuinely justified (§7.4).

---

## 14. Risks and alternatives

| Question | Decision | Reasoning |
|---|---|---|
| Screenshots vs short video/GIF | **Screenshots** | Reviewable frame by frame before commit, diffable in review, no autoplay in a README, and — decisively — a GIF cannot be sanitized after the fact. A single stray frame showing a dashboard or another tab is unrecoverable. Screenshots also survive as portfolio evidence in contexts where video does not render. |
| Browser chrome vs content-only | **Content-only** for product shots | Chrome conveys nothing about the product and is the largest accidental-disclosure surface. The one exception is the Render crop, which is a dashboard row by nature. |
| Render dashboard evidence vs commit-SHA evidence | **Both** (owner's decision) | The screenshot is credible to a non-engineer; the written SHA plus `git`/`gh` confirmation is verifiable by an engineer and survives if the image is ever dropped for privacy reasons. |
| **Persistence: browser screenshot vs API output** | **API output** (B8) | Not a preference — the browser path does not exist (F20). But even if it did, two `curl` commands any reader can re-run are stronger evidence than a picture, and they demonstrate the stricter property: a client that never made the decision reads it back with no shared state. |
| Neon dashboard vs written proof | **Written only** | Reachability is P3, durability is B8, and vendor attribution is configuration. A dashboard screenshot proves a database exists in an account — not that this deployment's data survives — while adding project, region, compute, and billing exposure. |
| Cold start: one cycle vs three | **Three distinct idle cycles** (§5.3) | One cycle yields exactly one cold number, because the measuring request is the wake-up. Deferring the choice to execution time was the original plan's weakest point: it would have produced either three mislabelled "cold" numbers or an ad-hoc decision under time pressure. Three cycles cost roughly an hour of waiting and are unambiguous. |
| Cold start: n=1 per cycle vs repeated | **n=1 cold per cycle, n=3 warm**, uncertainty stated | Each additional genuinely-cold sample costs another 20–30 minute idle cycle. The honest framing ("n=1, free tier, this date, this network") is worth more than a slightly tighter range that would still not be a benchmark. |
| Many embedded screenshots vs a linked gallery | **Five product images embedded inline in `docs/15`, in walkthrough order** | The document *is* the gallery; a separate gallery page would split evidence from the claims it supports. The README links to `docs/15` rather than embedding anything, keeping the front page short. |
| `render.yaml` comment: fix here vs separate PR | **Fix here, comment-only** | Merging PR 5D redeploys regardless (§2.4), so the fix costs no extra deploy cycle. A separate PR would cost one, plus review overhead, to change a comment. The strict comment-only rule and the `git diff --cached render.yaml` check keep the blast radius at zero. |
| "AI agent" vs "AI-agent-style workflow" | **"AI-agent-style workflow"**, everywhere | The orchestration is deterministic and bounded, the provider is fake in the deployed path, and nothing executes autonomously. "AI agent" implies autonomy this system deliberately does not have — and the gap would be found in the first technical interview question. The weaker claim is the stronger position. |

**Residual risks**

1. **The merge moves the SHA** (§2.4) — handled by explicit wording, not by pretending.
2. **A cold start mid-capture** — retry and note it; it is honest evidence about a free tier.
3. **Idle state cannot be confirmed** for one of the three cycles — label that observation *assumed
   idle* and say so; do not upgrade it (§5.1).
4. **A live check fails** — §1.3 governs: record it, open a separate issue, do not fix inline.
5. **Screenshots go stale** as the UI evolves — mitigated by dating every image in `docs/15`'s header
   and by the verified-commit statement.
6. **A `render.yaml` edit slips beyond comments** — caught by the `git diff --cached render.yaml`
   check in §7.5; the remedy is to revert the file and drop that change entirely.
7. **The three cold cycles stretch the session** — roughly an hour of waiting. Accepted; the
   alternative is mislabelled data.

---

## 15. Owner inputs

All previously open inputs are resolved. Recorded here for the execution session:

| Input | Resolution | How |
|---|---|---|
| GitHub issue number | **#25** | Found via `gh issue list` — no owner input needed |
| PR 5C merged and `main` synced | **Confirmed** — `docs/live-demo-evidence` is at `origin/main` = `00522bd` | `git rev-list --left-right --count` — no owner input needed |
| Deployed commit SHA | Not resolvable from the service (F9); comes from the Render dashboard at execution time | Owner, step 6 |
| Who captures the evidence | **Split** — Claude drives Chrome for the five product screenshots; the owner captures and crops the Render deploy row | Owner decision |
| Run/job/ticket IDs in public screenshots | **Remain visible** — demo-data UUIDs, and the Run ID in `approved-decision.png` is the one B8 reads back | Owner decision |
| Deploy evidence form | **Both** — cropped Render screenshot and written SHA with `git`/`gh` confirmation | Owner decision |
| Demo script audience | **Both, clearly separated** — a ~2-minute non-engineer track and an engineer track | Owner decision |

Owner actions required **during execution**, not before it:

1. **Confirm idle state in Render three separate times** — immediately before Cycle A (step 1), Cycle B
   (step 2), and Cycle C's cold request (step 4). Each confirmation determines whether that observation
   is labelled *known idle* or *assumed idle* (§5.1). This is the single most schedule-sensitive input.
2. Capture and crop `render-deployment-status.png`, and read off the deployed commit SHA (step 6/11).

Nothing is blocked.
