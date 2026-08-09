// Console formatting: PASS/FAIL lines and the resolved-config echo every
// command prints before doing any work.

import type { ResolvedConfig, ResolvedValue } from "./types";

function formatResolvedValue<T>(label: string, resolved: ResolvedValue<T>): string {
  return `  ${label}: ${JSON.stringify(resolved.value)} (source: ${resolved.source})`;
}

// Always written to stderr: this is a diagnostic banner, printed before any
// work happens, never part of the machine-readable artifact — stdout stays
// reserved for the JSON blob under --print-json.
export function printResolvedConfig(config: ResolvedConfig): void {
  console.error("Resolved configuration:");
  console.error(formatResolvedValue("taskPath", config.taskPath));
  console.error(formatResolvedValue("agentDir", config.agentDir));
  console.error(`  baselineSha: ${config.baselineSha} (source: ${config.baselineSource})`);
  if (config.scope) console.error(formatResolvedValue("scope", config.scope));
  if (config.branch) console.error(formatResolvedValue("branch", config.branch));
  if (config.workingTree) console.error(formatResolvedValue("workingTree", config.workingTree));
  if (config.index) console.error(formatResolvedValue("index", config.index));
  if (config.mode) console.error(formatResolvedValue("mode", config.mode));
}

export function printStatusLine(label: string, status: string): void {
  console.log(`${label}: ${status}`);
}

export function printFailureReasons(reasons: readonly string[]): void {
  for (const reason of reasons) {
    console.error(`  - ${reason}`);
  }
}
