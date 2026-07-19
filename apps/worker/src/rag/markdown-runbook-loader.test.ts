import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownRunbookCorpusLoader, RunbookLoadError } from "./markdown-runbook-loader";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "runbook-loader-test-"));
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

interface FixtureChunk {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

function runbookContent(opts: {
  readonly runbookId: string;
  readonly serviceSlug?: string;
  readonly category?: string;
  readonly chunks: readonly FixtureChunk[];
  readonly h1?: string;
}): string {
  const frontMatterLines = [`runbookId: ${opts.runbookId}`];
  if (opts.serviceSlug !== undefined) frontMatterLines.push(`serviceSlug: ${opts.serviceSlug}`);
  if (opts.category !== undefined) frontMatterLines.push(`category: ${opts.category}`);
  const h1 = opts.h1 !== undefined ? `# ${opts.h1}\n\n` : "";
  const chunksMd = opts.chunks
    .map((c) => `## ${c.title}\n\n<!-- chunkId: ${c.id} -->\n\n${c.content}\n`)
    .join("\n");
  return `---\n${frontMatterLines.join("\n")}\n---\n\n${h1}${chunksMd}`;
}

async function load(runbooksDir: string) {
  return new MarkdownRunbookCorpusLoader({ runbooksDir }).load();
}

async function expectLoadError(
  runbooksDir: string,
  category: string,
): Promise<RunbookLoadError> {
  let thrown: unknown;
  try {
    await load(runbooksDir);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(RunbookLoadError);
  const error = thrown as RunbookLoadError;
  expect(error.category).toBe(category);
  return error;
}

describe("MarkdownRunbookCorpusLoader", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempDirs.splice(0).map((dir) => cleanup(dir)));
  });

  async function tempDir(): Promise<string> {
    const dir = await makeTempDir();
    tempDirs.push(dir);
    return dir;
  }

  // --- Happy path / determinism / ordering -------------------------------

  it("loads all files and chunks, sorted by filename, document order within a file", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "b-second.md"),
      runbookContent({ runbookId: "b-runbook", chunks: [{ id: "chunk-b-001", title: "B", content: "Body B." }] }),
    );
    await fs.writeFile(
      path.join(dir, "a-first.md"),
      runbookContent({
        runbookId: "a-runbook",
        chunks: [
          { id: "chunk-a-001", title: "A1", content: "Body A1." },
          { id: "chunk-a-002", title: "A2", content: "Body A2." },
        ],
      }),
    );

    const result = await load(dir);

    expect(result.sourceFileCount).toBe(2);
    expect(result.chunks.map((c) => c.chunkId)).toEqual(["chunk-a-001", "chunk-a-002", "chunk-b-001"]);
    expect(result.chunks[0]).toMatchObject({ runbookId: "a-runbook", title: "A1", content: "Body A1." });
  });

  it("produces a deep-equal result on a second load", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "only.md"),
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );

    const first = await load(dir);
    const second = await load(dir);

    expect(second).toEqual(first);
  });

  it("orders the corpus by filename regardless of file creation order", async () => {
    const dir = await tempDir();
    // Created in reverse-of-alphabetical order.
    await fs.writeFile(
      path.join(dir, "z-runbook.md"),
      runbookContent({ runbookId: "z-runbook", chunks: [{ id: "chunk-z-001", title: "Z", content: "Body Z." }] }),
    );
    await fs.writeFile(
      path.join(dir, "a-runbook.md"),
      runbookContent({ runbookId: "a-runbook", chunks: [{ id: "chunk-a-001", title: "A", content: "Body A." }] }),
    );

    const result = await load(dir);

    expect(result.chunks.map((c) => c.chunkId)).toEqual(["chunk-a-001", "chunk-z-001"]);
  });

  // --- Front matter grammar -----------------------------------------------

  it("rejects a file missing required runbookId", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nserviceSlug: svc\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects an unknown metadata key", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nrunbookId: r\nbogus: x\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a duplicate metadata key", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\nrunbookId: r2\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a blank optional metadata value", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\nserviceSlug: \n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects front matter not starting at line 1", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "\n---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a metadata value that fails its field pattern", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: Not_A_Valid_Slug!\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a metadata line with no colon", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\njustsometext\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a metadata block missing its closing delimiter", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nrunbookId: r\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  // --- Encoding ------------------------------------------------------------

  it("strips a UTF-8 BOM and still loads", async () => {
    const dir = await tempDir();
    const content = runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] });
    await fs.writeFile(path.join(dir, "bom.md"), "﻿" + content);

    const result = await load(dir);
    expect(result.chunks).toHaveLength(1);
  });

  it("loads a CRLF-only file identically to an LF file", async () => {
    const dir = await tempDir();
    const content = runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] });
    await fs.writeFile(path.join(dir, "crlf.md"), content.replace(/\n/g, "\r\n"));

    const result = await load(dir);
    expect(result.chunks).toEqual([{ chunkId: "chunk-001", runbookId: "r", title: "T", content: "C." }]);
  });

  // --- Preamble --------------------------------------------------------------

  it("allows a single H1 document title before the first chunk heading", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      runbookContent({ runbookId: "r", h1: "Doc Title", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );
    const result = await load(dir);
    expect(result.chunks).toHaveLength(1);
  });

  it("rejects a second H1 document title", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\n---\n\n# Title One\n\n# Title Two\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects stray preamble body text before the first H2 instead of silently dropping it", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\n---\n\nThis paragraph should not be silently discarded.\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  // --- Fence-aware parsing ----------------------------------------------------

  it("allows a blank line between the H2 and its chunkId comment", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      "---\nrunbookId: r\n---\n\n## T\n\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );
    const result = await load(dir);
    expect(result.chunks[0]?.chunkId).toBe("x-001");
  });

  it("does not treat an H2-looking line inside a backtick fence as a chunk boundary", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      "---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\n" +
        "Intro.\n\n```\n## Not A Real Heading\n```\n\nMore text.\n",
    );
    const result = await load(dir);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("## Not A Real Heading");
  });

  it("does not treat an H2-looking line inside a tilde fence as a chunk boundary", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      "---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\n" +
        "Intro.\n\n~~~\n## Not A Real Heading\n~~~\n\nMore text.\n",
    );
    const result = await load(dir);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]?.content).toContain("## Not A Real Heading");
  });

  it("rejects an unclosed code fence", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\n```\nunterminated\n",
    );
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("preserves an unrelated HTML comment inside chunk content as ordinary text", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      "---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\n" +
        "Some text.\n\n<!-- unrelated note -->\n\nMore text.\n",
    );
    const result = await load(dir);
    expect(result.chunks[0]?.content).toContain("<!-- unrelated note -->");
  });

  // --- Chunk / cardinality rules -----------------------------------------------

  it("rejects an H2 with no chunkId comment", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nrunbookId: r\n---\n\n## T\n\nJust content, no comment.\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects empty chunk content", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nrunbookId: r\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\n   \n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a file with zero chunk headings", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "---\nrunbookId: r\n---\n\n# Just A Title\n");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a directory with zero Markdown files", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "notes.txt"), "not markdown");
    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects a duplicate chunkId within one file", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      runbookContent({
        runbookId: "r",
        chunks: [
          { id: "dup-001", title: "One", content: "C1." },
          { id: "dup-001", title: "Two", content: "C2." },
        ],
      }),
    );
    await expectLoadError(dir, "DUPLICATE_CHUNK_ID");
  });

  it("rejects a duplicate chunkId across two files", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "a.md"),
      runbookContent({ runbookId: "r1", chunks: [{ id: "dup-001", title: "One", content: "C1." }] }),
    );
    await fs.writeFile(
      path.join(dir, "b.md"),
      runbookContent({ runbookId: "r2", chunks: [{ id: "dup-001", title: "Two", content: "C2." }] }),
    );
    await expectLoadError(dir, "DUPLICATE_CHUNK_ID");
  });

  // --- Root validation -----------------------------------------------------

  it("rejects when the configured runbooks directory does not exist", async () => {
    const dir = await tempDir();
    await expectLoadError(path.join(dir, "does-not-exist"), "DIRECTORY_NOT_FOUND");
  });

  it("rejects when runbooksDir itself is a symlink", async () => {
    const realDir = await tempDir();
    await fs.writeFile(
      path.join(realDir, "ok.md"),
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );
    const parent = await tempDir();
    const linkPath = path.join(parent, "link-to-real");
    await fs.symlink(realDir, linkPath, "dir");

    const error = await expectLoadError(linkPath, "FORMAT_INVALID");
    expect(error.message).not.toContain(realDir);
  });

  it("rejects when runbooksDir is a regular file, not a directory", async () => {
    const parent = await tempDir();
    const filePath = path.join(parent, "not-a-directory.md");
    await fs.writeFile(filePath, "just a file");
    await expectLoadError(filePath, "FORMAT_INVALID");
  });

  // --- Symlink / nested-directory fail-closed -------------------------------

  it("rejects a symlinked Markdown file inside the directory", async () => {
    const outside = await tempDir();
    const targetPath = path.join(outside, "real.md");
    await fs.writeFile(
      targetPath,
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );
    const dir = await tempDir();
    await fs.symlink(targetPath, path.join(dir, "linked.md"), "file");

    const error = await expectLoadError(dir, "FORMAT_INVALID");
    expect(error.message).not.toContain(outside);
    expect(error.message).not.toContain(dir);
  });

  it("rejects a symlinked directory entry", async () => {
    const outside = await tempDir();
    const dir = await tempDir();
    await fs.symlink(outside, path.join(dir, "linked-dir"), "dir");

    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("rejects an ordinary (non-symlink) nested directory instead of silently skipping it", async () => {
    const dir = await tempDir();
    await fs.mkdir(path.join(dir, "nested"));
    await fs.writeFile(
      path.join(dir, "nested", "inner.md"),
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );
    // Also give the top level at least one otherwise-valid file, so the
    // failure is unambiguously attributable to the nested directory itself.
    await fs.writeFile(
      path.join(dir, "top.md"),
      runbookContent({ runbookId: "r2", chunks: [{ id: "chunk-002", title: "T2", content: "C2." }] }),
    );

    await expectLoadError(dir, "FORMAT_INVALID");
  });

  it("still silently ignores an ordinary non-Markdown regular file", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, ".DS_Store"), "binary junk");
    await fs.writeFile(
      path.join(dir, "ok.md"),
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );

    const result = await load(dir);
    expect(result.sourceFileCount).toBe(1);
  });

  // --- Path boundary ---------------------------------------------------------

  it("rejects a file whose realpath resolves outside runbooksDir (defense in depth)", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "ok.md");
    await fs.writeFile(
      filePath,
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );

    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, "realpath").mockImplementation(async (target: Parameters<typeof fs.realpath>[0]) => {
      if (typeof target === "string" && target === filePath) {
        return "/definitely/outside/the/runbooks/dir.md";
      }
      return originalRealpath(target as string);
    });

    const error = await expectLoadError(dir, "FORMAT_INVALID");
    expect(error.message).toContain("resolves outside");
  });

  // --- Filesystem error boundaries --------------------------------------------

  it("maps a directory listing failure to DIRECTORY_READ_FAILED", async () => {
    const dir = await tempDir();
    vi.spyOn(fs, "readdir").mockRejectedValueOnce(new Error("EACCES: permission denied"));

    const error = await expectLoadError(dir, "DIRECTORY_READ_FAILED");
    expect(error.message).not.toContain("EACCES");
  });

  it("maps a file read failure to FILE_READ_FAILED", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "ok.md"),
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(new Error("EIO: i/o error"));

    const error = await expectLoadError(dir, "FILE_READ_FAILED");
    expect(error.message).not.toContain("EIO");
  });

  it("maps a root realpath failure to DIRECTORY_READ_FAILED", async () => {
    const dir = await tempDir();
    vi.spyOn(fs, "realpath").mockRejectedValueOnce(new Error("boom"));

    await expectLoadError(dir, "DIRECTORY_READ_FAILED");
  });

  it("maps a non-ENOENT lstat failure on the root directory to DIRECTORY_READ_FAILED", async () => {
    const dir = await tempDir();
    const eacces = Object.assign(
      new Error("EACCES: permission denied, lstat '" + dir + "'"),
      { code: "EACCES" },
    );
    vi.spyOn(fs, "lstat").mockRejectedValueOnce(eacces);

    const error = await expectLoadError(dir, "DIRECTORY_READ_FAILED");
    expect(error.message).not.toContain("EACCES");
    expect(error.message).not.toContain("permission denied");
    expect(error.message).not.toContain(dir);
  });

  it("maps an accepted Markdown file's realpath failure to FILE_READ_FAILED", async () => {
    const dir = await tempDir();
    const filePath = path.join(dir, "ok.md");
    await fs.writeFile(
      filePath,
      runbookContent({ runbookId: "r", chunks: [{ id: "chunk-001", title: "T", content: "C." }] }),
    );

    // Let the runbooksDir root's own realpath call succeed normally; only
    // the accepted file's realpath call fails.
    const originalRealpath = fs.realpath.bind(fs);
    const eio = Object.assign(new Error("EIO: i/o error, realpath '" + filePath + "'"), { code: "EIO" });
    vi.spyOn(fs, "realpath").mockImplementation(async (target: Parameters<typeof fs.realpath>[0]) => {
      if (typeof target === "string" && target === filePath) {
        throw eio;
      }
      return originalRealpath(target as string);
    });

    const error = await expectLoadError(dir, "FILE_READ_FAILED");
    expect(error.message).not.toContain("EIO");
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain(filePath);
  });

  // --- Sanitization -----------------------------------------------------------

  it("never includes the runbooksDir absolute path in any thrown error message", async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "bad.md"), "not front matter at all");

    let thrown: unknown;
    try {
      await load(dir);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(RunbookLoadError);
    const message = (thrown as RunbookLoadError).message;
    expect(message).not.toContain(dir);
    expect(message).not.toMatch(/\n\s*at /); // no embedded stack-trace frames
    expect(message).not.toContain("node_modules");
  });

  it("does not leak an unknown metadata key's sentinel name in the error message", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\nsentinelUnknownKey12345: x\n---\n\n## T\n\n<!-- chunkId: x-001 -->\n\nC.\n",
    );

    const error = await expectLoadError(dir, "FORMAT_INVALID");
    expect(error.message).not.toContain("sentinelUnknownKey12345");
  });

  it("does not leak an H2 title's sentinel text in the error message", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\n---\n\n## SENTINEL_TITLE_TEXT_44556\n\nNo chunkId comment here.\n",
    );

    const error = await expectLoadError(dir, "FORMAT_INVALID");
    expect(error.message).not.toContain("SENTINEL_TITLE_TEXT_44556");
  });

  it("does not leak a valid-looking duplicate chunkId's sentinel value in the error message", async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "a.md"),
      runbookContent({
        runbookId: "r1",
        chunks: [{ id: "sentinel-dup-chunk-77001", title: "One", content: "C1." }],
      }),
    );
    await fs.writeFile(
      path.join(dir, "b.md"),
      runbookContent({
        runbookId: "r2",
        chunks: [{ id: "sentinel-dup-chunk-77001", title: "Two", content: "C2." }],
      }),
    );

    const error = await expectLoadError(dir, "DUPLICATE_CHUNK_ID");
    expect(error.message).not.toContain("sentinel-dup-chunk-77001");
  });

  it("does not leak sentinel values from an internally invalid assembled chunk caught by runtime validation", async () => {
    // An H2 heading whose text is only whitespace passes the heading regex
    // (it requires "## " plus at least one character) but trims to an empty
    // title — a gap the parser's own per-chunk checks don't cover (only
    // empty *content* is checked directly), so this is caught by the final
    // validateStoredRunbookChunks defense-in-depth call inside load().
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, "bad.md"),
      "---\nrunbookId: r\n---\n\n##  \n\n<!-- chunkId: sentinel-empty-title-001 -->\n\nSENTINEL_CONTENT_TEXT_998877\n",
    );

    const error = await expectLoadError(dir, "FORMAT_INVALID");
    expect(error.message).not.toContain("sentinel-empty-title-001");
    expect(error.message).not.toContain("SENTINEL_CONTENT_TEXT_998877");
  });
});
