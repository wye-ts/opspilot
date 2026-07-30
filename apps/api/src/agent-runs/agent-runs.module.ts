import { Module } from "@nestjs/common";

import { AgentRuntimeModule } from "../execution/agent-runtime.module";
import { RunExecutionModule } from "../execution/run-execution.module";
import { AgentRunsController } from "./agent-runs.controller";

@Module({
  imports: [AgentRuntimeModule, RunExecutionModule],
  controllers: [AgentRunsController],
})
export class AgentRunsModule {}
