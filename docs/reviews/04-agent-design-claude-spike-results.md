# Claude Structured-Output Spike — Results

| Field | Value |
|---|---|
| Spike | `apps/worker/src/demo/run-claude-agent-spike.ts` (`pnpm --filter @opspilot/worker run spike:claude`) |
| Related design | `docs/04-agent-design.md` §22 (Live Claude Adapter), §28 (Open Implementation Questions) |
| Status | Run 2 complete (2026-07-17) — both scenarios passed after the evidence-citation fix |
| Decision | **ADOPT** (see Decision section — based on two live runs; see Limitations) |
| Model (Run 2) | `claude-sonnet-5` |

## Goal

Prove that a live Claude model, driven only through the official
`@anthropic-ai/sdk` (no Claude Agent SDK), can satisfy OpsPilot's existing
provider-neutral contracts (`LlmProvider`, `AgentTurnResult`,
`ResolutionReportSchema`, evidence-grounding validation) for:

1. Ticket context → Claude requests exactly one diagnostic tool → the
   existing `AgentOrchestrator` validates and executes it → the tool result
   is sent back to Claude → Claude submits `submit_resolution_report` →
   the existing report schema and evidence-grounding validation succeed.
2. A standalone forced-finalization call where only `submit_resolution_report`
   is available and explicitly selected via `tool_choice`.

This record is filled in after running the spike script against a real
`ANTHROPIC_API_KEY`; it cannot be completed by static analysis or by an
automated test run alone (see "no reliability claims from one live run" in
the spike's explicit scope limits).

## Measured observations

Run the spike multiple times before drawing conclusions — a single run is
not a reliability claim.

| Run | Model | Scenario | Outcome | Latency (ms) | Input tokens | Output tokens | Estimated cost (USD) | Tool selected correctly? | Report passed schema validation? | Report passed evidence-grounding? | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 (2026-07-17, initial) | `<TBD>` | tool-then-report | FAILED — `REPORT_EVIDENCE_INVALID` | not measured per-scenario (see aggregate totals below) | not measured per-scenario | not measured per-scenario | `<TBD>` | Yes | Yes | **No — cited an invented id, not the real toolCallId** | `get_service_status` selected correctly; tool-result round trip succeeded; normal (non-forced) finalization returned `report_submission`. Failed only because the report's evidence cited a fabricated id instead of the real `toolCallId`. |
| 1 (2026-07-17, initial) | `<TBD>` | forced-finalization probe | FAILED — `REPORT_EVIDENCE_INVALID` | not measured per-scenario | not measured per-scenario | not measured per-scenario | `<TBD>` | n/a (forced) | Yes | **No — cited an invented id, not the real toolCallId** | Forced finalization correctly returned `report_submission`; failed only on evidence-grounding for the same reason as above. |
| 2 (2026-07-17, post-fix) | `claude-sonnet-5` | tool-then-report | **PASSED** | 10,625 (calls 1+2) | 3,922 | 883 | 0.016674 | Yes | Yes | **Yes** | Investigation call requested `get_service_status` (call 1); forced finalization call submitted a valid report citing the exact surfaced `evidenceId` (call 2). Exit code 0. |
| 2 (2026-07-17, post-fix) | `claude-sonnet-5` | forced-finalization probe | **PASSED** | 7,578 (call 3) | 2,039 | 791 | 0.011988 | n/a (forced) | Yes | **Yes** | Standalone probe (call 3) submitted a valid report citing the exact surfaced `evidenceId`. Exit code 0. |

Any `protocol_error` or `LlmProviderError` encountered during a run should
be recorded here with its code/category and a short description — not just
"failed."

### Run 1 (initial, failed on evidence-grounding) — aggregate totals

Per-scenario latency/token breakdowns were not separately recorded for Run
1; only the totals across all Claude API responses in the run are
available:

| Field | Value |
|---|---|
| Successful Claude API responses | 3 (2 for tool-then-report: investigation call + forced finalization call; 1 for the standalone forced-finalization probe) |
| Total input tokens | 5,546 |
| Total output tokens | 1,809 |
| Total measured latency | 56,774 ms |

### Run 1 (initial, failed on evidence-grounding) — confirmed root cause and fix

Both scenarios failed **only** at evidence-grounding validation
(`REPORT_EVIDENCE_INVALID`), not at schema validation or tool selection.

- Allowed evidence id (the real `toolCallId`): `call-1`
- Claude-generated evidence id: `toolu_get_service_status_1` (a fabricated
  id shaped like a `tool_use` id, not the real `toolCallId`, and not
  derived from anything Claude was actually shown)

Root cause: the `tool_result` content Claude was shown contained only the
bare tool output (e.g. `{serviceSlug, status}`) — Claude was never told
what id to cite, so it invented one. Fix applied: `tool_result.content` now
explicitly wraps the output with `evidenceId` (the exact `toolCallId`),
`sourceType: "TOOL_EXECUTION"`, and `toolName`; the system/finalization
prompt now explicitly instructs Claude to copy that `evidenceId` field
exactly and never invent, derive, shorten, or rewrite it.
`findInvalidEvidence`, `successfulToolExecutionIds`,
`ResolutionReportSchema`, and the tool output schemas were **not**
changed — evidence acceptance rules remain exactly as strict as before.

### Run 2 (successful, confirms fix) — per-call breakdown

Date: 2026-07-17. Model: `claude-sonnet-5`. 3 live Claude API calls, exit
code 0.

| Call | Scenario | Input tokens | Output tokens | Latency (ms) | Normalized result |
|---|---|---|---|---|---|
| 1 | tool-then-report (investigation turn) | 1,861 | 81 | 2,852 | `diagnostic_tool_request` |
| 2 | tool-then-report (forced finalization turn) | 2,061 | 802 | 7,773 | `report_submission` |
| 3 | forced-finalization probe | 2,039 | 791 | 7,578 | `report_submission` |

| Field | Value |
|---|---|
| Live API calls | 3 |
| Total input tokens | 5,961 |
| Total output tokens | 1,674 |
| Total measured API latency | 18,203 ms |
| Estimated cost | USD 0.028662 |
| Exit code | 0 |

Both `ResolutionReportSchema` validation and evidence-grounding validation
passed for both report submissions (calls 2 and 3) — each cited the exact
surfaced `evidenceId` from `tool_result` content rather than an invented
id, confirming the Run 1 fix.

## Cost

| Field | Value |
|---|---|
| Pricing source | Claude Sonnet 5 introductory pricing: USD 2 per million input tokens, USD 10 per million output tokens |
| Pricing basis date | Valid through 2026-08-31 |
| Total run cost (USD), Run 2 | 0.028662 |
| Total run cost (USD), Run 1 | `<TBD>` — per-call token/latency breakdown wasn't recorded for Run 1, only totals (see "Run 1 — aggregate totals"), so cost wasn't computed for it |

Per-row "Estimated cost (USD)" in the table above = (input tokens × input
price) + (output tokens × output price), using the per-token prices in
effect as of "Pricing basis date". Record the exact model's price tier used
for the calculation, since it can differ across model variants. Run 2's
introductory pricing is time-limited (through 2026-08-31) — re-check the
pricing source before using this rate for any run after that date.

## Deferred measurements

These are explicitly not covered by this spike and must not be inferred
from it:

- **Report-repair success** — not measured in this spike. The spike only
  exercises a single investigation turn followed by a single (possibly
  forced) report submission; it never triggers or observes the
  `REPORT_REPAIR` phase described in `docs/04-agent-design.md`.
- **Deliberately induced live provider errors** — not measured in this
  spike. `LlmProviderError` classification (`AUTHENTICATION`, `RATE_LIMIT`,
  `CONNECTION`, `TIMEOUT`, `SERVER_ERROR`, `REQUEST_INVALID`, `UNKNOWN`) is
  covered by unit tests against a fake client (see
  `claude-llm-provider.test.ts`), not by deliberately provoking any of
  these conditions against the live Anthropic API.

## Findings

### Run 1 (initial, failed on evidence-grounding)

- Tool selection worked correctly — Claude chose `get_service_status` with
  no prompting beyond the tool description.
- The tool-call/tool-result round trip (validate → execute → feed result
  back) worked correctly end to end.
- Both normal (non-forced, `tool_choice: auto`) and forced
  (`tool_choice: {type:"tool",...}`) finalization correctly produced a
  `submit_resolution_report` call rather than a diagnostic tool call or a
  refusal.
- Both reports passed `ResolutionReportSchema` validation — the strict-mode
  tool schema (with unsupported constraints stripped, see Risks) was
  sufficient for Claude to produce a structurally valid report.
- Both scenarios failed evidence-grounding validation for the same reason:
  Claude was never shown an explicit `evidenceId` to cite, so it invented
  one resembling a `tool_use` id. This was not a schema-validation gap or a
  weakening of evidence rules — it was a prompt/protocol gap in what
  information Claude's tool_result actually contained. Fixed (see "Run 1 —
  confirmed root cause and fix" above); confirmed fixed by Run 2, below.

### Run 2 (successful, confirms fix)

- Tool selection, the tool-call/tool-result round trip, and both
  finalization paths (normal `tool_choice: auto` and forced
  `tool_choice: {type:"tool",...}`) all worked correctly again, matching
  Run 1.
- Both report submissions passed `ResolutionReportSchema` validation.
- Both report submissions passed evidence-grounding validation — each
  cited the exact surfaced `evidenceId` rather than an invented id,
  directly confirming the Run 1 fix (wrapping `tool_result.content` with
  an explicit `evidenceId` and tightening the system prompt) resolved the
  defect without any change to `findInvalidEvidence`,
  `successfulToolExecutionIds`, `ResolutionReportSchema`, or any tool
  output schema.
- Exit code 0 for both scenarios.

## Decision

**ADOPT** — based on two live runs (Run 1: initial, failed only on
evidence-grounding; Run 2: post-fix, both scenarios passed).

- Tool selection, tool execution, and both finalization paths worked
  correctly on both runs — no fundamental protocol incompatibility was
  observed at any point.
- The evidence-citation defect found in Run 1 was root-caused and fixed by
  surfacing `evidenceId` explicitly in `tool_result` content and
  tightening the system prompt's instructions — without weakening
  `findInvalidEvidence`, `successfulToolExecutionIds`,
  `ResolutionReportSchema`, or any tool output schema.
- Run 2 confirms the fix: both `ResolutionReportSchema` validation and
  evidence-grounding validation passed for both scenarios, with exit code
  0.
- This ADOPT decision is scoped to what these two runs actually
  exercised — see Limitations below before treating this as a broader
  production-readiness sign-off.

### Limitations

- **One successful live run does not establish production reliability.**
  Run 2 is a single successful run following the fix; it does not by
  itself prove consistent behavior across many runs, tickets, or model
  versions.
- **Report-repair was not measured.** Neither run triggers or observes the
  `REPORT_REPAIR` phase described in `docs/04-agent-design.md`.
- **Deliberately induced live provider errors were not measured.**
  `LlmProviderError` classification is covered by unit tests against a
  fake client, not by provoking auth/rate-limit/timeout/server failures
  against the live Anthropic API.
- **No RAG, persistence, production retry policy, or deployment was
  evaluated.** This spike is scoped to the `LlmProvider` adapter and the
  existing vertical-slice `AgentOrchestrator` only.

## Risks

- **Strict-schema stripping.** `claude-tool-schemas.ts`'s `toStrictInputSchema`
  removes JSON Schema constraints Claude's `strict: true` tool mode doesn't
  support (`minLength`/`maxLength`, `minimum`/`maximum`, `maxItems`, etc.)
  from the schema Claude actually sees. This only narrows what Claude's
  grammar-constrained sampling enforces at generation time — it does not
  weaken OpsPilot's own validation: the original Zod schemas
  (`ResolutionReportSchema`, each `DiagnosticToolDefinition.inputSchema`)
  remain the runtime validation source of truth, unchanged, and every tool
  call/report submission is still fully re-validated against them inside
  `AgentOrchestrator`. This fix keeps the existing hand-written recursive
  transform narrowly scoped to the two schemas in play; it does not
  introduce a new generic schema-conversion framework.

## Follow-ups deferred by this spike

- `ANTHROPIC_MODEL` is the environment variable name used here, matching
  `docs/03-technical-design.md` §26.1/§13.8.
- Phase (`INVESTIGATION`/`FINALIZATION`) is computed by the orchestrator
  from its bounded 2-turn loop (`MAX_PROVIDER_TURNS = 2`) and passed
  explicitly into `AgentTurnInput.phase` — the provider never infers it.
- No retry-policy customization beyond the Anthropic SDK's defaults.
- `AgentProtocolErrorCodeSchema` still has only one member
  (`PROVIDER_PROTOCOL_INVALID`); transport/auth/rate-limit/timeout/server
  errors are surfaced as a separate `LlmProviderError`, never laundered into
  a `protocol_error` result.
- Full investigation budgets, report-repair orchestration, RAG evidence,
  persistence (`AgentRun`/`AgentJob`), and production deployment concerns
  are all out of scope for this spike.
