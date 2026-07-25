import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import type { PrismaClientHandle } from "@opspilot/database";

import { PRISMA_CLIENT_HANDLE, PRISMA_SAFE_CLOSE } from "./prisma.tokens";

const INITIALIZATION_FAILURE_MESSAGE = "Failed to initialize the database connection.";

// The public startup error must never expose the underlying Prisma/Postgres
// error (see docs/12-agent-run-api.md) — only this fixed, application-authored
// message is ever surfaced. The raw cause is retained solely on Error.cause
// for internal debugging, never printed by main.ts's guarded bootstrap.
export class PrismaInitializationError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(INITIALIZATION_FAILURE_MESSAGE, options);
    this.name = "PrismaInitializationError";
  }
}

@Injectable()
export class PrismaLifecycleService implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(PRISMA_CLIENT_HANDLE) private readonly handle: PrismaClientHandle,
    @Inject(PRISMA_SAFE_CLOSE) private readonly safeClose: () => Promise<void>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.handle.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      await this.safeClose();
      throw new PrismaInitializationError({ cause: error });
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.safeClose();
  }
}
