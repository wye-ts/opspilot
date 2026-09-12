import { describe, expect, it } from "vitest";

import {
  DIAGNOSTIC_TOOL_CATALOG,
  GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY,
  GET_SERVICE_STATUS_CATALOG_ENTRY,
} from "./diagnostic-tool-catalog";
import { getRecentDeploymentsTool } from "./get-recent-deployments";
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

  it("exposes the get_recent_deployments tool by identity, not a copy", () => {
    expect(GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY.tool).toBe(getRecentDeploymentsTool);
    expect(GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY.tool.name).toBe("get_recent_deployments");
  });

  it("describes every documented outcome value get_recent_deployments can return", () => {
    const { description } = GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY;

    for (const outcome of ["SUCCEEDED", "FAILED", "ROLLED_BACK"]) {
      expect(description).toContain(outcome);
    }
  });

  it("tells the model what an empty deployment list does and does not mean", () => {
    // The knownService distinction only protects a run if the model is told it
    // exists. A description that omitted it would leave the model free to read
    // an empty list as "no deployments" when it may mean "unknown service".
    const { description } = GET_RECENT_DEPLOYMENTS_CATALOG_ENTRY;

    expect(description).toContain("knownService");
  });

  it("lists each tool exactly once, in a stable order", () => {
    const names = DIAGNOSTIC_TOOL_CATALOG.map((entry) => entry.tool.name);

    expect(names).toEqual(["get_service_status", "get_recent_deployments"]);
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
