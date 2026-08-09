// Common flag parsing shared by every entrypoint, plus per-command arg
// shapes. `--task <path>` is the only way a task declaration is ever read —
// no command auto-discovers one by well-known filename.

export class CliArgsError extends Error {}

const BOOLEAN_FLAGS = new Set(["print-json", "render-md", "focused", "final"]);

/** Parses `--flag value` / `--boolean-flag` pairs. Repeated non-boolean flags accumulate as a comma-joined string (used by --scope). */
export function parseArgsList(argv: readonly string[]): Map<string, string | boolean> {
  const result = new Map<string, string | boolean>();
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === undefined || !token.startsWith("--")) {
      throw new CliArgsError(`unexpected argument "${String(token)}"`);
    }
    const key = token.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      result.set(key, true);
      i += 1;
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new CliArgsError(`flag --${key} requires a value`);
    }
    if (result.has(key)) {
      const existing = result.get(key);
      result.set(key, `${String(existing)},${next}`);
    } else {
      result.set(key, next);
    }
    i += 2;
  }
  return result;
}

export interface CommonArgs {
  task?: string;
  baseline?: string;
  agentDir?: string;
  printJson: boolean;
}

export function parseCommonArgs(raw: Map<string, string | boolean>): CommonArgs {
  const task = raw.get("task");
  const baseline = raw.get("baseline");
  const agentDir = raw.get("agent-dir");
  return {
    ...(typeof task === "string" ? { task } : {}),
    ...(typeof baseline === "string" ? { baseline } : {}),
    ...(typeof agentDir === "string" ? { agentDir } : {}),
    printJson: raw.get("print-json") === true,
  };
}

export function getStringFlag(raw: Map<string, string | boolean>, key: string): string | undefined {
  const value = raw.get(key);
  return typeof value === "string" ? value : undefined;
}

export function getBooleanFlag(raw: Map<string, string | boolean>, key: string): boolean {
  return raw.get(key) === true;
}

/** Accepted on every command's entrypoint — see parseCommonArgs. */
export const COMMON_FLAGS: readonly string[] = ["task", "baseline", "agent-dir", "print-json"];

/**
 * Rejects any flag not in COMMON_FLAGS ∪ commandFlags. Every entrypoint calls
 * this immediately after parseArgsList, before any evidence selection, tool
 * probing, or provider invocation — an unknown or misspelled flag (e.g.
 * --review-dri) must never be silently ignored and fall through to running
 * with an unintended default; it is a CliArgsError, exit 1, nothing else
 * attempted.
 */
export function assertKnownFlags(raw: Map<string, string | boolean>, commandFlags: readonly string[]): void {
  const allowed = new Set<string>([...COMMON_FLAGS, ...commandFlags]);
  for (const key of raw.keys()) {
    if (!allowed.has(key)) {
      throw new CliArgsError(`unknown flag --${key}`);
    }
  }
}
