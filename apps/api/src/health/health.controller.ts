import { Controller, Get, Inject } from "@nestjs/common";
import type { PrismaClientHandle } from "@opspilot/database";

import { ApiError } from "../errors/api-error";
import { PRISMA_CLIENT_HANDLE } from "../persistence/prisma.tokens";

// Registered under /v1/health (see health.module.ts and app.module.ts) —
// keeps the single-origin contract to exactly one API prefix, matching
// docs/03-technical-design.md's original /v1/health/ready shape.
@Controller("health")
export class HealthController {
  constructor(@Inject(PRISMA_CLIENT_HANDLE) private readonly handle: PrismaClientHandle) {}

  // Process-only — never queries the database. A Render/Docker liveness
  // probe must be able to tell "the process is up" apart from "the
  // database is reachable" (see docs/08-cicd-deployment.md).
  @Get("live")
  live(): { data: { status: "ok" } } {
    return { data: { status: "ok" } };
  }

  // A lightweight query proves the connection this process already holds
  // is still usable. Failure reuses PERSISTENCE_UNAVAILABLE — the same
  // fixed 503 code/message the rest of the API already returns for a lost
  // database connection (see errors/api-error-catalog.ts) — so this never
  // leaks a connection string or a raw Postgres error.
  @Get("ready")
  async ready(): Promise<{ data: { status: "ready" } }> {
    try {
      await this.handle.prisma.$queryRaw`SELECT 1`;
      return { data: { status: "ready" } };
    } catch (error) {
      throw new ApiError("PERSISTENCE_UNAVAILABLE", { cause: error });
    }
  }
}
