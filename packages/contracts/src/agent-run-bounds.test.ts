import { describe, expect, it } from "vitest";

import { MAX_DIAGNOSTIC_TOOL_CALLS, MAX_PROVIDER_TURNS } from "./agent-run-bounds";

/**
 * The safety relationship that makes the bounded loop always terminate with a
 * deterministic report (docs/16-investigation-event-contract.md §0, issue #57
 * plan §5).
 *
 * One provider turn is reserved for forced finalization: a run can use at
 * most `MAX_PROVIDER_TURNS - 1` turns for diagnostic tool calls, because the
 * last turn is always the one that deterministically asks the provider for a
 * report. If the tool bound ever reached the turn bound, the loop could
 * exhaust every turn on tools and have no turn left in which to finalize.
 */
describe("bounded multi-step diagnostic loop invariants", () => {
  it("never lets diagnostic tool calls exhaust every provider turn", () => {
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBeLessThanOrEqual(MAX_PROVIDER_TURNS - 1);
  });

  // Equality is what lets the runtime use every tool turn and STILL reach the
  // forced finalization turn: with MAX_DIAGNOSTIC_TOOL_CALLS ===
  // MAX_PROVIDER_TURNS - 1, the loop can consume all three tool turns and
  // still have turn 3 reserved for finalization. If a future configuration
  // made the two unequal (MAX_DIAGNOSTIC_TOOL_CALLS < MAX_PROVIDER_TURNS - 1),
  // the orchestrator would need an explicit "force early finalization when
  // the tool bound is reached" rule — out of scope for #57. The invariant
  // assertion above plus this comment guard that future by failing loudly on
  // any change that lets tools crowd out the reserved finalization turn.
  it("holds at equality under the reviewed #57 ceiling (3 === 4 - 1)", () => {
    expect(MAX_PROVIDER_TURNS).toBe(4);
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBe(3);
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBe(MAX_PROVIDER_TURNS - 1);
  });
});
