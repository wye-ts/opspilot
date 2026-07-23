import { createPrismaClient, type PrismaClientHandle } from "../client";

const UNAVAILABLE_MESSAGE =
  "PostgreSQL test database is unreachable. Run:\n" +
  "  pnpm infra:up && pnpm db:test:ensure && pnpm db:migrate:test\n" +
  "then re-run the integration tests.";

// Fails loudly with one concise setup message rather than a cryptic driver
// stack trace, and never silently skips (see docs/11-agent-run-persistence.md).
export async function createTestPrismaClient(): Promise<PrismaClientHandle> {
  const handle = createPrismaClient();
  try {
    await handle.prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw new Error(UNAVAILABLE_MESSAGE, { cause: error });
  }
  return handle;
}

export async function truncateAllTables(handle: PrismaClientHandle): Promise<void> {
  await handle.prisma.$executeRaw`TRUNCATE TABLE agent_jobs, agent_runs, agent_trace_events RESTART IDENTITY CASCADE`;
}
