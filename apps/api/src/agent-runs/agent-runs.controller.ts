import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res } from "@nestjs/common";
import {
  AgentRunServiceError,
  type AgentRunService,
  type ExecuteAndPersistResult,
  type RunProviderUsageSummary,
  type ToolRegistry,
} from "@opspilot/agent-runtime";
import { LiveRunAdmissionError, type LiveRunBudgetReservation } from "@opspilot/database";
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
import type { LiveRunAdmissionController } from "../execution/live-run-admission";
import { logBudgetReconciliationFailure } from "../execution/live-run-budget-log";
import { createRunAbortHandles } from "../execution/run-abort-context";
import type { RunExecutionConfig } from "../execution/run-execution-config";
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

  if (outcome.stage === "finalization") {
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
   * The live path, in the canonical admission order.
   *
   *    2–7  admission                        (this.admission.admit)
   *    8    authoritative transaction        — commits before any provider call
   *    9    orchestrator under the composed abort signal
   *   10    provenance resolved, then finalize with persisted usage
   *   11    reconcile against the RESERVATION's date
   *   12    release the concurrency lease in an inner finally
   *
   * No LIVE rejection ever retries as FAKE.
   */
  private async executeLive(jobId: string, request: Request, res: Response) {
    // Steps 2–7. Throws an ApiError for any rejection. Nothing durable has been
    // written yet, so a rejection here consumes no reservation and creates no run.
    const admission = await this.admission.admit(request);

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
        maxOutputTokens: this.config.liveRunSafeguards.maxOutputTokens,
        usageHooks: this.usageHooks,
        liveAttemptLimit: this.config.liveRunSafeguards.maxAttemptsPerJob,
        budgetReservationInput: admission.reservationInput,
        // Only `abortContext` is passed — never a separately-derived `signal`
        // alongside it. AgentRunService computes the effective signal from
        // `abortContext.signal` itself, which is what makes it impossible for the
        // provider to be cancelled by one signal while finalization resolves
        // abort provenance from another.
        abortContext: abort.context,
      });

      return this.respond(result, res);
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        // Captured, not just rethrown: the cleanup block below reads its internal
        // execution context so a crashed run that already spent tokens is still
        // reconciled.
        crash = error;
        throw new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
      }
      if (error instanceof LiveRunAdmissionError) {
        // Raised from inside the authoritative transaction — the per-job attempt
        // limit or the closed budget gate. A domain rejection, not a server
        // fault, so it becomes a 429; the transaction rolled back, so no run row
        // and no reservation survive it.
        throw error.code === "LIVE_RUN_ATTEMPT_LIMIT"
          ? new ApiError("LIVE_RUN_ATTEMPT_LIMIT", { cause: error })
          : new ApiError("LIVE_RUN_BUDGET_EXHAUSTED", { cause: error });
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
   */
  private respond(result: ExecuteAndPersistResult, res: Response) {
    if (result.persistence === "unavailable") {
      const context = result.stage === "run-creation" ? "run-creation" : "finalization";
      throw mapDomainError(result.error, context);
    }

    res.status(HttpStatus.CREATED);
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
