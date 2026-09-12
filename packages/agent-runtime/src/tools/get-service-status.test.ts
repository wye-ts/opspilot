import { describe, expect, it } from "vitest";

import { getServiceStatusTool } from "./get-service-status";

describe("get_service_status", () => {
  it("returns the seeded status for each known service", async () => {
    await expect(getServiceStatusTool.execute({ serviceSlug: "notification-service" })).resolves.toEqual({
      serviceSlug: "notification-service",
      status: "DEGRADED",
    });
    await expect(getServiceStatusTool.execute({ serviceSlug: "billing-service" })).resolves.toEqual({
      serviceSlug: "billing-service",
      status: "OUTAGE",
    });
    await expect(getServiceStatusTool.execute({ serviceSlug: "auth-service" })).resolves.toEqual({
      serviceSlug: "auth-service",
      status: "OPERATIONAL",
    });
  });

  it("answers UNKNOWN for an ordinary unseeded service", async () => {
    // Never OPERATIONAL: defaulting to healthy would assert an operational
    // claim the fixture does not support.
    await expect(getServiceStatusTool.execute({ serviceSlug: "search-service" })).resolves.toEqual({
      serviceSlug: "search-service",
      status: "UNKNOWN",
    });
  });

  it("answers UNKNOWN for a slug that collides with an inherited Object member", async () => {
    // Issue #96. `serviceSlug` is a model-supplied string bounded only by
    // min(1)/max(100), so a plain `table[slug]` lookup walks the prototype
    // chain and returns an inherited function/object instead of undefined —
    // `?? "UNKNOWN"` never fires, the returned `status` is not a status at all,
    // and outputSchema rejects it, which fails the WHOLE run with
    // TOOL_OUTPUT_INVALID (agent-orchestrator.ts). These are ordinary unknown
    // services and must answer like one.
    for (const serviceSlug of [
      "constructor",
      "__proto__",
      "toString",
      "hasOwnProperty",
      "valueOf",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "toLocaleString",
    ]) {
      await expect(getServiceStatusTool.execute({ serviceSlug })).resolves.toEqual({
        serviceSlug,
        status: "UNKNOWN",
      });
    }
  });

  it("produces output conforming to its own outputSchema for a prototype-key slug", async () => {
    // The orchestrator validates every tool result before accepting it. This
    // asserts the property that actually protects the run, not just the shape
    // of the returned object.
    const result = await getServiceStatusTool.execute({ serviceSlug: "constructor" });

    expect(getServiceStatusTool.outputSchema.safeParse(result).success).toBe(true);
  });

  describe("input schema", () => {
    it("accepts a well-formed serviceSlug", () => {
      expect(getServiceStatusTool.inputSchema.safeParse({ serviceSlug: "auth-service" }).success).toBe(true);
    });

    it("rejects a missing, empty, or oversized serviceSlug", () => {
      expect(getServiceStatusTool.inputSchema.safeParse({}).success).toBe(false);
      expect(getServiceStatusTool.inputSchema.safeParse({ serviceSlug: "" }).success).toBe(false);
      expect(getServiceStatusTool.inputSchema.safeParse({ serviceSlug: "x".repeat(101) }).success).toBe(false);
    });

    it("rejects an unknown extra key rather than silently ignoring it", () => {
      expect(
        getServiceStatusTool.inputSchema.safeParse({ serviceSlug: "auth-service", verbose: true }).success,
      ).toBe(false);
    });
  });
});
