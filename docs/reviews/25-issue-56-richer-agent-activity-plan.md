# Issue #56 — Map Real Trace Data into Richer Agent Activity Presentation (narrow scope)

| | |
| --- | --- |
| Scope | #56 "Map real trace data into richer Agent Activity presentation" — **narrow scope only** (see Scope decision below) |
| Basis | `main` @ `e0610fb4968456847a0c072349357e9068acd937` (post-#69, the #55 merge), working tree clean |
| Status | Implemented and verified. `pnpm agent:verify --final` passes (typecheck/build clean; test suites pass except the same 4 pre-existing `apps/web` localStorage-environment failures confirmed present on unmodified `main` in #55's session — unrelated to this change). Independent Codex review (`pnpm agent:codex-review`) against the implementation diff: `READY_FOR_OWNER_REVIEW`, zero findings, after two implementation-time fix rounds (see §8). One controlled visual confirmation pass completed against a real running FAKE-mode investigation (§8) — looked correct, no action needed. Not yet committed, pushed, merged, or deployed — that decision is the owner's. No provider/LIVE request made. |
| Branch | `feat/56-richer-agent-activity` (created, empty) |
| Committed location | `docs/reviews/25-issue-56-richer-agent-activity-plan.md` |

---

## Scope decision (made before this plan, recorded here for the record)

Issue #56's own scope section states a preference order, not a single fixed design: *"Prefer expanding the product-facing mapping using data the runtime already emits. Add new runtime instrumentation only where real underlying data doesn't yet exist but is needed for a specific richer activity item."* Two materially different implementations both satisfy the issue's literal text:

- **Narrow**: Agent Activity (`TraceTimeline`) currently renders only the legacy 4-type `AgentTraceEvent` projection (`run.trace`) — `RETRIEVAL_COMPLETED`, `TOOL_REQUESTED`, `TOOL_COMPLETED`, `REPORT_GENERATED`. The backend has, since #36/#37, already been persisting and returning a much richer 12-type canonical lifecycle stream (`InvestigationEventRecord[]`, the `events` field on `InvestigationStateResponse`) that a *different* surface (the Investigation Progress Timeline's nested child rows) already renders — Agent Activity never adopted it. Migrating Agent Activity to consume this already-emitted, already-validated, already-persisted canonical stream (with a legacy fallback for pre-#37 runs) requires **zero new backend instrumentation, zero schema changes, zero new persistence** — purely a frontend presentation change consuming data that exists today.
- **Wide**: additionally instrument the diagnostic-tool call path to carry per-invocation structured facts (e.g. `get_service_status`'s `serviceSlug` input / `status` output) into the trace/investigation-event contract, so Agent Activity could render "notification-service is DEGRADED" instead of the generic "Checked service status." This requires a new additive schema field on the shared `TOOL_REQUESTED`/`TOOL_COMPLETED` event objects (the same objects `packages/contracts/src/investigation-event.ts` reuses byte-for-byte for the canonical write/read contract), a write/read-compatibility split for legacy rows, and — because today's tool catalog has exactly one entry and nothing structurally prevents a *future* tool's own input/output schema from carrying something less obviously safe to persist to a permanently public, anonymously-readable trace resource (`docs/14-web-ui.md`: this demo has no auth) — a new "how much structured tool data is safe to surface" boundary decision that #56 does not ask for.

**Decision (owner, this session): narrow scope.** Rationale: the narrow option alone is a substantial, directly-observable improvement (7 additional real lifecycle facts become visible: `RUN_CREATED`, `AGENT_STARTED`, `TOOL_FAILED`, `REPORT_GENERATION_STARTED`, `REPORT_SUBMITTED`, `REPORT_VALIDATION_FAILED`, `RUN_COMPLETED`/`RUN_FAILED` as closing lines — see §2.2) with no new safety surface, matches the issue's own explicitly stated preference ordering, and matches this repo's established pattern of deferring a "wide" data-exposure question to its own future issue rather than bundling it in (see `docs/reviews/24-issue-55-structured-evidence-plan.md`'s identical narrow/wide split). The tool-input/output enrichment is real and worth doing later — it is named explicitly in §5 (Out of scope) rather than silently dropped.

---

## 1. Current-state findings

| Area | File / symbol | What it does today |
| --- | --- | --- |
| Agent Activity component | `apps/web/src/components/TraceTimeline.tsx` | Renders `props.trace: readonly AgentTraceEvent[]` only — the legacy 4-type union. Computes a completed/running/neutral glyph per item and a Technical-details disclosure via `traceTechnicalEntries`. |
| Legacy label mapping | `apps/web/src/trace/trace-product-labels.ts` `presentTraceProductLabel` | Exhaustive-by-default-case switch over `AgentTraceEvent["type"]` (4 branches + unknown fallback). Owns Agent Activity's narrative voice: present-continuous/past-tense phrasing ("Checking service status" / "Checked service status"), never the raw type as primary copy. |
| Canonical event source (unused by Agent Activity) | `packages/contracts/src/investigation-event.ts` `InvestigationEventRecordPayload` | 12 write-eligible canonical types + `REPORT_GENERATED` legacy read-compat = 13 total. Already persisted incrementally per event (#37), reducer-validated (#36), and returned to the browser today as `InvestigationStateResponse.events` (`GET /v1/agent-jobs/:jobId/investigation`) — completely unused by `TraceTimeline`/Agent Activity. |
| Canonical label mapping (exists, wrong surface) | `apps/web/src/investigation-progress/investigation-event-labels.ts` `formatInvestigationEventLabel` | Already an exhaustive switch over all 13 canonical/legacy types, including `TOOL_FAILED` ("Tool failed: Get service status"). Used ONLY to label nested rows under the Investigation *Progress* Timeline's 4 canonical stage rows — a more literal, non-Agent-Activity voice ("Tool requested: X" vs Agent Activity's "Checking service status"). Not reusable verbatim without a tone/voice regression for the 4 types Agent Activity already covers. |
| Canonical-vs-legacy origin detection | `packages/contracts/src/investigation-lifecycle-compatibility.ts` `hasCanonicalInvestigationLifecycleMarker` | Already the established, tested, single source of truth for "is this event stream canonical (#37+) or legacy (pre-#37)?" — used today by `apps/web/src/investigation-progress/execution-stage-derivation.ts` to route Progress Timeline rendering. The exact same dual-path pattern this plan reuses for Agent Activity. |
| Legacy trace projection | `packages/contracts/src/investigation-lifecycle-compatibility.ts` `projectToLegacyAgentTraceEvent` | Deliberately drops `TOOL_FAILED` (documented as "would break `TraceTimeline`'s exhaustive switch" — see `docs/16-investigation-event-contract.md` §7). This function backs the persisted `run.trace` field for *every* consumer that still reads it (the legacy `GET /v1/agent-runs/:runId` detail endpoint, i.e. App.tsx's manual Refresh). This plan does not touch it — Agent Activity moves to reading `events` directly instead of routing through this projection, so `TOOL_FAILED`'s exclusion here becomes irrelevant to Agent Activity without changing this function's documented legacy contract. |
| App-level event state | `apps/web/src/App.tsx` | `events`/`eventsRef` (canonical `InvestigationEventRecord[]`) is already first-class app state, kept in sync across every mutation path (submit, retry, poll, resume, terminal-settlement authoritative read) via `setEventsSynced`/`applyObservedRunOutcome`. `run.trace` (legacy) is a *separate* field on the same `AgentRunDetail`/`InvestigationStateResponse` shapes, also kept in sync, but currently the only one `TraceTimeline` reads. |
| One known gap in the sync above | `apps/web/src/App.tsx`'s manual "Refresh" while `outcome.type === "RUNNING"` observes `RUNNING → RUNNING` | Restarts polling but does not itself refresh `events` (the legacy `getAgentRun` response it read from carries no canonical `events[]` — see the existing Finding-2 code comment at that call site). `events` catches up on the next poll tick (≤5s later per `healthyInterval`). A transient, self-healing staleness window — see §3. |
| Only diagnostic tool today | `packages/agent-runtime/src/tools/diagnostic-tool-catalog.ts` | Exactly one entry (`get_service_status`). Its allowlisted display name already exists in two places (`TOOL_PRODUCT_ACTIONS` in trace-product-labels.ts, `KNOWN_TOOL_DISPLAY_NAMES` in investigation-event-labels.ts) — both keyed by `toolName`, both degrade safely for an unknown tool. No change needed to either allowlist's *shape*, only to which canonical types the Agent-Activity-side one covers. |

---

## 2. Design

### 2.1 `TraceTimeline` switches its data source, not its data shape contract

`TraceTimeline` gains a second, optional prop carrying the already-computed `executionStageDerivation: ExecutionStageDerivation` (the same reducer-validated React state `App.tsx` already computes and holds for the Progress Timeline — see `apps/web/src/investigation-progress/execution-stage-derivation.ts` and `App.tsx`'s `deriveInvestigationProgressStages` call site), alongside its existing `trace` prop and the raw `events: readonly InvestigationEventRecord[]`.

**Correction from independent review (initial Codex pass, MAJOR):** the original draft branched on `hasCanonicalInvestigationLifecycleMarker(events)` alone. That marker only proves *origin* (was this stream written in canonical format), never *validity* — a marker-bearing stream the reducer has rejected (`canonical-invalid`, e.g. a `RUNNING` stream with `RETRIEVAL_COMPLETED` before `TOOL_REQUESTED` has even fired, or any other reducer-rejected ordering) would still have passed the marker check and been rendered as trusted activity, exactly the failure mode the Progress Timeline's `canonical-invalid` branch was built to prevent. Branching on `executionStageDerivation.kind` instead reuses the *already-validated* classification — no new validation logic, no second reducer call, and Agent Activity now fails closed exactly the way the Progress Timeline already does for the same corrupt input:

```ts
switch (executionStageDerivation.kind) {
  case "canonical":
    // Reducer-confirmed valid — render every applicable canonical event.
    activityItems = events.map(toActivityItem);
    break;
  case "canonical-invalid":
    // Fail closed: the stream is marker-bearing but reducer-rejected.
    // Never fall back to `trace` (a canonical writer never populates the
    // legacy `trace` field in parallel — falling back would silently
    // fabricate a plausible-looking legacy timeline for corrupt data,
    // which is the exact anti-pattern docs/16 §6 already rejects for the
    // Progress Timeline). Render an explicit "detail unavailable" state.
    activityItems = null;
    break;
  case "legacy":
    // No canonical stream at all (pre-#37 run, or none started yet).
    activityItems = trace.map(toActivityItem);
    break;
}
```

`props.trace` stays required (never removed) so every pre-#37 legacy run renders exactly as it does today — this is a strict superset of current behavior for the `legacy` and `canonical` cases, plus a new, honest "unavailable" state for `canonical-invalid` that has no prior equivalent (there was nothing to be wrong about before this issue).

The `canonical-invalid` unavailable state uses its own distinct copy ("Agent activity detail isn't available for this run right now."), not the Progress Timeline's identical string.

**Correction found during implementation (not caught by the plan-only Codex review — see the implementation note below).** The plan originally proposed reusing the Progress Timeline's exact wording verbatim. Doing so broke two existing tests (`App.canonical-invalid-policy.test.tsx`, `App.refresh-terminal-canonical.test.tsx`) that each assert on that exact string being present/absent for the *Progress Timeline's own* note — with Agent Activity now rendering byte-identical text on the same page, `screen.getByText(...)` started matching two elements (or the wrong one) instead of one. Beyond the test collision, reusing the string was also the wrong design independent of that: the two timelines are documented as deliberately separate surfaces with their own vocabularies (`docs/14-web-ui.md` §6.1), and the Progress Timeline's version specifically describes a `lastGoodStages`-dependent split behavior Agent Activity does not have (Agent Activity has no "frozen last-good events" concept — `ExecutionStageDerivation.canonical-invalid.lastGoodStages` holds only the 4 stage summaries, never raw investigation events). Distinct wording was the correct design even before the test collision surfaced it.

### 2.2 New presentation function, additive — `presentTraceProductLabel` is not modified

A new function, `presentInvestigationActivityLabel(payload: InvestigationEventRecordPayload): TraceProductLabel`, is added to `trace-product-labels.ts` as an **exhaustive switch with an `assertNever` default** (matching the established pattern in `investigation-lifecycle-compatibility.ts`'s own projection — a 14th future canonical type must fail to compile here until given an explicit choice, never silently fall through).

The 4 types Agent Activity already covers keep **byte-identical wording** by delegating to the existing per-type phrasing (no tone drift for what's already shipped):

| Canonical type | Agent Activity label | Basis |
| --- | --- | --- |
| `RUN_CREATED` | "Investigation created" | New — gives the log an opening line instead of starting mid-story |
| `AGENT_STARTED` | "Agent started analyzing the ticket" | New |
| `RETRIEVAL_COMPLETED` | (unchanged: "Runbook retrieval completed" + chunk-count detail) | Reused from `presentTraceProductLabel` |
| `TOOL_REQUESTED` | (unchanged: "Checking service status" / generic fallback) | Reused |
| `TOOL_COMPLETED` | (unchanged: "Checked service status" / generic fallback) | Reused |
| `TOOL_FAILED` | "Diagnostic tool failed" / "Checking service status — failed" for the grounded tool | New — previously invisible to Agent Activity entirely (silently dropped by the legacy projection) |
| `REPORT_GENERATION_STARTED` | "Preparing the final report" | New |
| `REPORT_SUBMITTED` | "Report submitted for validation" | New |
| `REPORT_VALIDATED` | (unchanged: "Resolution report generated") | Reused — `REPORT_VALIDATED` is documented as meaning exactly what legacy `REPORT_GENERATED` always meant |
| `REPORT_VALIDATION_FAILED` | "Report failed validation" | New |
| `RUN_COMPLETED` | "Investigation completed" | New — a closing narrative line; not redundant here the way it is on the Progress Timeline's stage rows, because Agent Activity is a chronological log, not a status widget |
| `RUN_FAILED` | "Investigation failed" | New — same closing-line rationale |
| `REPORT_GENERATED` (legacy read-compat) | (unchanged: "Resolution report generated") | Reused — only reachable via a legacy-format stream that still contains this literal type |

No raw failure code, tool name beyond the existing allowlist, or any other payload field is ever interpolated into a label — same safety posture `presentTraceProductLabel` already enforces (`docs/14-web-ui.md` §6.2's "never a raw payload dump" rule extends unchanged to the new function).

### 2.2a `traceItemStatus` must recognize `TOOL_FAILED`, not just `TOOL_COMPLETED`

**Correction from independent review (initial Codex pass, MAJOR):** `TraceTimeline.tsx`'s existing `traceItemStatus` resolves a `TOOL_REQUESTED` item to `"completed"` only when a later matching `TOOL_COMPLETED` exists for the same `toolCallId`; anything else — including a real, persisted `TOOL_FAILED` for that exact call — leaves it at `"running"` (the blue in-flight dot) forever, even on a terminally `RUN_FAILED` investigation. This bug is pre-existing but was invisible until now: `TOOL_FAILED` was never rendered by Agent Activity before this issue, so its matching `TOOL_REQUESTED` never had a failure to fail to notice. Bringing `TOOL_FAILED` into Agent Activity's vocabulary (§2.2) surfaces the bug, so this issue must fix it, not just add the new label.

Fix: generalize the lookahead to also match a `TOOL_FAILED` with the same `toolCallId`, resolving to a new `"failed"` status (not `"completed"` — a failed tool call did not succeed, and not the existing `"running"`/`"neutral"` values, which would either keep lying about it being in-flight or say nothing at all about a real terminal fact). The same status function must also give every one of §2.2's 7 new canonical types its own intentional status, not the `default: "neutral"` fallback — leaving them at `default` would regress `REPORT_VALIDATED` from today's completed green check (via the legacy `REPORT_GENERATED` case) to a neutral dot, which is exactly the "strict superset" claim in §2.1/§3 this plan makes and must not violate. Full status table:

```ts
function traceItemStatus(events, index, event): TraceItemStatus {
  if (event.type === "TOOL_REQUESTED") {
    const callId = event.toolCallId;
    const later = events.slice(index + 1);
    if (later.some((e) => e.type === "TOOL_COMPLETED" && e.toolCallId === callId)) return "completed";
    if (later.some((e) => e.type === "TOOL_FAILED" && e.toolCallId === callId)) return "failed";
    return "running";
  }
  switch (event.type) {
    // Existing legacy-shared cases — unchanged.
    case "TOOL_COMPLETED":
    case "RETRIEVAL_COMPLETED":
    case "REPORT_GENERATED":       // legacy read-compat type
    // New canonical success facts — same "completed" treatment REPORT_GENERATED
    // already gets, since REPORT_VALIDATED means exactly what it always meant.
    case "REPORT_VALIDATED":
    case "RUN_COMPLETED":
      return "completed";
    // New canonical failure facts.
    case "TOOL_FAILED":
    case "REPORT_VALIDATION_FAILED":
    case "RUN_FAILED":
      return "failed";
    // New canonical in-progress/lifecycle facts with no completed/failed
    // outcome of their own yet (they are markers that something is
    // starting or underway) — the existing "neutral" dot is the honest
    // choice, not a fallback-by-omission: RUN_CREATED/AGENT_STARTED/
    // REPORT_GENERATION_STARTED/REPORT_SUBMITTED are intermediate facts a
    // terminal outcome always supersedes with one of the cases above.
    case "RUN_CREATED":
    case "AGENT_STARTED":
    case "REPORT_GENERATION_STARTED":
    case "REPORT_SUBMITTED":
      return "neutral";
    default:
      return "neutral";
  }
}
```

A new `"failed"` glyph (`✕`, matching the failed-state glyph already used elsewhere in this codebase, e.g. `presentInvestigationProgressStage`'s `danger`/`✕` pairing) is added to `TRACE_ITEM_GLYPH` alongside the existing three. This is a small, additive change to an existing function — not a rewrite of its matching logic, which stays otherwise unchanged (array-order lookahead, no timers, no invented state).

**Open question needing your confirmation, with a recommendation, not left as a bare choice:** exact copy for the 7 new lines above is a product-voice decision. I recommend the wording in the table (present-tense, matches the existing "Checking…/Checked…" register) — flag if you want different phrasing before implementation; this is a one-line change per label either way, not a structural one.

### 2.3 Technical details disclosure stays sourced from whichever stream is active

`traceTechnicalEntries` is generalized to accept either shape (both already carry `toolName`/`toolCallId` on their `TOOL_REQUESTED` variant) so the existing Technical-details behavior — one sanitized `toolName`/`toolCallId` row per tool request, never a raw payload — continues unchanged for both legacy and canonical runs.

---

## 3. Compatibility

- **Pre-#37 legacy runs** (`executionStageDerivation.kind === "legacy"`): `TraceTimeline` falls back to `trace`, rendering exactly today's 4-type output, unchanged. Every existing `TraceTimeline.test.tsx` case keeps passing unmodified — they all construct `AgentTraceEvent[]` fixtures and never pass `executionStageDerivation`/`events`, and the component's own default for an omitted derivation prop is `{ kind: "legacy" }`, matching `App.tsx`'s own established default for a fresh/unwired call site.
- **A canonical run before its first event exists** (`events: []`, derivation `legacy` — no origin evidence yet): same fallback, same empty-state message ("No trace events were recorded for this run.") as today.
- **The Refresh-while-RUNNING staleness window** (§1): after a manual Refresh observes `RUNNING → RUNNING`, `events`/`executionStageDerivation` can lag `trace` by up to one poll interval (≤5s). Accepted, not fixed here — it is self-healing on the very next tick, App.tsx's existing architecture (not this plan) owns that timing, and #56 is presentation-only. Noted so a future reviewer does not mistake it for a regression this plan introduces.
- **A `canonical-invalid` stream** (reducer rejects the events): fixed by §2.1's correction — Agent Activity now renders the same "detail isn't available" state the Progress Timeline already shows for this condition, rather than either fabricating a legacy-looking timeline (crossed out by the original marker-only design) or crashing on an unrecognized shape. Zero fabricated detail is rendered for genuinely corrupt data, matching this repo's fail-closed precedent (`docs/16-investigation-event-contract.md` §6).

---

## 4. Verification plan

| Case | Expected |
| --- | --- |
| `presentInvestigationActivityLabel` — each of the 13 canonical/legacy types | Exact label text per §2.2's table, never the raw `type` string as primary copy |
| `presentInvestigationActivityLabel` — the 4 overlapping types produce byte-identical text to `presentTraceProductLabel` | No tone drift between the two functions for shared cases |
| `presentInvestigationActivityLabel` — unknown tool name on `TOOL_REQUESTED`/`TOOL_COMPLETED`/`TOOL_FAILED` | Degrades to the existing generic phrasing, raw tool name never in the primary copy (mirrors the existing `presentTraceProductLabel` test) |
| `traceItemStatus` — a `TOOL_REQUESTED` with a later matching `TOOL_FAILED` | Resolves to `"failed"` (✕), never `"running"` or `"completed"` |
| `traceItemStatus` — a `TOOL_REQUESTED` with a later matching `TOOL_COMPLETED` | Unchanged: resolves to `"completed"` (regression guard) |
| `traceItemStatus` — full canonical status parity: `REPORT_VALIDATED`/`RUN_COMPLETED` vs. `REPORT_VALIDATION_FAILED`/`RUN_FAILED` vs. the 4 lifecycle-only types | `"completed"` / `"failed"` / `"neutral"` respectively — `REPORT_VALIDATED` in particular must match the legacy `REPORT_GENERATED` row's existing `"completed"` glyph exactly (regression guard for the strict-superset claim) |
| `TraceTimeline` — `executionStageDerivation.kind === "canonical"` | Renders all applicable canonical types in the richer vocabulary, in `sequence` order, including a visible `TOOL_FAILED` (this is the one case that was previously silently dropped) |
| `TraceTimeline` — `executionStageDerivation.kind === "canonical-invalid"` | Renders the "detail isn't available" message, zero canonical events rendered, does not fall back to `trace`, does not throw — including for a stream containing an unrecognized future discriminant |
| `TraceTimeline` — `executionStageDerivation.kind === "legacy"` (or the prop omitted) | Renders exactly as today (regression guard — existing test file should need zero edits) |
| `traceTechnicalEntries` — generalized input | Same sanitized rows for both legacy and canonical `TOOL_REQUESTED` shapes |

**What deterministic tests cannot prove, and the bounded way to close that gap:** whether the new copy actually *reads well* end-to-end in a real investigation narrative is a subjective UX judgment, not a schema/logic property — deterministic tests can only prove the mapping is exhaustive, safe, and byte-stable for the 4 reused cases. Recommendation: one visual pass on a real FAKE-mode run screenshot after implementation (no LIVE/provider call needed — this is presentation-only and touches no model-facing surface), not a new paid observation category.

---

## 5. Out of scope (explicit)

- **Tool input/output enrichment** (e.g. "notification-service is DEGRADED" instead of "Checked service status") — the rejected "wide" option from the Scope decision above. Real and worth a future issue once/if a second diagnostic tool or a concrete product need makes the generic phrasing feel insufficient; deliberately not bundled here.
- Any change to `projectToLegacyAgentTraceEvent`, `run.trace`'s legacy shape, or the `GET /v1/agent-runs/:runId` legacy detail endpoint's response.
- Any change to the Investigation *Progress* Timeline, its stage rows, or `investigation-event-labels.ts` (a separate, already-shipped surface with its own established voice — see `docs/14-web-ui.md` §6.1's "two timelines, deliberately not one").
- Wiring a real RAG retriever so `RETRIEVAL_COMPLETED` becomes reachable through `apps/api` (still documented as currently unreachable — unrelated to this issue).
- Any orchestrator, persistence, database, or contract-schema change. Every field this plan renders already exists, is already validated, and is already returned over the wire today.
- Any change to `AgentOrchestratorErrorCode`/`ToolFailureCode` failure-message text (`FAILURE_DISPLAY_MESSAGES` stays exactly as-is; `TOOL_FAILED`'s Agent Activity label names only that a tool failed, never the failure code or the ResultPanel's already-existing detailed failure text).

---

## 6. Sequencing

1. `trace-product-labels.ts`: add `presentInvestigationActivityLabel` + generalize `traceTechnicalEntries`'s input type. Unit tests first (TDD, per repo convention).
2. `TraceTimeline.tsx`: fix `traceItemStatus` to recognize `TOOL_FAILED` (§2.2a) first, with its own regression test, before adding the new derivation-based branching — this isolates the pre-existing bug fix from the new feature in the diff/history. Then accept the new `executionStageDerivation`/`events` props, branch on `executionStageDerivation.kind` (§2.1), and render via the new function on the `canonical` path. Component tests for all three derivation kinds plus the `TOOL_FAILED` status case.
3. `App.tsx`: pass `executionStageDerivation` (the existing React state already computed for the Progress Timeline — `apps/web/src/App.tsx`'s `deriveInvestigationProgressStages` call already consumes the identical value) and `events={events}` alongside the existing `trace={run.trace}` at the one `<TraceTimeline>` call site — no new state, only a new prop wire-up to state that already exists.
4. `docs/14-web-ui.md` §6.2: update to describe the dual-source behavior, the expanded vocabulary, and the `canonical-invalid` unavailable state, mirroring how §6.1 already documents the Progress Timeline's canonical/legacy/invalid split.
5. `pnpm agent:verify --focused`, then `--final` before review-bundle.
6. Re-run `agent:review-bundle` → `agent:codex-review` against the implementation diff (a second, code-level review — the plan-only review above does not substitute for it; see `CONTEXT.md`'s one-initial-plus-one-final review budget).

---

## 7. Acceptance criteria

Issue #56 (narrow scope) is complete only when all of the following are true:

1. Agent Activity renders every applicable canonical investigation-event type (not just the legacy 4) for any run whose stream is reducer-confirmed `canonical`, with no fabricated agent actions — every label traces to a real, validated persisted event.
2. `TOOL_FAILED` is visible in Agent Activity for the first time, with its matching `TOOL_REQUESTED` correctly resolving to a `"failed"` status (never `"running"` or `"completed"`) — without any change to `projectToLegacyAgentTraceEvent`'s documented legacy-projection behavior.
3. A pre-#37 legacy run, or a canonical run with an empty event stream, renders identically to today — zero regression, verified by the existing `TraceTimeline.test.tsx` suite passing unmodified.
4. A `canonical-invalid` (reducer-rejected) stream renders the same "detail isn't available" state the Progress Timeline already uses for this condition — never a fabricated legacy-looking timeline, and never a crash, including for a stream containing an unrecognized future discriminant.
5. The Technical details disclosure keeps working identically for both legacy and canonical `TOOL_REQUESTED` shapes.
6. No new runtime instrumentation, schema field, persisted column, or safety-surface question was introduced — every rendered fact already existed in `InvestigationStateResponse.events` before this issue.
7. `docs/14-web-ui.md` §6.2 reflects the new dual-source behavior, expanded vocabulary, and the `canonical-invalid` state.
8. Deterministic unit/component test coverage (§4's table) is green, and one visual confirmation pass on a real FAKE-mode run has been completed and its outcome recorded (even if "looked fine, no action needed").
9. A second, code-level independent review (`agent:review-bundle` → `agent:codex-review` against the implementation diff) has converged with no unresolved BLOCKER/MAJOR findings — this plan-level review is necessary but not sufficient on its own.

**Explicitly still out of scope** (unchanged from §5): tool input/output enrichment, any backend/orchestrator/schema change, RAG retriever wiring, and any change to the Investigation Progress Timeline.

---

## 8. Implementation notes (post-plan, real findings)

Recorded here per this repo's convention of tracking real discoveries made during implementation, not just what the plan predicted.

1. **Both independent-review MAJORs from the plan-only review were real** and are reflected in §2.1/§2.2a above as implemented: gating on `executionStageDerivation.kind` (not the origin-only marker) for the canonical-invalid fail-closed path, and fixing `traceItemStatus`'s pre-existing `TOOL_FAILED` blind spot.
2. **A second-pass plan-only MINOR** (every new canonical type needs an intentional status, not a `default: "neutral"` fallback) was fixed directly in the plan text before implementation — confirmed correctly implemented in `TraceTimeline.tsx`'s `canonicalTraceItemStatus`.
3. **A real regression, not caught by either plan-only Codex review, surfaced only once real component tests ran against the implementation:** reusing the Progress Timeline's exact `canonical-invalid` copy verbatim broke two existing tests (`App.canonical-invalid-policy.test.tsx`, `App.refresh-terminal-canonical.test.tsx`) that assert on that string for the *Progress Timeline's own* note — once Agent Activity started rendering byte-identical text on the same page, those assertions collided. Fixed by giving Agent Activity its own distinct copy ("Agent activity detail isn't available for this run right now."), which was the correct design independent of the test collision (see §2.1's inline correction note). This is the kind of gap a plan-only review — which sees prose/pseudocode, not a rendered DOM — cannot catch; it is exactly what running the real test suite against the implementation is for.
4. **A second-pass implementation-diff Codex review MINOR**, correct and fixed directly: the new `.trace-timeline-step--failed` class had no corresponding CSS rule, so the ✕ glyph inherited the default text color instead of the danger-red token every other failed-state indicator in this codebase uses. Fixed in `styles.css` using the existing `--color-danger-text` token, matching `.investigation-progress-node--failed`'s established pattern. Re-review after the fix returned `READY_FOR_OWNER_REVIEW`, zero findings.
5. **One controlled visual confirmation pass** was completed: a real FAKE-mode investigation was run end-to-end through a locally running `apps/api` (dev Postgres, `AGENT_RUN_PROVIDER_MODE=FAKE`) and `apps/web` dev server, driven through an actual browser. Result: all 7 canonical event types rendered with the correct product-language labels and glyphs (2 gray-dot lifecycle markers, 4 green-check completions including the new `RUN_COMPLETED`/`REPORT_SUBMITTED`/`REPORT_GENERATION_STARTED`-family labels, the existing `TOOL_REQUESTED`/`TOOL_COMPLETED` pair unchanged), and the Technical Details disclosure still showed the sanitized tool name/call-id row exactly as before. No fabricated or mismatched detail observed. (One unrelated false alarm during this pass — a stale local Vite dependency-cache artifact made an early screenshot show a `canonical-invalid` state — was diagnosed as a dev-server caching issue, not a product bug, by clearing `apps/web/node_modules/.vite` and reproducing clean; not a finding about this issue's code.)
