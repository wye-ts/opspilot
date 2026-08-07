import { describe, expect, it } from "vitest";
import {
  isFinalizationAuthorized,
  markFinalizationSettled,
  resolveTerminalObservation,
  type TerminalSettlementClaim,
  type TerminalSettlementIdentity,
} from "./terminal-settlement";

function makeIdentity(overrides: Partial<TerminalSettlementIdentity> = {}): TerminalSettlementIdentity {
  return {
    jobId: "job-1",
    runId: "run-1",
    attemptNumber: 1,
    generation: 3,
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TerminalSettlementClaim> = {}): TerminalSettlementClaim {
  return {
    identity: makeIdentity(),
    terminalStatus: "COMPLETED",
    phase: "finalizing",
    ...overrides,
  };
}

describe("resolveTerminalObservation", () => {
  it("returns owner when there is no prior claim", () => {
    const identity = makeIdentity();
    const { decision, nextClaim } = resolveTerminalObservation(null, identity, "COMPLETED");
    expect(decision).toEqual({ kind: "owner" });
    expect(nextClaim.identity).toEqual(identity);
    expect(nextClaim.terminalStatus).toBe("COMPLETED");
  });

  it("returns duplicate when same identity and same status", () => {
    const prior = makeClaim();
    const { decision } = resolveTerminalObservation(prior, prior.identity, "COMPLETED");
    expect(decision).toEqual({ kind: "duplicate" });
  });

  it("returns duplicate for FAILED same-status", () => {
    const prior = makeClaim({ terminalStatus: "FAILED" });
    const { decision } = resolveTerminalObservation(prior, prior.identity, "FAILED");
    expect(decision).toEqual({ kind: "duplicate" });
  });

  it("returns inconsistent-terminal-status when same identity + opposite status (COMPLETED then FAILED)", () => {
    const prior = makeClaim({ terminalStatus: "COMPLETED" });
    const { decision, nextClaim } = resolveTerminalObservation(prior, prior.identity, "FAILED");
    expect(decision).toEqual({ kind: "inconsistent-terminal-status" });
    // Prior claim is preserved — no overwrite
    expect(nextClaim.terminalStatus).toBe("COMPLETED");
  });

  it("returns inconsistent-terminal-status when same identity + opposite status (FAILED then COMPLETED)", () => {
    const prior = makeClaim({ terminalStatus: "FAILED" });
    const { decision, nextClaim } = resolveTerminalObservation(prior, prior.identity, "COMPLETED");
    expect(decision).toEqual({ kind: "inconsistent-terminal-status" });
    expect(nextClaim.terminalStatus).toBe("FAILED");
  });

  it("treats different attemptNumber as a new identity (owner)", () => {
    const prior = makeClaim();
    const newIdentity = makeIdentity({ attemptNumber: 2 });
    const { decision } = resolveTerminalObservation(prior, newIdentity, "COMPLETED");
    expect(decision).toEqual({ kind: "owner" });
  });

  it("treats different generation as a new identity (owner)", () => {
    const prior = makeClaim();
    const newIdentity = makeIdentity({ generation: 4 });
    const { decision } = resolveTerminalObservation(prior, newIdentity, "COMPLETED");
    expect(decision).toEqual({ kind: "owner" });
  });

  it("treats different jobId as a new identity (owner)", () => {
    const prior = makeClaim();
    const newIdentity = makeIdentity({ jobId: "job-2" });
    const { decision } = resolveTerminalObservation(prior, newIdentity, "COMPLETED");
    expect(decision).toEqual({ kind: "owner" });
  });

  it("a new owner claim starts in phase 'finalizing'", () => {
    const identity = makeIdentity();
    const { nextClaim } = resolveTerminalObservation(null, identity, "COMPLETED");
    expect(nextClaim.phase).toBe("finalizing");
  });

  it("marks the claim 'inconsistent' on a contradiction, preserving the first status", () => {
    const prior = makeClaim({ terminalStatus: "FAILED", phase: "finalizing" });
    const { nextClaim } = resolveTerminalObservation(prior, prior.identity, "COMPLETED");
    expect(nextClaim.phase).toBe("inconsistent");
    expect(nextClaim.terminalStatus).toBe("FAILED");
  });

  it("returns 'already-inconsistent' for any further observation once an identity is marked inconsistent — matching status", () => {
    const inconsistentClaim = makeClaim({ terminalStatus: "FAILED", phase: "inconsistent" });
    const { decision, nextClaim } = resolveTerminalObservation(inconsistentClaim, inconsistentClaim.identity, "FAILED");
    expect(decision).toEqual({ kind: "already-inconsistent" });
    expect(nextClaim).toBe(inconsistentClaim);
  });

  it("returns 'already-inconsistent' for any further observation once an identity is marked inconsistent — opposite status", () => {
    const inconsistentClaim = makeClaim({ terminalStatus: "FAILED", phase: "inconsistent" });
    const { decision, nextClaim } = resolveTerminalObservation(inconsistentClaim, inconsistentClaim.identity, "COMPLETED");
    expect(decision).toEqual({ kind: "already-inconsistent" });
    expect(nextClaim).toBe(inconsistentClaim);
  });
});

describe("isFinalizationAuthorized", () => {
  it("is false when there is no claim at all", () => {
    expect(isFinalizationAuthorized(null, makeIdentity())).toBe(false);
  });

  it("is true for a matching identity still 'finalizing'", () => {
    const claim = makeClaim({ phase: "finalizing" });
    expect(isFinalizationAuthorized(claim, claim.identity)).toBe(true);
  });

  it("is true for a matching identity already 'settled'", () => {
    const claim = makeClaim({ phase: "settled" });
    expect(isFinalizationAuthorized(claim, claim.identity)).toBe(true);
  });

  it("is false for a matching identity marked 'inconsistent'", () => {
    const claim = makeClaim({ phase: "inconsistent" });
    expect(isFinalizationAuthorized(claim, claim.identity)).toBe(false);
  });

  it("is false when the identity no longer matches (a different claim now owns the ref)", () => {
    const claim = makeClaim({ identity: makeIdentity({ attemptNumber: 2 }) });
    expect(isFinalizationAuthorized(claim, makeIdentity({ attemptNumber: 1 }))).toBe(false);
  });
});

describe("markFinalizationSettled", () => {
  it("transitions an authorized 'finalizing' claim to 'settled'", () => {
    const claim = makeClaim({ phase: "finalizing" });
    const next = markFinalizationSettled(claim, claim.identity);
    expect(next?.phase).toBe("settled");
  });

  it("is a no-op when the claim is null", () => {
    expect(markFinalizationSettled(null, makeIdentity())).toBeNull();
  });

  it("is a no-op (never resurrects) when the claim was marked inconsistent during finalization", () => {
    const claim = makeClaim({ phase: "inconsistent", terminalStatus: "FAILED" });
    const next = markFinalizationSettled(claim, claim.identity);
    expect(next).toBe(claim);
    expect(next?.phase).toBe("inconsistent");
  });

  it("is a no-op when the identity no longer matches", () => {
    const claim = makeClaim({ identity: makeIdentity({ attemptNumber: 2 }), phase: "finalizing" });
    const next = markFinalizationSettled(claim, makeIdentity({ attemptNumber: 1 }));
    expect(next).toBe(claim);
  });
});
