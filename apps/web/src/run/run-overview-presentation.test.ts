import { describe, expect, it } from "vitest";

import { runStatusBadge } from "./run-overview-presentation";

describe("runStatusBadge", () => {
  it("maps COMPLETED to success/check/Completed", () => {
    expect(runStatusBadge("COMPLETED")).toEqual({ tone: "success", glyph: "✓", label: "Completed" });
  });

  it("maps FAILED to danger/cross/Failed", () => {
    expect(runStatusBadge("FAILED")).toEqual({ tone: "danger", glyph: "✕", label: "Failed" });
  });

  it("maps RUNNING to info/dot/Running", () => {
    expect(runStatusBadge("RUNNING")).toEqual({ tone: "info", glyph: "●", label: "Running" });
  });

  it("falls back to neutral/dash/raw-status for an unrecognized status", () => {
    expect(runStatusBadge("SOMETHING_UNEXPECTED")).toEqual({
      tone: "neutral",
      glyph: "—",
      label: "SOMETHING_UNEXPECTED",
    });
  });
});
