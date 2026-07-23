import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { PersistenceError } from "./errors";
// NOTE: verified against the actual installed Prisma 7.9.0 `prisma-client`
// generator output during the Prisma scaffolding checkpoint (see
// docs/11-agent-run-persistence.md) — adjust this import path if the
// generator's real export surface differs.
import { PrismaClient } from "./generated/prisma-client/client";

export type { PrismaClient } from "./generated/prisma-client/client";

export interface PrismaClientHandle {
  readonly prisma: PrismaClient;
  close(): Promise<void>;
}

const SETUP_MESSAGE =
  "DATABASE_URL is not set. Copy .env.example to .env at the repo root and run `pnpm infra:up`.";

export function createPrismaClient(): PrismaClientHandle {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Deliberately validated here — at PrismaClient construction time — not
    // at `prisma generate` time, which must succeed without DATABASE_URL.
    throw new PersistenceError("PERSISTENCE_UNAVAILABLE", SETUP_MESSAGE);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  return {
    prisma,
    async close() {
      // The pg.Pool is ours to manage under the driver-adapter model —
      // Prisma does not own or close it implicitly. Callers (the persisted
      // demo, integration test teardown) must call close() or the process
      // will hang on open Postgres connections. pool.end() must run even if
      // prisma.$disconnect() throws, or a $disconnect failure would leak the
      // underlying connection pool.
      try {
        await prisma.$disconnect();
      } finally {
        await pool.end();
      }
    },
  };
}
