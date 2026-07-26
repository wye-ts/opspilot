import { describe, expect, it } from "vitest";

import { runStatusBadge } from "./run-overview-presentation";

describe("runStatusBadge", () => {
  it("maps COMPLETED to success/check", () => {
    expect(runStatusBadge("COMPLETED")).toEqual({ tone: "success", glyph: "✓" });
  });

  it("maps FAILED to danger/cross", () => {
    expect(runStatusBadge("FAILED")).toEqual({ tone: "danger", glyph: "✕" });
  });

  it("maps RUNNING to info/dot", () => {
    expect(runStatusBadge("RUNNING")).toEqual({ tone: "info", glyph: "●" });
  });

  it("falls back to neutral/dash for an unrecognized status", () => {
    expect(runStatusBadge("SOMETHING_UNEXPECTED")).toEqual({ tone: "neutral", glyph: "—" });
  });
});
