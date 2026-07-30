import { Module } from "@nestjs/common";
import type { PrismaClientHandle } from "@opspilot/database";

import { PRISMA_CLIENT_HANDLE } from "../persistence/prisma.tokens";
import { createAgentRunApprovalService, type AgentRunApprovalService } from "./agent-run-approval.service";
import { AgentRunApprovalsController } from "./agent-run-approvals.controller";
import { AGENT_RUN_APPROVAL_SERVICE } from "./agent-run-approvals.tokens";

// Self-contained: no `imports` array needed since PrismaModule is @Global()
// (see persistence/prisma.module.ts) — PRISMA_CLIENT_HANDLE is reachable
// without threading it through this module's imports. No dependency on
// AgentRuntimeModule/RunExecutionModule or the orchestrator —
// approval has no orchestrator involvement (docs/13-approval-workflow.md
// §10); execution.tokens.ts and execution/agent-runtime.module.ts are
// untouched by this module.
@Module({
  controllers: [AgentRunApprovalsController],
  providers: [
    {
      provide: AGENT_RUN_APPROVAL_SERVICE,
      useFactory: (handle: PrismaClientHandle): AgentRunApprovalService => createAgentRunApprovalService(handle.prisma),
      inject: [PRISMA_CLIENT_HANDLE],
    },
  ],
})
export class AgentRunApprovalsModule {}
