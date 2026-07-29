import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_TOOL_CATALOG,
  GET_SERVICE_STATUS_CATALOG_ENTRY,
} from "./diagnostic-tool-catalog";
import { getServiceStatusTool } from "./get-service-status";

describe("diagnostic tool catalog", () => {
  it("exposes the get_service_status tool by identity, not a copy", () => {
    // Identity matters: a copied or re-declared tool object would validate and
    // execute independently of the one the registry hands the orchestrator.
    expect(GET_SERVICE_STATUS_CATALOG_ENTRY.tool).toBe(getServiceStatusTool);
    expect(GET_SERVICE_STATUS_CATALOG_ENTRY.tool.name).toBe("get_service_status");
  });

  it("describes every documented status value the tool can return", () => {
    const { description } = GET_SERVICE_STATUS_CATALOG_ENTRY;

    for (const status of ["OPERATIONAL", "DEGRADED", "OUTAGE", "UNKNOWN"]) {
      expect(description).toContain(status);
    }
  });

  it("lists each tool exactly once, in a stable order", () => {
    const names = DIAGNOSTIC_TOOL_CATALOG.map((entry) => entry.tool.name);

    expect(names).toEqual(["get_service_status"]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("leaves the tool's own schemas and behaviour untouched", async () => {
    const { tool } = GET_SERVICE_STATUS_CATALOG_ENTRY;

    expect(tool.inputSchema.safeParse({ serviceSlug: "billing-service" }).success).toBe(true);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    await expect(tool.execute({ serviceSlug: "billing-service" })).resolves.toEqual({
      serviceSlug: "billing-service",
      status: "OUTAGE",
    });
  });
});
