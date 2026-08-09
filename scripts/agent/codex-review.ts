#!/usr/bin/env node
// agent:codex-review — an evidence collector, not a verdict gate, exactly
// like agent:review-bundle. It invokes Codex (read-only, plain `codex exec`,
// never `codex exec review`) against exactly the evidence agent:review-bundle
// already produced, validates Codex's output strictly, and writes the result
// as a Harness-owned artifact. Exit 0 (status: OK) covers a validated
// NEEDS_FIXES verdict just as much as READY_FOR_OWNER_REVIEW; exit 1 means
// only "this tool's own output cannot be trusted" (blocked input, Codex
// unavailable/crashed, invalid output, or a TOCTOU mismatch). It never
// adjudicates findings, never routes fixes, and never commits/pushes/
// merges/deploys.
//
// One narrow exception to "the result artifact is always written": on
// OUTPUT_DESTINATION_UNSAFE, no persistent artifact is written at all. That
// failure category means a write target was classified unsafe — including
// possibly aliasing an evidence input this run already read — so writing
// there regardless would be the exact hazard the classification exists to
// prevent. The failure is still reported, just via stdout/stderr/--print-json
// rather than through a file at the unsafe (or evidence-aliasing) path.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic, writeJsonAtomic } from "./lib/atomic-write";
import { runCodexReview, type CodexInvocationOutcome } from "./lib/codex-invocation";
import { isCodexReviewPayload, verdictConsistentWithFindings } from "./lib/codex-review-payload";
import { assertKnownFlags, CliArgsError, getStringFlag, parseArgsList, parseCommonArgs } from "./lib/cli-args";
import { computeChangeSetFingerprint } from "./lib/fingerprint";
import { getCompleteChangeSet, getHeadSha } from "./lib/git";
import { checkOutputDestination, type EvidenceInput } from "./lib/output-destination";
import { buildProvenance, codexArtifactFreshness, isReviewBundleResult } from "./lib/provenance";
import { generateReviewDiff } from "./lib/reconstruction";
import { printFailureReasons, printResolvedConfig, printStatusLine } from "./lib/report";
import { BaselineResolutionError, resolveBaseline, resolveField } from "./lib/resolved-config";
import { parseTaskDeclaration, TaskDeclarationError } from "./lib/task-declaration";
import { checkTool } from "./lib/tool-availability";
import type {
  ChangeEntry,
  CodexReviewFailureCategory,
  CodexReviewPayload,
  CodexReviewResult,
  CodexSeverity,
  Freshness,
  MissingReason,
  ProvenanceBlock,
  ResolvedConfig,
  ReviewBundleResult,
  TaskDeclaration,
} from "./lib/types";

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Same regeneration semantics agent:review-bundle uses for review.diff — never a second diff format. Used only for freshness comparison here, never persisted. */
function currentChangeSetDiffHash(cwd: string, baselineSha: string, changeSet: readonly ChangeEntry[]): string {
  return sha256(generateReviewDiff(cwd, baselineSha, changeSet));
}

function tryReadFile(path: string): { ok: true; raw: Buffer } | { ok: false; reason: string } {
  try {
    return { ok: true, raw: readFileSync(path) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

const SEVERITY_ORDER: Record<CodexSeverity, number> = { BLOCKER: 0, MAJOR: 1, MINOR: 2 };

export function renderMarkdown(result: CodexReviewResult): string {
  const lines: string[] = [];
  lines.push("# Codex review", "");
  lines.push(`- status: ${result.status}`);

  if (result.status === "FAILED") {
    lines.push(`- failureCategory: ${result.failureCategory ?? "null"}`);
    lines.push(`- failureReason: ${result.failureReason ?? "null"}`);
  } else if (result.payload !== null) {
    lines.push(`- verdict: ${result.payload.verdict}`);
    lines.push("");
    lines.push("## Findings", "");
    if (result.payload.findings.length === 0) {
      lines.push("(none)");
    } else {
      const sorted = [...result.payload.findings].sort(
        (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
      );
      for (const finding of sorted) {
        lines.push(`### [${finding.severity}] ${finding.title}`, "");
        lines.push(`- location: ${finding.location}`);
        lines.push(`- reproduction: ${finding.reproduction}`);
        lines.push(`- whyItMatters: ${finding.whyItMatters}`);
        lines.push(`- smallestFix: ${finding.smallestFix}`);
        lines.push(`- missingTest: ${finding.missingTest}`);
        lines.push("");
      }
    }
  }

  lines.push("");
  lines.push("## Provenance", "");
  if (result.provenance === null) {
    lines.push("provenance unavailable");
  } else {
    lines.push(`- baseline: ${result.provenance.baselineSha}`);
    lines.push(`- head: ${result.provenance.headSha}`);
    lines.push(`- changeSetFingerprint: ${result.provenance.changeSetFingerprint}`);
  }
  lines.push(`- reviewJsonHash: ${result.reviewJsonHash ?? "null"}`);
  lines.push(`- reviewDiffHash: ${result.reviewDiffHash ?? "null"}`);
  lines.push(`- taskDeclarationHash: ${result.taskDeclarationHash ?? "no task declaration"}`);
  lines.push("");
  return lines.join("\n");
}

function main(): void {
  const cwd = process.cwd();
  const raw = parseArgsList(process.argv.slice(2));
  assertKnownFlags(raw, ["review-dir", "out", "timeout-ms"]);
  const common = parseCommonArgs(raw);
  const reviewDirFlag = getStringFlag(raw, "review-dir");
  const outFlag = getStringFlag(raw, "out");
  const timeoutMsFlag = getStringFlag(raw, "timeout-ms");

  let timeoutMs = 600000;
  if (timeoutMsFlag !== undefined) {
    const parsedTimeout = Number(timeoutMsFlag);
    if (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0) {
      throw new CliArgsError(`--timeout-ms must be a positive integer, got "${timeoutMsFlag}"`);
    }
    timeoutMs = parsedTimeout;
  }

  let failureCategory: CodexReviewFailureCategory = null;
  let failureReason: string | null = null;

  // --- Step 1: task declaration (if --task) ---------------------------------
  let taskDeclaration: TaskDeclaration | null = null;
  let taskDeclarationHash: string | null = null;
  let taskDeclarationRaw: Buffer | null = null;
  if (common.task !== undefined) {
    const read = tryReadFile(common.task);
    if (!read.ok) {
      failureCategory = "GROUND_TRUTH_UNRESOLVED";
      failureReason = `task declaration not found or unreadable at ${common.task}: ${read.reason}`;
    } else {
      taskDeclarationHash = sha256(read.raw);
      taskDeclarationRaw = read.raw;
      // Parse the exact bytes just captured (and hashed) above — never a
      // fresh read of common.task — so taskDeclarationHash is guaranteed to
      // describe exactly the bytes that drove parsing/validation.
      try {
        taskDeclaration = parseTaskDeclaration(taskDeclarationRaw, common.task);
      } catch (err) {
        if (err instanceof TaskDeclarationError) {
          failureCategory = "GROUND_TRUTH_UNRESOLVED";
          failureReason = `malformed task declaration: ${err.message}`;
        } else {
          throw err;
        }
      }
    }
  }

  const agentDirDefault = join(cwd, ".agent");
  const agentDir = resolveField(agentDirDefault, undefined, common.agentDir);
  const taskPath = resolveField<string | null>(null, undefined, common.task);

  // --- Step 2: resolve baseline, HEAD, complete change set + fingerprint ---
  let baselineSha = "";
  let baselineSource: ResolvedConfig["baselineSource"] = "merge-base-main";
  if (failureCategory === null) {
    try {
      const resolved = resolveBaseline(cwd, common.baseline, taskDeclaration?.baseline);
      baselineSha = resolved.sha;
      baselineSource = resolved.source;
    } catch (err) {
      if (err instanceof BaselineResolutionError) {
        failureCategory = "GROUND_TRUTH_UNRESOLVED";
        failureReason = err.message;
      } else {
        throw err;
      }
    }
  }

  let headSha = "";
  if (failureCategory === null) {
    try {
      headSha = getHeadSha(cwd);
    } catch {
      failureCategory = "GROUND_TRUTH_UNRESOLVED";
      failureReason = "cannot resolve HEAD (no commits yet?)";
    }
  }

  let changeSet: ChangeEntry[] = [];
  let changeSetFingerprint = "";
  if (failureCategory === null) {
    try {
      changeSet = getCompleteChangeSet(cwd, baselineSha);
      changeSetFingerprint = computeChangeSetFingerprint(cwd, changeSet);
    } catch (err) {
      failureCategory = "GROUND_TRUTH_UNRESOLVED";
      failureReason = `cannot describe the complete change set: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  const resolvedConfig: ResolvedConfig = { taskPath, agentDir, baselineSha, baselineSource };
  printResolvedConfig(resolvedConfig);

  // provenance is assigned exactly once, only once baseline/HEAD/fingerprint
  // have all resolved, and never cleared afterward.
  let provenance: ProvenanceBlock | null = null;
  if (failureCategory === null) {
    provenance = buildProvenance(baselineSha, headSha, changeSetFingerprint, resolvedConfig);
  }

  const reviewDir = resolveField(join(agentDir.value, "review"), undefined, reviewDirFlag);
  const outDir = resolveField(join(agentDir.value, "codex"), undefined, outFlag);
  const reviewJsonPath = join(reviewDir.value, "review.json");
  const reviewDiffPath = join(reviewDir.value, "review.diff");

  // --- Step 3: load + validate review.json / review.diff -------------------
  let reviewInputFreshness: Freshness = "MISSING";
  let reviewInputMissingReason: MissingReason = "NOT_FOUND";
  let reviewBundleResult: ReviewBundleResult | null = null;
  let reviewJsonHash: string | null = null;
  let reviewDiffHash: string | null = null;
  let reviewJsonRaw: Buffer | null = null;
  let reviewDiffRaw: Buffer | null = null;

  if (failureCategory === null) {
    if (!existsSync(reviewJsonPath)) {
      failureCategory = "INPUT_MISSING";
      failureReason = `review.json not found at ${reviewJsonPath} — run agent:review-bundle first`;
    } else {
      const read = tryReadFile(reviewJsonPath);
      if (!read.ok) {
        failureCategory = "INPUT_INVALID";
        reviewInputMissingReason = "INVALID_ARTIFACT";
        failureReason = `review.json unreadable: ${read.reason}`;
      } else {
        reviewJsonHash = sha256(read.raw);
        reviewJsonRaw = read.raw;
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(read.raw.toString("utf8"));
        } catch (err) {
          failureCategory = "INPUT_INVALID";
          reviewInputMissingReason = "INVALID_ARTIFACT";
          failureReason = `review.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (failureCategory === null) {
          if (!isReviewBundleResult(parsed)) {
            failureCategory = "INPUT_INVALID";
            reviewInputMissingReason = "INVALID_ARTIFACT";
            failureReason = "review.json failed schema validation";
          } else if (parsed.status !== "OK") {
            failureCategory = "INPUT_INVALID";
            reviewInputMissingReason = "INVALID_ARTIFACT";
            failureReason = `review.json status is ${parsed.status}, not OK — review-bundle evidence is not trustworthy`;
          } else {
            reviewBundleResult = parsed;
          }
        }
      }
    }
  }

  if (failureCategory === null) {
    if (!existsSync(reviewDiffPath)) {
      failureCategory = "INPUT_MISSING";
      failureReason = `review.diff not found at ${reviewDiffPath}`;
    } else {
      const read = tryReadFile(reviewDiffPath);
      if (!read.ok) {
        failureCategory = "INPUT_INVALID";
        reviewInputMissingReason = "INVALID_ARTIFACT";
        failureReason = `review.diff unreadable: ${read.reason}`;
      } else {
        reviewDiffHash = sha256(read.raw);
        reviewDiffRaw = read.raw;
      }
    }
  }

  // --- Step 4: pre-invocation freshness comparison --------------------------
  if (failureCategory === null && reviewBundleResult !== null) {
    reviewInputMissingReason = null;
    const bundleGit = reviewBundleResult.git;
    // The regenerated-current-diff fact (see codexArtifactFreshness's doc
    // comment): changeSetFingerprint alone cannot catch a Git-relevant
    // file-mode-only change to an already-changed path, since it deliberately
    // never hashes mode bits. Regenerating the diff over the exact same
    // baseline/change-set this run just resolved and comparing its hash to
    // the diffHash review-bundle recorded closes that gap before Codex is
    // ever invoked.
    const regeneratedDiffHash = currentChangeSetDiffHash(cwd, baselineSha, changeSet);
    const factsMatch =
      bundleGit.baselineSha === baselineSha &&
      bundleGit.headSha === headSha &&
      bundleGit.changeSetFingerprint === changeSetFingerprint &&
      bundleGit.diffHash === reviewDiffHash &&
      bundleGit.diffHash === regeneratedDiffHash &&
      reviewBundleResult.taskDeclarationHash === taskDeclarationHash;
    if (!factsMatch) {
      failureCategory = "INPUT_STALE";
      reviewInputFreshness = "STALE";
      failureReason =
        "review bundle (review.json/review.diff) is stale relative to current git state or task declaration — re-run agent:review-bundle";
    } else {
      reviewInputFreshness = "CURRENT";
    }
  }

  // --- Step 4.5: output destination safety (pre-invocation) -----------------
  // Every Harness-owned persistent write target this command produces must be
  // outside the repository or Git-ignored, and must not alias a current
  // evidence input (the task declaration, review.json, review.diff) — an
  // unignored in-repo destination would make its own successful artifact
  // stale the instant it's written, and an aliased destination would silently
  // overwrite evidence this run's own freshness checks depend on.
  //
  // This check runs regardless of any earlier diagnostic failure
  // (ground-truth/input): writing this run's own result artifact over an
  // unsafe destination is a hazard independent of *why* the run is otherwise
  // failing — including when the destination happens to alias the exact
  // --task path that just failed to read or parse. Finding an unsafe
  // destination here overrides any earlier failureCategory, since persisting
  // that earlier diagnostic would itself be the unsafe write.
  //
  // The log destination is only worth checking while a Codex invocation could
  // still happen — i.e. while nothing else has already failed the run —
  // since codex-review.log is never written otherwise.
  const logPath = join(agentDir.value, "logs", "codex-review.log");
  const evidenceInputs: EvidenceInput[] = [
    ...(common.task !== undefined ? [{ path: common.task, label: "task declaration (--task)" }] : []),
    { path: reviewJsonPath, label: "review.json" },
    { path: reviewDiffPath, label: "review.diff" },
  ];
  function outputDestinationUnsafeReason(checkLog: boolean): string | null {
    return (
      checkOutputDestination(
        cwd,
        join(outDir.value, "review-findings.json"),
        "review-findings.json (--out)",
        evidenceInputs,
      ).reason ??
      checkOutputDestination(
        cwd,
        join(outDir.value, "review-summary.md"),
        "review-summary.md (--out)",
        evidenceInputs,
      ).reason ??
      (checkLog ? checkOutputDestination(cwd, logPath, "codex-review.log (--agent-dir)", evidenceInputs).reason : null)
    );
  }

  const preInvocationUnsafeReason = outputDestinationUnsafeReason(failureCategory === null);
  if (preInvocationUnsafeReason !== null) {
    failureCategory = "OUTPUT_DESTINATION_UNSAFE";
    failureReason = preInvocationUnsafeReason;
  }

  // --- Step 5: codex availability ---------------------------------------------
  // Bounded so a hung/wrapped `codex --version` cannot wedge the command
  // indefinitely despite the timeout the invocation itself honors.
  if (failureCategory === null) {
    const probeTimeoutMs = Math.min(timeoutMs, 5000);
    const codexAvailability = checkTool("codex", ["--version"], probeTimeoutMs);
    if (!codexAvailability.available) {
      failureCategory = "CODEX_UNAVAILABLE";
      failureReason = "codex CLI not found on PATH (codex --version failed or timed out)";
    }
  }

  // --- Step 6: invoke codex exec --------------------------------------------
  let codexOutcome: CodexInvocationOutcome | null = null;
  if (failureCategory === null) {
    // Invariant: reaching here with failureCategory === null means Step 3
    // validated review.json/review.diff, which is the only place these are set.
    if (reviewJsonRaw === null || reviewDiffRaw === null) {
      throw new Error("invariant violated: review.json/review.diff bytes must be captured before codex is invoked");
    }
    codexOutcome = runCodexReview({
      cwd,
      reviewJsonRaw,
      reviewDiffRaw,
      taskDeclarationRaw,
      timeoutMs,
    });
    if (codexOutcome.status === "FAILED") {
      failureCategory = "CODEX_EXECUTION_FAILED";
      failureReason = codexOutcome.failureReason;
    }
  }

  // --- Step 7/8: post-invocation TOCTOU re-check, then parse/validate -------
  let payload: CodexReviewPayload | null = null;
  if (failureCategory === null && codexOutcome !== null && codexOutcome.status === "OK" && provenance !== null) {
    let currentBaselineSha = "";
    try {
      currentBaselineSha = resolveBaseline(cwd, common.baseline, taskDeclaration?.baseline).sha;
    } catch {
      // stays "" — never equals a real stored SHA, so this fails closed to STALE below.
    }

    let currentHeadSha = "";
    try {
      currentHeadSha = getHeadSha(cwd);
    } catch {
      // stays ""
    }

    let currentFingerprint = "";
    let currentRegeneratedDiffHash = "";
    if (currentBaselineSha !== "") {
      try {
        const currentChangeSet = getCompleteChangeSet(cwd, currentBaselineSha);
        currentFingerprint = computeChangeSetFingerprint(cwd, currentChangeSet);
        // Same regenerated-current-diff fact as Step 4's pre-invocation
        // check, re-evaluated against whatever baseline/change-set resolve
        // right now: catches a Git-relevant file-mode-only change made *while
        // codex exec was running*, which changeSetFingerprint alone cannot
        // (it never hashes mode bits) and which review.diff's own re-read
        // bytes hash cannot either (that file was never touched).
        currentRegeneratedDiffHash = currentChangeSetDiffHash(cwd, currentBaselineSha, currentChangeSet);
      } catch {
        // stays "" — never equals a real stored diff hash, so this fails closed to STALE below.
      }
    }

    let currentReviewJsonHash = "";
    const rereadReviewJson = tryReadFile(reviewJsonPath);
    if (rereadReviewJson.ok) currentReviewJsonHash = sha256(rereadReviewJson.raw);

    let currentReviewDiffHash = "";
    const rereadReviewDiff = tryReadFile(reviewDiffPath);
    if (rereadReviewDiff.ok) currentReviewDiffHash = sha256(rereadReviewDiff.raw);

    let currentTaskDeclarationHash: string | null = null;
    if (common.task !== undefined) {
      const rereadTask = tryReadFile(common.task);
      if (rereadTask.ok) currentTaskDeclarationHash = sha256(rereadTask.raw);
    }

    const postInvocationFreshness = codexArtifactFreshness(
      provenance,
      reviewJsonHash ?? "",
      reviewDiffHash ?? "",
      taskDeclarationHash,
      { baselineSha: currentBaselineSha, headSha: currentHeadSha, changeSetFingerprint: currentFingerprint },
      currentReviewJsonHash,
      currentReviewDiffHash,
      currentTaskDeclarationHash,
      currentRegeneratedDiffHash,
    );

    if (postInvocationFreshness !== "CURRENT") {
      failureCategory = "INPUT_STALE";
      reviewInputFreshness = "STALE";
      failureReason =
        "input changed while codex exec was running (TOCTOU): re-run agent:review-bundle and agent:codex-review";
    } else {
      try {
        const parsedPayload: unknown = JSON.parse(codexOutcome.outputLastMessageText ?? "");
        if (!isCodexReviewPayload(parsedPayload)) {
          failureCategory = "CODEX_OUTPUT_INVALID";
          failureReason = "codex output failed schema validation";
        } else if (!verdictConsistentWithFindings(parsedPayload)) {
          failureCategory = "CODEX_OUTPUT_INVALID";
          failureReason = "codex output verdict is inconsistent with its findings";
        } else {
          payload = parsedPayload;
        }
      } catch (err) {
        failureCategory = "CODEX_OUTPUT_INVALID";
        failureReason = `codex output is not valid JSON: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  // --- Step 9: output destination safety (immediately pre-persistence) ------
  // Revalidates every destination right before it is actually written,
  // independently of the pre-invocation check above: the (potentially long)
  // codex exec call in between is a window in which a destination's ancestor
  // could be swapped (e.g. to a symlink into an unignored repo directory)
  // after it was found safe but before this run's own artifacts land there.
  // Skipped only when the pre-invocation check already condemned a
  // destination — nothing will be persisted either way, so revalidating again
  // has nothing left to protect.
  if (failureCategory !== "OUTPUT_DESTINATION_UNSAFE") {
    const finalUnsafeReason = outputDestinationUnsafeReason(codexOutcome !== null && codexOutcome.invoked);
    if (finalUnsafeReason !== null) {
      failureCategory = "OUTPUT_DESTINATION_UNSAFE";
      failureReason = finalUnsafeReason;
    }
  }

  const status: "OK" | "FAILED" = failureCategory === null ? "OK" : "FAILED";

  const result: CodexReviewResult = {
    status,
    failureCategory,
    failureReason,
    payload,
    reviewInput: {
      freshness: reviewInputFreshness,
      missingReason: reviewInputMissingReason,
      reviewJsonPath,
      reviewDiffPath,
    },
    codexExec: {
      invoked: codexOutcome?.invoked ?? false,
      exitCode: codexOutcome?.exitCode ?? null,
      durationMs: codexOutcome?.durationMs ?? null,
      logPath: codexOutcome !== null && codexOutcome.invoked ? logPath : null,
    },
    reviewJsonHash,
    reviewDiffHash,
    taskDeclarationHash,
    provenance,
  };

  // Narrow exception to the normal "artifacts are always written" collector
  // rule: OUTPUT_DESTINATION_UNSAFE means at least one of these two paths (or
  // the log path) was classified unsafe — possibly because it aliases an
  // evidence input this run depends on. Writing here regardless of that
  // classification is exactly the bug the classification exists to prevent,
  // so on this failure category alone, no persistent artifact is written at
  // all; the failure is reported only via stdout/stderr/--print-json below.
  //
  // review-findings.json is the canonical completion marker, so it is never
  // the first thing written: any stale copy already on disk from a prior run
  // is removed first (best-effort — nothing to remove, or an as-yet-missing
  // parent directory, are both fine), the non-canonical diagnostic outputs
  // (review-summary.md, the raw Codex log) are persisted next, and
  // review-findings.json is (re)written only last, once those have both
  // succeeded. This way a persistence failure partway through (e.g.
  // review-summary.md's write throwing) propagates as an uncaught error
  // without ever leaving a "status: OK"-looking review-findings.json around
  // that would misrepresent this run — this run's own write already removed
  // it, and the final write that would recreate it is never reached. No
  // attempt beyond this ordering is made at transactional perfection across
  // the three files, per the trusted-local-machine threat model.
  if (failureCategory !== "OUTPUT_DESTINATION_UNSAFE") {
    const findingsPath = join(outDir.value, "review-findings.json");
    try {
      unlinkSync(findingsPath);
    } catch {
      // No stale artifact to remove — nothing to do.
    }
    writeFileAtomic(join(outDir.value, "review-summary.md"), renderMarkdown(result));
    if (codexOutcome !== null && codexOutcome.invoked && codexOutcome.rawLog !== null) {
      writeFileAtomic(logPath, codexOutcome.rawLog);
    }
    writeJsonAtomic(findingsPath, result);
  }

  if (result.failureReason !== null) {
    console.error("Failure reason:");
    printFailureReasons([result.failureReason]);
  }

  if (common.printJson) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printStatusLine("codex-review", result.status);
  }

  process.exit(result.status === "OK" ? 0 : 1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    if (err instanceof CliArgsError) {
      console.error(`agent:codex-review: ${err.message}`);
      process.exit(1);
    }
    console.error(err);
    process.exit(1);
  }
}
