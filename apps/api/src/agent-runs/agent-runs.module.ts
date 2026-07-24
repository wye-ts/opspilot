import { Module } from "@nestjs/common";

import { AgentRuntimeModule } from "../execution/agent-runtime.module";
import { DeterministicExecutionModule } from "../execution/deterministic-execution.module";
import { AgentRunsController } from "./agent-runs.controller";

@Module({
  imports: [AgentRuntimeModule, DeterministicExecutionModule],
  controllers: [AgentRunsController],
})
export class AgentRunsModule {}
