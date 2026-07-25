import { Body, Controller, Get, HttpStatus, Inject, Param, Post, Res } from "@nestjs/common";
import type { RecordApprovalDecisionInput } from "@opspilot/contracts";
import type { Response } from "express";

import { mapDomainError } from "../errors/map-domain-error";
import { UuidParamSchema } from "../validation/uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "../validation/zod-validation.pipe";
import type { AgentRunApprovalService } from "./agent-run-approval.service";
import { AGENT_RUN_APPROVAL_SERVICE } from "./agent-run-approvals.tokens";
import { mapAgentRunApprovalResponse } from "./dto/agent-run-approval-response.mapper";
import { RecordApprovalDecisionInputSchema } from "./dto/record-approval-decision-request.schema";

@Controller()
export class AgentRunApprovalsController {
  constructor(@Inject(AGENT_RUN_APPROVAL_SERVICE) private readonly service: AgentRunApprovalService) {}

  @Post("agent-runs/:runId/approval")
  async recordApprovalDecision(
    @Param("runId", new ZodParamValidationPipe(UuidParamSchema)) runId: string,
    @Body(new ZodValidationPipe(RecordApprovalDecisionInputSchema)) body: RecordApprovalDecisionInput,
    @Res({ passthrough: true }) res: Response,
  ) {
    try {
      // Passed straight through, unmodified — RecordApprovalDecisionParams IS
      // RecordApprovalDecisionInput (packages/database/src/types.ts), so
      // there is nothing here to reconstruct. The one undefined -> null
      // note conversion happens exactly once, inside packages/database's
      // toRecordApprovalDecisionWrite — never in this controller.
      const result = await this.service.recordApprovalDecision(runId, body);
      if (result.outcome === "created") {
        res.status(HttpStatus.CREATED);
        res.setHeader("Location", `/v1/agent-runs/${runId}/approval`);
      } else {
        // Explicit, not relied-upon-as-default: with @Res({ passthrough: true }),
        // Nest does not apply its own automatic POST-defaults-to-201 status
        // once the handler has taken over the response object.
        res.status(HttpStatus.OK);
      }
      return { data: mapAgentRunApprovalResponse(result.view) };
    } catch (error) {
      throw mapDomainError(error, "recordApprovalDecision");
    }
  }

  @Get("agent-runs/:runId/approval")
  async getApprovalDecision(@Param("runId", new ZodParamValidationPipe(UuidParamSchema)) runId: string) {
    try {
      const view = await this.service.getApprovalDecision(runId);
      return { data: mapAgentRunApprovalResponse(view) };
    } catch (error) {
      throw mapDomainError(error, "getApprovalDecision");
    }
  }
}
