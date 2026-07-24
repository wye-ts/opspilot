import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import { AgentRunServiceError, type AgentRunService, type ToolRegistry } from "@opspilot/agent-runtime";
import type { Response } from "express";

import { ApiError } from "../errors/api-error";
import { mapDomainError } from "../errors/map-domain-error";
import { DETERMINISTIC_PROVIDER_FACTORY, AGENT_RUN_SERVICE, TOOL_REGISTRY } from "../execution/execution.tokens";
import type { DeterministicProviderFactory } from "../execution/deterministic-provider-factory";
import { UuidParamSchema } from "../validation/uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "../validation/zod-validation.pipe";
import { ExecuteAgentRunRequestSchema } from "./dto/execute-agent-run-request.schema";
import { mapAgentRunResponse } from "./dto/agent-run-response.mapper";

@Controller()
export class AgentRunsController {
  constructor(
    @Inject(AGENT_RUN_SERVICE) private readonly agentRunService: AgentRunService,
    @Inject(TOOL_REGISTRY) private readonly toolRegistry: ToolRegistry,
    @Inject(DETERMINISTIC_PROVIDER_FACTORY) private readonly providerFactory: DeterministicProviderFactory,
  ) {}

  @Post("agent-jobs/:jobId/runs")
  async createAgentRun(
    @Param("jobId", new ZodParamValidationPipe(UuidParamSchema)) jobId: string,
    // The parsed body is intentionally discarded — the run body carries no
    // usable fields, only {} or absent is accepted (§10.3).
    @Body(new ZodValidationPipe(ExecuteAgentRunRequestSchema)) _body: Record<string, never>,
    @Res({ passthrough: true }) res: Response,
  ) {
    let result: Awaited<ReturnType<AgentRunService["executeAndPersist"]>>;
    try {
      result = await this.agentRunService.executeAndPersist({
        jobId,
        providerMode: "FAKE",
        // getAgentJob is never called before execution — the job snapshot
        // is derived exclusively from the row executeAndPersist's own
        // startRun call locks and returns (see docs/12-agent-run-api.md).
        createProvider: (job) => this.providerFactory.createProvider(job),
        toolRegistry: this.toolRegistry,
      });
    } catch (error) {
      if (error instanceof AgentRunServiceError) {
        throw new ApiError("AGENT_EXECUTION_CRASHED", { runId: error.runId, cause: error });
      }
      throw error;
    }

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
