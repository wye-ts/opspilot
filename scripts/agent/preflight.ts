#!/usr/bin/env node
// agent:preflight — read-only diagnostic step. Reports git/environment state
// without mutating anything (no infra, no migrations, no stashing, no branch
// changes, no installs, no test/build runs). Fails only when a
// caller-declared expectation is violated, or preflight cannot establish
// trustworthy ground truth for itself (unresolved baseline, malformed task
// declaration). Any other observed state — dirty tree, staged files, missing
// optional tooling — is reported, never treated as failure alone.

import { join } from "node:path";

import { writeJsonAtomic } from "./lib/atomic-write";
import { assertKnownFlags, CliArgsError, getStringFlag, parseArgsList, parseCommonArgs } from "./lib/cli-args";
import { computeChangeSetFingerprint } from "./lib/fingerprint";
import { getCompleteChangeSet, getCurrentBranch, getHeadSha, getStagedPaths, getWorkingTreeStatus } from "./lib/git";
import { printFailureReasons, printResolvedConfig, printStatusLine } from "./lib/report";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./lib/resolved-config";
import { loadTaskDeclaration, TaskDeclarationError } from "./lib/task-declaration";
import { checkToolAvailability } from "./lib/tool-availability";
import type { ExpectationCheck, PreflightResult, ResolvedConfig, TaskDeclaration } from "./lib/types";

const DOC_POINTERS = ["CONTEXT.md", "AGENTS.md", "scripts/agent/README.md", "docs/08-cicd-deployment.md"];

function main(): void {
  const cwd = process.cwd();
  const raw = parseArgsList(process.argv.slice(2));
  assertKnownFlags(raw, ["branch", "working-tree", "index"]);
  const common = parseCommonArgs(raw);

  const branchFlag = getStringFlag(raw, "branch");
  const workingTreeFlagRaw = getStringFlag(raw, "working-tree");
  const indexFlagRaw = getStringFlag(raw, "index");

  if (workingTreeFlagRaw !== undefined && workingTreeFlagRaw !== "clean" && workingTreeFlagRaw !== "any") {
    throw new CliArgsError('--working-tree must be "clean" or "any"');
  }
  if (indexFlagRaw !== undefined && indexFlagRaw !== "empty" && indexFlagRaw !== "any") {
    throw new CliArgsError('--index must be "empty" or "any"');
  }
  const workingTreeFlag = workingTreeFlagRaw as "clean" | "any" | undefined;
  const indexFlag = indexFlagRaw as "empty" | "any" | undefined;

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

  const branch = getCurrentBranch(cwd);
  const staged = getStagedPaths(cwd);
  const workingTree = getWorkingTreeStatus(cwd);
  const toolingAvailability = checkToolAvailability();

  const branchResolved = resolveField<string | null>(null, taskDeclaration?.expectedBranch, branchFlag);
  const workingTreeResolved = resolveField<"clean" | "any">("any", taskDeclaration?.expectedWorkingTree, workingTreeFlag);
  const indexResolved = resolveField<"empty" | "any">("any", taskDeclaration?.expectedIndex, indexFlag);

  const expectations: ExpectationCheck[] = [];

  if (branchResolved.source !== "default") {
    const satisfied = branch === branchResolved.value;
    expectations.push({ name: "branch", declared: branchResolved.value, observed: branch, satisfied });
    if (!satisfied) {
      failureReasons.push(`expected branch "${String(branchResolved.value)}", observed "${branch ?? "(detached HEAD)"}"`);
    }
  }

  if (workingTreeResolved.source !== "default") {
    const isClean =
      workingTree.trackedModified.length === 0 && workingTree.trackedDeleted.length === 0 && workingTree.untracked.length === 0;
    const observed = isClean ? "clean" : "dirty";
    const satisfied = workingTreeResolved.value === "any" || (workingTreeResolved.value === "clean" && isClean);
    expectations.push({ name: "workingTree", declared: workingTreeResolved.value, observed, satisfied });
    if (!satisfied) {
      failureReasons.push(`expected working tree "${workingTreeResolved.value}", observed "${observed}"`);
    }
  }

  if (indexResolved.source !== "default") {
    const isEmpty = staged.length === 0;
    const observed = isEmpty ? "empty" : "non-empty";
    const satisfied = indexResolved.value === "any" || (indexResolved.value === "empty" && isEmpty);
    expectations.push({ name: "index", declared: indexResolved.value, observed, satisfied });
    if (!satisfied) {
      failureReasons.push(`expected index "${indexResolved.value}", observed "${observed}"`);
    }
  }

  const resolvedConfig: ResolvedConfig = {
    taskPath,
    agentDir,
    baselineSha,
    baselineSource,
    branch: branchResolved,
    workingTree: workingTreeResolved,
    index: indexResolved,
  };

  printResolvedConfig(resolvedConfig);

  let changeSetFingerprint = "";
  if (baselineSha) {
    try {
      const changeSet = getCompleteChangeSet(cwd, baselineSha);
      changeSetFingerprint = computeChangeSetFingerprint(cwd, changeSet);
    } catch (err) {
      // Preflight cannot establish trustworthy ground truth for itself here,
      // which CONTEXT.md makes one of its two legitimate failure cases.
      failureReasons.push(
        `cannot describe the complete change set: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const status: "PASS" | "FAIL" = failureReasons.length === 0 ? "PASS" : "FAIL";

  const result: PreflightResult = {
    status,
    branch,
    staged,
    workingTree,
    expectations,
    docPointers: DOC_POINTERS,
    toolingAvailability,
    failureReasons,
    provenance: { baselineSha, headSha, changeSetFingerprint, resolvedConfig },
  };

  writeJsonAtomic(join(agentDir.value, "preflight.json"), result);

  if (failureReasons.length > 0) {
    console.error("Failure reasons:");
    printFailureReasons(failureReasons);
  }

  if (common.printJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStatusLine("preflight", status);
  }

  process.exit(status === "PASS" ? 0 : 1);
}

try {
  main();
} catch (err) {
  if (err instanceof CliArgsError) {
    console.error(`agent:preflight: ${err.message}`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
}
