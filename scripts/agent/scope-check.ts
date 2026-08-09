#!/usr/bin/env node
// agent:scope-check — opt-in, judgment-free check that the complete change
// set touches only caller-declared scope patterns. Scope is never inferred
// or decided by the harness; with none declared anywhere, this reports
// NOT_CONFIGURED (exit 0) rather than guessing one. Discovery is always
// unfiltered, so an out-of-scope file is guaranteed to appear in
// changeSetPaths before being flagged in outOfScopePaths.

import { join } from "node:path";

import { writeJsonAtomic } from "./lib/atomic-write";
import { CliArgsError, getStringFlag, parseArgsList, parseCommonArgs } from "./lib/cli-args";
import { computeChangeSetFingerprint } from "./lib/fingerprint";
import { getCompleteChangeSet, getHeadSha } from "./lib/git";
import { printFailureReasons, printResolvedConfig, printStatusLine } from "./lib/report";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./lib/resolved-config";
import { matchesAnyPattern } from "./lib/scope-patterns";
import { loadTaskDeclaration, TaskDeclarationError } from "./lib/task-declaration";
import type { ResolvedConfig, ScopeCheckResult, ScopeCheckStatus, TaskDeclaration } from "./lib/types";

function main(): void {
  const cwd = process.cwd();
  const raw = parseArgsList(process.argv.slice(2));
  const common = parseCommonArgs(raw);

  const cliScopeRaw = getStringFlag(raw, "scope");
  const cliScope = cliScopeRaw !== undefined ? cliScopeRaw.split(",").filter((s) => s.length > 0) : undefined;

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
  // Absent and explicit `scope: null` in the task declaration are both
  // NOT_CONFIGURED — normalize null to undefined so resolveField's "was this
  // tier provided" check treats them identically. `scope: []` stays distinct
  // (configured, matches nothing) since it is not null/undefined.
  const taskScope = taskDeclaration?.scope === null ? undefined : taskDeclaration?.scope;
  const scopeResolved = resolveField<string[] | null>(null, taskScope, cliScope);

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
    scope: scopeResolved,
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

  const isConfigured = scopeResolved.source !== "default";
  const scopePatterns = scopeResolved.value ?? [];
  const outOfScopePaths = isConfigured
    ? changeSetPaths.filter((path) => !matchesAnyPattern(path, scopePatterns))
    : [];

  let status: ScopeCheckStatus;
  if (failureReasons.length > 0) {
    status = "FAIL";
  } else if (!isConfigured) {
    status = "NOT_CONFIGURED";
  } else if (outOfScopePaths.length === 0) {
    status = "PASS";
  } else {
    status = "FAIL";
    failureReasons.push(`${outOfScopePaths.length} path(s) outside declared scope: ${outOfScopePaths.join(", ")}`);
  }

  const result: ScopeCheckResult = {
    status,
    scopePatterns,
    changeSetPaths,
    outOfScopePaths,
    failureReasons,
    provenance: { baselineSha, headSha, changeSetFingerprint, resolvedConfig },
  };

  writeJsonAtomic(join(agentDir.value, "scope-check.json"), result);

  if (failureReasons.length > 0) {
    console.error("Failure reasons:");
    printFailureReasons(failureReasons);
  }

  if (common.printJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStatusLine("scope-check", status);
  }

  process.exit(status === "FAIL" ? 1 : 0);
}

try {
  main();
} catch (err) {
  if (err instanceof CliArgsError) {
    console.error(`agent:scope-check: ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
