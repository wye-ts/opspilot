import { AgentOrchestratorErrorCodeSchema } from "@opspilot/contracts";
import { describe, expect, it } from "vitest";

import { FAILURE_DISPLAY_MESSAGES } from "./failure-messages";

describe("FAILURE_DISPLAY_MESSAGES", () => {
  it("has exactly the same keys as AgentOrchestratorErrorCodeSchema.options, no more, no fewer", () => {
    const expectedCodes = [...AgentOrchestratorErrorCodeSchema.options].sort();
    const actualCodes = Object.keys(FAILURE_DISPLAY_MESSAGES).sort();
    expect(actualCodes).toEqual(expectedCodes);
  });

  it("maps every code to a non-empty fixed string", () => {
    for (const message of Object.values(FAILURE_DISPLAY_MESSAGES)) {
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });
});
