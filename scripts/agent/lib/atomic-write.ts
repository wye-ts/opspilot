// One shared atomic-write helper used for every artifact the Harness writes:
// all .agent/*.json, review.diff, review.md, and log files. Writes to a
// same-directory temp file (never OS tmp, so the final rename stays on one
// filesystem), fsyncs, then renames — atomic on POSIX. Guarantees a
// crashed/interrupted run never leaves a half-written file that a later
// review-bundle run could misread as valid.

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";

export function writeFileAtomic(targetPath: string, data: string): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

  let fd: number;
  try {
    fd = openSync(tmpPath, "w");
  } catch (err) {
    throw new Error(`atomic write: failed to open temp file for ${targetPath}: ${String(err)}`);
  }

  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } catch (err) {
    closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
  closeSync(fd);

  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup only
    }
    throw err;
  }
}

export function writeJsonAtomic(targetPath: string, data: unknown): void {
  writeFileAtomic(targetPath, `${JSON.stringify(data, null, 2)}\n`);
}
