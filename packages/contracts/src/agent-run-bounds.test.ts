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

  // Slack, not equality (issue #107). MAX_DIAGNOSTIC_TOOL_CALLS = 3 with
  // MAX_PROVIDER_TURNS = 5 leaves TWO non-diagnostic turns: the forced
  // finalization turn plus one turn of headroom. That headroom is what lets a
  // corrective retry (#99's A3 re-prompt, #101's report correction) run even
  // when the model spent every diagnostic call — under the previous equality
  // the report landed on the forced finalization turn and no corrective slot
  // existed at all.
  //
  // The assertion above is the real invariant and must keep holding. This test
  // pins the CURRENT reviewed values so that changing either constant is a
  // deliberate, reviewed act rather than an incidental edit — a raise also
  // moves the per-run cost ceiling and every figure derived from it.
  //
  // Deliberately NOT asserting equality any more: equality is precisely what
  // #107 removed. Anything deriving "the report stage has begun" from turn
  // position rather than from the exhausted-or-final condition breaks the
  // moment these two stop coinciding (see agent-orchestrator.ts).
  it("holds with slack under the reviewed #107 ceiling (3 <= 5 - 1)", () => {
    expect(MAX_PROVIDER_TURNS).toBe(5);
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBe(3);
    expect(MAX_DIAGNOSTIC_TOOL_CALLS).toBeLessThan(MAX_PROVIDER_TURNS - 1);
  });
});
