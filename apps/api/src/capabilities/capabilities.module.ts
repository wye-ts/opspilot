import { Module } from "@nestjs/common";

import { RunExecutionModule } from "../execution/run-execution.module";
import { CapabilitiesController } from "./capabilities.controller";

// Registered under /v1/capabilities (see app.module.ts). Depends only on
// RunExecutionModule — the admission controller it asks reaches the database
// through the injected isBudgetOpen callback, so this module needs no Prisma
// dependency of its own.
@Module({
  imports: [RunExecutionModule],
  controllers: [CapabilitiesController],
})
export class CapabilitiesModule {}
