import { describe, expect, it } from "vitest";

import { resolveAbortProvenance, type RunAbortContext } from "./run-abort-context";

function context(overrides: { deadline?: boolean; disconnect?: boolean } = {}): RunAbortContext {
  const deadlineSignal = overrides.deadline === true ? AbortSignal.abort() : new AbortController().signal;
  const disconnectSignal =
    overrides.disconnect === true ? AbortSignal.abort() : new AbortController().signal;

  return {
    deadlineSignal,
    disconnectSignal,
    signal: AbortSignal.any([deadlineSignal, disconnectSignal]),
  };
}

describe("resolveAbortProvenance", () => {
  it("reports a timeout when the deadline fired", () => {
    // The provider saw a user abort and could only call it CANCELLED; the
    // deadline signal is the only thing that knows better.
    expect(resolveAbortProvenance("PROVIDER_CANCELLED", context({ deadline: true }))).toBe(
      "PROVIDER_TIMEOUT",
    );
  });

  it("reports a cancellation when only the caller went away", () => {
    expect(resolveAbortProvenance("PROVIDER_CANCELLED", context({ disconnect: true }))).toBe(
      "PROVIDER_CANCELLED",
    );
  });

  it("gives the deadline precedence when both fired", () => {
    // A documented, deterministic tie-break: a run that blew its budget and
    // also lost its client is a timeout. The disconnect is usually the
    // consequence — a caller giving up — not an independent cause.
    expect(resolveAbortProvenance("PROVIDER_CANCELLED", context({ deadline: true, disconnect: true }))).toBe(
      "PROVIDER_TIMEOUT",
    );
  });

  it("preserves a provider-native timeout when neither outer signal fired", () => {
    // The SDK's own per-attempt timeout, with the caller still waiting and the
    // budget unspent. Nothing to correct.
    expect(resolveAbortProvenance("PROVIDER_TIMEOUT", context())).toBe("PROVIDER_TIMEOUT");
    expect(resolveAbortProvenance("PROVIDER_CANCELLED", context())).toBe("PROVIDER_CANCELLED");
  });

  it("leaves a non-abort failure alone even when the deadline fired", () => {
    // The narrow-scope rule. Tools are not cancellable in this milestone, so a
    // tool failure can easily be followed by the deadline expiring. Rewriting
    // it as a timeout would bury the actual cause.
    const expired = context({ deadline: true });

    expect(resolveAbortProvenance("TOOL_EXECUTION_FAILED", expired)).toBe("TOOL_EXECUTION_FAILED");
    expect(resolveAbortProvenance("REPORT_SCHEMA_INVALID", expired)).toBe("REPORT_SCHEMA_INVALID");
    expect(resolveAbortProvenance("PROVIDER_UNAVAILABLE", expired)).toBe("PROVIDER_UNAVAILABLE");
  });

  it("is a no-op without a context, as on the FAKE path", () => {
    expect(resolveAbortProvenance("PROVIDER_CANCELLED", undefined)).toBe("PROVIDER_CANCELLED");
    expect(resolveAbortProvenance("TOOL_NOT_FOUND", undefined)).toBe("TOOL_NOT_FOUND");
  });
});
