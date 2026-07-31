# Evidence — LIVE Claude smoke: `REPORT_SCHEMA_INVALID`

## Sanitized production evidence

```text
Deployed commit SHA:  2bc96bdc27588bfdd93cc7ad7e28d03f64afd2ff  (main, PR #31 merge)
UTC timestamp:        not captured by the sanitized excerpt this investigation started from
Provider mode:        LIVE
Model:                 claude-sonnet-5
Status:                FAILED
Failure code:          REPORT_SCHEMA_INVALID
Message:               The submitted resolution report failed schema validation.
Duration:              48s
Estimated cost:        $0.01976
Trace:
  1. get_service_status requested
  2. get_service_status completed
Suggested actions:     0 (no report was persisted; this reflects the failed-run default, not a field Claude actually returned)
Approval:               not eligible

Ticket ID:  DEMO-317995fa-788f-49db-8a13-6aae02480899
Job ID:     fe9b1157-3206-4e98-981b-a2c815d1545b
Run ID:     6d4a00b6-7127-4ffe-b7f4-21d1c448d201
```

No raw provider request/response, secret, or idempotency key is reproduced anywhere in this
document or in the fix. The exact Zod issue paths/codes for this specific historical run were not
recoverable: before this fix, nothing captured them (see "Why existing tests missed it" below) —
which is itself part of what this fix closes for future occurrences.

## Root cause

**Expected shape:** A `ResolutionReport` satisfying `ResolutionReportSchema`
(`packages/contracts/src/resolution-report.ts`) — a strict object with bounded string lengths
(`summary` ≤ 1000, `rootCause` ≤ 1500, `customerImpact` ≤ 1000, `recommendedResolution` ≤ 2000),
`confidence` as a 0–1 fraction, `evidence` with 1–10 entries, and `suggestedActions` with 0–3
entries from a closed discriminated union.

**Actual structural shape:** The `submit_resolution_report` tool Claude calls is built from the
same Zod schema via `toStrictInputSchema` (`packages/provider-claude/src/claude-tool-schemas.ts`),
but Anthropic's strict-tool-use JSON Schema subset rejects numeric/length/count constraints
outright, so `stripUnsupported` unconditionally deletes `minLength`, `maxLength`, `minimum`,
`maximum`, `maxItems` (and `minItems` above 1) before the schema ever reaches the model. Zod still
enforces the real bounds downstream. So the object Claude returns can be structurally
well-formed — right keys, right types, right enum values — while still violating a bound nothing
in the schema *or* the prompt ever told it about: `confidence` given as a 0–100 percentage instead
of a 0–1 fraction, more than 10 evidence entries, more than 3 suggested actions, or a field beyond
its length cap. Any of those produces exactly this failure: a normal tool trace (`get_service_status`
only), a well-typed but bound-violating `submit_resolution_report` call, `REPORT_SCHEMA_INVALID`,
no report persisted.

**Why existing tests missed it:** Every fixture that exercises `REPORT_SCHEMA_INVALID`
(`resolution-report.test.ts`, `agent-orchestrator.test.ts`, `claude-orchestrator.integration.test.ts`,
`protocol-and-failure-cases.ts`) used a hand-authored `rawInput` that is either fully valid or
missing required fields outright — none constructed a structurally complete, correctly-typed report
that merely exceeds a numeric/length/count bound. The FAKE provider
(`fake-llm-provider.ts`) echoes whatever scripted `rawInput` a fixture author wrote, which by
construction always satisfies Zod, so this entire failure class is invisible under FAKE and only
reachable through a real model that was never told the bounds existed. This is the same shape of
gap `claude-message-mapping.ts`'s evidence-id prose already exists to close for a different field
(see the comment on `diagnostic_tool_result` mapping) — a live run is what surfaces a constraint the
JSON schema alone cannot carry.

**Fix:** State the full set of report bounds as explicit prose in the system prompt
(`REPORT_FIELD_BOUNDS`, appended to `BASE_SYSTEM_PROMPT` in
`packages/provider-claude/src/claude-message-mapping.ts`) — exact field lengths (including the
ones nested inside `evidence` entries and `suggestedActions` payloads), `confidence` as a 0–1
fraction (explicitly *not* a percentage), `evidence` 1–10, `suggestedActions` 0–3, and a compact
valid example — since this prose is the only remaining place these bounds can reach the model.
`ResolutionReportSchema` itself is unchanged: nothing was loosened, and no output that violates it
is accepted. Additionally, `agent-orchestrator.ts` now captures a sanitized diagnostic
(`summarizeReportValidationIssues`, `packages/contracts`) at the point of failure — validation issue
paths, codes, and expected/received *type names* only, never a value — surfaced through an optional
`onReportSchemaInvalid` hook on `AgentRunService.executeAndPersist`, logged by `apps/api` as one JSON
line (`report-validation-log.ts`) the same way `logProviderEvent` already logs provider telemetry.
This is what this incident lacked: without it, the exact issue that tripped Zod is unrecoverable
after the fact, as it was here.

**Follow-up correction (same fix, before commit):** an independent review flagged two gaps in the
first draft of this prose, both confirmed against the code before being applied: (1) the bounds were
appended only to the FINALIZATION-phase suffix, but `submit_resolution_report` is also offered as a
tool during INVESTIGATION (`claude-llm-provider.ts`'s `isInvestigation` tools array) — a voluntary
early submission never saw them; the bounds now live in `BASE_SYSTEM_PROMPT` itself, present on both
phases. (2) the nested length bounds inside `evidence[].evidenceId` and each `suggestedActions`
payload are stripped by `toStrictInputSchema` the same way the top-level ones are, but were not
originally restated; they now are. A separate review claim — that the adapter accepts free text or
JSON-in-prose as a successful report, and that top-level `additionalProperties` isn't enforced — did
not hold up against `claude-response-normalization.ts` and the existing exhaustive
`claude-tool-schemas.test.ts` coverage, and was not acted on.

**Non-interfering diagnostic hook (same review round, before commit):** a further finding was that
`AgentRunService.executeAndPersist` (`packages/agent-runtime/src/persistence/agent-run-service.ts`)
invoked `params.onReportSchemaInvalid` with no error boundary — a caller-supplied hook that threw
would propagate out of `executeAndPersist` before `finalize()` ran, leaving an already-known
terminal failure unpersisted and the row stuck `RUNNING`. Confirmed true by reading the call site.
The hook is now wrapped in its own `try`/`catch` inside `AgentRunService` itself (observability must
never be able to affect execution, persistence, accounting, or HTTP behavior); `apps/api`'s
`logReportValidationFailure` also swallows its own errors as defense in depth, but is not the
boundary of record.

**Historical root cause, stated honestly:** the pre-fix run did not capture safe Zod issue
paths/codes — that capture is exactly what this fix adds. The exact field and value that failed
validation on the original production run is therefore unknown and unrecoverable. What is proven,
from reading the code as it stood at that commit, is the root-cause *class*: the report violated at
least one constraint that `toStrictInputSchema` strips from the Claude-facing strict schema
(`minLength`/`maxLength`/`minimum`/`maximum`/`maxItems`), and Zod still enforced downstream. The
specific examples earlier in this document (confidence as a percentage, an over-count array, an
over-length field) are illustrations of that class, not a claim about which one the historical run
actually hit.

## Why the correction cannot hide malformed reports

- `ResolutionReportSchema` was not weakened, widened, or given new optional fields. A report that
  violates any bound still fails `safeParse` and still finalizes as `REPORT_SCHEMA_INVALID`.
- No envelope extraction, coercion, truncation, or default-value invention was added anywhere in the
  parse path. `agent-orchestrator.ts` still returns `parsedReport.data` verbatim on success and
  nothing on failure.
- No schema-repair retry and no second Claude call were added. `ANTHROPIC_MAX_RETRIES` stays `0`.
- The new diagnostic never carries a value: `summarizeReportValidationIssues` only reads `.path`,
  `.code`, this codebase's own static schema bound (`.minimum`/`.maximum`), and a derived
  `typeof`/`Array.isArray` type name — it never serializes `.input` or `.message` (see its tests for
  an explicit assertion that no offending value ever appears in the sanitized output).

## Test coverage added

- `packages/contracts/src/resolution-report-validation.test.ts` — `summarizeReportValidationIssues`
  against every relevant Zod issue code (`too_big`, `too_small`, `invalid_type`, `invalid_value`,
  `unrecognized_keys`), asserting the sanitized output never contains the offending value.
- `packages/agent-runtime/src/agent/agent-orchestrator.test.ts` — a structurally complete report
  that violates `confidence`'s bound (the production failure class) still fails
  `REPORT_SCHEMA_INVALID`, with the sanitized `reportValidationIssues` attached and no raw value
  present; the existing missing-fields case now also asserts on `reportValidationIssues`.
- `packages/agent-runtime/src/persistence/agent-run-service.test.ts` — `onReportSchemaInvalid` fires
  exactly once with the sanitized diagnostic, the run still finalizes and persists as
  `REPORT_SCHEMA_INVALID` normally, and the hook never fires for a different failure code.
- `packages/provider-claude/src/claude-llm-provider.test.ts` — both the INVESTIGATION and
  FINALIZATION prompts state every field bound (including the ones nested inside `evidence` entries
  and `suggestedActions` payloads), since `submit_resolution_report` is offered as a tool on both
  phases and a voluntary early submission must see them too; only FINALIZATION additionally carries
  the "call it now" forcing instruction. A markdown/prose-wrapped response is confirmed to normalize
  to `protocol_error`, never parsed as an embedded report — there is no markdown/JSON-in-prose
  extraction path anywhere in this codebase.
- `apps/api/src/execution/report-validation-log.test.ts` — the log line is valid JSON containing
  only the sanitized fields.
- `packages/agent-runtime/src/persistence/agent-run-service.test.ts` — a throwing
  `onReportSchemaInvalid` hook does not prevent `finalize()` from running: the run still persists as
  `REPORT_SCHEMA_INVALID` exactly once, LIVE usage/cost are still recorded, no second provider call
  happens, and the thrown error never reaches the caller (see "Non-interfering diagnostic hook"
  below).

## Focused verification

```text
pnpm --filter @opspilot/contracts run test        — 64 passed
pnpm --filter @opspilot/provider-claude run test   — 194 passed
pnpm --filter @opspilot/agent-runtime run test     — 217 passed
pnpm --filter @opspilot/api run test               — 528 passed
pnpm typecheck                                     — clean
git diff --check                                   — clean
```

## Confirmations

- Production LIVE remains disabled: `render.yaml` already declares `AGENT_RUN_PROVIDER_MODE=FAKE`,
  `LIVE_AGENT_RUNS_ENABLED=false`, `ANTHROPIC_MAX_RETRIES=0`; nothing in this fix touches those
  values.
- No second paid LIVE request was made during this investigation or fix.
- No secret, idempotency key, or raw provider request/response was logged, persisted, or committed.
- No automatic or schema-repair retry was added.
- Usage/cost accounting on a `REPORT_SCHEMA_INVALID` failure is unchanged — `finalize()` still
  persists whatever usage was observed regardless of the failure code.
