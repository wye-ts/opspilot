import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { DiagnosticToolDefinition } from "@opspilot/agent-runtime";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createRecordingToolRegistry, type RecordedToolExecution } from "./recording-tool-registry";

const { getServiceStatusTool } = opspilotAgentRuntime;

const throwingTool: DiagnosticToolDefinition = {
  name: "throwing_tool",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({}).strict(),
  async execute() {
    throw new Error("simulated failure");
  },
};

describe("createRecordingToolRegistry", () => {
  it("preserves find() lookup behavior for registered and unregistered tool names", () => {
    const recorder: RecordedToolExecution[] = [];
    const registry = createRecordingToolRegistry([getServiceStatusTool], recorder);

    expect(registry.find("get_service_status")?.name).toBe("get_service_status");
    expect(registry.find("nonexistent")).toBeUndefined();
  });

  it("preserves the wrapped tool's input/output schema references", () => {
    const recorder: RecordedToolExecution[] = [];
    const registry = createRecordingToolRegistry([getServiceStatusTool], recorder);
    const wrapped = registry.find("get_service_status");

    expect(wrapped?.inputSchema).toBe(getServiceStatusTool.inputSchema);
    expect(wrapped?.outputSchema).toBe(getServiceStatusTool.outputSchema);
  });

  it("preserves real execute() behavior and result, while recording the call", async () => {
    const recorder: RecordedToolExecution[] = [];
    const registry = createRecordingToolRegistry([getServiceStatusTool], recorder);
    const wrapped = registry.find("get_service_status")!;

    const output = await wrapped.execute({ serviceSlug: "notification-service" });

    expect(output).toEqual({ serviceSlug: "notification-service", status: "DEGRADED" });
    expect(recorder).toEqual([
      { toolName: "get_service_status", input: { serviceSlug: "notification-service" } },
    ]);
  });

  it("records an attempted call even when the wrapped execute() then throws, without swallowing the error", async () => {
    const recorder: RecordedToolExecution[] = [];
    const registry = createRecordingToolRegistry([throwingTool], recorder);
    const wrapped = registry.find("throwing_tool")!;

    await expect(wrapped.execute({})).rejects.toThrow("simulated failure");
    expect(recorder).toEqual([{ toolName: "throwing_tool", input: {} }]);
  });

  it("records every attempt in call order across multiple executions", async () => {
    const recorder: RecordedToolExecution[] = [];
    const registry = createRecordingToolRegistry([getServiceStatusTool], recorder);
    const wrapped = registry.find("get_service_status")!;

    await wrapped.execute({ serviceSlug: "auth-service" });
    await wrapped.execute({ serviceSlug: "billing-service" });

    expect(recorder).toEqual([
      { toolName: "get_service_status", input: { serviceSlug: "auth-service" } },
      { toolName: "get_service_status", input: { serviceSlug: "billing-service" } },
    ]);
  });
});
