#!/usr/bin/env node
// Generic root-.env-loading process wrapper: loads the repo root's .env (if
// present) into process.env, then spawns the requested command with that
// environment, inherited stdio, and the child's own exit code/signal
// preserved. Used by apps/api's start/start:dev/demo scripts so they never
// need a hardcoded --env-file flag of their own. Never inspects or prints
// .env contents, and never prints a raw spawn/env-loading error or stack —
// only the fixed messages below.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ENV_LOAD_FAILURE_MESSAGE = "Failed to load the root .env file.";
const SPAWN_FAILURE_MESSAGE = "Failed to launch the requested command.";
const USAGE_MESSAGE = "Usage: run-with-root-env.mjs <command> [args...]";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, "..");
const envPath = join(repoRoot, ".env");

if (existsSync(envPath)) {
  try {
    // Preserves already-defined environment variables — a variable already
    // set in process.env is never overwritten by the file.
    process.loadEnvFile(envPath);
  } catch {
    console.error(ENV_LOAD_FAILURE_MESSAGE);
    process.exit(1);
  }
}

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error(USAGE_MESSAGE);
  process.exit(1);
}

let child;
try {
  child = spawn(command, args, { stdio: "inherit", env: process.env });
} catch {
  console.error(SPAWN_FAILURE_MESSAGE);
  process.exit(1);
}

child.on("error", () => {
  console.error(SPAWN_FAILURE_MESSAGE);
  process.exitCode = 1;
});

// Named handlers (not inline arrows) so they can be removed by reference
// below, exactly once, before the parent re-raises the same signal on
// itself.
function handleSigint() {
  child.kill("SIGINT");
}
function handleSigterm() {
  child.kill("SIGTERM");
}

process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);

child.on("exit", (code, signal) => {
  // Both listeners must be removed BEFORE re-raising a signal on the
  // parent below — otherwise process.kill(process.pid, signal) would just
  // re-invoke our own forwarding handler (if it hasn't already fired and
  // self-removed via `once`) instead of falling through to Node's default
  // signal disposition, which is what actually terminates this process
  // with the matching exit signal. Removing unconditionally here is safe
  // even when the relevant handler already auto-removed itself after
  // firing (removing an absent listener is a no-op), and also covers the
  // child exiting for a reason unrelated to a forwarded signal, in which
  // case a still-pending listener would otherwise leak.
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);

  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
