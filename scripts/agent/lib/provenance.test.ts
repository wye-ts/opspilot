import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildProvenance,
  compareProvenance,
  FINAL_NOT_RUN,
  FINAL_STEP_COMMANDS,
  isFinalVerifyResult,
  isFocusedVerifyResult,
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
