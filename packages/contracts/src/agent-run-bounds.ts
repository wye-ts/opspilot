/**
 * Reviewed source constants for the bounded multi-step diagnostic loop
 * (issue #57, docs/16-investigation-event-contract.md §0).
 *
 * These are compile-time, code-reviewed ceilings — deliberately NOT
 * environment knobs. Checkpoint A only adds the constants and the reducer
 * acceptance for streams up to these bounds; the orchestrator adopts them
 * (and therefore emits up to `MAX_DIAGNOSTIC_TOOL_CALLS` tool calls) in
 * Checkpoint B.
 */
export const MAX_PROVIDER_TURNS = 4;
export const MAX_DIAGNOSTIC_TOOL_CALLS = 3;
