import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProvenance,
  codexArtifactFreshness,
  compareProvenance,
  FINAL_NOT_RUN,
  FINAL_STEP_COMMANDS,
  isFinalVerifyResult,
  isFocusedVerifyResult,
  isReviewBundleResult,
  isScopeCheckResult,
  loadGateResult,
  scopeSemanticsCurrent,
} from "./provenance";
import type {
  ConfigSource,
  ProvenanceBlock,
  ResolvedConfig,
  ScopeCheckResult,
  StepStatus,
  VerifyMode,
  VerifyResult,
  VerifyStep,
} from "./types";

function sampleStep(command: string, status: StepStatus): VerifyStep {
  return { command, status, exitCode: status === "PASS" ? 0 : 1, durationMs: 10, logPath: "/tmp/log", outputTail: "" };
}

/** The steps a real, fully-successful `agent:verify --final` run would have recorded. */
function validFinalPassSteps(): VerifyStep[] {
  return FINAL_STEP_COMMANDS.map((command) => sampleStep(command, "PASS"));
}

function sampleResolvedConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    taskPath: { value: null, source: "default" },
    agentDir: { value: "/repo/.agent", source: "default" },
    baselineSha: "a".repeat(40),
    baselineSource: "merge-base-main",
    scope: { value: null, source: "default" },
    ...overrides,
  };
}

function sampleProvenance(config: ResolvedConfig = sampleResolvedConfig()): ProvenanceBlock {
  return buildProvenance("a".repeat(40), "b".repeat(40), "c".repeat(64), config);
}

function sampleVerifyResult(provenance: ProvenanceBlock, mode: VerifyMode = "focused"): VerifyResult {
  return {
    mode,
    status: "PASS",
    touchedWorkspaces: [],
    // A default PASS must be a shape the real producer could emit: focused
    // mode legitimately PASSes with zero steps, but final mode's contract
    // requires all four steps present and passing.
    steps: mode === "final" ? validFinalPassSteps() : [],
    notRun: mode === "final" ? [...FINAL_NOT_RUN] : [],
    failureReasons: [],
    provenance: {
      ...provenance,
      resolvedConfig: { ...provenance.resolvedConfig, mode: { value: mode, source: "cli" } },
    },
  };
}

function sampleScopeCheckResult(scope: { value: string[] | null; source: ConfigSource }): ScopeCheckResult {
  return {
    status: "PASS",
    scopePatterns: scope.value ?? [],
    changeSetPaths: [],
    outOfScopePaths: [],
    failureReasons: [],
    provenance: sampleProvenance(sampleResolvedConfig({ scope })),
  };
}

function currentFactsFor(provenance: ProvenanceBlock) {
  return {
    baselineSha: provenance.baselineSha,
    headSha: provenance.headSha,
    changeSetFingerprint: provenance.changeSetFingerprint,
  };
}

describe("compareProvenance", () => {
  it("returns CURRENT when baseline, head, and fingerprint all match", () => {
    const provenance = sampleProvenance();
    const result = compareProvenance(provenance, {
      baselineSha: provenance.baselineSha,
      headSha: provenance.headSha,
      changeSetFingerprint: provenance.changeSetFingerprint,
    });
    expect(result).toBe("CURRENT");
  });

  it("returns STALE when the fingerprint differs (e.g. a file edited after the gate ran)", () => {
    const provenance = sampleProvenance();
    const result = compareProvenance(provenance, {
      baselineSha: provenance.baselineSha,
      headSha: provenance.headSha,
      changeSetFingerprint: "different-fingerprint",
    });
    expect(result).toBe("STALE");
  });

  it("returns STALE when HEAD differs (e.g. a commit after the gate ran)", () => {
    const provenance = sampleProvenance();
    const result = compareProvenance(provenance, {
      baselineSha: provenance.baselineSha,
      headSha: "d".repeat(40),
      changeSetFingerprint: provenance.changeSetFingerprint,
    });
    expect(result).toBe("STALE");
  });
});

describe("loadGateResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provenance-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("MISSING + NOT_FOUND when no file exists at the expected path", () => {
    const result = loadGateResult<VerifyResult>(join(dir, "nope.json"), isFocusedVerifyResult, {
      baselineSha: "x",
      headSha: "y",
      changeSetFingerprint: "z",
    });
    expect(result.freshness).toBe("MISSING");
    expect(result.missingReason).toBe("NOT_FOUND");
    expect(result.result).toBeNull();
  });

  it("MISSING + INVALID_ARTIFACT when the file exists but is not valid JSON", () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{not json at all");
    const result = loadGateResult<VerifyResult>(path, isFocusedVerifyResult, {
      baselineSha: "x",
      headSha: "y",
      changeSetFingerprint: "z",
    });
    expect(result.freshness).toBe("MISSING");
    expect(result.missingReason).toBe("INVALID_ARTIFACT");
  });

  it("MISSING + INVALID_ARTIFACT when the file is valid JSON but fails schema validation", () => {
    const path = join(dir, "wrong-shape.json");
    writeFileSync(path, JSON.stringify({ status: "PASS" }));
    const result = loadGateResult<VerifyResult>(path, isFocusedVerifyResult, {
      baselineSha: "x",
      headSha: "y",
      changeSetFingerprint: "z",
    });
    expect(result.freshness).toBe("MISSING");
    expect(result.missingReason).toBe("INVALID_ARTIFACT");
  });

  it("CURRENT when the stored provenance matches current facts exactly", () => {
    const provenance = sampleProvenance();
    const path = join(dir, "verify-focused.json");
    writeFileSync(path, JSON.stringify(sampleVerifyResult(provenance)));

    const result = loadGateResult<VerifyResult>(path, isFocusedVerifyResult, {
      baselineSha: provenance.baselineSha,
      headSha: provenance.headSha,
      changeSetFingerprint: provenance.changeSetFingerprint,
    });
    expect(result.freshness).toBe("CURRENT");
    expect(result.missingReason).toBeNull();
    expect(result.result?.status).toBe("PASS");
  });

  it("STALE when the stored provenance disagrees with current facts", () => {
    const provenance = sampleProvenance();
    const path = join(dir, "verify-focused.json");
    writeFileSync(path, JSON.stringify(sampleVerifyResult(provenance)));

    const result = loadGateResult<VerifyResult>(path, isFocusedVerifyResult, {
      baselineSha: provenance.baselineSha,
      headSha: provenance.headSha,
      changeSetFingerprint: "some-other-fingerprint",
    });
    expect(result.freshness).toBe("STALE");
    expect(result.missingReason).toBeNull();
  });
});

// Regression (Codex finding: one mode-agnostic validator meant a focused
// artifact satisfied the verify-final.json contract, so the weaker guarantee
// could be read as the CI-equivalent one).
describe("mode-specific verify artifact validation", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provenance-mode-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a focused result under the final validator, and vice versa", () => {
    const focused = sampleVerifyResult(sampleProvenance(), "focused");
    const final = sampleVerifyResult(sampleProvenance(), "final");

    expect(isFocusedVerifyResult(focused)).toBe(true);
    expect(isFinalVerifyResult(focused)).toBe(false);
    expect(isFinalVerifyResult(final)).toBe(true);
    expect(isFocusedVerifyResult(final)).toBe(false);
  });

  it("a focused result copied verbatim to verify-final.json loads as MISSING + INVALID_ARTIFACT", () => {
    const provenance = sampleProvenance();
    const path = join(dir, "verify-final.json");
    writeFileSync(path, JSON.stringify(sampleVerifyResult(provenance, "focused")));

    const result = loadGateResult<VerifyResult>(path, isFinalVerifyResult, currentFactsFor(provenance));
    expect(result.freshness).toBe("MISSING");
    expect(result.missingReason).toBe("INVALID_ARTIFACT");
    expect(result.result).toBeNull();
  });

  it("rejects an artifact whose top-level mode and recorded resolved-configuration mode disagree", () => {
    const doctored = sampleVerifyResult(sampleProvenance(), "focused");
    doctored.mode = "final";
    expect(isFinalVerifyResult(doctored)).toBe(false);
  });

  it("rejects structurally invalid artifacts: unknown fields, wrong element types, bad resolved config", () => {
    const valid = sampleVerifyResult(sampleProvenance(), "focused");

    expect(isFocusedVerifyResult({ ...valid, unexpectedField: 1 })).toBe(false);
    expect(isFocusedVerifyResult({ ...valid, touchedWorkspaces: [1, 2] })).toBe(false);
    expect(isFocusedVerifyResult({ ...valid, steps: [{ command: "x" }] })).toBe(false);
    expect(isFocusedVerifyResult({ ...valid, notRun: [null] })).toBe(false);
    expect(
      isFocusedVerifyResult({
        ...valid,
        provenance: { ...valid.provenance, resolvedConfig: { ...valid.provenance.resolvedConfig, baselineSource: "made-up" } },
      }),
    ).toBe(false);
  });

  it("accepts the shapes the producer really does emit, without inventing extra invariants", () => {
    // A final run that failed before any step ran still records the fixed
    // notRun pair and an empty steps list — that must stay valid.
    const earlyFailure = sampleVerifyResult(sampleProvenance(), "final");
    earlyFailure.status = "FAIL";
    earlyFailure.steps = [];
    earlyFailure.failureReasons = ["unresolved baseline"];
    expect(isFinalVerifyResult(earlyFailure)).toBe(true);

    // A focused run with zero touched workspaces and zero steps is a real PASS.
    expect(isFocusedVerifyResult(sampleVerifyResult(sampleProvenance(), "focused"))).toBe(true);
  });
});

// Regression (Codex finding: the exact doctored artifact reproduction).
// mode: "final", status: "PASS", steps: [], notRun: [] must not validate as
// CURRENT/PASS — only the shapes the real producer can actually emit may.
describe("final-mode step/notRun contract (Codex finding: doctored PASS-with-no-steps artifact)", () => {
  function finalResult(overrides: Partial<VerifyResult> = {}): VerifyResult {
    return { ...sampleVerifyResult(sampleProvenance(), "final"), ...overrides };
  }

  it("rejects the exact Codex-reported doctored artifact: PASS with empty steps and empty notRun", () => {
    const doctored = finalResult({ status: "PASS", steps: [], notRun: [] });
    expect(isFinalVerifyResult(doctored)).toBe(false);
  });

  it("rejects a PASS with zero steps even when notRun is correct", () => {
    const doctored = finalResult({ status: "PASS", steps: [] });
    expect(isFinalVerifyResult(doctored)).toBe(false);
  });

  it("rejects a PASS whose notRun is wrong or missing entries, even with all four steps correct", () => {
    const validSteps = validFinalPassSteps();
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: validSteps, notRun: [] }))).toBe(false);
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: validSteps, notRun: ["integration"] }))).toBe(
      false,
    );
    expect(
      isFinalVerifyResult(
        finalResult({ status: "PASS", steps: validSteps, notRun: ["docker-smoke", "integration"] }),
      ),
    ).toBe(false);
  });

  it("rejects a PASS with an incorrect command string or with steps out of order", () => {
    const wrongCommand = validFinalPassSteps();
    wrongCommand[1] = sampleStep("pnpm something-else", "PASS");
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: wrongCommand }))).toBe(false);

    const reordered = [...validFinalPassSteps()].reverse();
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: reordered }))).toBe(false);
  });

  it("rejects a PASS with fewer than four steps, or more than four", () => {
    const tooFew = validFinalPassSteps().slice(0, 3);
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: tooFew }))).toBe(false);

    const tooMany = [...validFinalPassSteps(), sampleStep("pnpm extra-step", "PASS")];
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: tooMany }))).toBe(false);
  });

  it("rejects a PASS where one of the four steps itself is recorded as FAIL", () => {
    const oneFailed = validFinalPassSteps();
    oneFailed[2] = sampleStep(FINAL_STEP_COMMANDS[2] ?? "", "FAIL");
    expect(isFinalVerifyResult(finalResult({ status: "PASS", steps: oneFailed }))).toBe(false);
  });

  it("accepts a legitimate early failure: zero steps, FAIL, correct notRun", () => {
    const legitimate = finalResult({ status: "FAIL", steps: [], failureReasons: ["unresolved baseline"] });
    expect(isFinalVerifyResult(legitimate)).toBe(true);
  });

  it("accepts a legitimate fail-fast prefix: leading steps PASS, the executed step FAIL", () => {
    // Failed on the second step (pnpm test); build and check:bundle never ran.
    const prefix = [sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "PASS"), sampleStep(FINAL_STEP_COMMANDS[1] ?? "", "FAIL")];
    const legitimate = finalResult({ status: "FAIL", steps: prefix, failureReasons: ["step failed: pnpm test"] });
    expect(isFinalVerifyResult(legitimate)).toBe(true);

    // Also legitimate: failing on the very first step.
    const failFirst = finalResult({
      status: "FAIL",
      steps: [sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "FAIL")],
      failureReasons: ["step failed: pnpm typecheck"],
    });
    expect(isFinalVerifyResult(failFirst)).toBe(true);

    // And failing on the last step, with all three prior steps PASS.
    const failLast = finalResult({
      status: "FAIL",
      steps: [
        sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "PASS"),
        sampleStep(FINAL_STEP_COMMANDS[1] ?? "", "PASS"),
        sampleStep(FINAL_STEP_COMMANDS[2] ?? "", "PASS"),
        sampleStep(FINAL_STEP_COMMANDS[3] ?? "", "FAIL"),
      ],
      failureReasons: ["step failed: pnpm --filter @opspilot/web run check:bundle"],
    });
    expect(isFinalVerifyResult(failLast)).toBe(true);
  });

  it("rejects a FAIL prefix where an earlier step is recorded as FAIL too (should have stopped there)", () => {
    const twoFailed = finalResult({
      status: "FAIL",
      steps: [sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "FAIL"), sampleStep(FINAL_STEP_COMMANDS[1] ?? "", "FAIL")],
    });
    expect(isFinalVerifyResult(twoFailed)).toBe(false);
  });

  it("rejects a FAIL whose executed prefix ends in PASS instead of FAIL", () => {
    const noFailure = finalResult({
      status: "FAIL",
      steps: [sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "PASS"), sampleStep(FINAL_STEP_COMMANDS[1] ?? "", "PASS")],
    });
    expect(isFinalVerifyResult(noFailure)).toBe(false);
  });

  it("a doctored artifact on disk loads as MISSING + INVALID_ARTIFACT, not CURRENT/PASS", () => {
    const dir = mkdtempSync(join(tmpdir(), "provenance-final-doctored-"));
    try {
      const provenance = sampleProvenance();
      const doctored = { ...sampleVerifyResult(provenance, "final"), status: "PASS" as const, steps: [], notRun: [] };
      const path = join(dir, "verify-final.json");
      writeFileSync(path, JSON.stringify(doctored));

      const result = loadGateResult<VerifyResult>(path, isFinalVerifyResult, currentFactsFor(provenance));
      expect(result.freshness).toBe("MISSING");
      expect(result.missingReason).toBe("INVALID_ARTIFACT");
      expect(result.result).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// MAJOR regression (HQ-adjudicated, structured-codex-review-v1 final
// re-review): the real agent:verify producer (verify.ts) selects
// status/failureReasons and each step's status/exitCode as exact bijections —
// `status: failureReasons.length === 0 ? "PASS" : "FAIL"` at the result level,
// `status: exitCode === 0 ? "PASS" : "FAIL"` at the step level (an abnormal/
// signal-killed spawn's null exit status is already normalized to 1 before
// this ever reaches disk). A doctored/corrupted artifact whose fields
// disagree with those bijections is not a shape the real producer could ever
// emit and must not be read as trustworthy evidence.
describe("verify-result producer invariants (status/failureReasons, step status/exitCode)", () => {
  it("(A) rejects PASS with non-empty failureReasons", () => {
    const bad = { ...sampleVerifyResult(sampleProvenance(), "focused"), failureReasons: ["stale failure reason"] };
    expect(isFocusedVerifyResult(bad)).toBe(false);
  });

  it("(B) rejects FAIL with empty failureReasons", () => {
    const bad = { ...sampleVerifyResult(sampleProvenance(), "focused"), status: "FAIL" as const, failureReasons: [] };
    expect(isFocusedVerifyResult(bad)).toBe(false);
  });

  it("(C) rejects a PASS step carrying a producer-invalid nonzero exitCode", () => {
    const bad = {
      ...sampleVerifyResult(sampleProvenance(), "focused"),
      steps: [{ ...sampleStep("pnpm test", "PASS"), exitCode: 1 }],
    };
    expect(isFocusedVerifyResult(bad)).toBe(false);
  });

  it("(D) rejects a FAIL step carrying the producer's successful exitCode (0)", () => {
    const bad = {
      ...sampleVerifyResult(sampleProvenance(), "focused"),
      status: "FAIL" as const,
      steps: [{ ...sampleStep("pnpm test", "FAIL"), exitCode: 0 }],
      failureReasons: ["step failed: pnpm test (exit 0)"],
    };
    expect(isFocusedVerifyResult(bad)).toBe(false);
  });

  it("(E) accepts normal producer-generated focused/final PASS and FAIL shapes", () => {
    expect(isFocusedVerifyResult(sampleVerifyResult(sampleProvenance(), "focused"))).toBe(true);
    expect(isFinalVerifyResult(sampleVerifyResult(sampleProvenance(), "final"))).toBe(true);

    const focusedFail = {
      ...sampleVerifyResult(sampleProvenance(), "focused"),
      status: "FAIL" as const,
      touchedWorkspaces: ["@opspilot/web"],
      steps: [sampleStep("pnpm --filter @opspilot/web run test", "FAIL")],
      failureReasons: ["step failed: pnpm --filter @opspilot/web run test (exit 1)"],
    };
    expect(isFocusedVerifyResult(focusedFail)).toBe(true);

    const finalFail = {
      ...sampleVerifyResult(sampleProvenance(), "final"),
      status: "FAIL" as const,
      steps: [sampleStep(FINAL_STEP_COMMANDS[0] ?? "", "FAIL")],
      failureReasons: ["step failed: pnpm typecheck (exit 1)"],
    };
    expect(isFinalVerifyResult(finalFail)).toBe(true);
  });
});

// Regression (Codex finding: provenance recorded resolvedConfig but freshness
// ignored it, so a scope-check artifact stayed CURRENT after the scope it
// checked against changed).
describe("scopeSemanticsCurrent", () => {
  it("STALE when a task-declaration scope changed under an unchanged tree and HEAD", () => {
    const stored = sampleScopeCheckResult({ value: ["apps/web/**"], source: "task-declaration" });

    expect(
      scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: ["apps/web/**"] }),
    ).toBe(true);
    expect(
      scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: ["apps/web/**", "docs/**"] }),
    ).toBe(false);
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: null })).toBe(false);
  });

  it("fails closed to STALE when a task-sourced scope cannot be re-derived at all", () => {
    const stored = sampleScopeCheckResult({ value: ["apps/web/**"], source: "task-declaration" });
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: false, taskScope: null })).toBe(false);
  });

  it("preserves CLI override semantics: a --scope-sourced scope is never re-derived or invented", () => {
    const stored = sampleScopeCheckResult({ value: ["apps/web/**"], source: "cli" });
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: false, taskScope: null })).toBe(true);
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: ["something/else/**"] })).toBe(
      true,
    );
  });

  it("a not-configured run stays current only while no scope is configured now either", () => {
    const stored = sampleScopeCheckResult({ value: null, source: "default" });
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: false, taskScope: null })).toBe(true);
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: null })).toBe(true);
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: ["docs/**"] })).toBe(false);
  });

  it("distinguishes a declared-but-empty scope from a scope that gained patterns", () => {
    const stored = sampleScopeCheckResult({ value: [], source: "task-declaration" });
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: [] })).toBe(true);
    expect(scopeSemanticsCurrent(stored, { taskDeclarationSupplied: true, taskScope: ["docs/**"] })).toBe(false);
  });
});

// Codex finding (structured-codex-review-v1, HQ-adjudicated MAJOR): the real
// agent:scope-check producer only ever emits three status/failureReasons/
// outOfScopePaths combinations (see scope-check.ts's own status-selection
// logic) — a doctored/corrupted artifact whose status disagrees with those
// fields (e.g. a PASS still carrying a real FAIL's outOfScopePaths) must not
// be read as trustworthy evidence.
describe("isScopeCheckResult producer invariants", () => {
  it("(A) rejects PASS with non-empty outOfScopePaths", () => {
    const bad = { ...sampleScopeCheckResult({ value: ["apps/**"], source: "task-declaration" }), status: "PASS" as const, outOfScopePaths: ["x.txt"] };
    expect(isScopeCheckResult(bad)).toBe(false);
  });

  it("(B) rejects PASS with non-empty failureReasons", () => {
    const bad = {
      ...sampleScopeCheckResult({ value: ["apps/**"], source: "task-declaration" }),
      status: "PASS" as const,
      failureReasons: ["some stale failure reason"],
    };
    expect(isScopeCheckResult(bad)).toBe(false);
  });

  it("(C) rejects FAIL with empty failureReasons", () => {
    const bad = { ...sampleScopeCheckResult({ value: ["apps/**"], source: "task-declaration" }), status: "FAIL" as const, failureReasons: [] };
    expect(isScopeCheckResult(bad)).toBe(false);
  });

  it("(D) accepts producer-valid PASS / FAIL / NOT_CONFIGURED examples", () => {
    const pass = sampleScopeCheckResult({ value: ["apps/**"], source: "task-declaration" });
    expect(pass.status).toBe("PASS");
    expect(isScopeCheckResult(pass)).toBe(true);

    const fail = {
      ...sampleScopeCheckResult({ value: ["apps/**"], source: "task-declaration" }),
      status: "FAIL" as const,
      outOfScopePaths: ["x.txt"],
      failureReasons: ["1 path(s) outside declared scope: x.txt"],
    };
    expect(isScopeCheckResult(fail)).toBe(true);

    const notConfigured = {
      ...sampleScopeCheckResult({ value: null, source: "default" }),
      status: "NOT_CONFIGURED" as const,
    };
    expect(isScopeCheckResult(notConfigured)).toBe(true);
  });

  it("rejects NOT_CONFIGURED with non-empty scopePatterns (not the producer's actual unconfigured shape)", () => {
    const bad = {
      ...sampleScopeCheckResult({ value: ["apps/**"], source: "default" }),
      status: "NOT_CONFIGURED" as const,
    };
    expect(bad.scopePatterns).toEqual(["apps/**"]);
    expect(isScopeCheckResult(bad)).toBe(false);
  });

  it("rejects NOT_CONFIGURED with non-empty outOfScopePaths or failureReasons", () => {
    const withOutOfScope = {
      ...sampleScopeCheckResult({ value: null, source: "default" }),
      status: "NOT_CONFIGURED" as const,
      outOfScopePaths: ["x.txt"],
    };
    expect(isScopeCheckResult(withOutOfScope)).toBe(false);

    const withFailureReason = {
      ...sampleScopeCheckResult({ value: null, source: "default" }),
      status: "NOT_CONFIGURED" as const,
      failureReasons: ["some reason"],
    };
    expect(isScopeCheckResult(withFailureReason)).toBe(false);
  });
});

describe("isReviewBundleResult", () => {
  function sampleReviewBundleResult(): import("./types").ReviewBundleResult {
    return {
      status: "OK",
      failureReason: null,
      git: {
        baselineSha: "a".repeat(40),
        headSha: "b".repeat(40),
        branch: "main",
        changedPaths: ["x.txt"],
        diffHash: "d".repeat(64),
        changeSetFingerprint: "e".repeat(64),
      },
      reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
      verify: {
        focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
        final: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      },
      scopeCheck: { freshness: "MISSING", missingReason: "NOT_FOUND", result: null },
      taskDeclarationHash: null,
    };
  }

  it("accepts a well-formed review bundle result", () => {
    expect(isReviewBundleResult(sampleReviewBundleResult())).toBe(true);
  });

  /** A provenance block whose baselineSha/headSha/changeSetFingerprint agree exactly with `sampleReviewBundleResult()`'s own `git` facts — what the real producer always embeds in a nested result it marks CURRENT. */
  function provenanceMatchingBundleGit(config: ResolvedConfig = sampleResolvedConfig()): ProvenanceBlock {
    const { baselineSha, headSha, changeSetFingerprint } = sampleReviewBundleResult().git;
    return buildProvenance(baselineSha, headSha, changeSetFingerprint, config);
  }

  it("accepts a nested CURRENT verify/scope-check result whose provenance agrees with the enclosing git facts", () => {
    const withNested = sampleReviewBundleResult();
    withNested.verify.focused = {
      freshness: "CURRENT",
      missingReason: null,
      result: sampleVerifyResult(provenanceMatchingBundleGit(), "focused"),
    };
    withNested.scopeCheck = {
      freshness: "CURRENT",
      missingReason: null,
      result: {
        ...sampleScopeCheckResult({ value: null, source: "default" }),
        provenance: provenanceMatchingBundleGit(sampleResolvedConfig({ scope: { value: null, source: "default" } })),
      },
    };
    expect(isReviewBundleResult(withNested)).toBe(true);
  });

  // Codex finding (structured-codex-review-v1): a CURRENT nested result is
  // only trustworthy evidence if its own provenance actually agrees with the
  // enclosing bundle's git facts — the real producer (loadGateResult) only
  // ever marks a nested result CURRENT once compareProvenance already
  // confirmed exactly that. A forged artifact that hand-sets freshness:
  // "CURRENT" on a nested result carrying a different baseline/head/
  // fingerprint must fail structural validation outright (INPUT_INVALID at
  // the codex-review.ts layer), never be read as trustworthy CURRENT
  // evidence.
  it("rejects a forged CURRENT nested verify result whose provenance disagrees with the enclosing git facts", () => {
    const forged = sampleReviewBundleResult();
    forged.verify.focused = {
      freshness: "CURRENT",
      missingReason: null,
      // Uses the unrelated default sampleProvenance() facts, not the
      // bundle's own git facts — a mismatched baseline/head/fingerprint.
      result: sampleVerifyResult(sampleProvenance(), "focused"),
    };
    expect(isReviewBundleResult(forged)).toBe(false);
  });

  it("rejects a forged CURRENT nested scope-check result whose provenance disagrees with the enclosing git facts", () => {
    const forged = sampleReviewBundleResult();
    forged.scopeCheck = {
      freshness: "CURRENT",
      missingReason: null,
      result: sampleScopeCheckResult({ value: null, source: "default" }),
    };
    expect(isReviewBundleResult(forged)).toBe(false);
  });

  it("a STALE nested result is never required to agree with the enclosing git facts", () => {
    const withStale = sampleReviewBundleResult();
    withStale.verify.final = {
      freshness: "STALE",
      missingReason: null,
      result: sampleVerifyResult(sampleProvenance(), "final"),
    };
    expect(isReviewBundleResult(withStale)).toBe(true);
  });

  it("rejects an unknown top-level field", () => {
    expect(isReviewBundleResult({ ...sampleReviewBundleResult(), extra: 1 })).toBe(false);
  });

  it("rejects a missing changeSetFingerprint on git", () => {
    const bad = sampleReviewBundleResult();
    const { changeSetFingerprint: _drop, ...gitWithoutFingerprint } = bad.git;
    expect(isReviewBundleResult({ ...bad, git: gitWithoutFingerprint })).toBe(false);
  });

  it("rejects an invalid reconstructionProof.status", () => {
    const bad = sampleReviewBundleResult();
    expect(
      isReviewBundleResult({ ...bad, reconstructionProof: { ...bad.reconstructionProof, status: "UNKNOWN" } }),
    ).toBe(false);
  });

  // MAJOR regression (HQ-adjudicated, structured-codex-review-v1 final
  // re-review): the real reconstruction producer (reconstruction.ts's
  // buildReconstructionProof) only ever sets a non-null cleanupError when
  // cleanup itself failed, in which case status is unconditionally forced to
  // CLEANUP_FAILED — every other status is hardcoded with `cleanupError:
  // null` at its call site. A MATCH (or any other non-cleanup status)
  // carrying a cleanupError, or a CLEANUP_FAILED without one, is not a shape
  // the real producer could ever emit.
  describe("reconstructionProof producer invariant (status vs. cleanupError)", () => {
    it("(A) rejects MATCH with a non-null cleanupError", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: "leaked worktree" },
        }),
      ).toBe(false);
    });

    it("(B) rejects a non-cleanup status (MISMATCH) carrying a cleanupError", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          status: "FAILED",
          failureReason: "reconstruction proof: MISMATCH",
          reconstructionProof: { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: "leaked worktree" },
        }),
      ).toBe(false);
    });

    it("(C) rejects CLEANUP_FAILED without a cleanupError", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          status: "FAILED",
          failureReason: "reconstruction proof: CLEANUP_FAILED",
          reconstructionProof: { status: "CLEANUP_FAILED", missingPaths: [], extraPaths: [], cleanupError: null },
        }),
      ).toBe(false);
    });

    it("(D) accepts normal producer-generated reconstruction states", () => {
      const match = sampleReviewBundleResult();
      expect(isReviewBundleResult(match)).toBe(true);

      const mismatch = {
        ...sampleReviewBundleResult(),
        status: "FAILED" as const,
        failureReason: "reconstruction proof: MISMATCH",
        reconstructionProof: { status: "MISMATCH" as const, missingPaths: [], extraPaths: [], cleanupError: null },
      };
      expect(isReviewBundleResult(mismatch)).toBe(true);

      const cleanupFailed = {
        ...sampleReviewBundleResult(),
        status: "FAILED" as const,
        failureReason: "reconstruction proof: CLEANUP_FAILED",
        reconstructionProof: {
          status: "CLEANUP_FAILED" as const,
          missingPaths: [],
          extraPaths: [],
          cleanupError: "worktree is still registered at /tmp/x",
        },
      };
      expect(isReviewBundleResult(cleanupFailed)).toBe(true);
    });
  });

  it("rejects a MISSING nested result with a non-null missingReason contract violated (result present)", () => {
    const bad = sampleReviewBundleResult();
    expect(
      isReviewBundleResult({
        ...bad,
        verify: {
          ...bad.verify,
          focused: { freshness: "MISSING", missingReason: "NOT_FOUND", result: sampleVerifyResult(sampleProvenance()) },
        },
      }),
    ).toBe(false);
  });

  it("rejects a CURRENT nested result with a null result", () => {
    const bad = sampleReviewBundleResult();
    expect(
      isReviewBundleResult({
        ...bad,
        scopeCheck: { freshness: "CURRENT", missingReason: null, result: null },
      }),
    ).toBe(false);
  });

  it("accepts a non-null taskDeclarationHash", () => {
    const withHash = { ...sampleReviewBundleResult(), taskDeclarationHash: "f".repeat(64) };
    expect(isReviewBundleResult(withHash)).toBe(true);
  });

  it("rejects a missing taskDeclarationHash field", () => {
    const bad = sampleReviewBundleResult();
    const { taskDeclarationHash: _drop, ...withoutHash } = bad;
    expect(isReviewBundleResult(withoutHash)).toBe(false);
  });

  it("rejects a non-string, non-null taskDeclarationHash", () => {
    expect(isReviewBundleResult({ ...sampleReviewBundleResult(), taskDeclarationHash: 123 })).toBe(false);
  });

  // MAJOR regression (HQ): the real agent:review-bundle producer never emits
  // these combinations (review-bundle.ts only sets failureReason to null once
  // reconstructionProof.status === "MATCH", and status: "OK" only once
  // failureReason stays null) — a hand-crafted or corrupted artifact claiming
  // otherwise must not be read as trustworthy evidence, so a Codex review
  // built on it must never reach INPUT_STALE/CURRENT at all: it fails
  // structural validation outright (INPUT_INVALID, Codex never invoked).
  describe("producer-invariant contradictions (status vs. failureReason vs. reconstructionProof)", () => {
    it("rejects status: OK with a MISMATCH reconstructionProof, even with failureReason null", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          status: "OK",
          failureReason: null,
          reconstructionProof: { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: null },
        }),
      ).toBe(false);
    });

    it("rejects status: OK with a non-null failureReason, even with a MATCH reconstructionProof", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          status: "OK",
          failureReason: "some failure",
          reconstructionProof: { status: "MATCH", missingPaths: [], extraPaths: [], cleanupError: null },
        }),
      ).toBe(false);
    });

    it("rejects status: FAILED with a null failureReason", () => {
      const bad = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...bad,
          status: "FAILED",
          failureReason: null,
        }),
      ).toBe(false);
    });

    it("accepts a normal producer-generated OK + MATCH bundle", () => {
      const good = sampleReviewBundleResult();
      expect(good.status).toBe("OK");
      expect(good.failureReason).toBeNull();
      expect(good.reconstructionProof.status).toBe("MATCH");
      expect(isReviewBundleResult(good)).toBe(true);
    });

    it("accepts a normal producer-generated FAILED bundle with a non-null failureReason", () => {
      const failed = sampleReviewBundleResult();
      expect(
        isReviewBundleResult({
          ...failed,
          status: "FAILED",
          failureReason: "reconstruction proof: MISMATCH",
          reconstructionProof: { status: "MISMATCH", missingPaths: [], extraPaths: [], cleanupError: null },
        }),
      ).toBe(true);
    });

    // review-bundle remains an evidence collector: nested verify/scope-check
    // freshness/status of any shape must not be required by this validator —
    // only a CURRENT-claiming nested result's provenance is required to
    // agree with the enclosing git facts (see the dedicated describe block
    // above), which this CURRENT scopeCheck satisfies via
    // provenanceMatchingBundleGit.
    it("does not require nested verify/scope-check CURRENT/PASS for an OK + MATCH bundle", () => {
      const withStaleNested = sampleReviewBundleResult();
      withStaleNested.verify.focused = {
        freshness: "STALE",
        missingReason: null,
        result: sampleVerifyResult(sampleProvenance(), "focused"),
      };
      const { baselineSha, headSha, changeSetFingerprint } = withStaleNested.git;
      withStaleNested.scopeCheck = {
        freshness: "CURRENT",
        missingReason: null,
        result: {
          ...sampleScopeCheckResult({ value: null, source: "default" }),
          status: "FAIL",
          // A producer-valid FAIL always carries at least one failure reason.
          failureReasons: ["1 path(s) outside declared scope: x.txt"],
          provenance: buildProvenance(baselineSha, headSha, changeSetFingerprint, sampleResolvedConfig({ scope: { value: null, source: "default" } })),
        },
      };
      expect(isReviewBundleResult(withStaleNested)).toBe(true);
    });
  });
});

describe("codexArtifactFreshness", () => {
  function facts(provenance: ProvenanceBlock): { baselineSha: string; headSha: string; changeSetFingerprint: string } {
    return {
      baselineSha: provenance.baselineSha,
      headSha: provenance.headSha,
      changeSetFingerprint: provenance.changeSetFingerprint,
    };
  }

  it("CURRENT when all seven facts match, including both task-declaration hashes null", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "review-json-hash",
      "review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("CURRENT");
  });

  it("STALE when the provenance state facts differ", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      { ...facts(provenance), headSha: "different" },
      "review-json-hash",
      "review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("STALE");
  });

  it("STALE when reviewJsonHash differs", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "different-review-json-hash",
      "review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("STALE");
  });

  it("STALE when reviewDiffHash differs", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "review-json-hash",
      "different-review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("STALE");
  });

  // BLOCKER regression (HQ): changeSetFingerprint deliberately never hashes
  // file mode bits, and review.diff's own re-read bytes hash cannot catch
  // drift either when review.diff itself was never touched — only a
  // regenerated diff over the *current* change set proves the frozen
  // review.diff bytes still represent Git reality. This is the seventh fact.
  it("STALE when currentChangeSetDiffHash disagrees with the stored review.diff bytes hash, even with every other fact identical (mode-only drift)", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "review-json-hash",
      "review-diff-hash",
      null,
      "regenerated-diff-hash-reflecting-a-mode-change",
    );
    expect(result).toBe("STALE");
  });

  it("CURRENT when currentChangeSetDiffHash agrees with the stored review.diff bytes hash", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "review-json-hash",
      "review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("CURRENT");
  });

  // The specific HQ scenario: identical provenance/diff-relevant facts,
  // differing taskDeclarationHash — this must be caught, since a task
  // declaration can change (or vanish) without moving any of the other five
  // facts at all.
  it("STALE when taskDeclarationHash differs, with every other fact identical", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      "task-hash-a",
      facts(provenance),
      "review-json-hash",
      "review-diff-hash",
      "task-hash-b",
      "review-diff-hash",
    );
    expect(result).toBe("STALE");
  });

  it("STALE when one side has a task declaration hash and the other does not", () => {
    const provenance = sampleProvenance();
    expect(
      codexArtifactFreshness(
        provenance,
        "review-json-hash",
        "review-diff-hash",
        "task-hash-a",
        facts(provenance),
        "review-json-hash",
        "review-diff-hash",
        null,
        "review-diff-hash",
      ),
    ).toBe("STALE");
    expect(
      codexArtifactFreshness(
        provenance,
        "review-json-hash",
        "review-diff-hash",
        null,
        facts(provenance),
        "review-json-hash",
        "review-diff-hash",
        "task-hash-b",
        "review-diff-hash",
      ),
    ).toBe("STALE");
  });

  it("both sides null for taskDeclarationHash does not itself force STALE", () => {
    const provenance = sampleProvenance();
    const result = codexArtifactFreshness(
      provenance,
      "review-json-hash",
      "review-diff-hash",
      null,
      facts(provenance),
      "review-json-hash",
      "review-diff-hash",
      null,
      "review-diff-hash",
    );
    expect(result).toBe("CURRENT");
  });
});

describe("loadGateResult semantic freshness", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "provenance-semantic-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("downgrades an otherwise-CURRENT result to STALE when its command semantics no longer hold", () => {
    const stored = sampleScopeCheckResult({ value: ["apps/web/**"], source: "task-declaration" });
    const path = join(dir, "scope-check.json");
    writeFileSync(path, JSON.stringify(stored));
    const facts = currentFactsFor(stored.provenance);

    const unchanged = loadGateResult<ScopeCheckResult>(path, isScopeCheckResult, facts, (result) =>
      scopeSemanticsCurrent(result, { taskDeclarationSupplied: true, taskScope: ["apps/web/**"] }),
    );
    expect(unchanged.freshness).toBe("CURRENT");

    const scopeChanged = loadGateResult<ScopeCheckResult>(path, isScopeCheckResult, facts, (result) =>
      scopeSemanticsCurrent(result, { taskDeclarationSupplied: true, taskScope: ["docs/**"] }),
    );
    expect(scopeChanged.freshness).toBe("STALE");
    expect(scopeChanged.missingReason).toBeNull();
    // STALE still hands back the result it read — it is evidence about a
    // different configuration, not an unreadable artifact.
    expect(scopeChanged.result?.scopePatterns).toEqual(["apps/web/**"]);
  });
});
