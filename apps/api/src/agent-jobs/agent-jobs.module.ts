import { Module } from "@nestjs/common";

import { AgentRuntimeModule } from "../execution/agent-runtime.module";
import { AgentJobsController } from "./agent-jobs.controller";

@Module({
  imports: [AgentRuntimeModule],
  controllers: [AgentJobsController],
})
export class AgentJobsModule {}
