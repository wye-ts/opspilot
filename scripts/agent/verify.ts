#!/usr/bin/env node
// agent:verify --focused|--final — the two distinct verification guarantees
// from CONTEXT.md. Focused mode maps the complete change set to touched
// workspaces (path-prefix heuristic, no dependency-graph awareness) and runs
// their typecheck/test. Final mode runs, unmodified, the exact CI `verify`
// job commands. Neither ever runs `pnpm install`, `pnpm db:generate`, starts
// Postgres, or builds/runs Docker.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeJsonAtomic } from "./lib/atomic-write";
import { CliArgsError, getBooleanFlag, parseArgsList, parseCommonArgs } from "./lib/cli-args";
import { computeChangeSetFingerprint } from "./lib/fingerprint";
import { getCompleteChangeSet, getHeadSha } from "./lib/git";
import { printFailureReasons, printResolvedConfig, printStatusLine } from "./lib/report";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./lib/resolved-config";
import { loadTaskDeclaration, TaskDeclarationError } from "./lib/task-declaration";
import type { ResolvedConfig, TaskDeclaration, VerifyMode, VerifyResult, VerifyStep } from "./lib/types";

/**
 * A workspace's package.json, read exactly once. An unreadable or unparseable
 * manifest is carried as an explicit error rather than collapsed into "no
 * scripts": a manifest the harness cannot read tells it nothing about whether
 * that workspace needs checking, and silently skipping it would report PASS for
 * a workspace nothing ever ran against.
 */
type WorkspaceManifest =
  | { ok: true; name: string | null; scripts: Record<string, unknown> }
  | { ok: false; error: string };

interface Workspace {
  name: string;
  dir: string;
  manifest: WorkspaceManifest;
}

function readWorkspaceManifest(pkgJsonPath: string): WorkspaceManifest {
  let raw: string;
  try {
    raw = readFileSync(pkgJsonPath, "utf8");
  } catch (err) {
    return { ok: false, error: `unreadable: ${err instanceof Error ? err.message : String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "not a JSON object" };
  }

  const pkg = parsed as { name?: unknown; scripts?: unknown };
  const scripts =
    typeof pkg.scripts === "object" && pkg.scripts !== null && !Array.isArray(pkg.scripts)
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  return { ok: true, name: typeof pkg.name === "string" ? pkg.name : null, scripts };
}

function discoverWorkspaces(cwd: string): Workspace[] {
  const roots = ["apps", "packages"];
  const workspaces: Workspace[] = [];
  for (const root of roots) {
    const rootPath = join(cwd, root);
    if (!existsSync(rootPath)) continue;
    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = `${root}/${entry.name}`;
      const pkgJsonPath = join(cwd, dir, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      const manifest = readWorkspaceManifest(pkgJsonPath);
      const name = manifest.ok && manifest.name !== null ? manifest.name : dir;
      workspaces.push({ name, dir, manifest });
    }
  }
  return workspaces.sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

function touchedWorkspacesFor(changeSetPaths: readonly string[], workspaces: readonly Workspace[]): Workspace[] {
  const touched = new Map<string, Workspace>();
  for (const path of changeSetPaths) {
    for (const ws of workspaces) {
      if (path === ws.dir || path.startsWith(`${ws.dir}/`)) {
        touched.set(ws.dir, ws);
        break;
      }
    }
  }
  return [...touched.values()].sort((a, b) => (a.dir < b.dir ? -1 : 1));
}

/** Only ever called for a workspace whose manifest read succeeded — a valid manifest that simply lacks the script is the one legitimate reason to skip it. */
function hasScript(manifest: Extract<WorkspaceManifest, { ok: true }>, scriptName: string): boolean {
  return typeof manifest.scripts[scriptName] === "string";
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function runStep(command: string, args: string[], cwd: string, agentDir: string, logName: string): VerifyStep {
  const start = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  const durationMs = Date.now() - start;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const logPath = join(agentDir, "logs", `verify-${sanitizeForFilename(logName)}.log`);
  writeFileAtomic(logPath, output);
  const exitCode = result.status ?? 1;
  const tailLines = output.split("\n").slice(-50);
  return {
    command: `${command} ${args.join(" ")}`,
    status: exitCode === 0 ? "PASS" : "FAIL",
    exitCode,
    durationMs,
    logPath,
    outputTail: tailLines.join("\n"),
  };
}

interface FocusedOutcome {
  steps: VerifyStep[];
  touchedWorkspaces: string[];
  failureReasons: string[];
}

function runFocused(cwd: string, agentDir: string, changeSetPaths: readonly string[]): FocusedOutcome {
  const workspaces = discoverWorkspaces(cwd);
  const touched = touchedWorkspacesFor(changeSetPaths, workspaces);
  const steps: VerifyStep[] = [];
  const failureReasons: string[] = [];

  for (const ws of touched) {
    if (!ws.manifest.ok) {
      // Fail closed: the change set directly touched this workspace, and the
      // harness cannot tell what (if anything) it should have run there.
      failureReasons.push(`cannot read ${ws.dir}/package.json (${ws.manifest.error})`);
      continue;
    }
    if (hasScript(ws.manifest, "typecheck")) {
      steps.push(runStep("pnpm", ["--filter", ws.name, "run", "typecheck"], cwd, agentDir, `focused-${ws.dir}-typecheck`));
    }
    if (hasScript(ws.manifest, "test")) {
      steps.push(runStep("pnpm", ["--filter", ws.name, "run", "test"], cwd, agentDir, `focused-${ws.dir}-test`));
    }
  }

  return { steps, touchedWorkspaces: touched.map((ws) => ws.name), failureReasons };
}

// Mirrors CI's `verify` job exactly (.github/workflows/ci.yml). If that job
// ever adds a step, this array needs a matching one-line update — the only
// coupling between the two, by design (§11). lib/provenance.ts's
// isFinalVerifyResult independently hardcodes the same four command strings
// (as `FINAL_STEP_COMMANDS`) to validate a stored result's `steps` against
// this exact contract; the two lists must be kept in sync by hand if this one
// ever changes, same as the CI coupling above.
const FINAL_MODE_STEPS: Array<{ command: string; args: string[]; logName: string }> = [
  { command: "pnpm", args: ["typecheck"], logName: "final-typecheck" },
  { command: "pnpm", args: ["test"], logName: "final-test" },
  { command: "pnpm", args: ["build"], logName: "final-build" },
  { command: "pnpm", args: ["--filter", "@opspilot/web", "run", "check:bundle"], logName: "final-check-bundle" },
];

function runFinal(cwd: string, agentDir: string): VerifyStep[] {
  const steps: VerifyStep[] = [];
  for (const spec of FINAL_MODE_STEPS) {
    const step = runStep(spec.command, spec.args, cwd, agentDir, spec.logName);
    steps.push(step);
    if (step.status === "FAIL") break; // fail-fast, matching CI's own step ordering
  }
  return steps;
}

function main(): void {
  const cwd = process.cwd();
  const raw = parseArgsList(process.argv.slice(2));
  const common = parseCommonArgs(raw);
  const focused = getBooleanFlag(raw, "focused");
  const final = getBooleanFlag(raw, "final");

  if (focused === final) {
    throw new CliArgsError("exactly one of --focused or --final is required");
  }
  const mode: VerifyMode = focused ? "focused" : "final";

  const failureReasons: string[] = [];

  let taskDeclaration: TaskDeclaration | null = null;
  if (common.task !== undefined) {
    try {
      taskDeclaration = loadTaskDeclaration(common.task);
    } catch (err) {
      if (err instanceof TaskDeclarationError) {
        failureReasons.push(`malformed task declaration: ${err.message}`);
      } else {
        throw err;
      }
    }
  }

  const agentDirDefault = join(cwd, ".agent");
  const agentDir = resolveField(agentDirDefault, undefined, common.agentDir);
  const taskPath = resolveField<string | null>(null, undefined, common.task);

  let baselineSha = "";
  let baselineSource: ResolvedConfig["baselineSource"] = "merge-base-main";
  try {
    const resolved = resolveBaseline(cwd, common.baseline, taskDeclaration?.baseline);
    baselineSha = resolved.sha;
    baselineSource = resolved.source;
  } catch (err) {
    if (err instanceof BaselineResolutionError) {
      failureReasons.push(err.message);
    } else {
      throw err;
    }
  }

  let headSha = "";
  try {
    headSha = getHeadSha(cwd);
  } catch {
    failureReasons.push("cannot resolve HEAD (no commits yet?)");
  }

  const resolvedConfig: ResolvedConfig = {
    taskPath,
    agentDir,
    baselineSha,
    baselineSource,
    mode: { value: mode, source: "cli" },
  };

  printResolvedConfig(resolvedConfig);

  let changeSetPaths: string[] = [];
  let changeSetFingerprint = "";
  if (baselineSha) {
    try {
      const changeSet = getCompleteChangeSet(cwd, baselineSha);
      changeSetPaths = changeSet.map((e) => e.path);
      changeSetFingerprint = computeChangeSetFingerprint(cwd, changeSet);
    } catch (err) {
      changeSetPaths = [];
      failureReasons.push(
        `cannot describe the complete change set: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  let steps: VerifyStep[] = [];
  let touchedWorkspaces: string[] = [];
  // Final mode's notRun is always exactly this pair, unconditionally — even
  // on an early failure (unresolved baseline, malformed task declaration)
  // that skips running any steps at all. This must never be structurally
  // omittable, per CONTEXT.md's "always explicitly reports" requirement.
  const notRun: string[] = mode === "final" ? ["integration", "docker-smoke"] : [];

  if (failureReasons.length === 0) {
    if (mode === "focused") {
      const focusedResult = runFocused(cwd, agentDir.value, changeSetPaths);
      steps = focusedResult.steps;
      touchedWorkspaces = focusedResult.touchedWorkspaces;
      failureReasons.push(...focusedResult.failureReasons);
    } else {
      steps = runFinal(cwd, agentDir.value);
    }
  }

  for (const step of steps) {
    if (step.status === "FAIL") {
      failureReasons.push(`step failed: ${step.command} (exit ${step.exitCode})`);
    }
  }

  const status: "PASS" | "FAIL" = failureReasons.length === 0 ? "PASS" : "FAIL";

  const result: VerifyResult = {
    mode,
    status,
    touchedWorkspaces,
    steps,
    notRun,
    failureReasons,
    provenance: { baselineSha, headSha, changeSetFingerprint, resolvedConfig },
  };

  writeJsonAtomic(join(agentDir.value, `verify-${mode}.json`), result);

  if (failureReasons.length > 0) {
    console.error("Failure reasons:");
    printFailureReasons(failureReasons);
  }

  if (common.printJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStatusLine(`verify --${mode}`, status);
  }

  process.exit(status === "PASS" ? 0 : 1);
}

try {
  main();
} catch (err) {
  if (err instanceof CliArgsError) {
    console.error(`agent:verify: ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
