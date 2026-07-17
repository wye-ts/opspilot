import { describe, expect, it } from "vitest";

import { ResolutionReportSchema } from "./resolution-report";

const validReport = {
  category: "SERVICE_DEGRADATION",
  summary: "Notification delivery is delayed for some customers.",
  rootCause:
    "The notification service is degraded after repeated upstream rate-limit responses.",
  customerImpact:
    "Some password-reset and account-verification emails are delayed.",
  recommendedResolution:
    "Monitor the upstream provider, reduce retry pressure, and escalate if degradation continues.",
  confidence: 0.9,
  evidence: [
    {
      evidenceId: "rag-chunk-001",
      sourceType: "RAG_CHUNK",
      finding:
        "The runbook identifies upstream rate limiting as a known cause of delayed notifications.",
    },
    {
      evidenceId: "tool-execution-001",
      sourceType: "TOOL_EXECUTION",
      finding: "The notification service currently reports DEGRADED.",
    },
  ],
  suggestedActions: [
    {
      type: "CREATE_ESCALATION",
      payload: {
        team: "Messaging Platform",
        reason: "Sustained upstream rate limiting is affecting customers.",
        priority: "HIGH",
      },
    },
  ],
} as const;

describe("ResolutionReportSchema", () => {
  it("accepts a valid grounded resolution report", () => {
    const result = ResolutionReportSchema.safeParse(validReport);

    expect(result.success).toBe(true);
  });

  it("rejects confidence outside the zero-to-one range", () => {
    const result = ResolutionReportSchema.safeParse({
      ...validReport,
      confidence: 1.5,
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported suggested action types", () => {
    const result = ResolutionReportSchema.safeParse({
      ...validReport,
      suggestedActions: [
        {
          type: "RESTART_PRODUCTION_SERVICE",
          payload: {
            service: "notification-service",
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects more than three suggested actions", () => {
    const action = {
      type: "UPDATE_TICKET_STATUS",
      payload: {
        status: "IN_PROGRESS",
        reason: "Investigation is continuing.",
      },
    } as const;

    const result = ResolutionReportSchema.safeParse({
      ...validReport,
      suggestedActions: [action, action, action, action],
    });

    expect(result.success).toBe(false);
  });
});
