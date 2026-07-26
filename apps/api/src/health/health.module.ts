import { Module } from "@nestjs/common";

import { HealthController } from "./health.controller";

// Self-contained: PrismaModule is @Global() (see persistence/prisma.module.ts),
// so PRISMA_CLIENT_HANDLE is reachable without an imports array. Must be
// registered before NotFoundModule in app.module.ts — the catch-all route
// is order-sensitive.
@Module({
  controllers: [HealthController],
})
export class HealthModule {}
