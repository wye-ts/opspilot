import { describe, expect, it } from "vitest";

import { deriveInvestigationProgressStages, presentInvestigationProgressStage } from "./investigation-progress-stages";

const BASE = {
  providerMode: "FAKE" as const,
  activeStageKey: null,
  failedStage: null,
  jobCreated: false,
  runOutcomeType: null,
  approvalLoadStatus: "idle" as const,
};

describe("deriveInvestigationProgressStages", () => {
  it("FAKE mode never includes the availability stage", () => {
    const stages = deriveInvestigationProgressStages(BASE);
    expect(stages.map((s) => s.key)).toEqual(["job", "run", "approval"]);
  });

  it("LIVE mode includes the availability stage first", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, providerMode: "LIVE" });
    expect(stages.map((s) => s.key)).toEqual(["availability", "job", "run", "approval"]);
  });

  it("everything is pending before anything starts", () => {
    const stages = deriveInvestigationProgressStages(BASE);
    expect(stages.every((s) => s.status === "pending")).toBe(true);
  });

  it("marks the active stage, leaving later stages pending", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, activeStageKey: "job" });
    expect(stages.find((s) => s.key === "job")?.status).toBe("active");
    expect(stages.find((s) => s.key === "run")?.status).toBe("pending");
    expect(stages.find((s) => s.key === "approval")?.status).toBe("pending");
  });

  it("marks job completed and run active once the job exists and run is in flight", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, activeStageKey: "run", jobCreated: true });
    expect(stages.find((s) => s.key === "job")?.status).toBe("completed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("active");
  });

  it("a failed job stage blocks run at pending and drops approval entirely, even though phase is idle (activeStageKey null)", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, failedStage: "job" });
    expect(stages.find((s) => s.key === "job")?.status).toBe("failed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("pending");
    // `run` stays listed because the workflow really does contain it — it just
    // never got there. `approval` is omitted instead of listed as Pending: a
    // pending row is labelled by what it was ABOUT to do, so keeping it would
    // read "Pending — Loading approval state…" for a fetch that can no longer
    // happen. See isTerminallyFailedBeforeApproval.
    expect(stages.map((s) => s.key)).toEqual(["job", "run"]);
  });

  it("a failed run stage marks job completed and run failed", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, failedStage: "run", jobCreated: true });
    expect(stages.find((s) => s.key === "job")?.status).toBe("completed");
    expect(stages.find((s) => s.key === "run")?.status).toBe("failed");
  });

  it("LIVE availability is inferred completed once the job exists, even with no activeStageKey", () => {
    const stages = deriveInvestigationProgressStages({
      ...BASE,
      providerMode: "LIVE",
      jobCreated: true,
      failedStage: "run",
    });
    expect(stages.find((s) => s.key === "availability")?.status).toBe("completed");
  });

  describe("run stage is outcome-aware, not run!==null-aware", () => {
    it("RUNNING outcome reads Active, not Completed — approval stays Pending", () => {
      const stages = deriveInvestigationProgressStages({ ...BASE, jobCreated: true, runOutcomeType: "RUNNING" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("active");
      expect(stages.find((s) => s.key === "run")?.label).toBe("Agent investigation in progress…");
      expect(stages.find((s) => s.key === "approval")?.status).toBe("pending");
    });

    it("COMPLETED outcome reads Completed", () => {
      const stages = deriveInvestigationProgressStages({ ...BASE, jobCreated: true, runOutcomeType: "COMPLETED" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("completed");
    });

    // The production incident: a terminally FAILED run is permanently
    // approval-ineligible, and App.tsx correctly never issues the approval
    // fetch — so the Timeline must not keep advertising one.
    it("FAILED outcome reads Failed even with no failedStage set — and approval is omitted, not left Pending", () => {
      const stages = deriveInvestigationProgressStages({ ...BASE, jobCreated: true, runOutcomeType: "FAILED" });
      expect(stages.find((s) => s.key === "run")?.status).toBe("failed");
      expect(stages.map((s) => s.key)).toEqual(["job", "run"]);
      expect(stages.some((s) => s.label === "Loading approval state…")).toBe(false);
    });

    it("keeps the approval stage for an approval-load failure, which does not stop the workflow", () => {
      const stages = deriveInvestigationProgressStages({
        ...BASE,
        jobCreated: true,
        runOutcomeType: "COMPLETED",
        approvalLoadStatus: "failed",
      });
      expect(stages.find((s) => s.key === "approval")?.status).toBe("failed");
    });

    it("availability reads completed once a run exists with ANY outcome, including RUNNING", () => {
      const stages = deriveInvestigationProgressStages({
        ...BASE,
        providerMode: "LIVE",
        jobCreated: true,
        runOutcomeType: "RUNNING",
      });
      expect(stages.find((s) => s.key === "availability")?.status).toBe("completed");
    });

    it("an in-flight run request (activeStageKey) takes priority over a stale runOutcomeType", () => {
      const stages = deriveInvestigationProgressStages({
        ...BASE,
        jobCreated: true,
        activeStageKey: "run",
        runOutcomeType: null,
      });
      expect(stages.find((s) => s.key === "run")?.status).toBe("active");
    });
  });

  it("a failed availability stage leaves job/run/approval pending", () => {
    const stages = deriveInvestigationProgressStages({ ...BASE, providerMode: "LIVE", failedStage: "availability" });
    expect(stages.find((s) => s.key === "availability")?.status).toBe("failed");
    expect(stages.find((s) => s.key === "job")?.status).toBe("pending");
  });

  it("approval status is driven only by approvalLoadStatus, independent of activeStageKey", () => {
    const idle = deriveInvestigationProgressStages({ ...BASE, activeStageKey: null, approvalLoadStatus: "idle" });
    const loading = deriveInvestigationProgressStages({ ...BASE, activeStageKey: null, approvalLoadStatus: "loading" });
    const loaded = deriveInvestigationProgressStages({ ...BASE, activeStageKey: null, approvalLoadStatus: "loaded" });
    const failed = deriveInvestigationProgressStages({ ...BASE, activeStageKey: null, approvalLoadStatus: "failed" });
    expect(idle.find((s) => s.key === "approval")?.status).toBe("pending");
    expect(loading.find((s) => s.key === "approval")?.status).toBe("active");
    expect(loaded.find((s) => s.key === "approval")?.status).toBe("completed");
    expect(failed.find((s) => s.key === "approval")?.status).toBe("failed");
  });

  it("uses the completed label only once completed, and the active label otherwise", () => {
    const pending = deriveInvestigationProgressStages(BASE).find((s) => s.key === "job");
    const active = deriveInvestigationProgressStages({ ...BASE, activeStageKey: "job" }).find((s) => s.key === "job");
    const completed = deriveInvestigationProgressStages({ ...BASE, jobCreated: true, activeStageKey: "run" }).find(
      (s) => s.key === "job",
    );
    const failed = deriveInvestigationProgressStages({ ...BASE, failedStage: "job" }).find((s) => s.key === "job");
    expect(pending?.label).toBe("Creating investigation…");
    expect(active?.label).toBe("Creating investigation…");
    expect(failed?.label).toBe("Creating investigation…");
    expect(completed?.label).toBe("Investigation created");
  });
});

describe("presentInvestigationProgressStage", () => {
  it("never uses color as the only signal — every status has a distinct glyph and label", () => {
    const presentations = (["pending", "active", "completed", "failed"] as const).map((status) =>
      presentInvestigationProgressStage(status),
    );
    const glyphs = presentations.map((p) => p.glyph);
    const labels = presentations.map((p) => p.badgeLabel);
    expect(new Set(glyphs).size).toBe(4);
    expect(new Set(labels).size).toBe(4);
  });

  it("failed is danger-toned and completed is success-toned", () => {
    expect(presentInvestigationProgressStage("failed").tone).toBe("danger");
    expect(presentInvestigationProgressStage("completed").tone).toBe("success");
  });
});
