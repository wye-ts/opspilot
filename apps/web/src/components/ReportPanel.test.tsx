import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ResolutionReport } from "../api/types";
import { ReportPanel, type ReportableOutcome } from "./ReportPanel";

const baseReport: ResolutionReport = {
  category: "SERVICE_DEGRADATION",
  summary: "A diagnostic check was performed.",
  rootCause: "The service returned elevated error rates.",
  customerImpact: "Some customers saw failed requests.",
  recommendedResolution: "Monitor and escalate if it continues.",
  confidence: 0.75,
  evidence: [{ evidenceId: "ev-1", sourceType: "TOOL_EXECUTION", finding: "get_service_status completed successfully." }],
  suggestedActions: [],
};

describe("ReportPanel", () => {
  it("renders all six report fields plus evidence for a COMPLETED outcome", () => {
    const outcome: ReportableOutcome = { type: "COMPLETED", report: baseReport };
    render(<ReportPanel outcome={outcome} />);

    expect(screen.getByText(baseReport.category)).toBeInTheDocument();
    expect(screen.getByText("0.75")).toBeInTheDocument();
    expect(screen.getByText(baseReport.summary)).toBeInTheDocument();
    expect(screen.getByText(baseReport.rootCause)).toBeInTheDocument();
    expect(screen.getByText(baseReport.customerImpact)).toBeInTheDocument();
    expect(screen.getByText(baseReport.recommendedResolution)).toBeInTheDocument();
    expect(screen.getByText(/get_service_status completed successfully/)).toBeInTheDocument();
  });

  // Suggested actions moved to SuggestedActionsPanel — this
  // panel no longer renders them at all, empty or not.
  it("never renders anything about suggested actions, regardless of the report's own data", () => {
    const report: ResolutionReport = {
      ...baseReport,
      suggestedActions: [{ type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." } }],
    };
    render(<ReportPanel outcome={{ type: "COMPLETED", report }} />);

    expect(screen.queryByText(/Suggested actions/)).toBeNull();
    expect(screen.queryByText("Update ticket status")).toBeNull();
  });

  it("renders failure code and message for a FAILED outcome, with no report fields", () => {
    const outcome: ReportableOutcome = { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." };
    render(<ReportPanel outcome={outcome} />);

    expect(screen.getByText("RETRIEVAL_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    expect(screen.queryByText(/Suggested actions/)).toBeNull();
  });

  // RUNNING is excluded at the type level now — App.tsx
  // never mounts this component for a RUNNING outcome at all.
});
