// Generic (non-Prisma) TEST_DATABASE_URL -> DATABASE_URL remapper, used only
// by test:integration to run vitest itself against the test database.
// run-prisma-against-test-database.mjs covers the Prisma-CLI case by reusing
// run-prisma.mjs's launcher; this script exists because vitest is not a
// Prisma command, so that reuse path does not apply here.
import { spawnSync } from "node:child_process";

const SETUP_MESSAGE =
  "TEST_DATABASE_URL is not set.\n" +
  "Copy .env.example to .env at the repo root, then run: pnpm infra:up && pnpm db:test:ensure";

if (!process.env.TEST_DATABASE_URL) {
  console.error(SETUP_MESSAGE);
  process.exit(1);
}

const [command, ...args] = process.argv.slice(2);
const result = spawnSync(command, args, {
  stdio: "inherit",
  env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
});
process.exit(result.status ?? 1);
