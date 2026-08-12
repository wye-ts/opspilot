import { describe, expect, it } from "vitest";

import { CURRENT_MODEL_LABEL, presentProviders } from "./provider-presentation";

describe("presentProviders", () => {
  it("labels the modes Demo and Live — never Live Claude", () => {
    const { demo, live } = presentProviders(null);
    expect(demo.label).toBe("Demo");
    expect(live.label).toBe("Live");
  });

  it("keeps Demo always selectable with its availability pill, even with unknown capabilities", () => {
    const { demo } = presentProviders(null);
    expect(demo.disabled).toBe(false);
    expect(demo.pill).toEqual({ text: "Available", tone: "success" });
    expect(demo.unavailableReason).toBeNull();
  });

  it("collapses LIVE to unavailable when the snapshot does not advertise live runs", () => {
    const { live } = presentProviders({ liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" });
    expect(live.disabled).toBe(true);
    expect(live.unavailableReason).toContain("Temporarily unavailable");
    expect(live.pill).toEqual({ text: "Temporarily unavailable", tone: "neutral" });
    expect(live.currentModel).toBeNull();
  });

  it("fails closed on unknown capabilities — LIVE unavailable, explained, never hidden", () => {
    const { live } = presentProviders(null);
    expect(live.disabled).toBe(true);
    expect(live.unavailableReason).not.toBeNull();
  });

  it("offers LIVE when liveAgentRuns is AVAILABLE", () => {
    const { live } = presentProviders({ liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" });
    expect(live.disabled).toBe(false);
    expect(live.pill).toEqual({ text: "Available", tone: "success" });
    expect(live.unavailableReason).toBeNull();
  });

  it("shows the grounded current-model label only while LIVE is available", () => {
    const { live } = presentProviders({ liveAgentRuns: "AVAILABLE", liveAccess: "TOKEN_REQUIRED" });
    expect(live.currentModel).toContain(CURRENT_MODEL_LABEL);
    expect(live.currentModel).toContain("Current model");

    const offline = presentProviders({ liveAgentRuns: "UNAVAILABLE", liveAccess: "NOT_APPLICABLE" }).live;
    expect(offline.currentModel).toBeNull();
  });

  it("offers a single remaining public-trial run as 'Daily trial available'", () => {
    const { live } = presentProviders({ liveAgentRuns: "AVAILABLE", liveAccess: "PUBLIC_TRIAL", visitorRunsRemaining: 1, turnstileSiteKey: "1x00000000000000000000AA" });
    expect(live.disabled).toBe(false);
    expect(live.pill).toEqual({ text: "Daily trial available", tone: "success" });
  });

  it("collapses LIVE to a quota-used reason when a public trial visitor has no runs left", () => {
    const { live } = presentProviders({ liveAgentRuns: "AVAILABLE", liveAccess: "PUBLIC_TRIAL", visitorRunsRemaining: 0, turnstileSiteKey: "1x00000000000000000000AA" });
    expect(live.disabled).toBe(true);
    expect(live.pill).toEqual({ text: "Daily trial used", tone: "warning" });
    expect(live.unavailableReason).toContain("already used today's live trial run");
    expect(live.currentModel).toBeNull();
  });
});
