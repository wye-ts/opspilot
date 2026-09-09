import { CHECKPOINT_B_CASES } from "./cases/checkpoint-b-cases";
import {
  ADVERSARIAL_TOOL_INPUT_SHAPE_CASE,
  FABRICATED_RAG_EVIDENCE_CASE,
  FABRICATED_TOOL_EVIDENCE_CASE,
  FABRICATED_TOOL_OUTPUT_EVIDENCE_CASE,
  INJECTION_PROBE_STRUCTURAL_CASE,
} from "./cases/evidence-grounding-cases";
import { PROTOCOL_AND_FAILURE_CASES } from "./cases/protocol-and-failure-cases";
import { TOPIC_RUNBOOK_CASES } from "./cases/topic-runbook-cases";
import type { EvaluationCase } from "./types";

// Fixed array order — the runner is required to execute (and report) cases in
// exactly this order, never sorted (see docs/07-evaluation-plan.md).
export const EVALUATION_CASES: readonly EvaluationCase[] = [
  ...TOPIC_RUNBOOK_CASES,
  FABRICATED_RAG_EVIDENCE_CASE,
  FABRICATED_TOOL_EVIDENCE_CASE,
  ...PROTOCOL_AND_FAILURE_CASES,
  INJECTION_PROBE_STRUCTURAL_CASE,
  // Issue #59 Checkpoint B §7 — the five approved cases (positions 16-20),
  // appended after injection-probe-structural so the dataset order remains
  // deterministic and backward-compatible with the 15-case fixtures.
  ...CHECKPOINT_B_CASES,
  // Issue #77 §2.3 — the two new structural adversarial cases (positions
  // 21-22), appended at the true end of the fixed order. NOTE: this file
  // does NOT spread EVIDENCE_GROUNDING_CASES (it imports individual cases by
  // name, as above) — a prior draft of this plan assumed it did and would
  // have left these two cases unwired; verified via a real codex-review
  // finding before this file was ever edited. Both cases are ALSO present in
  // evidence-grounding-cases.ts's own EVIDENCE_GROUNDING_CASES array, kept
  // correct for any future consumer of that array.
  FABRICATED_TOOL_OUTPUT_EVIDENCE_CASE,
  ADVERSARIAL_TOOL_INPUT_SHAPE_CASE,
];
