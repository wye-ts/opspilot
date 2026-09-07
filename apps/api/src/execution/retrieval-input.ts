import type { RetrievalInput } from "@opspilot/agent-runtime";
import type { AgentJobRecord } from "@opspilot/database";

// Issue #72 §2.2: the per-job RetrievalInput factory AgentRunsController
// passes to executeAndPersist (both the FAKE and LIVE call sites) as
// `retrievalInputFactory`. Resolved by agent-run-service.ts against the
// authoritative, row-locked AgentJobRecord `startRun`/`startLiveRunWithAttemptLimit`
// returned — never against a separately-timed read.
//
// The query is the ticket's own summary, unmodified: the same text
// deterministic-scenario.ts already derives serviceSlug from, so both the
// retriever and the deterministic FAKE scenario reason about the identical
// ticket text. topK mirrors apps/worker/src/evaluation/types.ts's
// EVALUATION_TOP_K (3) — the same bound this repo's evaluation harness
// already uses for a "one representative topK" retrieval call, kept in sync
// by convention rather than a cross-package import (evaluation types are
// worker-internal, not part of any shared package's public surface).
const RETRIEVAL_TOP_K = 3;

export function buildRetrievalInput(job: AgentJobRecord): RetrievalInput {
  return { query: job.ticketContext.summary, topK: RETRIEVAL_TOP_K };
}
