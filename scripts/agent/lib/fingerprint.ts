// Content-based fingerprint of the complete change set: catches an edit to an
// already-changed file, not just an added/removed path.
//
// Framing: NUL-delimited fields, one trailing NUL per field, with a leading
// version tag. A field separator must be a byte that cannot occur inside any
// field, and NUL is the only such byte — Git explicitly permits tabs and
// newlines in a path, so the earlier `<status>\t<path>\t<hash>\n` framing was
// ambiguous (two different change sets could frame to identical bytes).
//
// Object types are read with lstat and never followed: a symlink is fingerprinted
// as the Git-tracked link representation (a hash of its target string), not as
// whatever it happens to point at. Anything that is neither a regular file nor a
// symlink nor absent fails closed rather than being hashed as something it is not.
//
// Known v1 cut: file mode bits (a chmod-only change) are still not hashed.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, type Stats } from "node:fs";
import { join } from "node:path";

import type { ChangeEntry } from "./types";

/** Bumped whenever the framing or the hashed facts change, so artifacts written by an older harness can never be mistaken for current ones. */
const FINGERPRINT_VERSION = "opspilot-harness/change-set-fingerprint@2";

/** Raised when a change-set entry is a filesystem object v1 cannot faithfully represent (directory, socket, FIFO, device, submodule gitlink). */
export class UnsupportedChangeEntryError extends Error {
  constructor(path: string, kind: string) {
    super(`cannot fingerprint "${path}": unsupported filesystem object type (${kind})`);
    this.name = "UnsupportedChangeEntryError";
  }
}

export type EntryKind = "file" | "symlink" | "deleted";

export interface EntryContent {
  kind: EntryKind;
  /** sha256 of the regular-file bytes or of the symlink's raw target bytes; null when deleted. */
  contentHash: string | null;
}

/**
 * Classifies one change-set path on disk without ever following a symlink.
 * A missing path is `deleted` (a deletion is a legitimate change-set outcome);
 * a broken symlink is still a `symlink` — which is exactly why `existsSync`
 * (which follows the link and reports a broken one as absent) cannot be used here.
 */
export function readEntryContent(cwd: string, relPath: string): EntryContent {
  const fullPath = join(cwd, relPath);

  let stats: Stats;
  try {
    stats = lstatSync(fullPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "ENOTDIR") {
      return { kind: "deleted", contentHash: null };
    }
    throw err;
  }

  if (stats.isSymbolicLink()) {
    // The link target string is what Git stores as the blob for mode 120000.
    return { kind: "symlink", contentHash: sha256Buffer(readlinkSync(fullPath, { encoding: "buffer" })) };
  }
  if (stats.isFile()) {
    return { kind: "file", contentHash: sha256Buffer(readFileSync(fullPath)) };
  }

  throw new UnsupportedChangeEntryError(relPath, describeStatKind(stats));
}

function describeStatKind(stats: Stats): string {
  if (stats.isDirectory()) return "directory";
  if (stats.isFIFO()) return "fifo";
  if (stats.isSocket()) return "socket";
  if (stats.isBlockDevice()) return "block device";
  if (stats.isCharacterDevice()) return "character device";
  return "unknown";
}

export function computeChangeSetFingerprint(cwd: string, changeSet: readonly ChangeEntry[]): string {
  const sorted = [...changeSet].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash("sha256");
  hash.update(nulField(FINGERPRINT_VERSION));
  for (const entry of sorted) {
    const content = readEntryContent(cwd, entry.path);
    hash.update(nulField(entry.status));
    hash.update(nulField(entry.path));
    hash.update(nulField(content.kind));
    hash.update(nulField(content.contentHash ?? ""));
  }
  return hash.digest("hex");
}

/** One NUL-terminated field. Safe because no field's value can itself contain a NUL byte: Git forbids NUL in a path, and every other field is a fixed token or hex digest. */
function nulField(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, "utf8"), Buffer.from([0])]);
}

function sha256Buffer(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
