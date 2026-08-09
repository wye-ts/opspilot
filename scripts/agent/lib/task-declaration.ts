// Loads and strict-schema-validates a task declaration file. Flat, facts-only:
// unknown fields are rejected outright rather than silently ignored, so the
// harness never grows into a policy engine that interprets task-declaration
// content. Callers must only load this via an explicit --task <path> — never
// auto-discovered by well-known filename.
//
// Parsing is split from disk I/O (parseTaskDeclaration vs. loadTaskDeclaration)
// so that a caller who has already captured a task file's raw bytes off disk
// for another purpose (e.g. hashing) can parse those exact captured bytes
// directly, rather than reading the file a second time. A second read is not
// merely wasteful: between the first read (used for the hash) and a second
// read (used for parsing), the file on disk could change, so the hash and the
// parsed semantics would no longer be guaranteed to describe the same bytes.
// loadTaskDeclaration remains a read-once convenience wrapper for callers that
// have no independent reason to capture the bytes themselves.

import { readFileSync } from "node:fs";

import type { TaskDeclaration } from "./types";

export class TaskDeclarationError extends Error {}

const REQUIRED_SCHEMA = "opspilot-harness/task-declaration@1";

const ALLOWED_KEYS = new Set<string>([
  "$schema",
  "baseline",
  "expectedBranch",
  "expectedWorkingTree",
  "expectedIndex",
  "scope",
]);

/**
 * Parses and strict-schema-validates already-captured task declaration bytes.
 * Performs no filesystem access of its own — `sourcePath` is used only to
 * label error messages (and defaults to a generic placeholder when omitted),
 * never to (re-)read the file. Callers that already hold the exact bytes a
 * hash was computed over (e.g. review-bundle.ts, codex-review.ts) must parse
 * those same bytes here rather than re-reading the source path, so the hash
 * and the parsed semantics are guaranteed to describe identical content.
 */
export function parseTaskDeclaration(raw: Buffer | string, sourcePath?: string): TaskDeclaration {
  const label = sourcePath ?? "<captured task declaration bytes>";
  const text = typeof raw === "string" ? raw : raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TaskDeclarationError(`task declaration at ${label} is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TaskDeclarationError(`task declaration at ${label} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TaskDeclarationError(`task declaration at ${label} has unknown field "${key}"`);
    }
  }

  if (obj.$schema !== REQUIRED_SCHEMA) {
    throw new TaskDeclarationError(`task declaration at ${label} must declare "$schema": "${REQUIRED_SCHEMA}"`);
  }

  if (obj.baseline !== undefined && typeof obj.baseline !== "string") {
    throw new TaskDeclarationError(`task declaration at ${label}: "baseline" must be a string`);
  }
  if (obj.expectedBranch !== undefined && typeof obj.expectedBranch !== "string") {
    throw new TaskDeclarationError(`task declaration at ${label}: "expectedBranch" must be a string`);
  }
  if (
    obj.expectedWorkingTree !== undefined &&
    obj.expectedWorkingTree !== "clean" &&
    obj.expectedWorkingTree !== "any"
  ) {
    throw new TaskDeclarationError(`task declaration at ${label}: "expectedWorkingTree" must be "clean" or "any"`);
  }
  if (obj.expectedIndex !== undefined && obj.expectedIndex !== "empty" && obj.expectedIndex !== "any") {
    throw new TaskDeclarationError(`task declaration at ${label}: "expectedIndex" must be "empty" or "any"`);
  }
  if (
    obj.scope !== undefined &&
    obj.scope !== null &&
    (!Array.isArray(obj.scope) || !obj.scope.every((item) => typeof item === "string"))
  ) {
    throw new TaskDeclarationError(`task declaration at ${label}: "scope" must be an array of strings or null`);
  }

  const declaration: TaskDeclaration = { $schema: REQUIRED_SCHEMA };
  if (obj.baseline !== undefined) declaration.baseline = obj.baseline as string;
  if (obj.expectedBranch !== undefined) declaration.expectedBranch = obj.expectedBranch as string;
  if (obj.expectedWorkingTree !== undefined) {
    declaration.expectedWorkingTree = obj.expectedWorkingTree as "clean" | "any";
  }
  if (obj.expectedIndex !== undefined) declaration.expectedIndex = obj.expectedIndex as "empty" | "any";
  if (obj.scope !== undefined) declaration.scope = obj.scope as string[] | null;

  return declaration;
}

/**
 * Convenience wrapper for callers with no independent reason to capture the
 * raw bytes themselves: reads the file exactly once and parses that same
 * read's bytes. Callers that also need the raw bytes for another purpose
 * (hashing) should call `parseTaskDeclaration` directly on their own capture
 * instead of this wrapper, to guarantee a single read.
 */
export function loadTaskDeclaration(path: string): TaskDeclaration {
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    throw new TaskDeclarationError(`task declaration not found or unreadable at ${path}: ${String(err)}`);
  }
  return parseTaskDeclaration(raw, path);
}
