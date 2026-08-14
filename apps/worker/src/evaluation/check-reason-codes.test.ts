import { describe, expect, it } from "vitest";

import { CHECK_REASON_MESSAGES, resolveCheckReasonMessage, type CheckReasonCode } from "./check-reason-codes";

// Every CheckReasonCode a failCheck call site in evaluation-evaluator.ts can
// actually construct. If a new code is ever added there without a matching
// entry here, this list (and the totality check below) is the thing that
// must be updated — TypeScript's Record<CheckReasonCode, string> typing on
// CHECK_REASON_MESSAGES already makes an incomplete map a compile error;
// this test proves it holds at runtime too.
const ALL_CHECK_REASON_CODES: readonly CheckReasonCode[] = [
  "RETRIEVAL_NOT_OBSERVED",
  "RETRIEVAL_TOP1_MISMATCH",
  "RETRIEVAL_HIT3_MISMATCH",
  "RETRIEVAL_NO_RESULTS_MISMATCH",
  "RETRIEVAL_FORBIDDEN_MISMATCH",
  "TOOL_REQUESTED_MISMATCH",
  "TOOL_EXECUTED_MISMATCH",
  "TOOL_COMPLETED_MISMATCH",
  "TOOL_FORBIDDEN_EXECUTED_MISMATCH",
  "TOOL_FORBIDDEN_COMPLETED_MISMATCH",
  "SCHEMA_HANDLING_MISMATCH",
  "EVIDENCE_GROUNDING_MISMATCH",
  "PAYLOAD_NOT_AVAILABLE",
  "EVIDENCE_TYPES_MISMATCH",
  "EVIDENCE_IDS_MISMATCH",
  "ACTION_TYPES_MISMATCH",
  "FAILURE_CODE_RUN_COMPLETED",
  "FAILURE_CODE_MISMATCH",
  "STATUS_MISMATCH",
];

describe("CHECK_REASON_MESSAGES", () => {
  it("is total: every declared CheckReasonCode resolves to a non-empty, fixed message", () => {
    for (const code of ALL_CHECK_REASON_CODES) {
      const message = resolveCheckReasonMessage(code);
      expect(typeof message).toBe("string");
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it("has exactly as many entries as the declared code list — no undeclared extra, no missing one", () => {
    expect(Object.keys(CHECK_REASON_MESSAGES).sort()).toEqual([...ALL_CHECK_REASON_CODES].sort());
  });

  it("never produces a message that looks like a stack trace line, a node_modules path, or a file:// URL", () => {
    for (const message of Object.values(CHECK_REASON_MESSAGES)) {
      expect(message).not.toMatch(/\n\s+at\s+/);
      expect(message).not.toContain("node_modules");
      expect(message).not.toContain("file://");
    }
  });

  it("every message is unique — no two reason codes silently collapse to the same display text", () => {
    const messages = Object.values(CHECK_REASON_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });
});
