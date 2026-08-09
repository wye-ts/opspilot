// Loads and strict-schema-validates a task declaration file. Flat, facts-only:
// unknown fields are rejected outright rather than silently ignored, so the
// harness never grows into a policy engine that interprets task-declaration
// content. Callers must only load this via an explicit --task <path> — never
// auto-discovered by well-known filename.

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

export function loadTaskDeclaration(path: string): TaskDeclaration {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new TaskDeclarationError(`task declaration not found or unreadable at ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new TaskDeclarationError(`task declaration at ${path} is not valid JSON: ${String(err)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TaskDeclarationError(`task declaration at ${path} must be a JSON object`);
  }

  const obj = parsed as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new TaskDeclarationError(`task declaration at ${path} has unknown field "${key}"`);
    }
  }

  if (obj.$schema !== REQUIRED_SCHEMA) {
    throw new TaskDeclarationError(`task declaration at ${path} must declare "$schema": "${REQUIRED_SCHEMA}"`);
  }

  if (obj.baseline !== undefined && typeof obj.baseline !== "string") {
    throw new TaskDeclarationError(`task declaration at ${path}: "baseline" must be a string`);
  }
  if (obj.expectedBranch !== undefined && typeof obj.expectedBranch !== "string") {
    throw new TaskDeclarationError(`task declaration at ${path}: "expectedBranch" must be a string`);
  }
  if (
    obj.expectedWorkingTree !== undefined &&
    obj.expectedWorkingTree !== "clean" &&
    obj.expectedWorkingTree !== "any"
  ) {
    throw new TaskDeclarationError(`task declaration at ${path}: "expectedWorkingTree" must be "clean" or "any"`);
  }
  if (obj.expectedIndex !== undefined && obj.expectedIndex !== "empty" && obj.expectedIndex !== "any") {
    throw new TaskDeclarationError(`task declaration at ${path}: "expectedIndex" must be "empty" or "any"`);
  }
  if (
    obj.scope !== undefined &&
    obj.scope !== null &&
    (!Array.isArray(obj.scope) || !obj.scope.every((item) => typeof item === "string"))
  ) {
    throw new TaskDeclarationError(`task declaration at ${path}: "scope" must be an array of strings or null`);
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
