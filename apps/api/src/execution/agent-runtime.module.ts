import { Module } from "@nestjs/common";
import { createAgentRunService, createPrismaAgentRunRepository, getServiceStatusTool, InMemoryToolRegistry } from "@opspilot/agent-runtime";
import type { PrismaClientHandle } from "@opspilot/database";

import { PRISMA_CLIENT_HANDLE } from "../persistence/prisma.tokens";
import { AGENT_RUN_SERVICE, TOOL_REGISTRY } from "./execution.tokens";

// The AgentRunService is built from the one outer-owned PrismaClientHandle —
// never constructed a second time inside a controller (see
// docs/12-agent-run-api.md). No live provider/retriever is wired anywhere
// in this module; the tool registry carries only the deterministic
// get_service_status tool.
@Module({
  providers: [
    {
      provide: AGENT_RUN_SERVICE,
      useFactory: (handle: PrismaClientHandle) => {
        const repository = createPrismaAgentRunRepository(handle.prisma);
        return createAgentRunService(repository);
      },
      inject: [PRISMA_CLIENT_HANDLE],
    },
    {
      provide: TOOL_REGISTRY,
      useValue: new InMemoryToolRegistry([getServiceStatusTool]),
    },
  ],
  exports: [AGENT_RUN_SERVICE, TOOL_REGISTRY],
})
export class AgentRuntimeModule {}
