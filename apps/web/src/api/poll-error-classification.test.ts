import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./http-client";
import { classifyInvestigationPollError } from "./poll-error-classification";

describe("classifyInvestigationPollError", () => {
  it("AGENT_JOB_NOT_FOUND → not-found", () => {
    const error = new ApiRequestError(404, "AGENT_JOB_NOT_FOUND", "no job", "req-1");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "not-found" });
  });

  it("INTERNAL_DATA_INVALID → data-corrupt", () => {
    const error = new ApiRequestError(500, "INTERNAL_DATA_INVALID", "corrupt", "req-2");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "data-corrupt" });
  });

  it("ROUTE_PARAMETER_INVALID → permanent-invalid", () => {
    const error = new ApiRequestError(400, "ROUTE_PARAMETER_INVALID", "bad uuid", "req-3");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "permanent-invalid" });
  });

  it("PERSISTENCE_UNAVAILABLE → transient", () => {
    const error = new ApiRequestError(503, "PERSISTENCE_UNAVAILABLE", "db down", "req-4");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "transient" });
  });

  it("unmapped 5xx → transient", () => {
    const error = new ApiRequestError(502, "BAD_GATEWAY", "boom", "req-5");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "transient" });
  });

  it("unmapped 4xx → permanent-invalid", () => {
    const error = new ApiRequestError(410, "GONE", "gone", "req-6");
    expect(classifyInvestigationPollError(error)).toEqual({ kind: "permanent-invalid" });
  });

  it("plain network throw (not ApiRequestError) → transient", () => {
    expect(classifyInvestigationPollError(new Error("fetch failed"))).toEqual({
      kind: "transient",
    });
    expect(classifyInvestigationPollError("string error")).toEqual({ kind: "transient" });
    expect(classifyInvestigationPollError(null)).toEqual({ kind: "transient" });
  });
});
