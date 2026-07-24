import { type DynamicModule, Module } from "@nestjs/common";
import type { PrismaClientHandle } from "@opspilot/database";

import { AgentJobsModule } from "./agent-jobs/agent-jobs.module";
import { AgentRunsModule } from "./agent-runs/agent-runs.module";
import { NotFoundModule } from "./common/not-found.module";
import { PrismaModule } from "./persistence/prisma.module";

@Module({})
export class AppModule {
  // Takes the single outer-owned PrismaClientHandle and guarded safeClose
  // main.ts creates — never constructs its own (see
  // docs/12-agent-run-api.md).
  static forRoot(handle: PrismaClientHandle, safeClose: () => Promise<void>): DynamicModule {
    return {
      module: AppModule,
      // NotFoundModule's catch-all route must be registered LAST so every
      // specific endpoint route is matched first — see
      // common/not-found.controller.ts.
      imports: [PrismaModule.forRoot(handle, safeClose), AgentJobsModule, AgentRunsModule, NotFoundModule],
    };
  }
}
