// Builds the Codex review prompt and invokes `codex exec` against exactly the
// evidence agent:review-bundle already produced. Plain `codex exec`, never
// `codex exec review` — the `review` subcommand computes its own git diff,
// which would let Codex review a different scope than the harness-verified
// review bundle. `--sandbox read-only` is the primary write-prevention
// mechanism; `--ignore-user-config`/`--ignore-rules` keep the reviewer from
// silently inheriting whatever the invoking machine's own Codex config
// happens to contain. Reviewer model/effort are frozen constants, never a CLI
// flag. `--output-last-message <file>` is the only channel this module reads
// from — never stdout scraping — and is invocation-scoped: a stale file left
// over at that exact path from a previous run is treated as a hard failure
// rather than silently overwritten or, worse, misread as this run's output.
//
// Codex never reads the mutable original review.json/review.diff/task-
// declaration paths. The caller hands over the exact bytes it already hashed
// for freshness purposes, and this module writes them, unmodified, into
// invocation-scoped snapshot files under the same temp directory as
// --output-last-message, then points the prompt at those snapshots. This
// closes the ABA window a mutable path leaves open: an evidence file swapped
// out after the pre-invocation hash check and restored before the post-
// invocation re-check would otherwise let Codex read substituted content
// while every hash comparison still lines up. Because the snapshot is written
// straight from already-in-memory bytes (never re-read from the original
// path), there is no new TOCTOU window between "bytes hashed" and "bytes
// frozen" for this module to introduce.
//
// This module never itself persists anything outside its own invocation-
// scoped temp directory (which it always cleans up): the raw invocation log
// is handed back as data, not written to disk here. Persisting it — after a
// destination-safety revalidation immediately before the write — is
// codex-review.ts's job, so all persistent-write authorization for this
// command lives in one Harness layer.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROMPT_TEMPLATE_PATH = join(__dirname, "codex", "review-prompt.md");
const OUTPUT_SCHEMA_PATH = join(__dirname, "codex", "review-payload.schema.json");

// Frozen reviewer configuration (see the plan's "Codex invocation boundary").
// Constants, not CLI flags, in v1.
const CODEX_MODEL = "gpt-5.6-sol";
const CODEX_REASONING_EFFORT = "high";

// Real codex output is never scraped from stdout, but a verbose review can
// still emit a lot of incidental tool-call chatter to stdout/stderr before
// exiting 0. Node's spawnSync default maxBuffer (1 MiB) would abort an
// otherwise-successful run with ENOBUFS; this is a generous explicit bound,
// not a redesign to streaming.
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export type CodexInvocationFailureCategory = "CODEX_EXECUTION_FAILED";

export interface RunCodexReviewOptions {
  /** Repo root, passed to `codex exec -C`. */
  cwd: string;
  /** Exact bytes already hashed by the caller for freshness purposes — snapshotted verbatim, never re-read from disk. */
  reviewJsonRaw: Buffer;
  reviewDiffRaw: Buffer;
  /** Included in the prompt (as a snapshot) only when an explicit --task was given. */
  taskDeclarationRaw: Buffer | null;
  timeoutMs: number;
  /** Test-only seam: substitutes the `codex` binary name. Production callers never pass this. */
  codexBin?: string;
  /**
   * Test-only seam: use this exact directory as the invocation-scoped temp
   * output location instead of a freshly `mkdtemp`'d one, so a test can
   * pre-seed a stale file at the forced `--output-last-message` path without
   * needing to predict a random directory name. Production callers never
   * pass this.
   */
  tempDirOverride?: string;
}

export interface CodexInvocationOutcome {
  /** True iff a `codex exec` child process was actually started (a real OS process exists), regardless of what happened next. False for a spawn failure where no child was ever started (e.g. ENOENT/EACCES) — distinguished from a post-launch timeout/signal, which keeps this true. */
  invoked: boolean;
  status: "OK" | "FAILED";
  failureCategory: CodexInvocationFailureCategory | null;
  failureReason: string | null;
  exitCode: number | null;
  durationMs: number | null;
  /**
   * Raw invocation log text (command, exit code, signal, stdout/stderr) —
   * null only when codex was never actually spawned (nothing to log).
   * Persisting this to disk is codex-review.ts's responsibility, done only
   * after its own destination-safety revalidation immediately precedes the
   * write, not this module's.
   */
  rawLog: string | null;
  /** Raw, unvalidated contents of `--output-last-message`. Validation is codex-review.ts's job, not this module's. */
  outputLastMessageText: string | null;
}

function buildPrompt(reviewJsonPath: string, reviewDiffPath: string, taskDeclarationPath: string | null): string {
  const template = readFileSync(PROMPT_TEMPLATE_PATH, "utf8");
  const taskLine =
    taskDeclarationPath !== null
      ? `- The task declaration governing this session's scope: \`${taskDeclarationPath}\``
      : "";
  return template
    .replaceAll("{{REVIEW_JSON_PATH}}", reviewJsonPath)
    .replaceAll("{{REVIEW_DIFF_PATH}}", reviewDiffPath)
    .replaceAll("{{TASK_DECLARATION_LINE}}", taskLine);
}

function failed(
  failureReason: string,
  extra: Partial<Pick<CodexInvocationOutcome, "invoked" | "exitCode" | "durationMs" | "rawLog">> = {},
): CodexInvocationOutcome {
  return {
    invoked: false,
    status: "FAILED",
    failureCategory: "CODEX_EXECUTION_FAILED",
    failureReason,
    exitCode: null,
    durationMs: null,
    rawLog: null,
    outputLastMessageText: null,
    ...extra,
  };
}

/**
 * Builds the prompt, spawns `codex exec` with a timeout, and returns a
 * structured outcome including the raw log as data. Never throws for an
 * expected failure mode (spawn error, signal, timeout, nonzero exit,
 * pre-existing temp path) — those are all reported via the returned outcome
 * so `codex-review.ts` can write its artifacts either way.
 */
export function runCodexReview(options: RunCodexReviewOptions): CodexInvocationOutcome {
  const codexBin = options.codexBin ?? "codex";

  const tempDir = options.tempDirOverride ?? mkdtempSync(join(tmpdir(), "harness-codex-review-"));
  const outputLastMessagePath = join(tempDir, "output-last-message.json");
  const snapshotReviewJsonPath = join(tempDir, "review.json");
  const snapshotReviewDiffPath = join(tempDir, "review.diff");
  const snapshotTaskDeclarationPath = options.taskDeclarationRaw !== null ? join(tempDir, "task-declaration.json") : null;

  try {
    if (existsSync(outputLastMessagePath)) {
      return failed(`invocation-scoped output path already exists (stale file): ${outputLastMessagePath}`);
    }

    try {
      writeFileSync(snapshotReviewJsonPath, options.reviewJsonRaw);
      writeFileSync(snapshotReviewDiffPath, options.reviewDiffRaw);
      if (snapshotTaskDeclarationPath !== null && options.taskDeclarationRaw !== null) {
        writeFileSync(snapshotTaskDeclarationPath, options.taskDeclarationRaw);
      }
    } catch (err) {
      return failed(`failed to write invocation-scoped evidence snapshot: ${String(err)}`);
    }

    const prompt = buildPrompt(snapshotReviewJsonPath, snapshotReviewDiffPath, snapshotTaskDeclarationPath);

    const args = [
      "exec",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "-c",
      `model="${CODEX_MODEL}"`,
      "-c",
      `model_reasoning_effort="${CODEX_REASONING_EFFORT}"`,
      "-C",
      options.cwd,
      "--output-schema",
      OUTPUT_SCHEMA_PATH,
      "--output-last-message",
      outputLastMessagePath,
      "-",
    ];

    const start = Date.now();
    const result = spawnSync(codexBin, args, {
      input: prompt,
      encoding: "utf8",
      timeout: options.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER_BYTES,
    });
    const durationMs = Date.now() - start;

    // A real child process exists iff spawnSync actually got a pid. A spawn
    // failure that never started a process at all (ENOENT/EACCES) reports
    // `pid: 0` (or undefined), never a real positive pid — distinguishing it
    // from a child that started and was later killed by a timeout/signal,
    // which always has a real pid even though `status` also ends up null.
    const invoked = typeof result.pid === "number" && result.pid > 0;

    if (!invoked) {
      return failed(`codex exec failed to execute: ${result.error?.message ?? "unknown spawn error"}`, {
        invoked: false,
        durationMs,
      });
    }

    const rawLog = [
      `command: ${codexBin} ${args.join(" ")}`,
      `exitCode: ${result.status ?? "null"}`,
      `signal: ${result.signal ?? "null"}`,
      `spawnError: ${result.error ? result.error.message : "null"}`,
      `durationMs: ${durationMs}`,
      "--- stdout ---",
      result.stdout ?? "",
      "--- stderr ---",
      result.stderr ?? "",
    ].join("\n");

    if (result.error) {
      return failed(`codex exec failed to execute: ${result.error.message}`, {
        invoked: true,
        durationMs,
        rawLog,
      });
    }
    if (result.status === null) {
      const signalNote = result.signal ? ` (terminated by signal ${result.signal})` : " (terminated abnormally)";
      return failed(`codex exec produced no exit code${signalNote} — possible timeout`, {
        invoked: true,
        durationMs,
        rawLog,
      });
    }
    if (result.status !== 0) {
      return failed(`codex exec exited ${result.status}`, {
        invoked: true,
        exitCode: result.status,
        durationMs,
        rawLog,
      });
    }

    let outputLastMessageText: string;
    try {
      outputLastMessageText = readFileSync(outputLastMessagePath, "utf8");
    } catch (err) {
      return failed(`codex exec exited 0 but did not produce --output-last-message: ${String(err)}`, {
        invoked: true,
        exitCode: result.status,
        durationMs,
        rawLog,
      });
    }

    return {
      invoked: true,
      status: "OK",
      failureCategory: null,
      failureReason: null,
      exitCode: result.status,
      durationMs,
      rawLog,
      outputLastMessageText,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
