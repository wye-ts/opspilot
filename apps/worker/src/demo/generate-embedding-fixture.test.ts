import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

import opspilotAgentRuntime from "@opspilot/agent-runtime";
import type { EmbedRequest, EmbedResponse } from "voyageai";
import { describe, expect, it, vi } from "vitest";

import type { StoredRunbookChunk } from "@opspilot/agent-runtime";
import type { QueryRecord } from "../../../../runbooks-eval/validate-query-set";
import { buildEmbeddingFixture } from "./generate-embedding-fixture";
import type { VoyageEmbeddingClient } from "../rag/voyage-embedding-client";

const { computeCorpusContentHash, sha256 } = opspilotAgentRuntime;

const corpus: readonly StoredRunbookChunk[] = [
  { chunkId: "b", runbookId: "r1", title: "B", content: "Content B" },
  { chunkId: "a", runbookId: "r1", title: "A", content: "Content A" },
];

const queries: readonly QueryRecord[] = [
  { id: "q2", group: "exact", query: "second query", expectedChunkIds: ["a"], distractorChunkIds: [] },
  { id: "q1", group: "exact", query: "first query", expectedChunkIds: ["b"], distractorChunkIds: [] },
];

const rawQuerySetText = '{"queries":[]}';

function buildFakeClient(embed: VoyageEmbeddingClient["embed"]): VoyageEmbeddingClient {
  return { embed };
}

describe("buildEmbeddingFixture", () => {
  it("makes exactly two requests: one document batch, one query batch, with correct inputType and complete contents", async () => {
    const embed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> => {
      if (request.inputType === "document") {
        return {
          data: [
            { embedding: [1, 0], index: 0 },
            { embedding: [0, 1], index: 1 },
          ],
        };
      }
      return {
        data: [
          { embedding: [0.5, 0.5], index: 0 },
          { embedding: [0.9, 0.1], index: 1 },
        ],
      };
    });

    await buildEmbeddingFixture(
      buildFakeClient(embed),
      "voyage-4-lite",
      2,
      corpus,
      queries,
      rawQuerySetText,
    );

    expect(embed).toHaveBeenCalledTimes(2);

    // Document batch: sorted by chunkId (a, b) — full corpus content, nothing omitted.
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({
        input: ["Content A", "Content B"],
        model: "voyage-4-lite",
        inputType: "document",
        outputDimension: 2,
        outputDtype: "float",
      }),
    );

    // Query batch: sorted by id (q1, q2) — full query text, nothing omitted.
    expect(embed).toHaveBeenCalledWith(
      expect.objectContaining({
        input: ["first query", "second query"],
        model: "voyage-4-lite",
        inputType: "query",
        outputDimension: 2,
        outputDtype: "float",
      }),
    );
  });

  it("produces a fixture whose corpusContentHash/queryContentHash match the shared hash functions", async () => {
    const embed = vi.fn(async (request: EmbedRequest): Promise<EmbedResponse> => {
      if (request.inputType === "document") {
        return {
          data: [
            { embedding: [1, 0], index: 0 },
            { embedding: [0, 1], index: 1 },
          ],
        };
      }
      return {
        data: [
          { embedding: [0.5, 0.5], index: 0 },
          { embedding: [0.9, 0.1], index: 1 },
        ],
      };
    });

    const fixture = await buildEmbeddingFixture(
      buildFakeClient(embed),
      "voyage-4-lite",
      2,
      corpus,
      queries,
      rawQuerySetText,
    );

    expect(fixture.corpusContentHash).toBe(computeCorpusContentHash(corpus));
    expect(fixture.queryContentHash).toBe(sha256(rawQuerySetText));
    expect(fixture.embeddingModel).toBe("voyage-4-lite");
    expect(fixture.dimensions).toBe(2);
    expect(fixture.chunks).toEqual([
      { chunkId: "a", vector: [1, 0] },
      { chunkId: "b", vector: [0, 1] },
    ]);
    expect(fixture.queries).toEqual([
      { id: "q1", vector: [0.5, 0.5] },
      { id: "q2", vector: [0.9, 0.1] },
    ]);
  });

  it("propagates a RetrieverError from extractValidatedEmbeddings on a malformed response", async () => {
    const embed = vi.fn(async (): Promise<EmbedResponse> => ({ data: [{ embedding: [1, 0], index: 0 }] }));

    await expect(
      buildEmbeddingFixture(buildFakeClient(embed), "voyage-4-lite", 2, corpus, queries, rawQuerySetText),
    ).rejects.toThrow();
  });
});

// Issue #125 / docs/reviews/49, raised by independent review: this script makes
// two billed Voyage requests, so it must refuse to start on an unpinned Node
// exactly like the Anthropic entry points do.
//
// Exercised through the REAL CLI rather than by calling the guard directly: a
// guard that passes its own unit tests can still be wired in after the spend
// begins, or swallowed by a top-level handler that prints nothing useful —
// both of which happened to earlier drafts of this change.
describe("generate:embedding-fixture entry point — runtime gate", () => {
  const SCRIPT = resolve(import.meta.dirname, "generate-embedding-fixture.ts");
  const PINNED = readFileSync(resolve(import.meta.dirname, "../../../../.nvmrc"), "utf8").trim();

  /**
   * An installed Node whose version differs from the pin. Discovered rather
   * than hardcoded, and the test skips where no second runtime exists (CI
   * installs exactly one), because a fabricated pass is worse than a skip.
   */
  function findMismatchedNode(): string | null {
    const root = resolve(homedir(), ".nvm/versions/node");
    if (!existsSync(root)) return null;
    for (const entry of readdirSync(root)) {
      if (entry.replace(/^v/, "") === PINNED) continue;
      const candidate = resolve(root, entry, "bin/node");
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  it("exits non-zero on a mismatched Node, before reading credentials or calling Voyage", () => {
    const wrongNode = findMismatchedNode();
    if (wrongNode === null) {
      expect(PINNED).toMatch(/^\d+(\.\d+)*$/);
      return;
    }

    const result = spawnSync(wrongNode, ["--import", "tsx", SCRIPT], {
      encoding: "utf8",
      // No credential is supplied on purpose. If the guard ran too late (or
      // not at all) the script would stop at requireEnv instead, and the
      // final assertion below catches exactly that.
      env: { ...process.env, VOYAGE_API_KEY: "" },
      timeout: 180_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("REFUSING TO START");
    expect(result.stderr).toContain("generate-embedding-fixture");
    expect(result.stderr).toContain(PINNED);
    // Proves it refused for the RUNTIME reason and got there first — not
    // because the credential happened to be missing.
    expect(result.stderr).not.toContain("VOYAGE_API_KEY");
  });
});
