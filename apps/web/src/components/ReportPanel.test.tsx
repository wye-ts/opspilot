import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { AgentRunOutcomeView, ResolutionReport } from "../api/types";
import { ReportPanel } from "./ReportPanel";

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
    const outcome: AgentRunOutcomeView = { type: "COMPLETED", report: baseReport };
    render(<ReportPanel outcome={outcome} onRefresh={vi.fn()} refreshDisabled={false} />);

    expect(screen.getByText(baseReport.category)).toBeInTheDocument();
    expect(screen.getByText("0.75")).toBeInTheDocument();
    expect(screen.getByText(baseReport.summary)).toBeInTheDocument();
    expect(screen.getByText(baseReport.rootCause)).toBeInTheDocument();
    expect(screen.getByText(baseReport.customerImpact)).toBeInTheDocument();
    expect(screen.getByText(baseReport.recommendedResolution)).toBeInTheDocument();
    expect(screen.getByText(/get_service_status completed successfully/)).toBeInTheDocument();
  });

  it("renders one card per suggested action, all three variants", () => {
    const report: ResolutionReport = {
      ...baseReport,
      suggestedActions: [
        { type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." } },
        { type: "CREATE_ESCALATION", payload: { team: "platform", reason: "Needs attention.", priority: "HIGH" } },
        { type: "DRAFT_CUSTOMER_REPLY", payload: { subject: "Update", body: "We are looking into it." } },
      ],
    };
    render(<ReportPanel outcome={{ type: "COMPLETED", report }} onRefresh={vi.fn()} refreshDisabled={false} />);

    expect(screen.getByText("Update ticket status")).toBeInTheDocument();
    expect(screen.getByText("Create escalation")).toBeInTheDocument();
    expect(screen.getByText("Draft customer reply")).toBeInTheDocument();
    expect(screen.getByText("RESOLVED")).toBeInTheDocument();
    expect(screen.getByText("platform")).toBeInTheDocument();
    expect(screen.getByText("We are looking into it.")).toBeInTheDocument();
  });

  it("renders zero suggested actions cleanly", () => {
    render(<ReportPanel outcome={{ type: "COMPLETED", report: baseReport }} onRefresh={vi.fn()} refreshDisabled={false} />);
    expect(screen.getByText("This run produced no suggested actions.")).toBeInTheDocument();
  });

  it("renders failure code and message for a FAILED outcome, with no report fields", () => {
    const outcome: AgentRunOutcomeView = { type: "FAILED", code: "RETRIEVAL_FAILED", message: "Runbook retrieval failed." };
    render(<ReportPanel outcome={outcome} onRefresh={vi.fn()} refreshDisabled={false} />);

    expect(screen.getByText("RETRIEVAL_FAILED")).toBeInTheDocument();
    expect(screen.getByText("Runbook retrieval failed.")).toBeInTheDocument();
    expect(screen.queryByText(/Suggested actions/)).toBeNull();
  });

  it("renders the not-yet-produced state for a RUNNING outcome", () => {
    render(<ReportPanel outcome={{ type: "RUNNING" }} onRefresh={vi.fn()} refreshDisabled={false} />);
    expect(screen.getByText("This run has not produced a report yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });
});
