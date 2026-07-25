import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { PrismaClientHandle } from "@opspilot/database";

import { PrismaLifecycleService } from "./prisma-lifecycle.service";
import { PRISMA_CLIENT_HANDLE, PRISMA_SAFE_CLOSE } from "./prisma.tokens";

// Global — main.ts owns the single PrismaClientHandle and guarded safeClose
// (see docs/12-agent-run-api.md); every other module needs read access to
// the same handle without threading it through every intermediate module's
// imports array.
@Global()
@Module({})
export class PrismaModule {
  static forRoot(handle: PrismaClientHandle, safeClose: () => Promise<void>): DynamicModule {
    return {
      module: PrismaModule,
      providers: [
        { provide: PRISMA_CLIENT_HANDLE, useValue: handle },
        { provide: PRISMA_SAFE_CLOSE, useValue: safeClose },
        PrismaLifecycleService,
      ],
      exports: [PRISMA_CLIENT_HANDLE, PRISMA_SAFE_CLOSE],
    };
  }
}
