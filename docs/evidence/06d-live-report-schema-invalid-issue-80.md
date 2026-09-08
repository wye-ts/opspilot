# Evidence — Issue #80: LIVE `REPORT_SCHEMA_INVALID` on `suggestedActions`

## What Issue #80 speculated vs. what actually happened

Issue #80 was filed from an incidental log line
(`report_schema_invalid` with `issues: [{ path: ["suggestedActions"], code: "custom" }]`) that,
before this fix, carried no further detail — the persisted log collapsed every `custom`-coded Zod
issue on `ResolutionReportSchema` to `{ path, code: "custom" }` regardless of which of several
structurally-distinct invariants at that path actually failed. The issue's own "Problem" section
correctly identified this as ambiguous and named the disposition/cardinality rule
(`recommendationDisposition` vs. `suggestedActions` count, F1/F2 in
`packages/contracts/src/resolution-report.ts`) as the most likely candidate, while explicitly
flagging that the real cause was unrecoverable without a live capture.

**A real local LIVE reproduction (2026-09-07, same ticket summary the original incident used: "i
cannot send message to my client.") confirmed the actual cause is a DIFFERENT invariant at the
same kind of path** — not F1/F2, but the "groundedBy entries must each appear in report.evidence"
check (F5). The model is non-deterministic here: 1 of 3 identical-prompt local reproductions
succeeded outright; the other 2 both failed the same way.

## Sanitized reproduction evidence

```text
Local reproduction, 2026-09-07 (via `pnpm --filter @opspilot/api run build` +
node dist/main.js against local docker-compose Postgres)
Provider mode:  LIVE
Model:          claude-sonnet-5
Ticket summary: "i cannot send message to my client."
Failure code:   REPORT_SCHEMA_INVALID
Trace:          get_service_status x2 (both returned UNKNOWN), then report_submission
```

Captured raw report (via a temporary, uncommitted local debug log removed before this diff was
finalized — never present in the deployed path or any committed code):

```json
{
  "category": "UNKNOWN",
  "rootCause": null,
  "confidence": 0.2,
  "evidence": [],
  "suggestedActions": [
    {
      "type": "CREATE_ESCALATION",
      "payload": { "team": "Messaging Platform", "priority": "MEDIUM", "...": "..." },
      "groundedBy": [{ "evidenceId": "toolu_01FFurNRPQ45Z3v2FbdDkHXb", "sourceType": "TOOL_EXECUTION" }]
    },
    {
      "type": "DRAFT_CUSTOMER_REPLY",
      "payload": { "...": "..." },
      "groundedBy": [{ "evidenceId": "toolu_01FFurNRPQ45Z3v2FbdDkHXb", "sourceType": "TOOL_EXECUTION" }]
    }
  ],
  "evidenceState": "INSUFFICIENT",
  "recommendationDisposition": "ACTIONABLE"
}
```

Real Zod issues (captured the same way):

```json
[
  { "path": ["suggestedActions", 0, "groundedBy", 0], "code": "custom",
    "message": "suggestedActions[].groundedBy entries must each appear in report.evidence." },
  { "path": ["suggestedActions", 1, "groundedBy", 0], "code": "custom",
    "message": "suggestedActions[].groundedBy entries must each appear in report.evidence." }
]
```

## Root cause

The model treated the `get_service_status` tool call's UNKNOWN/inconclusive result as **not worth
listing in `evidence`** (a truthful zero-evidence `INSUFFICIENT` report, which the prompt
correctly teaches is valid), while **still citing its `toolu_...` id in two
`suggestedActions[].groundedBy` arrays** — because it wanted the escalation/reply actions to be
"grounded" in the fact that a status check came back inconclusive. Nothing in
`REPORT_FIELD_BOUNDS` (`packages/provider-claude/src/claude-message-mapping.ts`) told the model
these two things are mutually exclusive: `ResolutionReportSchema`'s own `applyReportEvidenceInvariants`
requires every `groundedBy` locator to already exist as a `report.evidence` entry, with no
exception for an inconclusive result. This is a genuine prompt-clarity gap, not a schema defect —
the schema's fail-closed behavior here is correct and was never the bug.

## Fix

1. **Prompt clarity** (`packages/provider-claude/src/claude-message-mapping.ts`,
   `REPORT_FIELD_BOUNDS`): states explicitly that an inconclusive/UNKNOWN tool result must still be
   listed as its own `evidence` entry (with `supports: []`) before it can be cited in any
   `suggestedActions[].groundedBy`, and that `evidence: []` is truthful ONLY when no diagnostic
   tool was called at all. Advances the logical prompt version to `opspilot-agent-v4`
   (`docs/03-technical-design.md`, `docs/04-agent-design.md` §20.4).
2. **Operator-facing diagnostic detail** (`packages/contracts/src/resolution-report-validation.ts`):
   `ReportValidationIssue` now carries an optional `message` field, populated ONLY for
   `code: "custom"`. Every `custom` issue on `ResolutionReportSchema`/`StoredResolutionReportSchema`
   is added via a fixed, hand-written literal in this package's own `superRefine` bodies — none
   interpolate report data — so surfacing it is safe under the same never-log-raw-value constraint
   the rest of the module enforces (every `addIssue` call site was read and confirmed before this
   change). This closes exactly the gap Issue #80 hit: before this fix, a `custom` failure at
   `suggestedActions[0].groundedBy[0]` was indistinguishable in the log from "duplicate locator"
   (F4), "empty groundedBy" (F3), or "cardinality mismatch" (F1/F2) — all four are now
   distinguishable from the persisted log line alone, with no live debug capture required.

## Why the fix cannot hide malformed reports

- `ResolutionReportSchema`'s invariants are unchanged — no bound was loosened, no exception was
  added for inconclusive tool results, no repair/normalization was introduced. A report that still
  cites an uncited locator continues to fail closed exactly as before.
- The new `message` field only ever carries this package's own fixed literal strings, never
  anything derived from the report Claude submitted — confirmed by reading every `addIssue` call
  site in `resolution-report.ts` and by a dedicated test
  (`resolution-report-validation.test.ts`) asserting no non-`custom` issue ever carries a
  `message`.
- No schema-repair retry, no second Claude call, no envelope extraction was added.

## Test coverage added

- `packages/contracts/src/resolution-report-validation.test.ts` — a dedicated regression test
  reproducing Issue #80's exact real failure shape (`evidence: []`, a `groundedBy` locator citing
  an uncited tool-call id) and asserting the sanitized message; a second test asserting no
  non-`custom` issue code ever carries `message`.
- `packages/contracts/src/resolution-report.test.ts` — every existing `custom`-code assertion
  (F1, F2, F4, F5, the impossible-hybrid G3 case) updated to assert the new `message` field.
- `packages/agent-runtime/src/agent/agent-orchestrator.test.ts` — a new end-to-end orchestrator
  test locking Issue #80's exact production report shape through `runAgentOrchestrator`, asserting
  both the failure code and the sanitized `reportValidationIssues` (including `message`).
- `packages/provider-claude/src/claude-llm-provider.test.ts` — a new test asserting the tightened
  `REPORT_FIELD_BOUNDS` prose is present on both INVESTIGATION and FINALIZATION phases.

## Focused verification

```text
pnpm --filter @opspilot/contracts run test        — 326 passed
pnpm --filter @opspilot/agent-runtime run test     — 371 passed
pnpm --filter @opspilot/provider-claude run test   — 236 passed
pnpm --filter @opspilot/api run test               — 644 passed
pnpm --filter @opspilot/worker run test            — 517 passed, 3 skipped
pnpm typecheck                                     — clean
pnpm run lint                                      — clean
pnpm run build                                     — clean
```

`apps/web`'s 4 known localStorage-environment test failures (documented in this repo's
`opspilot-development` skill) reproduce identically on unmodified `main` — confirmed via
`git stash` before writing this fix — and are unrelated to this change; `apps/web` is untouched by
this diff.

## Confirmations

- Two real, paid LIVE Anthropic calls were made during this investigation (one succeeded, one
  reproduced the bug); a third attempt hit `LIVE_RUN_BUDGET_EXHAUSTED` as expected. Local
  `live_run_budget` rows for the reproduction day were cleared afterward (local Postgres only,
  never production).
- The temporary debug capture (`console.error` behind an env-var-gated branch in
  `agent-orchestrator.ts`) was removed before this diff was finalized — `git status`/`git diff`
  confirmed zero leftover trace of it.
- No secret, idempotency key, or raw provider request/response is reproduced anywhere in this
  document or in the fix. The captured raw report above is reproduced with all evidence/action
  string fields either omitted or replaced with `"..."` beyond what is needed to show the
  structural shape.
- Production LIVE remains gated behind the existing `LIVE_AGENT_RUNS_ENABLED`/token-access
  controls; nothing in this fix touches those values.
