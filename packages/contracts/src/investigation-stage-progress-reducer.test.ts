import { describe, expect, it } from "vitest";

import { AgentOrchestratorErrorCodeSchema } from "./agent-orchestrator";
import { ExecutionStageProgressListSchema } from "./investigation-execution-stage";
import type { InvestigationEventRecord, InvestigationEventRecordPayload } from "./investigation-event";
import {
  InvestigationEventContractError,
  deriveExecutionStageProgress,
  type DeriveExecutionStageProgressInput,
  type InvestigationEventContractErrorCode,
} from "./investigation-stage-progress-reducer";

const RUN_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_RUN_ID = "33333333-3333-4333-8333-333333333333";
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

function at(offsetSeconds: number): string {
  return new Date(T0 + offsetSeconds * 1000).toISOString();
}

/** Builds a record; `sequence` is assigned positionally by `stream` below. */
function ev(payload: InvestigationEventRecordPayload, offsetSeconds: number) {
  return { payload, offsetSeconds };
}

function stream(
  entries: readonly { payload: InvestigationEventRecordPayload; offsetSeconds: number }[],
  runId = RUN_ID,
): InvestigationEventRecord[] {
  return entries.map((entry, index) => ({
    runId,
    sequence: index + 1,
    recordedAt: at(entry.offsetSeconds),
    payload: entry.payload,
  }));
}

function derive(input: Partial<DeriveExecutionStageProgressInput> & { events: readonly InvestigationEventRecord[] }) {
  return deriveExecutionStageProgress({
    runStatus: "RUNNING",
    now: at(100),
    ...input,
  });
}

/** Asserts the exact typed contract-error code, never a broad `.toThrow()`. */
function expectCode(
  run: () => unknown,
  expected: InvestigationEventContractErrorCode,
): InvestigationEventContractError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${expected} but nothing was thrown`).toBeInstanceOf(
    InvestigationEventContractError,
  );
  const error = caught as InvestigationEventContractError;
  expect(error.code).toBe(expected);
  return error;
}

function stage(progress: readonly { key: string }[], key: string) {
  const found = progress.find((entry) => entry.key === key);
  if (!found) throw new Error(`no progress entry for ${key}`);
  return found as (typeof progress)[number] & {
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    elapsedMs: number | null;
    failureCode?: string;
  };
}

// ── Canonical happy paths ────────────────────────────────────────────────

const NO_TOOL_SUCCESS = [
  ev({ type: "RUN_CREATED" }, 0),
  ev({ type: "AGENT_STARTED" }, 1),
  ev({ type: "REPORT_SUBMITTED" }, 5),
  ev({ type: "REPORT_VALIDATED" }, 6),
  ev({ type: "RUN_COMPLETED" }, 6),
];

const ONE_TOOL_SUCCESS = [
  ev({ type: "RUN_CREATED" }, 0),
  ev({ type: "AGENT_STARTED" }, 1),
  ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 2),
  ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" }, 3),
  ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "check_status" }, 4),
  ev({ type: "REPORT_GENERATION_STARTED" }, 5),
  ev({ type: "REPORT_SUBMITTED" }, 9),
  ev({ type: "REPORT_VALIDATED" }, 10),
  ev({ type: "RUN_COMPLETED" }, 10),
];

describe("successful runs", () => {
  it("no-tool success omits DIAGNOSTIC_EXECUTION rather than leaving it pending", () => {
    const progress = derive({
      events: stream(NO_TOOL_SUCCESS),
      runStatus: "COMPLETED",
      now: at(6),
    });
    expect(stage(progress, "INVESTIGATION_CREATED").status).toBe("completed");
    expect(stage(progress, "AGENT_ANALYSIS").status).toBe("completed");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("omitted");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("completed");
  });

  it("one-tool success closes each stage at its real boundary event", () => {
    const progress = derive({ events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) });
    expect(stage(progress, "AGENT_ANALYSIS").completedAt).toBe(at(3)); // first TOOL_REQUESTED
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").startedAt).toBe(at(3));
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").completedAt).toBe(at(5)); // REPORT_GENERATION_STARTED
    expect(stage(progress, "REPORT_GENERATION").startedAt).toBe(at(5));
    expect(stage(progress, "REPORT_GENERATION").status).toBe("completed");
  });

  it("rejects a tool run that submits a report without REPORT_GENERATION_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_SUBMITTED" }, 4),
            ev({ type: "REPORT_VALIDATED" }, 5),
            ev({ type: "RUN_COMPLETED" }, 5),
          ]),
          runStatus: "COMPLETED",
          now: at(5),
        }),
      "MISSING_LIFECYCLE_FACT",
    );
  });

  it("allows the direct no-tool path to submit without REPORT_GENERATION_STARTED", () => {
    const progress = derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) });
    expect(stage(progress, "REPORT_GENERATION").status).toBe("completed");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("omitted");
  });
});

// ── Step 1: strict completion ────────────────────────────────────────────

describe("strict RUN_COMPLETED invariants", () => {
  it("rejects RUN_CREATED -> RUN_COMPLETED", () => {
    expectCode(
      () =>
        derive({
          events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "RUN_COMPLETED" }, 1)]),
          runStatus: "COMPLETED",
        }),
      "MISSING_LIFECYCLE_FACT",
    );
  });

  it("rejects RUN_CREATED -> AGENT_STARTED -> RUN_COMPLETED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "RUN_COMPLETED" }, 2),
          ]),
          runStatus: "COMPLETED",
        }),
      "MISSING_LIFECYCLE_FACT",
    );
  });

  it("rejects TOOL_FAILED -> RUN_COMPLETED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" }, 3),
            ev({ type: "RUN_COMPLETED" }, 4),
          ]),
          runStatus: "COMPLETED",
        }),
      "CONTRADICTORY_COMPLETION",
    );
  });

  it("rejects REPORT_VALIDATION_FAILED -> RUN_COMPLETED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" }, 3),
            ev({ type: "RUN_COMPLETED" }, 4),
          ]),
          runStatus: "COMPLETED",
        }),
      "CONTRADICTORY_COMPLETION",
    );
  });

  it("rejects RUN_COMPLETED with an open tool call", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "RUN_COMPLETED" }, 3),
          ]),
          runStatus: "COMPLETED",
        }),
      "OPEN_TOOL_CALL",
    );
  });

  it("rejects RUN_COMPLETED without REPORT_VALIDATED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "RUN_COMPLETED" }, 3),
          ]),
          runStatus: "COMPLETED",
        }),
      "MISSING_LIFECYCLE_FACT",
    );
  });
});

// ── Step 2: lifecycle uniqueness and ordering ────────────────────────────

describe("lifecycle uniqueness and ordering", () => {
  it("rejects duplicate RUN_CREATED", () => {
    expectCode(
      () =>
        derive({
          events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "RUN_CREATED" }, 1)]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects duplicate AGENT_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "AGENT_STARTED" }, 2),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects duplicate REPORT_GENERATION_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_GENERATION_STARTED" }, 4),
            ev({ type: "REPORT_GENERATION_STARTED" }, 5),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects duplicate REPORT_SUBMITTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "REPORT_SUBMITTED" }, 3),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects a duplicate report outcome", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "REPORT_VALIDATED" }, 3),
            ev({ type: "REPORT_VALIDATED" }, 4),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects REPORT_VALIDATED without REPORT_SUBMITTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_VALIDATED" }, 2),
          ]),
        }),
      "REPORT_OUTCOME_WITHOUT_SUBMISSION",
    );
  });

  it("rejects REPORT_VALIDATION_FAILED without REPORT_SUBMITTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_VALIDATION_FAILED", failureCode: "REPORT_SCHEMA_INVALID" }, 2),
          ]),
        }),
      "REPORT_OUTCOME_WITHOUT_SUBMISSION",
    );
  });

  it("rejects REPORT_GENERATION_STARTED after REPORT_SUBMITTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "REPORT_GENERATION_STARTED" }, 3),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects a stream not beginning with RUN_CREATED (the legacy-trace case)", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 0),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 1),
          ]),
        }),
      "RUN_CREATED_NOT_FIRST",
    );
  });

  it("rejects legacy REPORT_GENERATED inside a canonical stream", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "REPORT_GENERATED" }, 3),
          ]),
        }),
      "LEGACY_EVENT_IN_CANONICAL_STREAM",
    );
  });

  it("rejects mixed runIds", () => {
    const events = stream(NO_TOOL_SUCCESS);
    const mixed = events.map((event, index) =>
      index === 2 ? { ...event, runId: OTHER_RUN_ID } : event,
    );
    expectCode(() => derive({ events: mixed, runStatus: "COMPLETED", now: at(6) }), "MIXED_RUN_IDS");
  });

  it("rejects a second terminal event with MULTIPLE_TERMINAL_EVENTS", () => {
    expectCode(
      () =>
        derive({
          events: stream([...NO_TOOL_SUCCESS, ev({ type: "RUN_COMPLETED" }, 7)]),
          runStatus: "COMPLETED",
          now: at(7),
        }),
      "MULTIPLE_TERMINAL_EVENTS",
    );
  });

  it("rejects a non-terminal event after a terminal event with EVENT_AFTER_TERMINAL", () => {
    expectCode(
      () =>
        derive({
          events: stream([...NO_TOOL_SUCCESS, ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 7)]),
          runStatus: "COMPLETED",
          now: at(7),
        }),
      "EVENT_AFTER_TERMINAL",
    );
  });

  it("rejects runStatus disagreeing with the terminal event", () => {
    expectCode(
      () => derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "RUNNING", now: at(6) }),
      "RUN_STATUS_MISMATCH",
    );
    expectCode(
      () => derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "FAILED", now: at(6) }),
      "RUN_STATUS_MISMATCH",
    );
  });

  it("rejects a terminal runStatus with an empty stream", () => {
    expectCode(() => derive({ events: [], runStatus: "COMPLETED" }), "RUN_STATUS_MISMATCH");
  });
});

// ── Step 3: tool-call identity and state ─────────────────────────────────

describe("tool-call identity and state", () => {
  const prefix = [ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 1)];

  it("rejects a repeated TOOL_REQUESTED id via the one-tool limit", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 3),
          ]),
        }),
      "TOOL_LIMIT_EXCEEDED",
    );
  });

  it("rejects a tool-name mismatch between request and outcome", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "check_status" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "other_tool" }, 3),
          ]),
        }),
      "TOOL_NAME_MISMATCH",
    );
  });

  it("rejects an outcome without a request", () => {
    expectCode(
      () =>
        derive({
          events: stream([...prefix, ev({ type: "TOOL_COMPLETED", toolCallId: "ghost", toolName: "t" }, 2)]),
        }),
      "TOOL_OUTCOME_WITHOUT_REQUEST",
    );
  });

  it("rejects a duplicate outcome / reuse of a closed id", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 4),
          ]),
        }),
      "DUPLICATE_TOOL_OUTCOME",
    );
  });

  it("rejects REPORT_GENERATION_STARTED with an open tool", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "REPORT_GENERATION_STARTED" }, 3),
          ]),
        }),
      "OPEN_TOOL_CALL",
    );
  });

  it("rejects REPORT_SUBMITTED with an open tool", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "REPORT_SUBMITTED" }, 3),
          ]),
        }),
      "OPEN_TOOL_CALL",
    );
  });

  it("rejects a tool request after the report phase begins", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_GENERATION_STARTED" }, 4),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "t" }, 5),
          ]),
        }),
      "TOOL_REQUEST_AFTER_REPORT_PHASE",
    );
  });

  it("rejects a terminal event with an open tool", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "DIAGNOSTIC_EXECUTION" }, 3),
          ]),
          runStatus: "FAILED",
        }),
      "OPEN_TOOL_CALL",
    );
  });

  it("rejects a second tool call after the first completed (v1 executes at most one)", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "a" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "a" }, 3),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "b" }, 4),
          ]),
        }),
      "TOOL_LIMIT_EXCEEDED",
    );
  });

  it("preserves a valid mid-tool RUNNING prefix", () => {
    const progress = derive({
      events: stream([...prefix, ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2)]),
      runStatus: "RUNNING",
      now: at(12),
    });
    expect(stage(progress, "AGENT_ANALYSIS").status).toBe("completed");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("active");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").elapsedMs).toBe(10_000);
    expect(stage(progress, "REPORT_GENERATION").status).toBe("pending");
  });

  it("preserves a valid mid-report RUNNING prefix", () => {
    const progress = derive({
      events: stream([
        ...prefix,
        ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
        ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
        ev({ type: "REPORT_GENERATION_STARTED" }, 4),
      ]),
      runStatus: "RUNNING",
      now: at(9),
    });
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("completed");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("active");
    expect(stage(progress, "REPORT_GENERATION").elapsedMs).toBe(5_000);
  });
});

// ── Step 4: failure facts ────────────────────────────────────────────────

describe("failure facts are immediate and consistent", () => {
  const toolFailure = (failureCode: "TOOL_EXECUTION_FAILED" | "TOOL_OUTPUT_INVALID") => [
    ev({ type: "RUN_CREATED" }, 0),
    ev({ type: "AGENT_STARTED" }, 1),
    ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
    ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode }, 3),
  ];

  it("TOOL_FAILED immediately fails DIAGNOSTIC_EXECUTION with the exact tool code", () => {
    const progress = derive({
      events: stream(toolFailure("TOOL_EXECUTION_FAILED")),
      runStatus: "RUNNING",
      now: at(3),
    });
    const diagnostic = stage(progress, "DIAGNOSTIC_EXECUTION");
    expect(diagnostic.status).toBe("failed");
    expect(diagnostic.failureCode).toBe("TOOL_EXECUTION_FAILED");
    expect(diagnostic.completedAt).toBe(at(3));
  });

  it("accepts a matching TOOL_FAILED + RUN_FAILED pair", () => {
    const progress = derive({
      events: stream([
        ...toolFailure("TOOL_EXECUTION_FAILED"),
        ev({ type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").failureCode).toBe("TOOL_EXECUTION_FAILED");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("omitted");
  });

  it("rejects a mismatching tool failure code in RUN_FAILED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...toolFailure("TOOL_EXECUTION_FAILED"),
            ev({ type: "RUN_FAILED", failureCode: "TOOL_OUTPUT_INVALID", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
          ]),
          runStatus: "FAILED",
        }),
      "FAILURE_FACT_MISMATCH",
    );
  });

  it("rejects a mismatching failedStage in RUN_FAILED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...toolFailure("TOOL_EXECUTION_FAILED"),
            ev({ type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "REPORT_GENERATION" }, 4),
          ]),
          runStatus: "FAILED",
        }),
      "FAILURE_FACT_MISMATCH",
    );
  });

  const reportFailure = (failureCode: "REPORT_SCHEMA_INVALID" | "REPORT_EVIDENCE_INVALID") => [
    ev({ type: "RUN_CREATED" }, 0),
    ev({ type: "AGENT_STARTED" }, 1),
    ev({ type: "REPORT_SUBMITTED" }, 2),
    ev({ type: "REPORT_VALIDATION_FAILED", failureCode }, 3),
  ];

  it("accepts a matching REPORT_SCHEMA_INVALID pair", () => {
    const progress = derive({
      events: stream([
        ...reportFailure("REPORT_SCHEMA_INVALID"),
        ev({ type: "RUN_FAILED", failureCode: "REPORT_SCHEMA_INVALID", failedStage: "REPORT_GENERATION" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    const report = stage(progress, "REPORT_GENERATION");
    expect(report.status).toBe("failed");
    expect(report.failureCode).toBe("REPORT_SCHEMA_INVALID");
    expect(report.completedAt).toBe(at(3)); // the specific fact's timestamp, not RUN_FAILED's
  });

  it("accepts a matching REPORT_EVIDENCE_INVALID pair", () => {
    const progress = derive({
      events: stream([
        ...reportFailure("REPORT_EVIDENCE_INVALID"),
        ev({ type: "RUN_FAILED", failureCode: "REPORT_EVIDENCE_INVALID", failedStage: "REPORT_GENERATION" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    expect(stage(progress, "REPORT_GENERATION").failureCode).toBe("REPORT_EVIDENCE_INVALID");
  });

  it("rejects a mismatching report failure code in RUN_FAILED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...reportFailure("REPORT_SCHEMA_INVALID"),
            ev({ type: "RUN_FAILED", failureCode: "REPORT_EVIDENCE_INVALID", failedStage: "REPORT_GENERATION" }, 4),
          ]),
          runStatus: "FAILED",
        }),
      "FAILURE_FACT_MISMATCH",
    );
  });

  it("rejects any non-terminal event after a failure fact", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...reportFailure("REPORT_SCHEMA_INVALID"),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 4),
          ]),
        }),
      "EVENT_AFTER_FAILURE",
    );
  });

  it("lets a run-level failure establish the stage when no specific failure exists", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    const analysis = stage(progress, "AGENT_ANALYSIS");
    expect(analysis.status).toBe("failed");
    expect(analysis.failureCode).toBe("PROVIDER_TIMEOUT");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("omitted");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("omitted");
  });

  it("rejects RUN_FAILED naming a stage that already resolved", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "INVESTIGATION_CREATED" }, 2),
          ]),
          runStatus: "FAILED",
        }),
      "FAILED_STAGE_NOT_TRUTHFUL",
    );
  });
});

// ── Step 6: runtime input/output validation ──────────────────────────────

describe("runtime input validation", () => {
  it("rejects an invalid `now`", () => {
    expectCode(() => derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: "not-a-date" }), "INVALID_NOW");
  });

  it("rejects a malformed event record even when the TypeScript type was bypassed", () => {
    const events = [
      { runId: RUN_ID, sequence: 1, recordedAt: "yesterday", payload: { type: "RUN_CREATED" } },
    ] as unknown as InvestigationEventRecord[];
    expectCode(() => derive({ events }), "INVALID_EVENT_RECORD");
  });

  it("rejects an unknown payload type smuggled past the type system", () => {
    const events = [
      { runId: RUN_ID, sequence: 1, recordedAt: at(0), payload: { type: "NOT_A_REAL_EVENT" } },
    ] as unknown as InvestigationEventRecord[];
    expectCode(() => derive({ events }), "INVALID_EVENT_RECORD");
  });

  it("rejects a sequence gap, a duplicate sequence, and out-of-order events", () => {
    const base = stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 1)]);

    const gap = [base[0]!, { ...base[1]!, sequence: 3 }];
    expectCode(() => derive({ events: gap }), "SEQUENCE_NOT_CONTIGUOUS");

    const duplicate = [base[0]!, { ...base[1]!, sequence: 1 }];
    expectCode(() => derive({ events: duplicate }), "SEQUENCE_NOT_CONTIGUOUS");

    const outOfOrder = [base[1]!, base[0]!]; // sequences 2,1 in array order
    expectCode(() => derive({ events: outOfOrder }), "SEQUENCE_NOT_CONTIGUOUS");
  });

  it("clamps negative clock skew to zero rather than reporting a negative duration", () => {
    const progress = derive({
      events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 50)]),
      runStatus: "RUNNING",
      now: at(10), // earlier than the stage's startedAt
    });
    expect(stage(progress, "AGENT_ANALYSIS").elapsedMs).toBe(0);
  });
});

describe("output self-validation", () => {
  const cases: readonly (readonly [string, DeriveExecutionStageProgressInput])[] = [
    ["no-tool success", { events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) }],
    ["one-tool success", { events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) }],
    [
      "tool failure",
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
          ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" }, 3),
          ev({ type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
        ]),
        runStatus: "FAILED",
        now: at(4),
      },
    ],
    ["empty running", { events: [], runStatus: "RUNNING", now: at(1) }],
    [
      "mid-tool running",
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
        ]),
        runStatus: "RUNNING",
        now: at(9),
      },
    ],
  ];

  it("every reducer output validates against ExecutionStageProgressListSchema", () => {
    for (const [name, input] of cases) {
      const progress = deriveExecutionStageProgress(input);
      const parsed = ExecutionStageProgressListSchema.safeParse(progress);
      expect(parsed.success, `expected ${name} output to satisfy the schema`).toBe(true);
      expect(progress).toHaveLength(4);
    }
  });
});

// ── Timestamps ───────────────────────────────────────────────────────────

describe("timestamps and elapsed time", () => {
  it("an active stage's elapsed time is now - startedAt", () => {
    const progress = derive({
      events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 10)]),
      runStatus: "RUNNING",
      now: at(45),
    });
    const analysis = stage(progress, "AGENT_ANALYSIS");
    expect(analysis.startedAt).toBe(at(10));
    expect(analysis.completedAt).toBeNull();
    expect(analysis.elapsedMs).toBe(35_000);
  });

  it("a settled stage's elapsed time is stable regardless of now", () => {
    const events = stream([
      ev({ type: "RUN_CREATED" }, 0),
      ev({ type: "AGENT_STARTED" }, 1),
      ev({ type: "RUN_FAILED", failureCode: "RETRIEVAL_FAILED", failedStage: "AGENT_ANALYSIS" }, 4),
    ]);
    const a = derive({ events, runStatus: "FAILED", now: at(4) });
    const b = derive({ events, runStatus: "FAILED", now: at(9999) });
    expect(stage(a, "AGENT_ANALYSIS").elapsedMs).toBe(3_000);
    expect(stage(b, "AGENT_ANALYSIS").elapsedMs).toBe(3_000);
  });

  it("pending and omitted stages carry null timestamps and elapsed time", () => {
    const progress = derive({ events: stream([ev({ type: "RUN_CREATED" }, 0)]), now: at(1) });
    const analysis = stage(progress, "AGENT_ANALYSIS");
    expect(analysis.status).toBe("pending");
    expect(analysis.startedAt).toBeNull();
    expect(analysis.completedAt).toBeNull();
    expect(analysis.elapsedMs).toBeNull();
  });

  it("orders strictly by sequence even when recordedAt values are identical", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 0),
        ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 0),
      ]),
      runStatus: "RUNNING",
      now: at(0),
    });
    expect(stage(progress, "AGENT_ANALYSIS").status).toBe("completed");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("active");
  });
});

// ── Finding 1: terminal failure truthfulness ─────────────────────────────

describe("terminal failure names only a truthful stage", () => {
  const activeStages = (progress: ReturnType<typeof derive>) =>
    progress.filter((entry) => entry.status === "active").map((entry) => entry.key);
  const pendingStages = (progress: ReturnType<typeof derive>) =>
    progress.filter((entry) => entry.status === "pending").map((entry) => entry.key);

  it("rejects a failure naming a future pending REPORT_GENERATION", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "REPORT_GENERATION" }, 1),
          ]),
          runStatus: "FAILED",
          now: at(1),
        }),
      "FAILED_STAGE_NOT_TRUTHFUL",
    );
  });

  it("rejects a failure naming a future pending DIAGNOSTIC_EXECUTION", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "DIAGNOSTIC_EXECUTION" }, 2),
          ]),
          runStatus: "FAILED",
          now: at(2),
        }),
      "FAILED_STAGE_NOT_TRUTHFUL",
    );
  });

  it("accepts the narrow pre-agent RUN_CREATED -> RUN_FAILED(AGENT_ANALYSIS) exception", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "RUN_FAILED", failureCode: "RETRIEVAL_PARAMS_INVALID", failedStage: "AGENT_ANALYSIS" }, 1),
      ]),
      runStatus: "FAILED",
      now: at(1),
    });
    expect(stage(progress, "INVESTIGATION_CREATED").status).toBe("completed");
    expect(stage(progress, "AGENT_ANALYSIS").status).toBe("failed");
    expect(stage(progress, "AGENT_ANALYSIS").failureCode).toBe("RETRIEVAL_PARAMS_INVALID");
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("omitted");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("omitted");
    expect(activeStages(progress)).toEqual([]);
    expect(pendingStages(progress)).toEqual([]);
  });

  it("accepts a failure on the currently active analysis stage", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }, 2),
      ]),
      runStatus: "FAILED",
      now: at(2),
    });
    expect(stage(progress, "AGENT_ANALYSIS").status).toBe("failed");
    expect(activeStages(progress)).toEqual([]);
    expect(pendingStages(progress)).toEqual([]);
  });

  it("accepts a failure on the currently active diagnostic stage (via TOOL_FAILED)", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
        ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" }, 3),
        ev({ type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("failed");
    expect(activeStages(progress)).toEqual([]);
    expect(pendingStages(progress)).toEqual([]);
  });

  it("accepts a failure on the currently active report stage (before submission)", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
        ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
        ev({ type: "REPORT_GENERATION_STARTED" }, 4),
        ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "REPORT_GENERATION" }, 5),
      ]),
      runStatus: "FAILED",
      now: at(5),
    });
    expect(stage(progress, "REPORT_GENERATION").status).toBe("failed");
    expect(activeStages(progress)).toEqual([]);
    expect(pendingStages(progress)).toEqual([]);
  });

  it("every accepted terminal result has zero active and zero pending stages", () => {
    const terminalCases: readonly DeriveExecutionStageProgressInput[] = [
      { events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) },
      { events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) },
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "RUN_FAILED", failureCode: "RETRIEVAL_PARAMS_INVALID", failedStage: "AGENT_ANALYSIS" }, 1),
        ]),
        runStatus: "FAILED",
        now: at(1),
      },
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
          ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_EXECUTION_FAILED" }, 3),
          ev({ type: "RUN_FAILED", failureCode: "TOOL_EXECUTION_FAILED", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
        ]),
        runStatus: "FAILED",
        now: at(4),
      },
    ];

    for (const input of terminalCases) {
      const progress = deriveExecutionStageProgress(input);
      expect(activeStages(progress)).toEqual([]);
      expect(pendingStages(progress)).toEqual([]);
    }
  });
});

// ── Finding 2: forward-only phase ordering ───────────────────────────────

describe("forward-only phase ordering", () => {
  it("rejects a tool request before AGENT_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 1),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects AGENT_STARTED after a tool event", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "AGENT_STARTED" }, 4),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects AGENT_STARTED after report submission", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "REPORT_SUBMITTED" }, 1),
            ev({ type: "AGENT_STARTED" }, 2),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects retrieval before AGENT_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 1),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects retrieval during diagnostics", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 3),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects retrieval after the report phase begins", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_GENERATION_STARTED" }, 2),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 3),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects duplicate retrieval", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 2),
            ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 3),
          ]),
        }),
      "DUPLICATE_LIFECYCLE_FACT",
    );
  });

  it("rejects a report submission before AGENT_STARTED", () => {
    expectCode(
      () =>
        derive({
          events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "REPORT_SUBMITTED" }, 1)]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("every accepted result has at most one active stage", () => {
    const acceptedCases: readonly DeriveExecutionStageProgressInput[] = [
      { events: [], runStatus: "RUNNING", now: at(1) },
      { events: stream([ev({ type: "RUN_CREATED" }, 0)]), runStatus: "RUNNING", now: at(1) },
      {
        events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 1)]),
        runStatus: "RUNNING",
        now: at(2),
      },
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 2),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 3),
        ]),
        runStatus: "RUNNING",
        now: at(4),
      },
      {
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
          ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
          ev({ type: "REPORT_GENERATION_STARTED" }, 4),
        ]),
        runStatus: "RUNNING",
        now: at(5),
      },
      { events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) },
    ];

    for (const input of acceptedCases) {
      const progress = deriveExecutionStageProgress(input);
      const active = progress.filter((entry) => entry.status === "active");
      expect(active.length).toBeLessThanOrEqual(1);
    }
  });
});

// ── Finding 4: the list schema enforces its advertised shape ─────────────

describe("ExecutionStageProgressListSchema enforces exactly four ordered entries", () => {
  const entry = (key: string) => ({
    key,
    status: "omitted" as const,
    startedAt: null,
    completedAt: null,
    elapsedMs: null,
  });

  const CORRECT = [
    entry("INVESTIGATION_CREATED"),
    entry("AGENT_ANALYSIS"),
    entry("DIAGNOSTIC_EXECUTION"),
    entry("REPORT_GENERATION"),
  ];

  it("accepts exactly the four stages in order", () => {
    expect(ExecutionStageProgressListSchema.safeParse(CORRECT).success).toBe(true);
  });

  it("rejects an empty list", () => {
    expect(ExecutionStageProgressListSchema.safeParse([]).success).toBe(false);
  });

  it("rejects a single valid stage", () => {
    expect(ExecutionStageProgressListSchema.safeParse([entry("INVESTIGATION_CREATED")]).success).toBe(false);
  });

  it("rejects four duplicate stage keys", () => {
    const duplicates = [
      entry("INVESTIGATION_CREATED"),
      entry("INVESTIGATION_CREATED"),
      entry("INVESTIGATION_CREATED"),
      entry("INVESTIGATION_CREATED"),
    ];
    expect(ExecutionStageProgressListSchema.safeParse(duplicates).success).toBe(false);
  });

  it("rejects the four valid stages in reverse order", () => {
    expect(ExecutionStageProgressListSchema.safeParse([...CORRECT].reverse()).success).toBe(false);
  });

  it("rejects five entries", () => {
    expect(
      ExecutionStageProgressListSchema.safeParse([...CORRECT, entry("REPORT_GENERATION")]).success,
    ).toBe(false);
  });

  it("still accepts representative reducer outputs", () => {
    const outputs = [
      deriveExecutionStageProgress({ events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) }),
      deriveExecutionStageProgress({ events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) }),
      deriveExecutionStageProgress({ events: [], runStatus: "RUNNING", now: at(1) }),
    ];
    for (const output of outputs) {
      expect(ExecutionStageProgressListSchema.safeParse(output).success).toBe(true);
    }
  });
});

// ── Finding 2: REPORT_GENERATION_STARTED requires a tool path ────────────

describe("REPORT_GENERATION_STARTED is a finalization-turn fact", () => {
  it("rejects a no-tool report-start prefix", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_GENERATION_STARTED" }, 2),
          ]),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("rejects a no-tool report-start completed stream", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_GENERATION_STARTED" }, 2),
            ev({ type: "REPORT_SUBMITTED" }, 3),
            ev({ type: "REPORT_VALIDATED" }, 4),
            ev({ type: "RUN_COMPLETED" }, 4),
          ]),
          runStatus: "COMPLETED",
          now: at(4),
        }),
      "PHASE_ORDER_VIOLATION",
    );
  });

  it("allows the legal no-tool direct submission", () => {
    const progress = derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) });
    expect(stage(progress, "REPORT_GENERATION").status).toBe("completed");
    // Report generation begins at REPORT_SUBMITTED on this path.
    expect(stage(progress, "REPORT_GENERATION").startedAt).toBe(at(5));
  });

  it("allows tool success with report-start", () => {
    const progress = derive({ events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) });
    expect(stage(progress, "REPORT_GENERATION").status).toBe("completed");
  });
});

// ── Finding 3: tool-path finalization failures need report-start ─────────

describe("tool-path finalization failure attribution", () => {
  const toolSuccessPrefix = [
    ev({ type: "RUN_CREATED" }, 0),
    ev({ type: "AGENT_STARTED" }, 1),
    ev({ type: "RETRIEVAL_COMPLETED", chunks: [] }, 2),
    ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 3),
    ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 4),
  ];

  it("rejects a finalization provider failure with no report-start", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...toolSuccessPrefix,
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "DIAGNOSTIC_EXECUTION" }, 5),
          ]),
          runStatus: "FAILED",
          now: at(5),
        }),
      "MISSING_LIFECYCLE_FACT",
    );
  });

  it("accepts the same failure once report-start is recorded and it fails REPORT_GENERATION", () => {
    const progress = derive({
      events: stream([
        ...toolSuccessPrefix,
        ev({ type: "REPORT_GENERATION_STARTED" }, 5),
        ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "REPORT_GENERATION" }, 6),
      ]),
      runStatus: "FAILED",
      now: at(6),
    });
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").status).toBe("completed");
    expect(stage(progress, "REPORT_GENERATION").status).toBe("failed");
    expect(stage(progress, "REPORT_GENERATION").failureCode).toBe("PROVIDER_TIMEOUT");
  });

  it("still accepts a genuine TOOL_FAILED followed by a matching diagnostic RUN_FAILED", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
        ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: "TOOL_OUTPUT_INVALID" }, 3),
        ev({ type: "RUN_FAILED", failureCode: "TOOL_OUTPUT_INVALID", failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
      ]),
      runStatus: "FAILED",
      now: at(4),
    });
    expect(stage(progress, "DIAGNOSTIC_EXECUTION").failureCode).toBe("TOOL_OUTPUT_INVALID");
  });
});

// ── Finding 4: sequential tool calls ─────────────────────────────────────

describe("v1 executes at most one tool call", () => {
  const prefix = [ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 1)];

  it("rejects a second request while the first is still open", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "a" }, 2),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "b" }, 3),
          ]),
        }),
      "TOOL_LIMIT_EXCEEDED",
    );
  });

  it("rejects a second request after the first completed", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "a" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "a" }, 3),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "b" }, 4),
          ]),
        }),
      "TOOL_LIMIT_EXCEEDED",
    );
  });

  it("rejects a second request after the first failed", () => {
    // A failure fact makes any later non-terminal event illegal, so the
    // stream is rejected before the tool limit is consulted — the point is
    // that a second tool call is unreachable either way.
    expectCode(
      () =>
        derive({
          events: stream([
            ...prefix,
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "a" }, 2),
            ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "a", failureCode: "TOOL_EXECUTION_FAILED" }, 3),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c2", toolName: "b" }, 4),
          ]),
        }),
      "EVENT_AFTER_FAILURE",
    );
  });

  it("accepts the single-tool path and the no-tool path", () => {
    const oneTool = derive({ events: stream(ONE_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(10) });
    expect(stage(oneTool, "DIAGNOSTIC_EXECUTION").status).toBe("completed");

    const noTool = derive({ events: stream(NO_TOOL_SUCCESS), runStatus: "COMPLETED", now: at(6) });
    expect(stage(noTool, "DIAGNOSTIC_EXECUTION").status).toBe("omitted");
  });
});

// ── Finding 5: runStatus is runtime-validated ────────────────────────────

describe("runStatus is runtime-validated", () => {
  const bogus = "BOGUS" as never;

  it("rejects an invalid status on a non-terminal prefix", () => {
    expectCode(
      () =>
        deriveExecutionStageProgress({
          events: stream([ev({ type: "RUN_CREATED" }, 0), ev({ type: "AGENT_STARTED" }, 1)]),
          runStatus: bogus,
          now: at(2),
        }),
      "INVALID_RUN_STATUS",
    );
  });

  it("rejects an invalid status on a completed-looking stream", () => {
    expectCode(
      () =>
        deriveExecutionStageProgress({
          events: stream(NO_TOOL_SUCCESS),
          runStatus: bogus,
          now: at(6),
        }),
      "INVALID_RUN_STATUS",
    );
  });

  it("rejects an invalid status on a failed-looking stream", () => {
    expectCode(
      () =>
        deriveExecutionStageProgress({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }, 2),
          ]),
          runStatus: bogus,
          now: at(2),
        }),
      "INVALID_RUN_STATUS",
    );
  });
});

// ── Finding 6: failure-code / stage / context compatibility ──────────────

describe("failure-code and stage must be causally compatible", () => {
  const preAgent = (failureCode: string) =>
    stream([
      ev({ type: "RUN_CREATED" }, 0),
      ev(
        { type: "RUN_FAILED", failureCode, failedStage: "AGENT_ANALYSIS" } as InvestigationEventRecordPayload,
        1,
      ),
    ]);

  const duringAnalysis = (failureCode: string, failedStage: string) =>
    stream([
      ev({ type: "RUN_CREATED" }, 0),
      ev({ type: "AGENT_STARTED" }, 1),
      ev({ type: "RUN_FAILED", failureCode, failedStage } as InvestigationEventRecordPayload, 2),
    ]);

  const duringDiagnostics = (failureCode: string, failedStage: string) =>
    stream([
      ev({ type: "RUN_CREATED" }, 0),
      ev({ type: "AGENT_STARTED" }, 1),
      ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
      ev({ type: "RUN_FAILED", failureCode, failedStage } as InvestigationEventRecordPayload, 3),
    ]);

  const duringReport = (failureCode: string, failedStage: string) =>
    stream([
      ev({ type: "RUN_CREATED" }, 0),
      ev({ type: "AGENT_STARTED" }, 1),
      ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
      ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
      ev({ type: "REPORT_GENERATION_STARTED" }, 4),
      ev({ type: "RUN_FAILED", failureCode, failedStage } as InvestigationEventRecordPayload, 5),
    ]);

  // ── Rejections explicitly required by the finding ─────────────────────

  it("rejects TOOL_EXECUTION_FAILED on AGENT_ANALYSIS", () => {
    expectCode(
      () => derive({ events: duringAnalysis("TOOL_EXECUTION_FAILED", "AGENT_ANALYSIS"), runStatus: "FAILED" }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects REPORT_SCHEMA_INVALID pre-agent and during analysis", () => {
    expectCode(
      () => derive({ events: preAgent("REPORT_SCHEMA_INVALID"), runStatus: "FAILED" }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
    expectCode(
      () => derive({ events: duringAnalysis("REPORT_SCHEMA_INVALID", "AGENT_ANALYSIS"), runStatus: "FAILED" }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects PROVIDER_TIMEOUT on DIAGNOSTIC_EXECUTION", () => {
    expectCode(
      () => derive({ events: duringDiagnostics("PROVIDER_TIMEOUT", "DIAGNOSTIC_EXECUTION"), runStatus: "FAILED" }),
      "OPEN_TOOL_CALL",
    );
    // With the tool closed, the finalization rule catches it first; with
    // report-start recorded, the stage/code rule is what rejects it.
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_GENERATION_STARTED" }, 4),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "DIAGNOSTIC_EXECUTION" }, 5),
          ]),
          runStatus: "FAILED",
        }),
      "FAILED_STAGE_NOT_TRUTHFUL",
    );
  });

  it("rejects TOOL_OUTPUT_INVALID on REPORT_GENERATION", () => {
    expectCode(
      () => derive({ events: duringReport("TOOL_OUTPUT_INVALID", "REPORT_GENERATION"), runStatus: "FAILED" }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects REPORT_EVIDENCE_INVALID without a REPORT_VALIDATION_FAILED fact", () => {
    expectCode(
      () => derive({ events: duringReport("REPORT_EVIDENCE_INVALID", "REPORT_GENERATION"), runStatus: "FAILED" }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects TOOL_INPUT_INVALID without a TOOL_FAILED fact", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_GENERATION_STARTED" }, 4),
            ev({ type: "RUN_FAILED", failureCode: "TOOL_INPUT_INVALID", failedStage: "DIAGNOSTIC_EXECUTION" }, 5),
          ]),
          runStatus: "FAILED",
        }),
      "FAILED_STAGE_NOT_TRUTHFUL",
    );
  });

  // ── Legal categories ─────────────────────────────────────────────────

  it("accepts every retrieval code on an active AGENT_ANALYSIS", () => {
    for (const code of ["RETRIEVAL_PARAMS_INVALID", "RETRIEVAL_FAILED", "RETRIEVAL_RESPONSE_INVALID"]) {
      const progress = derive({
        events: duringAnalysis(code, "AGENT_ANALYSIS"),
        runStatus: "FAILED",
        now: at(2),
      });
      expect(stage(progress, "AGENT_ANALYSIS").failureCode, `code ${code}`).toBe(code);
    }
  });

  it("accepts all four tool codes with a matching TOOL_FAILED fact on DIAGNOSTIC_EXECUTION", () => {
    for (const code of [
      "TOOL_NOT_FOUND",
      "TOOL_INPUT_INVALID",
      "TOOL_EXECUTION_FAILED",
      "TOOL_OUTPUT_INVALID",
    ] as const) {
      const progress = derive({
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
          ev({ type: "TOOL_FAILED", toolCallId: "c1", toolName: "t", failureCode: code }, 3),
          ev({ type: "RUN_FAILED", failureCode: code, failedStage: "DIAGNOSTIC_EXECUTION" }, 4),
        ]),
        runStatus: "FAILED",
        now: at(4),
      });
      expect(stage(progress, "DIAGNOSTIC_EXECUTION").failureCode, `code ${code}`).toBe(code);
    }
  });

  it("accepts both report-validation codes with a matching fact on REPORT_GENERATION", () => {
    for (const code of ["REPORT_SCHEMA_INVALID", "REPORT_EVIDENCE_INVALID"] as const) {
      const progress = derive({
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "REPORT_SUBMITTED" }, 2),
          ev({ type: "REPORT_VALIDATION_FAILED", failureCode: code }, 3),
          ev({ type: "RUN_FAILED", failureCode: code, failedStage: "REPORT_GENERATION" }, 4),
        ]),
        runStatus: "FAILED",
        now: at(4),
      });
      expect(stage(progress, "REPORT_GENERATION").failureCode, `code ${code}`).toBe(code);
    }
  });

  it("accepts every provider/protocol code on an active AGENT_ANALYSIS", () => {
    for (const code of [
      "PROVIDER_PROTOCOL_INVALID",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_CANCELLED",
    ]) {
      const progress = derive({
        events: duringAnalysis(code, "AGENT_ANALYSIS"),
        runStatus: "FAILED",
        now: at(2),
      });
      expect(stage(progress, "AGENT_ANALYSIS").failureCode, `code ${code}`).toBe(code);
    }
  });

  it("accepts every provider/protocol code on an active REPORT_GENERATION", () => {
    for (const code of [
      "PROVIDER_PROTOCOL_INVALID",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_CANCELLED",
    ]) {
      const progress = derive({
        events: duringReport(code, "REPORT_GENERATION"),
        runStatus: "FAILED",
        now: at(5),
      });
      expect(stage(progress, "REPORT_GENERATION").failureCode, `code ${code}`).toBe(code);
    }
  });

  it("accepts only RETRIEVAL_PARAMS_INVALID for the pre-agent exception", () => {
    const progress = derive({
      events: preAgent("RETRIEVAL_PARAMS_INVALID"),
      runStatus: "FAILED",
      now: at(1),
    });
    expect(stage(progress, "AGENT_ANALYSIS").failureCode).toBe("RETRIEVAL_PARAMS_INVALID");

    for (const code of [
      "RETRIEVAL_FAILED",
      "RETRIEVAL_RESPONSE_INVALID",
      "PROVIDER_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
      "TOOL_EXECUTION_FAILED",
      "REPORT_SCHEMA_INVALID",
    ]) {
      expectCode(
        () => derive({ events: preAgent(code), runStatus: "FAILED", now: at(1) }),
        "FAILURE_CODE_STAGE_MISMATCH",
      );
    }
  });
});

// ── Provider/report causality (v1) ───────────────────────────────────────

describe("provider failures cannot follow a submitted report", () => {
  it("rejects a provider failure after a direct no-tool submission", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "REPORT_SUBMITTED" }, 2),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "REPORT_GENERATION" }, 3),
          ]),
          runStatus: "FAILED",
          now: at(3),
        }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects a provider failure after a tool-path submission", () => {
    expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: "t" }, 3),
            ev({ type: "REPORT_GENERATION_STARTED" }, 4),
            ev({ type: "REPORT_SUBMITTED" }, 5),
            ev({ type: "RUN_FAILED", failureCode: "PROVIDER_UNAVAILABLE", failedStage: "REPORT_GENERATION" }, 6),
          ]),
          runStatus: "FAILED",
          now: at(6),
        }),
      "FAILURE_CODE_STAGE_MISMATCH",
    );
  });

  it("rejects every provider/protocol code after submission", () => {
    for (const code of [
      "PROVIDER_PROTOCOL_INVALID",
      "PROVIDER_UNAVAILABLE",
      "PROVIDER_TIMEOUT",
      "PROVIDER_CANCELLED",
    ]) {
      expectCode(
        () =>
          derive({
            events: stream([
              ev({ type: "RUN_CREATED" }, 0),
              ev({ type: "AGENT_STARTED" }, 1),
              ev({ type: "REPORT_SUBMITTED" }, 2),
              ev(
                {
                  type: "RUN_FAILED",
                  failureCode: code,
                  failedStage: "REPORT_GENERATION",
                } as InvestigationEventRecordPayload,
                3,
              ),
            ]),
            runStatus: "FAILED",
            now: at(3),
          }),
        "FAILURE_CODE_STAGE_MISMATCH",
      );
    }
  });

  it("accepts a provider failure during analysis, before any tool or report", () => {
    const progress = derive({
      events: stream([
        ev({ type: "RUN_CREATED" }, 0),
        ev({ type: "AGENT_STARTED" }, 1),
        ev({ type: "RUN_FAILED", failureCode: "PROVIDER_TIMEOUT", failedStage: "AGENT_ANALYSIS" }, 2),
      ]),
      runStatus: "FAILED",
      now: at(2),
    });
    expect(stage(progress, "AGENT_ANALYSIS").failureCode).toBe("PROVIDER_TIMEOUT");
  });

  it("accepts report schema and evidence failures after submission", () => {
    for (const code of ["REPORT_SCHEMA_INVALID", "REPORT_EVIDENCE_INVALID"] as const) {
      const progress = derive({
        events: stream([
          ev({ type: "RUN_CREATED" }, 0),
          ev({ type: "AGENT_STARTED" }, 1),
          ev({ type: "REPORT_SUBMITTED" }, 2),
          ev({ type: "REPORT_VALIDATION_FAILED", failureCode: code }, 3),
          ev({ type: "RUN_FAILED", failureCode: code, failedStage: "REPORT_GENERATION" }, 4),
        ]),
        runStatus: "FAILED",
        now: at(4),
      });
      expect(stage(progress, "REPORT_GENERATION").failureCode, `code ${code}`).toBe(code);
    }
  });
});

// ── Safe error messages ──────────────────────────────────────────────────

describe("contract errors never echo provider-controlled values", () => {
  // Schema-valid (1..128 chars) but hostile: log forging via newline, an
  // ANSI escape, a tab, and credential-looking content. Built from escape
  // sequences so the fixture itself stays readable.
  const MALICIOUS_ID = ["c1", "\n[ERROR] forged sk-secret-AKIAIOSFODNN7", "\u001b[31m", "\tinjected"].join("");
  const MALICIOUS_NAME = ["tool", "\n[WARN] sk-secret-leak"].join("");

  const assertSanitized = (message: string, raw: string) => {
    expect(message).not.toContain(raw);
    expect(message).not.toContain("sk-secret");
    expect(message).not.toContain("\n");
    expect(message).not.toContain("\u001b");
    expect(message).not.toContain("\t");
  };

  it("omits a malicious toolCallId from an outcome-without-request message", () => {
    const error = expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_COMPLETED", toolCallId: MALICIOUS_ID, toolName: "t" }, 2),
          ]),
        }),
      "TOOL_OUTCOME_WITHOUT_REQUEST",
    );
    assertSanitized(error.message, MALICIOUS_ID);
    expect(error.message).not.toContain("forged");
  });

  it("omits a malicious toolName from a name-mismatch message", () => {
    const error = expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: "c1", toolName: "real_tool" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: "c1", toolName: MALICIOUS_NAME }, 3),
          ]),
        }),
      "TOOL_NAME_MISMATCH",
    );
    assertSanitized(error.message, MALICIOUS_NAME);
  });

  it("omits a malicious toolCallId from a duplicate-outcome message", () => {
    const error = expectCode(
      () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev({ type: "TOOL_REQUESTED", toolCallId: MALICIOUS_ID, toolName: "t" }, 2),
            ev({ type: "TOOL_COMPLETED", toolCallId: MALICIOUS_ID, toolName: "t" }, 3),
            ev({ type: "TOOL_COMPLETED", toolCallId: MALICIOUS_ID, toolName: "t" }, 4),
          ]),
        }),
      "DUPLICATE_TOOL_OUTCOME",
    );
    assertSanitized(error.message, MALICIOUS_ID);
  });
});

// ── Exhaustive failure policy coverage ───────────────────────────────────

describe("every current orchestrator error code has a runtime-exercised policy", () => {
  // The compile-time guarantee is `satisfies Record<AgentOrchestratorErrorCode,
  // FailurePolicy>` in the reducer: adding a code fails the build until a
  // policy exists. This test complements it by proving each current code is
  // actually reachable through the reducer in at least one direction.
  const ALL_CODES = AgentOrchestratorErrorCodeSchema.options;

  it("covers all 13 codes with an accept or a typed reject", () => {
    expect(ALL_CODES).toHaveLength(13);

    for (const code of ALL_CODES) {
      // Attribute every code to AGENT_ANALYSIS during an active analysis
      // phase: retrieval and provider codes are accepted there, and tool and
      // report codes must be rejected with an exact typed code.
      const run = () =>
        derive({
          events: stream([
            ev({ type: "RUN_CREATED" }, 0),
            ev({ type: "AGENT_STARTED" }, 1),
            ev(
              { type: "RUN_FAILED", failureCode: code, failedStage: "AGENT_ANALYSIS" } as InvestigationEventRecordPayload,
              2,
            ),
          ]),
          runStatus: "FAILED",
          now: at(2),
        });

      const expectsAnalysis =
        code.startsWith("RETRIEVAL_") || code.startsWith("PROVIDER_");

      if (expectsAnalysis) {
        const progress = run();
        expect(stage(progress, "AGENT_ANALYSIS").failureCode, `code ${code}`).toBe(code);
      } else {
        expectCode(run, "FAILURE_CODE_STAGE_MISMATCH");
      }
    }
  });
});
