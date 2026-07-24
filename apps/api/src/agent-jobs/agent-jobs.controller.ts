import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Post } from "@nestjs/common";
import type { AgentRunService } from "@opspilot/agent-runtime";
import { TicketContextSchema, type TicketContext } from "@opspilot/contracts";

import { mapDomainError } from "../errors/map-domain-error";
import { UuidParamSchema } from "../validation/uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "../validation/zod-validation.pipe";
import { AGENT_RUN_SERVICE } from "../execution/execution.tokens";
import { mapAgentJobDetailResponse, mapAgentJobResponse } from "./dto/agent-job-response.mapper";

@Controller("agent-jobs")
export class AgentJobsController {
  constructor(@Inject(AGENT_RUN_SERVICE) private readonly agentRunService: AgentRunService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createAgentJob(@Body(new ZodValidationPipe(TicketContextSchema)) body: TicketContext) {
    try {
      const job = await this.agentRunService.createAgentJob(body);
      return { data: mapAgentJobResponse(job) };
    } catch (error) {
      throw mapDomainError(error, "createAgentJob");
    }
  }

  @Get(":jobId")
  async getAgentJob(@Param("jobId", new ZodParamValidationPipe(UuidParamSchema)) jobId: string) {
    try {
      const persisted = await this.agentRunService.getAgentJob(jobId);
      return { data: mapAgentJobDetailResponse(persisted) };
    } catch (error) {
      throw mapDomainError(error, "getAgentJob");
    }
  }
}
