import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { StoredResolutionReport } from "../api/types";
import { ReportPanel, type ReportableOutcome } from "./ReportPanel";

// A legacy-shaped stored report (no evidenceState, non-null rootCause, >= 1
// evidence) — the read-side shape the API can deliver for a pre-#58 row.
const baseReport: StoredResolutionReport = {
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

    // Sentence-case pill text, never the raw enum, and confidence as a
    // rounded percentage (final polish pass, item 5).
    expect(screen.getByText("Outcome · Service degradation")).toBeInTheDocument();
    expect(screen.getByText("Confidence · 75%")).toBeInTheDocument();
    expect(screen.getByText(baseReport.summary)).toBeInTheDocument();
    expect(screen.getByText(baseReport.rootCause!)).toBeInTheDocument();
    expect(screen.getByText(baseReport.customerImpact)).toBeInTheDocument();
    expect(screen.getByText(baseReport.recommendedResolution)).toBeInTheDocument();
    expect(screen.getByText(/get_service_status completed successfully/)).toBeInTheDocument();
  });

  // Suggested actions moved to SuggestedActionsPanel — this
  // panel no longer renders them at all, empty or not.
  it("never renders anything about suggested actions, regardless of the report's own data", () => {
    const report: StoredResolutionReport = {
      ...baseReport,
      suggestedActions: [{ type: "UPDATE_TICKET_STATUS", payload: { status: "RESOLVED", reason: "Fixed." }, groundedBy: [] }],
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

  // Issue #58 (P1-1): rootCause is nullable. The rendered value is
  // evidence-state-aware — a non-null rootCause always renders verbatim, and
  // a null rootCause renders a state-specific sentence so the UI never shows
  // a bare "null" for a grounded non-causal or insufficient conclusion.
  describe("evidence-state-aware rootCause rendering (Issue #58)", () => {
    const withNullRootCause = (report: StoredResolutionReport): ReportableOutcome => ({
      type: "COMPLETED",
      report,
    });

    it("renders a non-null rootCause verbatim even when evidenceState is absent (legacy read)", () => {
      render(<ReportPanel outcome={{ type: "COMPLETED", report: baseReport }} />);
      expect(screen.getByText("The service returned elevated error rates.")).toBeInTheDocument();
    });

    it("renders SUFFICIENT + null rootCause as a grounded non-causal conclusion", () => {
      render(
        <ReportPanel
          outcome={withNullRootCause({ ...baseReport, rootCause: null, evidenceState: "SUFFICIENT" })}
        />,
      );
      expect(screen.getByText("No causal root cause identified.")).toBeInTheDocument();
    });

    it("renders INSUFFICIENT + null rootCause as 'Not determined — insufficient evidence.'", () => {
      render(
        <ReportPanel
          outcome={withNullRootCause({ ...baseReport, rootCause: null, evidenceState: "INSUFFICIENT" })}
        />,
      );
      expect(screen.getByText("Not determined — insufficient evidence.")).toBeInTheDocument();
    });

    it("renders CONFLICTING + null rootCause as 'Not determined — evidence is conflicting.'", () => {
      render(
        <ReportPanel
          outcome={withNullRootCause({ ...baseReport, rootCause: null, evidenceState: "CONFLICTING" })}
        />,
      );
      expect(screen.getByText("Not determined — evidence is conflicting.")).toBeInTheDocument();
    });

    it("renders a legacy-shaped null rootCause (no evidenceState) as plain 'Not determined.'", () => {
      // Corrupt-ish read shape: a null rootCause without any evidenceState.
      // The web layer never asserts it is a valid stored row (the API already
      // revalidated), so it must still render rather than crash.
      render(<ReportPanel outcome={withNullRootCause({ ...baseReport, rootCause: null })} />);
      expect(screen.getByText("Not determined.")).toBeInTheDocument();
    });
  });

  // Issue #41 HQ polish §2/§3 — the FAILED card's <dl> stacks vertically
  // (never the cramped default two-column grid), the failure code never
  // wraps mid-identifier, and the top summary is generic unless a real
  // failed canonical stage grounds a more specific one.
  describe("FAILED outcome polish (HQ review §2/§3)", () => {
    const outcome: ReportableOutcome = {
      type: "FAILED",
      code: "PROVIDER_UNAVAILABLE",
      message: "The provider was unavailable.",
    };

    it("the Failure code / Message fields use the vertical-stack layout class, not the default two-column <dl>", () => {
      render(<ReportPanel outcome={outcome} />);
      const dl = screen.getByText("Failure code").closest("dl");
      expect(dl).not.toBeNull();
      expect(dl).toHaveClass("report-panel-failure-fields");
    });

    it("the failure code carries a class overriding the generic .mono anywhere-wrap, so PROVIDER_UNAVAILABLE never breaks mid-identifier", () => {
      render(<ReportPanel outcome={outcome} />);
      const code = screen.getByText("PROVIDER_UNAVAILABLE");
      expect(code).toHaveClass("mono");
      expect(code).toHaveClass("report-panel-failure-code");
    });

    it("with no failedStageLabel, keeps the existing generic summary", () => {
      render(<ReportPanel outcome={outcome} />);
      expect(screen.getByText("The run failed before producing a report.")).toBeInTheDocument();
    });

    it("with a grounded failedStageLabel, shows the specific 'Investigation failed during X.' summary instead", () => {
      render(<ReportPanel outcome={outcome} failedStageLabel="agent analysis" />);
      expect(screen.getByText("Investigation failed during agent analysis.")).toBeInTheDocument();
      expect(screen.queryByText("The run failed before producing a report.")).toBeNull();
    });

    it("never invents a failed-stage sentence for a COMPLETED outcome (prop is FAILED-only)", () => {
      render(<ReportPanel outcome={{ type: "COMPLETED", report: baseReport }} failedStageLabel="agent analysis" />);
      expect(screen.queryByText(/Investigation failed/)).toBeNull();
    });
  });

  // RUNNING is excluded at the type level now — App.tsx
  // never mounts this component for a RUNNING outcome at all.
});
