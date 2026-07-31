// Named re-export syntax (`export { X } from "./y"`) compiles, under
// CommonJS, to a live-binding getter. Vite-node's CJS interop (used by
// Vitest) does not reliably forward these getters when this module is
// consumed via a default import (required for worker's ESM<->CommonJS
// interop — see docs/11-agent-run-persistence.md and packages/agent-runtime/
// src/index.ts for the full explanation): every getter-backed property reads
// back as `undefined` under Vitest, even though plain Node and tsx are
// unaffected. Every VALUE export below is therefore imported first, then
// re-exported as a plain `const` — which compiles to a direct property
// assignment, not a getter. Type-only exports are unaffected (fully erased
// at compile time) and keep the ordinary `export type {...} from "./y"` form.

import { createPrismaClient as _createPrismaClient } from "./client";
import { AgentRunApprovalError as _AgentRunApprovalError } from "./approval-errors";
import { LiveRunAdmissionError as _LiveRunAdmissionError } from "./live-run-errors";
import { PersistenceError as _PersistenceError, normalizeDatabaseError as _normalizeDatabaseError } from "./errors";
import { FAILURE_DISPLAY_MESSAGES as _FAILURE_DISPLAY_MESSAGES } from "./failure-messages";
import { TicketContextSchema as _TicketContextSchema, validateOrThrow as _validateOrThrow } from "./validation";
import {
  createJob as _createJob,
  currentBudgetDate as _currentBudgetDate,
  finalizeCompleted as _finalizeCompleted,
  finalizeFailed as _finalizeFailed,
  getAgentJob as _getAgentJob,
  getAgentRun as _getAgentRun,
  isLiveRunBudgetOpen as _isLiveRunBudgetOpen,
  reconcileLiveRunBudget as _reconcileLiveRunBudget,
  replayLiveRun as _replayLiveRun,
  startLiveRunWithAttemptLimit as _startLiveRunWithAttemptLimit,
  startRun as _startRun,
} from "./repositories/agent-run-repository";
import {
  getApprovalDecision as _getApprovalDecision,
  recordApprovalDecision as _recordApprovalDecision,
} from "./repositories/agent-run-approval-repository";

export const createPrismaClient = _createPrismaClient;
export const AgentRunApprovalError = _AgentRunApprovalError;
export const LiveRunAdmissionError = _LiveRunAdmissionError;
export const PersistenceError = _PersistenceError;
export const normalizeDatabaseError = _normalizeDatabaseError;
export const FAILURE_DISPLAY_MESSAGES = _FAILURE_DISPLAY_MESSAGES;
export const TicketContextSchema = _TicketContextSchema;
export const validateOrThrow = _validateOrThrow;
export const createJob = _createJob;
export const finalizeCompleted = _finalizeCompleted;
export const finalizeFailed = _finalizeFailed;
export const getAgentJob = _getAgentJob;
export const getAgentRun = _getAgentRun;
export const startRun = _startRun;
export const startLiveRunWithAttemptLimit = _startLiveRunWithAttemptLimit;
export const replayLiveRun = _replayLiveRun;
export const reconcileLiveRunBudget = _reconcileLiveRunBudget;
export const isLiveRunBudgetOpen = _isLiveRunBudgetOpen;
export const currentBudgetDate = _currentBudgetDate;
export const recordApprovalDecision = _recordApprovalDecision;
export const getApprovalDecision = _getApprovalDecision;

export type { PrismaClient, PrismaClientHandle } from "./client";
// A re-exported `export type { PersistenceError } from "./errors"` would
// redeclare the plain-const value export above (TS2323). A local type-alias
// declaration does not conflict, because it lives in the type namespace
// while the const lives in the value namespace — exactly like `class X`
// merges both namespaces under one name. This restores PersistenceError as
// an ordinary type usable at consumer call sites (e.g.
// `readonly error: PersistenceError`) without `InstanceType<typeof X>`.
export type PersistenceError = InstanceType<typeof PersistenceError>;
export type { PersistenceErrorCode } from "./errors";
// Same TS2323-avoidance pattern as PersistenceError above.
export type AgentRunApprovalError = InstanceType<typeof AgentRunApprovalError>;
export type { AgentRunApprovalErrorCode } from "./approval-errors";
// Same TS2323-avoidance pattern as PersistenceError above.
export type LiveRunAdmissionError = InstanceType<typeof LiveRunAdmissionError>;
export type { LiveRunAdmissionErrorCode } from "./live-run-errors";
export type {
  AgentJobRecord,
  AgentRunApprovalRecord,
  AgentRunApprovalStatus,
  AgentRunApprovalView,
  AgentRunApprovalWrite,
  AgentRunOutcome,
  AgentRunRecord,
  AgentRunStatus,
  ApprovalDecision,
  PersistedAgentJob,
  PersistedAgentRun,
  ProviderMode,
  LiveRunBudgetReservation,
  LiveRunBudgetReservationInput,
  LiveRunStartResult,
  RecordApprovalDecisionParams,
  RecordApprovalDecisionResult,
  ReplayedLiveRun,
  RunPricingStatus,
  RunProviderUsageWrite,
  StartedAgentRun,
  StartedLiveRun,
  TicketContext,
} from "./types";
