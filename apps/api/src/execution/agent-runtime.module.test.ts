import {
  DIAGNOSTIC_TOOL_CATALOG,
  type ToolRegistry,
} from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";

import { AgentRuntimeModule } from "./agent-runtime.module";
import { TOOL_REGISTRY } from "./execution.tokens";

// Issue #93. These tests exist because "offered to the model" and "executable
// by the registry" were wired from two different sources: ClaudeLlmProvider
// defaults to DIAGNOSTIC_TOOL_CATALOG (create-llm-provider.ts), while this
// module hand-listed [getServiceStatusTool]. With a one-entry catalog the
// divergence was invisible; appending a second entry would have made a LIVE
// turn offer a tool the registry could not resolve, and the orchestrator fails
// that whole run with TOOL_NOT_FOUND (agent-orchestrator.ts). No FAKE-mode
// test could have caught it — FakeLlmProvider scripts which tool is requested,
// so the offered list never participates.
//
// Following runbook-retrieval-wiring.test.ts's precedent for the same class of
// question: read AgentRuntimeModule's OWN provider metadata rather than
// re-constructing a registry the way the module does (which would prove only
// that the test agrees with itself) or compiling the whole module (which drags
// in the Prisma-backed providers this question does not involve). A future edit
// that hand-lists the registry again fails here.
function deployedToolRegistry(): ToolRegistry {
  const providers = Reflect.getMetadata("providers", AgentRuntimeModule) as readonly {
    readonly provide?: unknown;
    readonly useValue?: ToolRegistry;
  }[];
  const entry = providers.find((provider) => provider.provide === TOOL_REGISTRY);
  if (entry?.useValue === undefined) {
    throw new Error("AgentRuntimeModule no longer declares a TOOL_REGISTRY useValue provider");
  }
  return entry.useValue;
}

describe("issue #93: the deployed TOOL_REGISTRY can execute every tool the model is offered", () => {
  it("resolves every tool in the shared catalog by name", () => {
    const registry = deployedToolRegistry();

    expect(DIAGNOSTIC_TOOL_CATALOG.length).toBeGreaterThan(0);
    for (const entry of DIAGNOSTIC_TOOL_CATALOG) {
      expect(registry.find(entry.tool.name)).toBeDefined();
    }
  });

  it("resolves each catalog tool by identity, not an equivalent copy", () => {
    const registry = deployedToolRegistry();

    // A copy would validate and execute independently of the definition the
    // catalog advertises — the same identity discipline the catalog's own test
    // applies to its entries.
    for (const entry of DIAGNOSTIC_TOOL_CATALOG) {
      expect(registry.find(entry.tool.name)).toBe(entry.tool);
    }
  });

  it("covers the specific tools this milestone's two-tool investigation needs", () => {
    // Named explicitly, not only derived from the catalog: a change that
    // silently emptied or truncated the catalog would keep the two loops above
    // passing while removing the capability entirely.
    const registry = deployedToolRegistry();

    expect(registry.find("get_service_status")).toBeDefined();
    expect(registry.find("get_recent_deployments")).toBeDefined();
  });

  it("does not resolve a name absent from the catalog", () => {
    const registry = deployedToolRegistry();

    expect(registry.find("not_a_real_tool")).toBeUndefined();
  });
});
