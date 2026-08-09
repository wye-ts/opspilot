// git/pnpm/docker presence + version, reported (never enforced beyond git,
// which every command depends on) by preflight.

import { spawnSync } from "node:child_process";

import type { ToolAvailabilityEntry } from "./types";

/**
 * `timeoutMs` is optional and unbounded by default (preflight's own
 * git/pnpm/docker probes never pass one). A caller that cannot tolerate a
 * hung probe — codex-review's availability check ahead of a real invocation
 * — passes one explicitly. A timed-out child is killed and reported the same
 * as any other spawn failure: `available: false`.
 */
export function checkTool(tool: string, versionArgs: string[], timeoutMs?: number): ToolAvailabilityEntry {
  const result = spawnSync(tool, versionArgs, {
    encoding: "utf8",
    ...(timeoutMs !== undefined ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}),
  });
  if (result.error || result.status !== 0) {
    return { tool, available: false, version: null };
  }
  const firstLine = (result.stdout || result.stderr || "").trim().split("\n")[0] ?? "";
  return { tool, available: true, version: firstLine.length > 0 ? firstLine : null };
}

export function checkToolAvailability(): ToolAvailabilityEntry[] {
  return [checkTool("git", ["--version"]), checkTool("pnpm", ["--version"]), checkTool("docker", ["--version"])];
}
