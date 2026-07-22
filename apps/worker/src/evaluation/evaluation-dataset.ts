import {
  FABRICATED_RAG_EVIDENCE_CASE,
  FABRICATED_TOOL_EVIDENCE_CASE,
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
];
