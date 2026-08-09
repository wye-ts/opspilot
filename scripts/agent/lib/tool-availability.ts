// git/pnpm/docker presence + version, reported (never enforced beyond git,
// which every command depends on) by preflight.

import { spawnSync } from "node:child_process";

import type { ToolAvailabilityEntry } from "./types";

function checkTool(tool: string, versionArgs: string[]): ToolAvailabilityEntry {
  const result = spawnSync(tool, versionArgs, { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { tool, available: false, version: null };
  }
  const firstLine = (result.stdout || result.stderr || "").trim().split("\n")[0] ?? "";
  return { tool, available: true, version: firstLine.length > 0 ? firstLine : null };
}

export function checkToolAvailability(): ToolAvailabilityEntry[] {
  return [checkTool("git", ["--version"]), checkTool("pnpm", ["--version"]), checkTool("docker", ["--version"])];
}
