import { describe, expect, it } from "vitest";
import type { InvestigationStateResponse } from "../api/types";
import { isNewerInvestigationSnapshot } from "./investigation-snapshot";

const JOB_ID = "0313ac34-6394-4f6d-9be1-ec277daa69dd";
const RUN_ID = "834cb857-2832-410e-ba3e-a10574a42a6d";

function makeSnapshot(overrides: Partial<InvestigationStateResponse> = {}): InvestigationStateResponse {
  return {
    job: { id: JOB_ID, ticketId: "TKT-1", summary: "Test summary here", createdAt: "2026-01-01T00:00:00.000Z" },
    run: {
      id: RUN_ID,
      jobId: JOB_ID,
      attemptNumber: 1,
      status: "RUNNING",
      providerMode: "FAKE",
      modelIdentifier: null,
      startedAt: "2026-01-01T00:01:00.000Z",
      finishedAt: null,
      createdAt: "2026-01-01T00:01:00.000Z",
      estimatedCostUsd: null,
    },
    trace: [],
    outcome: { type: "RUNNING" },
    events: [{ runId: RUN_ID, sequence: 1, recordedAt: "2026-01-01T00:01:00.000Z", payload: { type: "RUN_CREATED" } }],
    ...overrides,
  };
}

const CURRENT_JOB_ID = JOB_ID;
const CURRENT_GEN = 2;
const MIN_ATTEMPT = 1;

describe("isNewerInvestigationSnapshot", () => {
  it("accepts a snapshot with more events for the same run", () => {
    const current = makeSnapshot({ events: [] });
    const incoming = makeSnapshot();
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, CURRENT_GEN)).toBe(true);
  });

  it("rejects a stale poll generation", () => {
    const current = makeSnapshot();
    const incoming = makeSnapshot();
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, 1)).toBe(false);
  });

  it("rejects a different job", () => {
    const current = makeSnapshot();
    const incoming = makeSnapshot({ job: { ...makeSnapshot().job, id: "other-job" } });
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, CURRENT_GEN)).toBe(false);
  });

  it("rejects incoming with null run when current has a run", () => {
    const current = makeSnapshot();
    const incoming = makeSnapshot({ run: null, outcome: null, events: [] });
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, CURRENT_GEN)).toBe(false);
  });

  it("rejects incoming with lower attempt number than the floor", () => {
    const current = makeSnapshot();
    const incoming = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 1 } });
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, 2, incoming, CURRENT_GEN)).toBe(false);
  });

  it("rejects RUNNING incoming when current is already terminal", () => {
    const current = makeSnapshot({ run: { ...makeSnapshot().run!, status: "COMPLETED", finishedAt: "2026-01-01T00:02:00.000Z" }, outcome: { type: "COMPLETED", report: {} as any } });
    const incoming = makeSnapshot(); // still RUNNING
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, CURRENT_GEN)).toBe(false);
  });

  it("rejects incoming with fewer events for the same runId", () => {
    const current = makeSnapshot({ events: [makeSnapshot().events[0]!, makeSnapshot().events[0]!] });
    const incoming = makeSnapshot({ events: [makeSnapshot().events[0]!] });
    expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, MIN_ATTEMPT, incoming, CURRENT_GEN)).toBe(false);
  });

  // Finding 3: current-attempt monotonicity, independent of minAttemptNumber.
  describe("current-attempt monotonicity (independent of minAttemptNumber)", () => {
    it("rejects an incoming attempt below the CURRENTLY HELD attempt, even when it clears the floor", () => {
      const current = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 2 } });
      const incoming = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 1 } });
      // floor is 1 — attempt 1 clears the floor, but must still be rejected
      // because the CURRENT held run is already at attempt 2.
      expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, 1, incoming, CURRENT_GEN)).toBe(false);
    });

    it("allows an incoming snapshot at the SAME attempt as current — normal comparison continues", () => {
      const current = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 2 }, events: [] });
      const incoming = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 2 } });
      expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, 1, incoming, CURRENT_GEN)).toBe(true);
    });

    it("allows an incoming attempt ABOVE the currently held attempt", () => {
      const current = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 1 } });
      const incoming = makeSnapshot({ run: { ...makeSnapshot().run!, attemptNumber: 2 } });
      expect(isNewerInvestigationSnapshot(current, CURRENT_JOB_ID, CURRENT_GEN, 1, incoming, CURRENT_GEN)).toBe(true);
    });
  });
});
