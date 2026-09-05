import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createPrismaClient, type PrismaClient, type PrismaClientHandle } from "../client";
import { AgentRunApprovalError } from "../approval-errors";
import type { RecordApprovalDecisionResult } from "../types";
import { createTestPrismaClient, truncateAllTables } from "../test/test-db";
import { appendDirectSuccessPrefix, appendFailurePrefix } from "../test/canonical-stream";
import { createJob, finalizeCompleted, finalizeFailed, startRun } from "./agent-run-repository";
import { getApprovalDecision, recordApprovalDecision } from "./agent-run-approval-repository";

// Issue #59 Checkpoint B §10 — the shared reachable approval-eligibility
// matrix consumed by BOTH the repository parity (this file) and the
// evaluator parity (apps/worker/src/evaluation/approval-parity.test.ts).
// This package compiles to CommonJS, where `import.meta` is a compile error
// (TS1470) and vite-node does not reliably provide `__dirname`; the package
// root is the working directory under both `pnpm --filter ... run test` and
// the recursive root `pnpm test` (same convention as
// packages/provider-claude/src/module-boundary.test.ts).
const APPROVAL_ELIGIBILITY_FIXTURE_PATH = join(
  process.cwd(),
  "src",
  "test",
  "approval-eligibility-vectors.json",
);

interface ApprovalEligibilityVector {
  readonly id: string;
  readonly runStatus: "RUNNING" | "COMPLETED" | "FAILED";
  readonly suggestedActionCount: number;
  readonly expectedRepositoryEligibility: "ELIGIBLE" | "NOT_ELIGIBLE";
  readonly evaluationObservable: boolean;
}

function loadApprovalEligibilityFixture(): { readonly vectors: readonly ApprovalEligibilityVector[] } {
  return JSON.parse(readFileSync(APPROVAL_ELIGIBILITY_FIXTURE_PATH, "utf8")) as unknown as {
    readonly vectors: readonly ApprovalEligibilityVector[];
  };
}

// Issue #60 Checkpoint B (§6): approval fixtures carry the full new-write #60
// contract. The eligible report is ACTIONABLE with a grounded DRAFT_CUSTOMER_REPLY
// action (groundedBy cites e-1, present in report.evidence); the ineligible
// variant is ADVISORY with zero actions.
const ELIGIBLE_REPORT = {
  category: "UNKNOWN",
  summary: "A diagnostic check was performed.",
  rootCause: "Root cause.",
  customerImpact: "Impact.",
  recommendedResolution: "Draft a customer-facing reply acknowledging the diagnostic check for a human to review.",
  confidence: 0.5,
  evidence: [
    // Issue #55 §2.2b: rootCause is non-null, so at least one entry must
    // declare ROOT_CAUSE support on write.
    { evidenceId: "e-1", sourceType: "TOOL_EXECUTION", finding: "f", supports: ["ROOT_CAUSE"] },
  ],
  evidenceState: "SUFFICIENT",
  recommendationDisposition: "ACTIONABLE",
  suggestedActions: [
    {
      type: "DRAFT_CUSTOMER_REPLY",
      payload: { subject: "Update", body: "A human will follow up." },
      groundedBy: [{ evidenceId: "e-1", sourceType: "TOOL_EXECUTION" }],
    },
  ],
};

const EMPTY_ACTIONS_REPORT = {
  ...ELIGIBLE_REPORT,
  suggestedActions: [],
  recommendationDisposition: "ADVISORY",
};


let handle: PrismaClientHandle;
let prisma: PrismaClient;

beforeAll(async () => {
  handle = await createTestPrismaClient();
  prisma = handle.prisma;
});

afterAll(async () => {
  await handle.close();
});

afterEach(async () => {
  await truncateAllTables(handle);
});

async function createEligibleCompletedRun(client: PrismaClient = prisma) {
  const job = await createJob(client, { ticketId: "TKT-approval-eligible", summary: "Approval eligible run" });
  const started = await startRun(client, job.id, "FAKE", null);
  await appendDirectSuccessPrefix(client, started.run.id);
  const run = await finalizeCompleted(client, started.run.id, ELIGIBLE_REPORT);
  return { job, run };
}

async function createIneligibleEmptyActionsRun(client: PrismaClient = prisma) {
  const job = await createJob(client, { ticketId: "TKT-approval-empty", summary: "Approval empty actions run" });
  const started = await startRun(client, job.id, "FAKE", null);
  await appendDirectSuccessPrefix(client, started.run.id);
  const run = await finalizeCompleted(client, started.run.id, EMPTY_ACTIONS_REPORT);
  return { job, run };
}

async function createRunningRun(client: PrismaClient = prisma) {
  const job = await createJob(client, { ticketId: "TKT-approval-running", summary: "Approval running run" });
  const started = await startRun(client, job.id, "FAKE", null);
  return { job, run: started.run };
}

async function createFailedRun(client: PrismaClient = prisma) {
  const job = await createJob(client, { ticketId: "TKT-approval-failed", summary: "Approval failed run" });
  const started = await startRun(client, job.id, "FAKE", null);
  const failedStage = await appendFailurePrefix(client, started.run.id, "TOOL_NOT_FOUND");
  const run = await finalizeFailed(client, started.run.id, "TOOL_NOT_FOUND", failedStage);
  return { job, run };
}

describe("recordApprovalDecision", () => {
  it("creates an APPROVED decision on an eligible run", async () => {
    const { run } = await createEligibleCompletedRun();
    const result = await recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" });
    expect(result.outcome).toBe("created");
    expect(result.view.status).toBe("APPROVED");
    expect(result.view.reviewerName).toBe("jacky");
    expect(result.view.note).toBeNull();
    expect(result.view.decidedAt).toBeInstanceOf(Date);
  });

  it("creates a REJECTED decision on an eligible run", async () => {
    const { run } = await createEligibleCompletedRun();
    const result = await recordApprovalDecision(prisma, run.id, { decision: "REJECTED", reviewerName: "jacky" });
    expect(result.outcome).toBe("created");
    expect(result.view.status).toBe("REJECTED");
  });

  it("replays an identical decision idempotently, with zero new rows and the same decidedAt", async () => {
    const { run } = await createEligibleCompletedRun();
    const input = { decision: "APPROVED" as const, reviewerName: "jacky", note: "Looks correct." };
    const first = await recordApprovalDecision(prisma, run.id, input);
    const second = await recordApprovalDecision(prisma, run.id, input);
    expect(first.outcome).toBe("created");
    expect(second.outcome).toBe("replayed");
    expect(second.view.decidedAt).toEqual(first.view.decidedAt);
    const rows = await prisma.agentRunApproval.findMany({ where: { runId: run.id } });
    expect(rows).toHaveLength(1);
  });

  it("conflicts when the same decision is replayed with a different note", async () => {
    const { run } = await createEligibleCompletedRun();
    await recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky", note: "a" });
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky", note: "b" }),
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });
  });

  it("conflicts when the same decision is replayed with a different reviewer", async () => {
    const { run } = await createEligibleCompletedRun();
    await recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" });
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "someone-else" }),
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });
  });

  it("conflicts on the opposite decision", async () => {
    const { run } = await createEligibleCompletedRun();
    await recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" });
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "REJECTED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });
  });

  it("returns PERSISTENCE_NOT_FOUND for a nonexistent run", async () => {
    await expect(
      recordApprovalDecision(prisma, "00000000-0000-0000-0000-000000000000", {
        decision: "APPROVED",
        reviewerName: "jacky",
      }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_NOT_FOUND" });
  });

  it("rejects a RUNNING run as not approval-eligible", async () => {
    const { run } = await createRunningRun();
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "RUN_NOT_APPROVAL_ELIGIBLE" });
  });

  it("rejects a FAILED run as not approval-eligible", async () => {
    const { run } = await createFailedRun();
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "RUN_NOT_APPROVAL_ELIGIBLE" });
  });

  it("rejects a COMPLETED run with an empty suggestedActions array as not approval-eligible", async () => {
    const { run } = await createIneligibleEmptyActionsRun();
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "RUN_NOT_APPROVAL_ELIGIBLE" });
  });

  it("rejects a malformed input before opening any transaction — distinct from the mid-transaction rollback test below", async () => {
    const { run } = await createEligibleCompletedRun();
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "MAYBE" } as never),
    ).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
    const count = await prisma.agentRunApproval.count({ where: { runId: run.id } });
    expect(count).toBe(0);
  });
});

describe("getApprovalDecision", () => {
  it("returns NOT_ELIGIBLE for a RUNNING run", async () => {
    const { run } = await createRunningRun();
    const view = await getApprovalDecision(prisma, run.id);
    expect(view).toEqual({
      runId: run.id,
      status: "NOT_ELIGIBLE",
      reviewerName: null,
      note: null,
      decidedAt: null,
    });
  });

  it("returns NOT_ELIGIBLE for a FAILED run", async () => {
    const { run } = await createFailedRun();
    const view = await getApprovalDecision(prisma, run.id);
    expect(view.status).toBe("NOT_ELIGIBLE");
  });

  it("returns NOT_ELIGIBLE for a COMPLETED run with an empty suggestedActions array", async () => {
    const { run } = await createIneligibleEmptyActionsRun();
    const view = await getApprovalDecision(prisma, run.id);
    expect(view.status).toBe("NOT_ELIGIBLE");
  });

  it("returns PENDING for an eligible, undecided run", async () => {
    const { run } = await createEligibleCompletedRun();
    const view = await getApprovalDecision(prisma, run.id);
    expect(view.status).toBe("PENDING");
  });

  it("returns APPROVED after a decision is recorded", async () => {
    const { run } = await createEligibleCompletedRun();
    await recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" });
    const view = await getApprovalDecision(prisma, run.id);
    expect(view.status).toBe("APPROVED");
    expect(view.reviewerName).toBe("jacky");
  });

  it("returns REJECTED after a decision is recorded", async () => {
    const { run } = await createEligibleCompletedRun();
    await recordApprovalDecision(prisma, run.id, { decision: "REJECTED", reviewerName: "jacky" });
    const view = await getApprovalDecision(prisma, run.id);
    expect(view.status).toBe("REJECTED");
  });

  it("returns PERSISTENCE_NOT_FOUND for a nonexistent run", async () => {
    await expect(getApprovalDecision(prisma, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({
      code: "PERSISTENCE_NOT_FOUND",
    });
  });

  it("reflects a decision recorded via a different app instance (cross-client persistence)", async () => {
    const { run } = await createEligibleCompletedRun();
    const second = createPrismaClient();
    try {
      await recordApprovalDecision(second.prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" });
      const view = await getApprovalDecision(prisma, run.id);
      expect(view.status).toBe("APPROVED");
      expect(view.reviewerName).toBe("jacky");
    } finally {
      await second.close();
    }
  });
});

describe("concurrency", () => {
  it("conflicting concurrent decisions: exactly one created, one APPROVAL_ALREADY_DECIDED, exactly one row persisted", async () => {
    const { run } = await createEligibleCompletedRun();
    const second = createPrismaClient();
    try {
      const results = await Promise.allSettled([
        recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "a" }),
        recordApprovalDecision(second.prisma, run.id, { decision: "REJECTED", reviewerName: "b" }),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<RecordApprovalDecisionResult> => r.status === "fulfilled",
      );
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(fulfilled[0]?.value.outcome).toBe("created");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(AgentRunApprovalError);
      expect(rejected[0]?.reason).toMatchObject({ code: "APPROVAL_ALREADY_DECIDED" });

      const count = await prisma.agentRunApproval.count({ where: { runId: run.id } });
      expect(count).toBe(1);
    } finally {
      await second.close();
    }
  });

  it("identical concurrent decisions: exactly one created, one replayed, exactly one row, same decidedAt", async () => {
    const { run } = await createEligibleCompletedRun();
    const second = createPrismaClient();
    try {
      const input = { decision: "APPROVED" as const, reviewerName: "jacky" };
      const results = await Promise.allSettled([
        recordApprovalDecision(prisma, run.id, input),
        recordApprovalDecision(second.prisma, run.id, input),
      ]);
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const fulfilled = results as PromiseFulfilledResult<RecordApprovalDecisionResult>[];
      const outcomes = fulfilled.map((r) => r.value.outcome).sort();
      expect(outcomes).toEqual(["created", "replayed"]);

      const rows = await prisma.agentRunApproval.findMany({ where: { runId: run.id } });
      expect(rows).toHaveLength(1);

      const decidedAts = fulfilled.map((r) => r.value.view.decidedAt?.toISOString());
      expect(decidedAts[0]).toBe(decidedAts[1]);
    } finally {
      await second.close();
    }
  });
});

describe("stored-row corruption (raw SQL bypass, real Postgres)", () => {
  it("getApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when an approval row exists for a RUNNING run", async () => {
    const { run } = await createRunningRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;
    await expect(getApprovalDecision(prisma, run.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });

  it("recordApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when called against a RUNNING run that already has a raw-inserted approval row", async () => {
    const { run } = await createRunningRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
  });

  it("recordApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when called against a FAILED run that already has a raw-inserted approval row", async () => {
    const { run } = await createFailedRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
  });

  it("recordApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when called against a COMPLETED empty-actions run that already has a raw-inserted approval row", async () => {
    const { run } = await createIneligibleEmptyActionsRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky')`;
    await expect(
      recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
    ).rejects.toMatchObject({ code: "PERSISTENCE_VALIDATION_FAILED" });
  });

  it("getApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when the stored reviewer_name exceeds 100 characters", async () => {
    const { run } = await createEligibleCompletedRun();
    const overlong = "a".repeat(101);
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', ${overlong})`;
    await expect(getApprovalDecision(prisma, run.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });

  it("getApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when the stored note exceeds 1000 characters", async () => {
    const { run } = await createEligibleCompletedRun();
    const overlong = "a".repeat(1001);
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name, note)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky', ${overlong})`;
    await expect(getApprovalDecision(prisma, run.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });

  it("getApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when the stored reviewer_name has leading/trailing whitespace", async () => {
    const { run } = await createEligibleCompletedRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name)
      VALUES (${run.id}::uuid, 'APPROVED', ' jacky ')`;
    await expect(getApprovalDecision(prisma, run.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });

  it("getApprovalDecision throws PERSISTENCE_VALIDATION_FAILED when the stored note has leading/trailing whitespace", async () => {
    const { run } = await createEligibleCompletedRun();
    await prisma.$executeRaw`INSERT INTO agent_run_approvals (run_id, decision, reviewer_name, note)
      VALUES (${run.id}::uuid, 'APPROVED', 'jacky', ' note ')`;
    await expect(getApprovalDecision(prisma, run.id)).rejects.toMatchObject({
      code: "PERSISTENCE_VALIDATION_FAILED",
    });
  });
});

// Issue #59 Checkpoint B §10.1 — repository side of the approval-eligibility
// parity. Seeds each reachable vector through the normal lifecycle APIs
// (createJob -> startRun -> finalizeCompleted/finalizeFailed, never raw SQL)
// and asserts the real PostgreSQL repository's getApprovalDecision eligibility
// agrees with the shared fixture. This is the side that executes actual
// persistence behavior.
describe("approval eligibility parity — shared fixture vs real PostgreSQL repository (§10.1)", () => {
  const fixture = loadApprovalEligibilityFixture();

  it("the fixture covers exactly the four minimum reachable matrix rows", () => {
    expect(fixture.vectors).toHaveLength(4);
    expect(
      fixture.vectors.map((vector) => `${vector.runStatus}+${vector.suggestedActionCount}`),
    ).toEqual(["RUNNING+0", "COMPLETED+0", "COMPLETED+1", "FAILED+0"]);
    // RUNNING is repository-only: it is not observable by offline evaluation.
    const running = fixture.vectors.find((vector) => vector.runStatus === "RUNNING");
    expect(running?.evaluationObservable).toBe(false);
  });

  it("repository eligibility agrees with the shared fixture for every reachable vector", async () => {
    for (const vector of fixture.vectors) {
      let runId: string;
      if (vector.runStatus === "RUNNING") {
        ({ run: { id: runId } } = await createRunningRun());
      } else if (vector.runStatus === "FAILED") {
        ({ run: { id: runId } } = await createFailedRun());
      } else if (vector.suggestedActionCount >= 1) {
        ({ run: { id: runId } } = await createEligibleCompletedRun());
      } else {
        ({ run: { id: runId } } = await createIneligibleEmptyActionsRun());
      }

      const view = await getApprovalDecision(prisma, runId);
      const repositoryEligible = view.status === "PENDING";
      expect(repositoryEligible, `repository eligible (${vector.id})`).toBe(
        vector.expectedRepositoryEligibility === "ELIGIBLE",
      );
      // The surfaced status is exactly the fixture's declared eligibility:
      // PENDING for an eligible undecided run, NOT_ELIGIBLE otherwise.
      expect(view.status, `view.status (${vector.id})`).toBe(
        vector.expectedRepositoryEligibility === "ELIGIBLE" ? "PENDING" : "NOT_ELIGIBLE",
      );
    }
  });
});

describe("mid-transaction rollback", () => {
  it("a real PostgreSQL failure after the approval INSERT rolls back the entire transaction, leaving no approval row and the AgentRun's full snapshot unchanged", async () => {
    const { run } = await createEligibleCompletedRun();

    // Full pre-attempt snapshot of the AgentRun row, captured before the
    // trigger even exists. recordApprovalDecision never writes to agent_runs
    // at all, so this is a change-detector across every column that could
    // conceivably be affected by a bug in this transaction: status, report,
    // failureCode, startedAt, finishedAt, attemptNumber, providerMode, and
    // modelIdentifier.
    const before = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });

    // Defensively drop any same-named trigger/function left behind by a prior
    // failed run of this test, before creating this test's own.
    await prisma.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS test_only_fail_agent_run_approvals_insert_trigger ON agent_run_approvals`,
    );
    await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_only_fail_agent_run_approvals_insert()`);

    // Test-only trigger/function, created and dropped entirely within this
    // test — not a production failure-injection hook. Fires AFTER the INSERT
    // into agent_run_approvals already ran inside the transaction, so a
    // rollback here proves real transactional atomicity, not pre-transaction
    // validation (see the "rejects a malformed input before opening any
    // transaction" test above, which has nothing to roll back).
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_only_fail_agent_run_approvals_insert()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'test-injected failure: agent_run_approvals insert';
      END;
      $$ LANGUAGE plpgsql;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_only_fail_agent_run_approvals_insert_trigger
      AFTER INSERT ON agent_run_approvals
      FOR EACH ROW
      EXECUTE FUNCTION test_only_fail_agent_run_approvals_insert();
    `);

    try {
      await expect(
        recordApprovalDecision(prisma, run.id, { decision: "APPROVED", reviewerName: "jacky" }),
      ).rejects.toBeTruthy();

      const count = await prisma.agentRunApproval.count({ where: { runId: run.id } });
      expect(count).toBe(0);

      const after = await prisma.agentRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(after).toEqual(before);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS test_only_fail_agent_run_approvals_insert_trigger ON agent_run_approvals`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_only_fail_agent_run_approvals_insert()`);
    }
  });
});
