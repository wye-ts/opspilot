import { spawnSync } from "node:child_process";

// "generate" and "validate" never need a live database connection and must
// succeed with DATABASE_URL absent (see docs/11-agent-run-persistence.md).
const COMMANDS_REQUIRING_DATABASE = new Set(["migrate", "db", "studio"]);

const SETUP_MESSAGE =
  "DATABASE_URL is not set.\n" +
  "Copy .env.example to .env at the repo root, then run: pnpm infra:up && pnpm db:test:ensure";

export function runPrisma(args, env = process.env) {
  const [primaryCommand] = args;

  if (COMMANDS_REQUIRING_DATABASE.has(primaryCommand) && !env.DATABASE_URL) {
    console.error(SETUP_MESSAGE);
    return 1;
  }

  let result;
  try {
    // Invoked through `pnpm exec prisma`, not a hardcoded node_modules/.bin
    // path, so pnpm's own resolution finds the correct locally-installed
    // binary. `env` is forwarded as-is and never logged or echoed here.
    result = spawnSync("pnpm", ["exec", "prisma", ...args], {
      stdio: "inherit",
      env,
    });
  } catch {
    console.error("Failed to launch the Prisma CLI via `pnpm exec prisma`.");
    return 1;
  }

  if (result.error) {
    console.error("Failed to launch the Prisma CLI via `pnpm exec prisma`.");
    return 1;
  }

  // Preserves the child's exact exit code, including Prisma's own 0/1/2
  // codes for `migrate diff --exit-code`.
  return result.status ?? 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runPrisma(process.argv.slice(2)));
}
