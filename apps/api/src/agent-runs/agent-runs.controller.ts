import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  AgentRunServiceError,
  type AgentRunService,
  type ExecuteAndPersistResult,
  type ReplayLiveRunResult,
  type RunProviderUsageSummary,
  type ToolRegistry,
} from "@opspilot/agent-runtime";
import {
  LIVE_RUN_IDEMPOTENCY_KEY_HEADER,
  LiveRunIdempotencyKeySchema,
} from "@opspilot/contracts";
import {
  LiveRunAdmissionError,
  type LiveRunBudgetReservation,
  type PersistedAgentRun,
} from "@opspilot/database";
import { SUPPORTED_CLAUDE_MODEL, type AgentRunProviderMode } from "@opspilot/provider-claude";
import type { Request, Response } from "express";

import { ApiError } from "../errors/api-error";
import { mapDomainError } from "../errors/map-domain-error";
import {
  AGENT_PROVIDER_FACTORY,
  AGENT_RUN_SERVICE,
  LIVE_RUN_ADMISSION,
  RUN_EXECUTION_CONFIG,
  TOOL_REGISTRY,
  USAGE_HOOKS,
} from "../execution/execution.tokens";
import type { AgentProviderFactory } from "../execution/api-provider-factory";
import type {
  AuthorizedLiveRequest,
  LiveRunAdmissionController,
} from "../execution/live-run-admission";
import { logBudgetReconciliationFailure } from "../execution/live-run-budget-log";
import { logEventEmissionFailure } from "../execution/event-emission-log";
import { logReportValidationFailure } from "../execution/report-validation-log";
import { createRunAbortHandles } from "../execution/run-abort-context";
import { PUBLIC_TRIAL_DEFAULTS, type RunExecutionConfig } from "../execution/run-execution-config";
import type { ApiUsageHooks } from "../execution/usage-hooks";
import { UuidParamSchema } from "../validation/uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "../validation/zod-validation.pipe";
import { ExecuteAgentRunRequestSchema } from "./dto/execute-agent-run-request.schema";
import { mapAgentRunResponse } from "./dto/agent-run-response.mapper";

interface RunAccounting {
  readonly usageSummary: RunProviderUsageSummary | null;
  readonly reservation: LiveRunBudgetReservation | null;
  readonly runId: string | null;
}

const NOTHING_TO_RECONCILE: RunAccounting = {
  usageSummary: null,
  reservation: null,
  runId: null,
};

/**
 * What the cleanup block needs to reconcile the budget, from whichever shape the
 * execution produced.
 *
 * Accepts either a result or a thrown AgentRunServiceError, because a crash is
 * the one path that returns nothing — and a run that crashed after a provider
 * call still spent real money, so it still has to be accounted for.
 */
function accountingOf(outcome: ExecuteAndPersistResult | AgentRunServiceError | undefined): RunAccounting {
  if (outcome === undefined) {
    return NOTHING_TO_RECONCILE;
  }

  if (outcome instanceof AgentRunServiceError) {
    return {
      usageSummary: outcome.executionContext?.usageSummary ?? null,
      reservation: outcome.executionContext?.reservation ?? null,
      runId: outcome.runId,
    };
  }

  if (outcome.persistence === "persisted") {
    return {
      usageSummary: outcome.usageSummary,
      reservation: outcome.reservation,
      runId: outcome.run.run.id,
    };
  }

  // Both of these executed real provider work before failing to persist, so
  // both carry the usage snapshot and the reservation the cleanup block must
  // reconcile. `event-emission` is identical to `finalization` in this
  // respect: the run is left RUNNING, but the tokens were still spent, and an
  // unreconciled reservation latches the whole day closed.
  if (outcome.stage === "finalization" || outcome.stage === "event-emission") {
    return {
      usageSummary: outcome.usageSummary,
      reservation: outcome.reservation,
      runId: outcome.runId,
    };
  }

  // run-creation failed, so no provider call happened and no reservation was
  // committed — there is nothing to reconcile.
  return NOTHING_TO_RECONCILE;
}

/**
 * Reads and validates the LIVE run's client request key.
 *
 * PART OF STEP 1 (request validation), deliberately — not part of admission.
 * It runs before the capability check, the kill switch, the token, the rate
 * limiter and the concurrency lease, for the same reason the Zod body pipe
 * already does: a malformed request is answered from the request alone, and
 * doing it here means a bad key cannot consume another client's rate-limit
 * budget or wedge the single concurrency slot on its way to being rejected.
 *
 * The value is used to build the request and is never logged — see the header's
 * contract in @opspilot/contracts.
 */
function requireIdempotencyKey(request: Request): string {
  const parsed = LiveRunIdempotencyKeySchema.safeParse(
    request.header(LIVE_RUN_IDEMPOTENCY_KEY_HEADER),
  );
  if (!parsed.success) {
    // One code for absent, blank, malformed, and oversized alike. Which of the
    // four it was tells an honest caller nothing it does not already know from
    // the documented requirement, and telling them apart would publish how the
    // value is parsed.
    throw new ApiError("LIVE_RUN_IDEMPOTENCY_KEY_INVALID");
  }
  return parsed.data;
}

@Controller()
export class AgentRunsController {
  constructor(
    @Inject(AGENT_RUN_SERVICE) private readonly agentRunService: AgentRunService,
    @Inject(TOOL_REGISTRY) private readonly toolRegistry: ToolRegistry,
    @Inject(AGENT_PROVIDER_FACTORY) private readonly providerFactory: AgentProviderFactory,
    @Inject(RUN_EXECUTION_CONFIG) private readonly config: RunExecutionConfig,
    @Inject(LIVE_RUN_ADMISSION) private readonly admission: LiveRunAdmissionController,
    @Inject(USAGE_HOOKS) private readonly usageHooks: ApiUsageHooks,
  ) {}

  @Post("agent-jobs/:jobId/runs")
  async createAgentRun(
    @Param("jobId", new ZodParamValidationPipe(UuidParamSchema)) jobId: string,
    @Body(new ZodValidationPipe(ExecuteAgentRunRequestSchema))
    body: { readonly providerMode?: AgentRunProviderMode },
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // ── Step 1. Validate the requested provider mode ───────────────────────
    // Done by the pipe above; an invalid enum value is a 400 before anything
    // here runs. An absent `providerMode` means "whatever this server defaults
    // to", which is what keeps every pre-PR-6B1 caller working. An explicitly
    // requested mode is never overridden and never downgraded: a LIVE request
    // that cannot be served is refused, not quietly run as FAKE.
    const requestedMode: AgentRunProviderMode = body.providerMode ?? this.config.defaultRequestMode;

    return requestedMode === "FAKE"
      ? this.executeFake(jobId, res)
      : this.executeLive(jobId, request, res);
  }

  /**
   * The deterministic path, unchanged from PR 6B1.
   *
   * Bypasses admission steps 2–7 entirely: no token check, no rate limit, no
   * concurrency lease, no budget reservation, no collector, and no abort context.
   * A FAKE run makes no network call, so there is nothing to bound, cancel, or
   * account for — and attaching any of it would be pure overhead.
   */
  private async executeFake(jobId: string, res: Response) {
    let result: ExecuteAndPersistResult;
    try {
      result = await this.agentRunService.executeAndPersist({
        jobId,
        providerMode: "FAKE",
        modelIdentifier: null,
        // getAgentJob is never called before execution — the job snapshot is
        // derived exclusively from the row executeAndPersist's own startRun call
        // locks and returns (see docs/12-agent-run-api.md).
        createProvider: (job) => this.providerFactory.createProvider(job, "FAKE"),
        toolRegistry: this.toolRegistry,
        onReportSchemaInvalid: logReportValidationFailure,
        onEventEmissionFailure: logEventEmissionFailure,
      });
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        throw new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
      }
      throw error;
    }

    return this.respond(result, res);
  }

  /**
   * The live path, in the canonical order.
   *
   *    1b   client request key                — a 400 before anything is held
   *    2–4  AUTHORIZATION                     (this.admission.authorize)
   *    4c   PUBLIC trial only (issue #39)     (this.admission.authorizePublicTrial)
   *         — Turnstile + visitor identity, a no-op on the private path,
   *           BEFORE 4b's database access
   *    4b   locked replay-only lookup         — answers 200, or falls through
   *    5–7  NEW-RUN SPEND ADMISSION           (this.admission.admitNewRun)
   *    8    authoritative transaction        — commits before any provider call
   *    9    orchestrator under the composed abort signal
   *   10    provenance resolved, then finalize with persisted usage
   *   11    reconcile against the RESERVATION's date
   *   12    release the concurrency lease in an inner finally
   *
   * THE SPLIT AT 4b IS THE POINT, and it fixes a real hole. Steps 2–7 used to run
   * as one block, so a request could not be RECOGNIZED as a repeat until after
   * every gate that governs NEW spending had let it through. That made the
   * documented 200 replay unreachable in precisely the situations it exists for:
   *
   *   the original request consumes the day's final reservation (or fails to
   *   reconcile, latching the day) -> its response is lost -> the recovery
   *   repeats the same key -> the advisory budget gate refuses at step 6, before
   *   any lookup -> the run that already exists can never be handed back
   *
   * The same held for an exhausted rate window and a busy concurrency slot.
   *
   * So the two questions are now asked in the order they actually depend on each
   * other. "May this caller be served at all?" (2–4) governs everything. "Does
   * this request already exist?" (4b) is answered next, for free. Only if the
   * answer is no does "may a NEW paid execution start?" (5–7) get asked.
   *
   * Nothing about a new key is relaxed: a request with no existing run runs the
   * identical gates, in the identical order, with the identical codes. And
   * authorization still comes first, so a replay is never an authentication
   * bypass and no unauthenticated caller can probe whether a key exists.
   *
   * No LIVE rejection ever retries as FAKE.
   *
   * Step 8 may still answer REPLAYED, and that is not redundant with 4b: two
   * same-key requests can both find nothing at 4b and both reach admission, and
   * only the locked transaction can decide which of them creates the run.
   *
   * THE ADMISSION DECISION LOG IS SETTLED FROM STEP 8'S RESULT, never from
   * `admitNewRun` resolving. Passing steps 5–7 proves only that this request MAY
   * reach the authoritative transaction — it does not prove that transaction
   * will create a new run, because a concurrent same-key request can still win
   * the race and commit first. Recording `admitted` as soon as the lease was
   * acquired would misreport that race's loser as a paid execution it never
   * performed. See `recordExecutionDecision` below and `AuthorizedLiveRequest`.
   */
  private async executeLive(jobId: string, request: Request, res: Response) {
    // Step 1b. Before authorization on purpose — see requireIdempotencyKey.
    const clientRequestId = requireIdempotencyKey(request);

    // Steps 2–4. Capability, kill switch, shared token. Throws an ApiError for
    // any rejection, and holds nothing: no lease, no allowance, no reservation.
    const authorized = this.admission.authorize(request);

    // Step 4c (issue #39) — PUBLIC trial only: Turnstile, then visitor
    // identity. A no-op on the private-token path. MUST run before any
    // database access, the replay lookup included — see
    // docs/reviews/23-issue-39-public-live-trial-plan.md §9 and
    // authorizePublicTrial's own doc comment.
    const publicTrial = await this.admission.authorizePublicTrial(request, res, authorized);

    // Step 4b. A locked, read-only lookup that takes no lease and consumes no
    // allowance — so a closed budget, a latched day, an exhausted rate window, or
    // a busy concurrency slot cannot stand between a caller and a run that
    // already exists.
    const replayed = await this.replayLiveRun(jobId, clientRequestId, authorized);
    if (replayed !== null) {
      // Rendered through the SAME responder a freshly created run uses, so the
      // 200/201 distinction and the Location header are decided in one place.
      // Steps 5–12 do not happen at all: nothing was admitted, so there is no
      // lease to release and no reservation to reconcile.
      authorized.recordReplayed();
      return this.respond(
        {
          persistence: "persisted",
          run: replayed,
          usageSummary: null,
          reservation: null,
          execution: "replayed",
        },
        res,
      );
    }

    // Steps 5–7. Rate limit, advisory budget, concurrency lease. Nothing durable
    // has been written yet, so a rejection here consumes no reservation and
    // creates no run.
    const admission = await this.admission.admitNewRun(request, authorized);

    const abort = createRunAbortHandles(res, this.config.providerDeadlineMs);

    let result: ExecuteAndPersistResult | undefined;
    let crash: AgentRunServiceError | undefined;

    try {
      // Steps 8–10. The service owns the transaction, the single collector, the
      // one snapshot, and usage persistence — see AgentRunService.
      // No explicit type argument: TCollector is inferred from `usageHooks`, so
      // the `collector` parameter below is the CONCRETE Claude collector (with
      // its `record`) rather than the runtime's narrow snapshot-only view.
      result = await this.agentRunService.executeAndPersist({
        jobId,
        providerMode: "LIVE",
        // The model is a fact about the provider that ran, so it is recorded for
        // LIVE and left null for FAKE rather than being invented.
        modelIdentifier: SUPPORTED_CLAUDE_MODEL,
        createProvider: (job, collector) =>
          this.providerFactory.createProvider(job, "LIVE", collector),
        toolRegistry: this.toolRegistry,
        outputBudget: this.config.liveRunSafeguards.outputBudget,
        usageHooks: this.usageHooks,
        // PUBLIC (issue #39) is a fixed, non-configurable 1 — never
        // LIVE_RUN_MAX_ATTEMPTS_PER_JOB, which remains the private path's
        // (configurable, default 2) limit. See PUBLIC_TRIAL_DEFAULTS.
        liveAttemptLimit:
          publicTrial !== null
            ? PUBLIC_TRIAL_DEFAULTS.maxAttemptsPerJob
            : this.config.liveRunSafeguards.maxAttemptsPerJob,
        budgetReservationInput: admission.reservationInput,
        clientRequestId,
        // Present only for a PUBLIC trial attempt (issue #39) — absent here
        // makes this call byte-identical to the private path.
        ...(publicTrial !== null ? { publicTrial } : {}),
        // Only `abortContext` is passed — never a separately-derived `signal`
        // alongside it. AgentRunService computes the effective signal from
        // `abortContext.signal` itself, which is what makes it impossible for the
        // provider to be cancelled by one signal while finalization resolves
        // abort provenance from another.
        abortContext: abort.context,
        onReportSchemaInvalid: logReportValidationFailure,
        onEventEmissionFailure: logEventEmissionFailure,
      });

      // Settled from the AUTHORITATIVE result, before responding — not from
      // `admitNewRun` having resolved. See the comment on `executeLive` above.
      this.recordExecutionDecision(result, authorized);
      return this.respond(result, res);
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        // Captured, not just rethrown: the cleanup block below reads its internal
        // execution context so a crashed run that already spent tokens is still
        // reconciled.
        crash = error;
        // A crash is only reachable AFTER `started = ...` succeeded — the replay
        // exit returns long before any provider is built (see AgentRunService).
        // So a run genuinely started here, and that is the fact worth recording
        // even though this particular attempt then failed to finish.
        authorized.recordAdmitted();
        throw new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
      }
      if (error instanceof LiveRunAdmissionError) {
        // Raised from inside the authoritative transaction — the per-job attempt
        // limit, the closed budget gate, or a stored ticket context that fails
        // the current LIVE execution bounds. All three are domain rejections
        // rather than server faults, and all three roll the transaction back, so
        // no run row and no reservation survive any of them.
        //
        // An exhaustive switch, not a two-way ternary: the previous form treated
        // "not the attempt limit" as "budget exhausted", so a third code would
        // have been reported as a 429 about the daily allowance. Adding a code
        // must not silently mislabel it.
        const apiError = new ApiError(error.code, { cause: error });
        authorized.recordRejected(apiError);
        throw apiError;
      }
      throw error;
    } finally {
      // Detaches the response listeners. Safe on every path, including the one
      // where the connection already dropped and the handle self-settled.
      abort.dispose();

      // Resolved ONCE, before the cleanup that uses it, so the reconciliation
      // call and the failure log cannot disagree about which run and which day
      // they are talking about.
      const accounting = accountingOf(crash ?? result);

      // The nested structure is a structural guarantee, not a convention: the
      // lease release sits in the INNER finally, so it runs whether
      // reconciliation succeeded, threw, or was skipped. Reconciliation can
      // therefore never leak the concurrency slot — and it can never replace the
      // response either, because this block runs after `return this.respond(...)`
      // has already produced its value.
      try {
        if (accounting.usageSummary !== null && accounting.reservation !== null) {
          // Step 11. Keyed on the RESERVATION's budgetDate — never a recomputed
          // "today". A run reserved at 23:59:50Z and finishing at 00:00:30Z
          // reconciles the day it reserved against; recomputing would credit the
          // new day and leave yesterday's reservation permanently unreconciled.
          await this.agentRunService.reconcileLiveRunBudget(
            accounting.reservation,
            accounting.usageSummary,
          );
        }
      } catch (error) {
        // Swallowed deliberately. A reconciliation failure must never change the
        // HTTP response: the run genuinely happened, the caller needs its id, and
        // turning a successful run into a 500 because a bookkeeping UPDATE failed
        // would be strictly worse for the caller than a stale budget row.
        //
        // "Stale" is NOT "harmless", and the distinction is precise. The daily
        // RUN COUNT remains correct — runs_reserved was incremented before
        // execution and is never decremented. The COST ACCOUNTING does not:
        // estimated_cost_nano_usd and pricing_unknown_runs are now missing a run
        // that already executed.
        //
        // What makes swallowing this safe is therefore NOT that the failure is
        // benign; it is that the resulting runs_reserved > runs_completed
        // mismatch is itself the fail-closed latch. Both the advisory read and
        // the authoritative reservation statement require the counters to match,
        // so this day admits no further LIVE runs until they do — see
        // startLiveRunWithAttemptLimit. The next UTC day starts from a clean row.
        //
        // The log is fixed-shape and sanitized — no credential, token, prompt,
        // provider body, SQL, or stack — and cannot itself throw.
        logBudgetReconciliationFailure({
          budgetDate: accounting.reservation?.budgetDate ?? "unknown",
          runId: accounting.runId,
          error,
        });
      } finally {
        // Step 12. Always, on every exit path.
        admission.concurrencyLease.release();
      }
    }
  }

  /**
   * Step 4b — the authenticated, replay-only lookup.
   *
   * Returns the existing run, or `null` when this key names none. A `null` is a
   * statement about the database, never about a failure to read it: a lookup that
   * could not complete THROWS rather than falling through, because continuing to
   * new-run admission on an unknown answer is how a request that may already have
   * executed becomes a second paid one.
   *
   * The persistence failure is mapped in the `run-creation` context, so a
   * nonexistent job produces the same 404 AGENT_JOB_NOT_FOUND the authoritative
   * transaction produces for it, and an outage produces the same 503 — one cause,
   * one public contract, whichever step happened to meet it.
   */
  private async replayLiveRun(
    jobId: string,
    clientRequestId: string,
    authorized: AuthorizedLiveRequest,
  ): Promise<PersistedAgentRun | null> {
    let result: ReplayLiveRunResult;
    try {
      result = await this.agentRunService.replayLiveRun({ jobId, clientRequestId });
    } catch (error) {
      // An unexpected throw is still this request's final decision, so it is
      // recorded like any other rather than leaving the request unlogged.
      authorized.recordRejected(error);
      throw error;
    }

    if (result.replay === "found") return result.run;
    if (result.replay === "absent") return null;

    const apiError = mapDomainError(result.error, "run-creation");
    authorized.recordRejected(apiError);
    throw apiError;
  }

  /**
   * Settles the admission decision log from the AUTHORITATIVE transaction's
   * result — the only place that actually knows whether this request created a
   * new run, was overtaken by a concurrent replay, or was refused before
   * anything was created.
   *
   * Called once, after `executeAndPersist` resolves and before `respond` (which
   * may itself throw for the `unavailable` variants) — so the decision is
   * recorded regardless of what `respond` does with the result afterward.
   *
   * The mapping, and why each case lands where it does:
   *
   *   execution: "started"                 -> admitted   (a new run was created)
   *   execution: "replayed"                -> replayed   (a concurrent same-key
   *                                                        request won the race —
   *                                                        see executeLive)
   *   unavailable, stage: "finalization"    -> admitted   (the provider genuinely
   *                                                        ran; only persisting
   *                                                        the outcome failed)
   *   unavailable, stage: "run-creation"    -> rejected   (nothing was ever
   *                                                        created)
   *
   * The finalization case is deliberately NOT `rejected`: the run spent tokens
   * (or definitively did not) before persistence failed, which is a fact about
   * execution, not about admission. Collapsing it into `rejected` would make a
   * genuinely started — and possibly paid — run indistinguishable in the log
   * from a request that never got past the gates at all.
   */
  private recordExecutionDecision(
    result: ExecuteAndPersistResult,
    authorized: AuthorizedLiveRequest,
  ): void {
    if (result.persistence === "persisted") {
      if (result.execution === "replayed") {
        authorized.recordReplayed();
      } else {
        authorized.recordAdmitted();
      }
      return;
    }

    // Both admitted a real execution: the authoritative transaction ran, the
    // run row exists, and a provider may well have been called. Only
    // run-creation below represents an attempt that never got that far.
    if (result.stage === "finalization" || result.stage === "event-emission") {
      authorized.recordAdmitted();
      return;
    }

    // stage === "run-creation": the authoritative transaction itself could not
    // run — no job lock was held long enough to create anything.
    authorized.recordRejected(mapDomainError(result.error, "run-creation"));
  }

  /**
   * 201 for a finalized run, whatever its status.
   *
   * An expected provider failure — auth, rate limit, timeout, cancellation —
   * produces a real AgentRun row with a FAILED status and a PROVIDER_* code.
   * Returning 502 or 504 for it would be contradictory: the resource was created,
   * the caller needs its id, and a later GET returns exactly this body. Hiding a
   * created run behind an error envelope would leave the UI with no runId and no
   * way to show the timeline.
   *
   * On an ACTUAL client disconnect nothing is written at all — the connection is
   * gone — but the run still finalizes FAILED with PROVIDER_CANCELLED.
   *
   * 200, not 201, for an idempotent REPLAY. This request created nothing: the
   * run it returns already existed, so claiming Created would be false, and a
   * client counting 201s would count one paid attempt too many. `Location` is
   * still sent, because it still names where the run lives.
   *
   * The BODY is identical either way — the same mapper over the same read model
   * — so a caller that only wants the run does not have to care which happened.
   */
  private respond(result: ExecuteAndPersistResult, res: Response) {
    if (result.persistence === "unavailable") {
      // Three distinct contexts now, because each maps PERSISTENCE_NOT_FOUND
      // differently: run-creation means the JOB was not found (404), while
      // finalization and event-emission both concern a run that demonstrably
      // existed, so a NOT_FOUND there is stored-data corruption (500).
      const context =
        result.stage === "run-creation"
          ? "run-creation"
          : result.stage === "event-emission"
            ? "event-emission"
            : "finalization";
      throw mapDomainError(result.error, context);
    }

    res.status(result.execution === "replayed" ? HttpStatus.OK : HttpStatus.CREATED);
    res.setHeader("Location", `/v1/agent-runs/${result.run.run.id}`);
    return { data: mapAgentRunResponse(result.run) };
  }

  @Get("agent-runs/:runId")
  async getAgentRun(@Param("runId", new ZodParamValidationPipe(UuidParamSchema)) runId: string) {
    try {
      const persisted = await this.agentRunService.getAgentRun(runId);
      return { data: mapAgentRunResponse(persisted) };
    } catch (error) {
      throw mapDomainError(error, "getAgentRun");
    }
  }
}
