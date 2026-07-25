import { describe, expect, it } from "vitest";

import { formatDateTime, formatDuration } from "./datetime";

describe("formatDateTime", () => {
  it("renders a valid ISO string", () => {
    const result = formatDateTime("2026-07-23T10:15:00.000Z");
    expect(result).not.toBe("—");
    expect(result.length).toBeGreaterThan(0);
  });

  it("renders the placeholder for null", () => {
    expect(formatDateTime(null)).toBe("—");
  });

  it("renders the placeholder for an unparseable string, never Invalid Date", () => {
    const result = formatDateTime("not-a-date");
    expect(result).toBe("—");
    expect(result).not.toMatch(/invalid/i);
  });
});

describe("formatDuration", () => {
  it("computes a sub-minute duration in seconds", () => {
    expect(formatDuration("2026-07-23T10:15:00.000Z", "2026-07-23T10:15:07.000Z")).toBe("7s");
  });

  it("computes a multi-minute duration", () => {
    expect(formatDuration("2026-07-23T10:15:00.000Z", "2026-07-23T10:17:05.000Z")).toBe("2m 5s");
  });

  it("returns the placeholder when finishedAt is null", () => {
    expect(formatDuration("2026-07-23T10:15:00.000Z", null)).toBe("—");
  });

  it("returns the placeholder for unparseable input", () => {
    expect(formatDuration("nope", "2026-07-23T10:15:00.000Z")).toBe("—");
  });
});
