import path from "node:path";

import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: path.join(import.meta.dirname, "prisma", "schema.prisma"),
  migrations: {
    path: path.join(import.meta.dirname, "prisma", "migrations"),
  },
  datasource: {
    // Must never throw when DATABASE_URL is absent — `prisma generate` and
    // TypeScript compilation must succeed with no real .env and no running
    // PostgreSQL (see docs/11-agent-run-persistence.md). Commands that do
    // need a connection (migrate/db/studio) get an explicit, fixed-message
    // check in scripts/run-prisma.mjs instead of an opaque Prisma error.
    url: process.env.DATABASE_URL ?? "",
    // Required by `prisma migrate diff --from-migrations ... --to-config-datasource`
    // (db:migrate:drift) — discovered only by running the real Prisma 7.9.0
    // CLI; not anticipated in the approved plan (deviation, documented in
    // docs/11-agent-run-persistence.md). Only `migrate diff` needs this; it
    // is never dereferenced by `generate`/`migrate dev`/`migrate deploy`.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ?? "",
  },
});
