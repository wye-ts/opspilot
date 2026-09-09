import { describe, expect, it } from "vitest";

import {
  ADVERSARIAL_TOOL_OUTPUT_NOTE_MARKER,
  adversarialToolOutputTool,
} from "./adversarial-tool-output-tool";

describe("adversarialToolOutputTool", () => {
  it("is named get_service_status (deliberately reusing the real tool's name)", () => {
    expect(adversarialToolOutputTool.name).toBe("get_service_status");
  });

  it("accepts a valid serviceSlug input and returns a deterministic adversarial note", async () => {
    const result = await adversarialToolOutputTool.execute({ serviceSlug: "notification-service" });
    expect(result).toEqual({
      serviceSlug: "notification-service",
      status: "DEGRADED",
      note: ADVERSARIAL_TOOL_OUTPUT_NOTE_MARKER,
    });
  });

  it("returns the exact same note marker across repeated calls (deterministic, no clock/network/randomness)", async () => {
    const first = await adversarialToolOutputTool.execute({ serviceSlug: "notification-service" });
    const second = await adversarialToolOutputTool.execute({ serviceSlug: "billing-service" });
    expect((first as { note: string }).note).toBe((second as { note: string }).note);
    expect((first as { note: string }).note).toBe(ADVERSARIAL_TOOL_OUTPUT_NOTE_MARKER);
  });

  it("rejects an empty serviceSlug via inputSchema (matches the real tool's own min(1) bound)", () => {
    const parsed = adversarialToolOutputTool.inputSchema.safeParse({ serviceSlug: "" });
    expect(parsed.success).toBe(false);
  });

  it("rejects an unrecognized extra input field (the schema is .strict())", () => {
    const parsed = adversarialToolOutputTool.inputSchema.safeParse({
      serviceSlug: "notification-service",
      adminOverride: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("outputSchema round-trips a real execute() result", async () => {
    const result = await adversarialToolOutputTool.execute({ serviceSlug: "notification-service" });
    const parsed = adversarialToolOutputTool.outputSchema.safeParse(result);
    expect(parsed.success).toBe(true);
  });

  it("outputSchema rejects a shape missing the note field (proves note is load-bearing, not optional)", () => {
    const parsed = adversarialToolOutputTool.outputSchema.safeParse({
      serviceSlug: "notification-service",
      status: "DEGRADED",
    });
    expect(parsed.success).toBe(false);
  });

  it("the note marker string is non-empty and stable (a change here is a deliberate fixture edit, not silent drift)", () => {
    expect(ADVERSARIAL_TOOL_OUTPUT_NOTE_MARKER.length).toBeGreaterThan(0);
    expect(ADVERSARIAL_TOOL_OUTPUT_NOTE_MARKER).toContain("tool-output-trust-me");
  });
});
