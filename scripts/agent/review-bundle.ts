#!/usr/bin/env node
// agent:review-bundle — an evidence collector, not a correctness/review gate.
// Produces a diff over the complete change set plus a machine-readable
// manifest of mechanically verifiable facts only. Never invokes
// agent:verify/agent:scope-check itself, never generates findings/severity/
// fix rationale. Exit 0 (status: OK) covers every combination of nested
// freshness/PASS-FAIL, including a CURRENT verify result that itself says
// FAIL. Exit 1 (status: FAILED) only when the collector cannot trust its own
// evidence: reconstruction anything other than MATCH, unresolved baseline,
// malformed task declaration, or an unrecoverable git/fs error.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeJsonAtomic } from "./lib/atomic-write";
import { assertKnownFlags, CliArgsError, getBooleanFlag, getStringFlag, parseArgsList, parseCommonArgs } from "./lib/cli-args";
import { computeChangeSetFingerprint } from "./lib/fingerprint";
import { getCompleteChangeSet, getCurrentBranch, getHeadSha } from "./lib/git";
import {
  isFinalVerifyResult,
  isFocusedVerifyResult,
  isScopeCheckResult,
  loadGateResult,
  scopeSemanticsCurrent,
} from "./lib/provenance";
import { printFailureReasons, printResolvedConfig, printStatusLine } from "./lib/report";
import { buildReconstructionProof } from "./lib/reconstruction";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./lib/resolved-config";
import { parseTaskDeclaration, TaskDeclarationError } from "./lib/task-declaration";
import type { ChangeEntry, ReconstructionProof, ResolvedConfig, ReviewBundleResult, TaskDeclaration } from "./lib/types";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function renderMarkdown(result: ReviewBundleResult): string {
  const lines: string[] = [];
  lines.push("# Review bundle", "");
  lines.push(`- status: ${result.status}`);
  if (result.failureReason) lines.push(`- failureReason: ${result.failureReason}`);
  lines.push(`- baseline: ${result.git.baselineSha}`);
  lines.push(`- head: ${result.git.headSha}`);
  lines.push(`- branch: ${result.git.branch ?? "(detached HEAD)"}`);
  lines.push(`- diffHash: ${result.git.diffHash}`);
  lines.push("");
  lines.push("## Changed paths", "");
  if (result.git.changedPaths.length === 0) {
    lines.push("(none)");
  } else {
    for (const path of result.git.changedPaths) lines.push(`- ${path}`);
  }
  lines.push("");
  lines.push("## Reconstruction proof", "");
  lines.push(`- status: ${result.reconstructionProof.status}`);
  if (result.reconstructionProof.missingPaths.length > 0) {
    lines.push(`- missingPaths: ${result.reconstructionProof.missingPaths.join(", ")}`);
  }
  if (result.reconstructionProof.extraPaths.length > 0) {
    lines.push(`- extraPaths: ${result.reconstructionProof.extraPaths.join(", ")}`);
  }
  if (result.reconstructionProof.cleanupError) {
    lines.push(`- cleanupError: ${result.reconstructionProof.cleanupError}`);
  }
  lines.push("");
  lines.push("## Nested gate results", "");
  lines.push(
    `- verify --focused: freshness=${result.verify.focused.freshness} missingReason=${result.verify.focused.missingReason ?? "null"} status=${result.verify.focused.result?.status ?? "n/a"}`,
  );
  lines.push(
    `- verify --final: freshness=${result.verify.final.freshness} missingReason=${result.verify.final.missingReason ?? "null"} status=${result.verify.final.result?.status ?? "n/a"}`,
  );
  lines.push(
    `- scope-check: freshness=${result.scopeCheck.freshness} missingReason=${result.scopeCheck.missingReason ?? "null"} status=${result.scopeCheck.result?.status ?? "n/a"}`,
  );
  lines.push("");
  lines.push(`- taskDeclarationHash: ${result.taskDeclarationHash ?? "no task declaration"}`);
  lines.push("");
  return lines.join("\n");
}

export interface ComputeReviewBundleOptions {
  cwd: string;
  agentDirDefault: string;
  /** Raw --agent-dir value, if the caller actually supplied one (undefined otherwise). */
  cliAgentDir?: string;
  /** Raw --task value, if the caller actually supplied one (undefined otherwise). */
  cliTaskPath?: string;
  cliBaseline?: string;
  taskDeclaration: TaskDeclaration | null;
  taskDeclarationError: string | null;
  /**
   * SHA-256 of the exact raw bytes read from `cliTaskPath`, or null when no
   * explicit --task was given. Computed by the caller (main()) independently
   * of task-declaration parse success, since a malformed-but-readable task
   * declaration still has bytes worth binding the bundle to.
   */
  taskDeclarationHash: string | null;
  /**
   * Test-only seam, threaded straight through to
   * lib/reconstruction.ts's own diffText override — lets tests engineer an
   * APPLY_FAILED or PATH_SET_MISMATCH without mocking git plumbing.
   * Production callers (main() below) never pass this.
   */
  diffTextOverride?: string;
}

export interface ComputeReviewBundleOutput {
  result: ReviewBundleResult;
  diffText: string;
  resolvedConfig: ResolvedConfig;
}

/** The full evidence-collection computation, independent of CLI/process concerns — exported so tests can exercise it directly (including the diffTextOverride seam) without spawning a process. */
export function computeReviewBundle(options: ComputeReviewBundleOptions): ComputeReviewBundleOutput {
  const {
    cwd,
    agentDirDefault,
    cliAgentDir,
    cliTaskPath,
    cliBaseline,
    taskDeclaration,
    taskDeclarationError,
    taskDeclarationHash,
  } = options;

  let failureReason: string | null = taskDeclarationError;

  // Task declarations are only ever supplied via an explicit CLI flag (never
  // task-declaration-sourced or auto-discovered), so the "task-declaration"
  // precedence tier never applies to these two fields — only default vs cli.
  const taskPath = resolveField<string | null>(null, undefined, cliTaskPath);
  const agentDir = resolveField(agentDirDefault, undefined, cliAgentDir);

  let baselineSha = "";
  let baselineSource: ResolvedConfig["baselineSource"] = "merge-base-main";
  if (failureReason === null) {
    try {
      const resolved = resolveBaseline(cwd, cliBaseline, taskDeclaration?.baseline);
      baselineSha = resolved.sha;
      baselineSource = resolved.source;
    } catch (err) {
      if (err instanceof BaselineResolutionError) {
        failureReason = err.message;
      } else {
        throw err;
      }
    }
  }

  let headSha = "";
  if (failureReason === null) {
    try {
      headSha = getHeadSha(cwd);
    } catch {
      failureReason = "cannot resolve HEAD (no commits yet?)";
    }
  }

  const resolvedConfig: ResolvedConfig = { taskPath, agentDir, baselineSha, baselineSource };

  const branch = getCurrentBranch(cwd);

  let changeSet: ChangeEntry[] = [];
  let changeSetFingerprint = "";
  if (failureReason === null) {
    try {
      changeSet = getCompleteChangeSet(cwd, baselineSha);
      changeSetFingerprint = computeChangeSetFingerprint(cwd, changeSet);
    } catch (err) {
      changeSet = [];
      failureReason = `cannot describe the complete change set: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const changedPaths = changeSet.map((e) => e.path).sort();

  let reconstructionProof: ReconstructionProof = {
    status: "APPLY_FAILED",
    missingPaths: [],
    extraPaths: [],
    cleanupError: null,
  };
  let diffText = "";

  if (failureReason === null) {
    try {
      const outcome = buildReconstructionProof(
        cwd,
        baselineSha,
        changeSet,
        options.diffTextOverride !== undefined ? { diffText: options.diffTextOverride } : {},
      );
      reconstructionProof = outcome.proof;
      diffText = outcome.diffText;
    } catch (err) {
      failureReason = `unrecoverable error during reconstruction: ${String(err instanceof Error ? err.message : err)}`;
    }
  }

  if (failureReason === null && reconstructionProof.status !== "MATCH") {
    failureReason = `reconstruction proof: ${reconstructionProof.status}`;
  }

  const currentFacts = { baselineSha, headSha, changeSetFingerprint };

  // Each verify artifact is validated against its own mode, so a focused run's
  // result can never be read out of verify-final.json as the stronger guarantee.
  const verifyFocused = loadGateResult(join(agentDir.value, "verify-focused.json"), isFocusedVerifyResult, currentFacts);
  const verifyFinal = loadGateResult(join(agentDir.value, "verify-final.json"), isFinalVerifyResult, currentFacts);

  // Scope-check freshness additionally covers the scope the gate actually
  // checked. review-bundle has no --scope of its own and never invents one; it
  // re-derives only from the task declaration it was explicitly given (the same
  // normalization scope-check applies: an explicit `scope: null` is "none").
  const currentScopeSemantics = {
    taskDeclarationSupplied: taskDeclaration !== null,
    taskScope: taskDeclaration?.scope ?? null,
  };
  const scopeCheck = loadGateResult(
    join(agentDir.value, "scope-check.json"),
    isScopeCheckResult,
    currentFacts,
    (stored) => scopeSemanticsCurrent(stored, currentScopeSemantics),
  );

  const diffHash = sha256(diffText);

  const result: ReviewBundleResult = {
    status: failureReason === null ? "OK" : "FAILED",
    failureReason,
    git: { baselineSha, headSha, branch, changedPaths, diffHash, changeSetFingerprint },
    reconstructionProof,
    verify: { focused: verifyFocused, final: verifyFinal },
    scopeCheck,
    taskDeclarationHash,
  };

  return { result, diffText, resolvedConfig };
}

function main(): void {
  const cwd = process.cwd();
  const raw = parseArgsList(process.argv.slice(2));
  assertKnownFlags(raw, ["out", "render-md"]);
  const common = parseCommonArgs(raw);
  const renderMd = getBooleanFlag(raw, "render-md");
  const outFlag = getStringFlag(raw, "out");

  let taskDeclaration: TaskDeclaration | null = null;
  let taskDeclarationError: string | null = null;
  let taskDeclarationHash: string | null = null;
  if (common.task !== undefined) {
    // Single read: the exact bytes captured here drive both the hash and the
    // parse below, so taskDeclarationHash always describes exactly the bytes
    // that produced (or failed to produce) taskDeclaration.
    let taskDeclarationRaw: Buffer | null = null;
    try {
      taskDeclarationRaw = readFileSync(common.task);
    } catch (err) {
      taskDeclarationError = `task declaration not found or unreadable at ${common.task}: ${String(err)}`;
    }
    if (taskDeclarationRaw !== null) {
      taskDeclarationHash = sha256(taskDeclarationRaw);
      try {
        taskDeclaration = parseTaskDeclaration(taskDeclarationRaw, common.task);
      } catch (err) {
        if (err instanceof TaskDeclarationError) {
          taskDeclarationError = `malformed task declaration: ${err.message}`;
        } else {
          throw err;
        }
      }
    }
  }

  const agentDirDefault = join(cwd, ".agent");

  const { result, diffText, resolvedConfig } = computeReviewBundle({
    cwd,
    agentDirDefault,
    ...(common.agentDir !== undefined ? { cliAgentDir: common.agentDir } : {}),
    ...(common.task !== undefined ? { cliTaskPath: common.task } : {}),
    ...(common.baseline !== undefined ? { cliBaseline: common.baseline } : {}),
    taskDeclaration,
    taskDeclarationError,
    taskDeclarationHash,
  });

  printResolvedConfig(resolvedConfig);

  const outDir = resolveField(join(resolvedConfig.agentDir.value, "review"), undefined, outFlag);

  writeJsonAtomic(join(outDir.value, "review.json"), result);
  writeFileAtomic(join(outDir.value, "review.diff"), diffText);
  if (renderMd) {
    writeFileAtomic(join(outDir.value, "review.md"), renderMarkdown(result));
  }

  if (result.failureReason !== null) {
    console.error("Failure reason:");
    printFailureReasons([result.failureReason]);
  }

  if (common.printJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStatusLine("review-bundle", result.status);
  }

  process.exit(result.status === "OK" ? 0 : 1);
}

// Only run as a CLI when executed directly — never as a side effect of
// another module (e.g. a test) importing computeReviewBundle/renderMarkdown.
if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err instanceof CliArgsError) {
      console.error(`agent:review-bundle: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  }
}
