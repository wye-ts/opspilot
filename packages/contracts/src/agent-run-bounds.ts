/**
 * Reviewed source constants for the bounded multi-step diagnostic loop
 * (issue #57, docs/16-investigation-event-contract.md §0).
 *
 * These are compile-time, code-reviewed ceilings — deliberately NOT
 * environment knobs. Checkpoint A only adds the constants and the reducer
 * acceptance for streams up to these bounds; the orchestrator adopts them
 * (and therefore emits up to `MAX_DIAGNOSTIC_TOOL_CALLS` tool calls) in
 * Checkpoint B.
 *
 * Issue #107 raised MAX_PROVIDER_TURNS from 4 to 5 so the documented bound
 * `MAX_DIAGNOSTIC_TOOL_CALLS <= MAX_PROVIDER_TURNS - 1` holds with genuine
 * SLACK (3 <= 4) rather than at equality. Under the old equality the single
 * non-diagnostic turn WAS the forced finalization turn, so a model that spent
 * every diagnostic call landed its report there — and the corrective retry
 * paths (#99, #101), which each need a later turn to submit into, could never
 * run at all.
 *
 * The slack is load-bearing in a second, less obvious way: it separates
 * "the diagnostic budget is exhausted" from "this is the last turn". Those two
 * conditions coincided under the old equality, and both the orchestrator's
 * report-stage transition and the reducer's REPORT_GENERATION_STARTED
 * requirement were written against that coincidence. See
 * agent-orchestrator.ts's reportStageBegun derivation — anything that keys off
 * "the report stage has begun" must use the exhausted-or-final condition, never
 * turn position alone.
 */
export const MAX_PROVIDER_TURNS = 5;
export const MAX_DIAGNOSTIC_TOOL_CALLS = 3;
