import { promises as fs } from "node:fs";
import path from "node:path";

import { validateStoredRunbookChunks } from "./runbook-corpus-validation";
import type { StoredRunbookChunk } from "@opspilot/agent-runtime";

export interface RunbookCorpusLoadResult {
  readonly chunks: readonly StoredRunbookChunk[];
  readonly sourceFileCount: number;
}

export interface RunbookCorpusLoader {
  load(): Promise<RunbookCorpusLoadResult>;
}

export type RunbookLoadErrorCategory =
  | "DIRECTORY_NOT_FOUND"
  | "DIRECTORY_READ_FAILED"
  | "FILE_READ_FAILED"
  | "FORMAT_INVALID"
  | "DUPLICATE_CHUNK_ID"
  | "UNKNOWN";

// Mirrors RetrieverError's sanitization convention, one step stricter: every
// message below is a fixed, application-authored string with NO
// interpolation of anything derived from disk — not a filename, not a
// metadata key/value, not a heading title, not a chunkId, not another
// validator's error string, and never a raw filesystem error's own
// message/stack. Runbook Markdown content and filenames are untrusted input
// (the same way runbook body text is treated as untrusted evidence data
// downstream); the simplest safe rule is that none of it ever reaches a
// message that could surface to a user or log.
export class RunbookLoadError extends Error {
  constructor(
    readonly category: RunbookLoadErrorCategory,
    message: string,
  ) {
    super(message);
    this.name = "RunbookLoadError";
  }
}

export interface MarkdownRunbookCorpusLoaderOptions {
  readonly runbooksDir: string;
}

// Shared by chunkId, runbookId, and serviceSlug: lowercase, hyphen-separated
// slugs, matching the seven existing corpus chunk IDs' shape.
const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const CATEGORY_PATTERN = /^[A-Z]+(_[A-Z]+)*$/;

const ALLOWED_METADATA_KEYS = new Set(["runbookId", "serviceSlug", "category"]);

const H1_PATTERN = /^# (.+)$/;
const H2_PATTERN = /^## (.+)$/;
const CHUNK_ID_COMMENT_PATTERN = /^<!-- chunkId: ([a-z0-9]+(?:-[a-z0-9]+)*) -->$/;

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

interface ParsedMetadata {
  readonly runbookId: string;
  readonly serviceSlug?: string;
  readonly category?: string;
}

interface FrontMatterResult {
  readonly metadata: ParsedMetadata;
  readonly bodyStartIndex: number;
}

function parseFrontMatter(lines: readonly string[]): FrontMatterResult {
  if (lines[0] !== "---") {
    throw new RunbookLoadError(
      "FORMAT_INVALID",
      'A runbook file must begin with a metadata block ("---") at the start of the document.',
    );
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    throw new RunbookLoadError(
      "FORMAT_INVALID",
      'A runbook file is missing the closing "---" of its metadata block.',
    );
  }

  const seenKeys = new Set<string>();
  let runbookId: string | undefined;
  let serviceSlug: string | undefined;
  let category: string | undefined;

  for (let i = 1; i < closingIndex; i++) {
    const line = lines[i]!;
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      throw new RunbookLoadError("FORMAT_INVALID", "A runbook metadata line is missing a colon.");
    }

    const key = line.slice(0, colonIndex).trim();
    const value = line.slice(colonIndex + 1).trim();

    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new RunbookLoadError("FORMAT_INVALID", "Runbook metadata contains an unknown key.");
    }
    if (seenKeys.has(key)) {
      throw new RunbookLoadError("FORMAT_INVALID", "Runbook metadata contains a duplicate key.");
    }
    seenKeys.add(key);

    if (value.length === 0) {
      throw new RunbookLoadError(
        "FORMAT_INVALID",
        "Runbook metadata contains an empty value for a metadata key.",
      );
    }

    const pattern = key === "category" ? CATEGORY_PATTERN : SLUG_PATTERN;
    if (!pattern.test(value)) {
      throw new RunbookLoadError(
        "FORMAT_INVALID",
        "Runbook metadata contains an invalid value for a metadata key.",
      );
    }

    if (key === "runbookId") runbookId = value;
    else if (key === "serviceSlug") serviceSlug = value;
    else if (key === "category") category = value;
  }

  if (runbookId === undefined) {
    throw new RunbookLoadError(
      "FORMAT_INVALID",
      'Runbook metadata is missing the required "runbookId" key.',
    );
  }

  return {
    metadata: {
      runbookId,
      ...(serviceSlug !== undefined ? { serviceSlug } : {}),
      ...(category !== undefined ? { category } : {}),
    },
    bodyStartIndex: closingIndex + 1,
  };
}

interface FenceState {
  readonly char: string;
  readonly length: number;
}

function parseFenceMarker(line: string): FenceState | null {
  const trimmed = line.trim();
  const match = /^(`{3,}|~{3,})/.exec(trimmed);
  if (!match) {
    return null;
  }
  const marker = match[1]!;
  return { char: marker.charAt(0), length: marker.length };
}

function isFenceClose(line: string, fence: FenceState): boolean {
  const trimmed = line.trim();
  if (trimmed.length < fence.length) {
    return false;
  }
  for (const character of trimmed) {
    if (character !== fence.char) {
      return false;
    }
  }
  return true;
}

function parseRunbookFile(raw: string): StoredRunbookChunk[] {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lines = withoutBom.split(/\r\n|\r|\n/);

  const { metadata, bodyStartIndex } = parseFrontMatter(lines);

  let index = bodyStartIndex;
  let h1Seen = false;

  // PREAMBLE: only blank lines and at most one H1 are permitted before the
  // first chunk heading — anything else is rejected rather than dropped.
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim().length === 0) {
      index++;
      continue;
    }
    if (H1_PATTERN.test(line)) {
      if (h1Seen) {
        throw new RunbookLoadError(
          "FORMAT_INVALID",
          "A runbook file has more than one document title (H1).",
        );
      }
      h1Seen = true;
      index++;
      continue;
    }
    if (H2_PATTERN.test(line)) {
      break;
    }
    throw new RunbookLoadError(
      "FORMAT_INVALID",
      "A runbook file has unexpected content before its first chunk heading.",
    );
  }

  const chunks: StoredRunbookChunk[] = [];

  while (index < lines.length) {
    const headingMatch = H2_PATTERN.exec(lines[index]!);
    if (!headingMatch) {
      // Unreachable in practice: the loop only re-enters here when the inner
      // content scan below stopped exactly because it saw an H2 line, or on
      // the first iteration where the PREAMBLE loop already confirmed one.
      throw new RunbookLoadError("UNKNOWN", "A runbook file could not be parsed.");
    }
    const title = headingMatch[1]!.trim();
    index++;

    // The chunkId comment must be the next non-empty line, not necessarily
    // the immediately following physical line.
    while (index < lines.length && lines[index]!.trim().length === 0) {
      index++;
    }
    const chunkIdMatch = index < lines.length ? CHUNK_ID_COMMENT_PATTERN.exec(lines[index]!.trim()) : null;
    if (!chunkIdMatch) {
      throw new RunbookLoadError(
        "FORMAT_INVALID",
        "A runbook chunk heading is missing its chunkId comment.",
      );
    }
    const chunkId = chunkIdMatch[1]!;
    index++;

    const contentLines: string[] = [];
    let fence: FenceState | null = null;

    while (index < lines.length) {
      const line = lines[index]!;

      if (fence !== null) {
        contentLines.push(line);
        if (isFenceClose(line, fence)) {
          fence = null;
        }
        index++;
        continue;
      }

      const openedFence = parseFenceMarker(line);
      if (openedFence !== null) {
        fence = openedFence;
        contentLines.push(line);
        index++;
        continue;
      }

      if (H2_PATTERN.test(line)) {
        break; // next chunk heading — leave it for the outer loop
      }

      contentLines.push(line);
      index++;
    }

    if (fence !== null) {
      throw new RunbookLoadError("FORMAT_INVALID", "A runbook chunk contains an unclosed code fence.");
    }

    const content = contentLines.join("\n").trim();
    if (content.length === 0) {
      throw new RunbookLoadError("FORMAT_INVALID", "A runbook chunk has empty content.");
    }

    chunks.push({
      chunkId,
      runbookId: metadata.runbookId,
      title,
      content,
      ...(metadata.serviceSlug !== undefined ? { serviceSlug: metadata.serviceSlug } : {}),
      ...(metadata.category !== undefined ? { category: metadata.category } : {}),
    });
  }

  if (chunks.length === 0) {
    throw new RunbookLoadError("FORMAT_INVALID", "A runbook file produced no chunks.");
  }

  return chunks;
}

export class MarkdownRunbookCorpusLoader implements RunbookCorpusLoader {
  constructor(private readonly options: MarkdownRunbookCorpusLoaderOptions) {}

  async load(): Promise<RunbookCorpusLoadResult> {
    const { runbooksDir } = this.options;

    let rootStat;
    try {
      rootStat = await fs.lstat(runbooksDir);
    } catch (error) {
      if (isEnoent(error)) {
        throw new RunbookLoadError("DIRECTORY_NOT_FOUND", "Runbooks directory not found.");
      }
      throw new RunbookLoadError("DIRECTORY_READ_FAILED", "Could not inspect the runbooks directory.");
    }
    if (rootStat.isSymbolicLink()) {
      throw new RunbookLoadError("FORMAT_INVALID", "The runbooks directory must not be a symlink.");
    }
    if (!rootStat.isDirectory()) {
      throw new RunbookLoadError("FORMAT_INVALID", "The configured runbooks path is not a directory.");
    }

    let entries;
    try {
      entries = await fs.readdir(runbooksDir, { withFileTypes: true });
    } catch (error) {
      if (error instanceof RunbookLoadError) throw error;
      throw new RunbookLoadError("DIRECTORY_READ_FAILED", "Could not list the runbooks directory.");
    }

    let realRunbooksDir: string;
    try {
      realRunbooksDir = await fs.realpath(runbooksDir);
    } catch (error) {
      if (error instanceof RunbookLoadError) throw error;
      throw new RunbookLoadError("DIRECTORY_READ_FAILED", "Could not resolve the runbooks directory.");
    }

    const acceptedFileNames: string[] = [];
    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) {
        throw new RunbookLoadError(
          "FORMAT_INVALID",
          "A runbook directory entry is a symlink, which is not permitted.",
        );
      }
      if (dirent.isDirectory()) {
        throw new RunbookLoadError(
          "FORMAT_INVALID",
          "A runbook directory entry is a nested directory, which is not permitted.",
        );
      }
      if (!dirent.isFile() || !dirent.name.endsWith(".md")) {
        continue; // e.g. .DS_Store, or another exotic entry type
      }
      acceptedFileNames.push(dirent.name);
    }

    if (acceptedFileNames.length === 0) {
      throw new RunbookLoadError("FORMAT_INVALID", "No Markdown runbook files were found.");
    }

    // Locale-independent, filesystem-enumeration-independent ordering.
    acceptedFileNames.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

    const allChunks: StoredRunbookChunk[] = [];
    const seenChunkIds = new Set<string>();

    for (const fileName of acceptedFileNames) {
      const originalPath = path.join(runbooksDir, fileName);

      let realFilePath: string;
      try {
        realFilePath = await fs.realpath(originalPath);
      } catch (error) {
        if (error instanceof RunbookLoadError) throw error;
        throw new RunbookLoadError("FILE_READ_FAILED", "Could not resolve a runbook file.");
      }

      const relative = path.relative(realRunbooksDir, realFilePath);
      if (relative.startsWith("..") || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new RunbookLoadError(
          "FORMAT_INVALID",
          "A runbook file resolves outside the runbooks directory.",
        );
      }

      let raw: string;
      try {
        // Read via the verified realFilePath, not a re-joined path, so what
        // was boundary-checked is exactly what gets read.
        raw = await fs.readFile(realFilePath, "utf-8");
      } catch (error) {
        if (error instanceof RunbookLoadError) throw error;
        throw new RunbookLoadError("FILE_READ_FAILED", "Could not read a runbook file.");
      }

      const fileChunks = parseRunbookFile(raw);

      for (const chunk of fileChunks) {
        if (seenChunkIds.has(chunk.chunkId)) {
          throw new RunbookLoadError("DUPLICATE_CHUNK_ID", "The runbook corpus contains a duplicate chunkId.");
        }
        seenChunkIds.add(chunk.chunkId);
        allChunks.push(chunk);
      }
    }

    const validationError = validateStoredRunbookChunks(allChunks);
    if (validationError !== null) {
      throw new RunbookLoadError("FORMAT_INVALID", "Loaded runbook chunks failed runtime validation.");
    }

    return { chunks: allChunks, sourceFileCount: acceptedFileNames.length };
  }
}
