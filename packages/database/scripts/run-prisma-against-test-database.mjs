import { runPrisma } from "./run-prisma.mjs";

const SETUP_MESSAGE =
  "TEST_DATABASE_URL is not set.\n" +
  "Copy .env.example to .env at the repo root, then run: pnpm infra:up && pnpm db:test:ensure";

if (!process.env.TEST_DATABASE_URL) {
  console.error(SETUP_MESSAGE);
  process.exit(1);
}

// Reuses runPrisma's own launcher behavior (database-required-command check,
// spawn, exit-code preservation) instead of duplicating it — only the env
// remapping (TEST_DATABASE_URL -> DATABASE_URL) is new here.
process.exit(
  runPrisma(process.argv.slice(2), {
    ...process.env,
    DATABASE_URL: process.env.TEST_DATABASE_URL,
  }),
);
