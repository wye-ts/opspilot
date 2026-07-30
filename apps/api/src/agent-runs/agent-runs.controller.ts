import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Req, Res } from "@nestjs/common";
import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import { SUPPORTED_CLAUDE_MODEL, type AgentRunProviderMode } from "@opspilot/provider-claude";
import type { Request, Response } from "express";

import { ApiError } from "../errors/api-error";
import { mapDomainError } from "../errors/map-domain-error";
import {
  AGENT_PROVIDER_FACTORY,
  AGENT_RUN_SERVICE,
  RUN_EXECUTION_CONFIG,
  TOOL_REGISTRY,
} from "../execution/execution.tokens";
import type { AgentProviderFactory } from "../execution/api-provider-factory";
import { createRunAbortHandles } from "../execution/run-abort-context";
import type { RunExecutionConfig } from "../execution/run-execution-config";
import { UuidParamSchema } from "../validation/uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "../validation/zod-validation.pipe";
import { ExecuteAgentRunRequestSchema } from "./dto/execute-agent-run-request.schema";
import { mapAgentRunResponse } from "./dto/agent-run-response.mapper";

@Controller()
export class AgentRunsController {
  constructor(
    @Inject(AGENT_RUN_SERVICE) private readonly agentRunService: AgentRunService,
    @Inject(TOOL_REGISTRY) private readonly toolRegistry: ToolRegistry,
    @Inject(AGENT_PROVIDER_FACTORY) private readonly providerFactory: AgentProviderFactory,
    @Inject(RUN_EXECUTION_CONFIG) private readonly config: RunExecutionConfig,
  ) {}

  /**
   * Admission for a LIVE request, in a fixed order.
   *
   * Both checks happen before `startRun`, so a rejected request creates no
   * AgentRun row and consumes nothing — which is why they are error statuses
   * rather than a persisted FAILED run. They are also both decided from local
   * state: no Anthropic object is touched and no network call is made.
   *
   * Capability is checked before the kill switch so that an operator reading
   * logs on a server with no credential sees LIVE_NOT_CONFIGURED rather than a
   * misleading "disabled".
   */
  private assertLiveRunAdmitted(): void {
    if (this.config.liveCapability.kind !== "present") {
      throw new ApiError("LIVE_NOT_CONFIGURED");
    }

    // Fail closed. A capable, correctly configured deployment still refuses
    // live runs until someone deliberately sets LIVE_AGENT_RUNS_ENABLED=true,
    // so adding a credential is not by itself sufficient to start spending.
    if (!this.config.liveAgentRunsEnabled) {
      throw new ApiError("LIVE_RUNS_DISABLED");
    }
  }

  @Post("agent-jobs/:jobId/runs")
  async createAgentRun(
    @Param("jobId", new ZodParamValidationPipe(UuidParamSchema)) jobId: string,
    @Body(new ZodValidationPipe(ExecuteAgentRunRequestSchema))
    body: { readonly providerMode?: AgentRunProviderMode },
    @Req() _request: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // An absent `providerMode` means "whatever this server defaults to", which
    // is what keeps every pre-PR-6B1 caller working. An explicitly requested
    // mode is never overridden, and never downgraded: a LIVE request that
    // cannot be served is refused below, not quietly run as FAKE.
    const requestedMode: AgentRunProviderMode = body.providerMode ?? this.config.defaultRequestMode;

    if (requestedMode === "LIVE") {
      this.assertLiveRunAdmitted();
    }

    // Only a live run gets a deadline and a disconnect watch. A deterministic
    // run makes no network call, so there is nothing to bound and nothing to
    // cancel — and attaching response listeners to it would be pure overhead.
    const abort = requestedMode === "LIVE" ? createRunAbortHandles(res, this.config.providerDeadlineMs) : undefined;

    let result: Awaited<ReturnType<AgentRunService["executeAndPersist"]>>;
    try {
      result = await this.agentRunService.executeAndPersist({
        jobId,
        providerMode: requestedMode,
        // The model is a fact about the provider that ran, so it is recorded
        // for LIVE and left null for FAKE rather than being invented.
        modelIdentifier: requestedMode === "LIVE" ? SUPPORTED_CLAUDE_MODEL : null,
        // getAgentJob is never called before execution — the job snapshot is
        // derived exclusively from the row executeAndPersist's own startRun
        // call locks and returns (see docs/12-agent-run-api.md).
        createProvider: (job) => this.providerFactory.createProvider(job, requestedMode),
        toolRegistry: this.toolRegistry,
        // Only `abortContext` is passed — never a separately-derived `signal`
        // alongside it. AgentRunService computes the effective signal from
        // `abortContext.signal` itself (see agent-run-service.ts), which is
        // what makes it impossible for the provider to be cancelled by one
        // signal while finalization resolves abort provenance from another.
        //
        // exactOptionalPropertyTypes: an optional property must be absent or a
        // real value, never an explicit undefined.
        ...(abort !== undefined ? { abortContext: abort.context } : {}),
      });
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        throw new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
      }
      throw error;
    } finally {
      // Detaches the response listeners. Safe on every path, including the
      // one where the connection already dropped and the handle self-settled.
      abort?.dispose();
    }

    if (result.persistence === "unavailable") {
      const context = result.stage === "run-creation" ? "run-creation" : "finalization";
      throw mapDomainError(result.error, context);
    }

    // 201 for a finalized run, whatever its status.
    //
    // An expected provider failure — auth, rate limit, timeout, cancellation —
    // produces a real AgentRun row with a FAILED status and a PROVIDER_* code.
    // Returning 502 or 504 for it would be contradictory: the resource was
    // created, the caller needs its id, and a later GET returns exactly this
    // body. Hiding a created run behind an error envelope would leave the UI
    // with no runId and no way to show the timeline.
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
