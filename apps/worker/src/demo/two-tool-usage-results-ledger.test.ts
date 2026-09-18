import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The run ledger in the two-tool-usage spike results is a hand-maintained
// table, and it drifted from its own prose THREE times across successive
// review rounds: a miscounted cost total, a claim that a retriever-less run
// had retrieved, and a recorded run missing from the summary list. Each was
// caught by a reviewer rather than by the repo.
//
// The ledger is the evidence record for a paid, non-reproducible experiment,
// so its internal arithmetic is worth pinning. This test derives the numbers
// from the table itself and checks the prose agrees.

const DOC_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../docs/reviews/47-issue-95-two-tool-usage-spike-results.md",
);

interface LedgerRow {
  readonly index: number;
  readonly completed: boolean;
  readonly billedCalls: number;
  readonly recorded: boolean;
}

function parseLedger(markdown: string): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const line of markdown.split("\n")) {
    // Ledger rows start with "| <number> |"; other tables in the document do not.
    const match = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|(.*)\|\s*$/.exec(line);
    if (!match) continue;
    const [, index, outcome, billed, disposition] = match;
    // "~3" (an approximate but real charge) and "0 (failed at the first call)"
    // must both parse. Anchoring on a leading digit silently read "~3" as 0 and
    // understated the total by a full run — caught the first time this test ran.
    const billedDigits = /(\d+)/.exec(billed ?? "");
    rows.push({
      index: Number(index),
      completed: (outcome ?? "").trim() === "Completed",
      billedCalls: billedDigits ? Number(billedDigits[1]) : 0,
      recorded: (disposition ?? "").includes("**Recorded.**"),
    });
  }
  return rows;
}

describe("two-tool-usage spike results — run ledger consistency", () => {
  const markdown = readFileSync(DOC_PATH, "utf8");
  const rows = parseLedger(markdown);

  it("parses a ledger with the expected shape", () => {
    expect(rows.length).toBeGreaterThanOrEqual(5);
    expect(rows.map((row) => row.index)).toEqual(
      Array.from({ length: rows.length }, (_, i) => i + 1),
    );
  });

  it("states an invocation total matching the number of ledger rows", () => {
    const stated = /(\w+) invocations total/.exec(markdown)?.[1]?.toLowerCase();
    const words: Record<string, number> = {
      three: 3,
      four: 4,
      five: 5,
      six: 6,
      seven: 7,
      eight: 8,
      nine: 9,
      ten: 10,
    };
    expect(stated).toBeDefined();
    expect(words[stated as string]).toBe(rows.length);
  });

  it("lists every Recorded run in the summary sentence", () => {
    const recorded = rows.filter((row) => row.recorded).map((row) => row.index);
    const sentence = /Only runs ([\d,\s and]+) are recorded as observations/.exec(markdown)?.[1];
    expect(sentence).toBeDefined();
    const listed = (sentence as string)
      .split(/,|\band\b/)
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isFinite(value));
    expect(listed).toEqual(recorded);
  });

  it("states a recorded-run count matching the Recorded rows", () => {
    const recordedCount = rows.filter((row) => row.recorded).length;
    const stated = /\*\*Descriptive record obtained from (\d+) recorded runs\*\*/.exec(markdown)?.[1];
    expect(stated).toBeDefined();
    expect(Number(stated)).toBe(recordedCount);
  });

  it("states a completed-run count matching the Completed rows", () => {
    const completedCount = rows.filter((row) => row.completed).length;
    const stated = /of (\d+) that completed/.exec(markdown)?.[1];
    expect(stated).toBeDefined();
    expect(Number(stated)).toBe(completedCount);
  });

  it("reconciles the stated cost with the billed calls in the table", () => {
    const billedCalls = rows.reduce((sum, row) => sum + row.billedCalls, 0);
    const statedTotal = /so ≈ \$([\d.]+) total/.exec(markdown)?.[1];
    expect(statedTotal).toBeDefined();
    // ~$0.13 per 3-call run, i.e. a per-call rate derived from the doc's own figure.
    const expected = (billedCalls / 3) * 0.13;
    expect(Math.abs(Number(statedTotal) - expected)).toBeLessThan(0.02);
  });

  it("does not claim the retriever-less run retrieved anything", () => {
    // Run 1 is discarded precisely because no retriever was wired.
    expect(markdown).toMatch(/Run 1 performed \*\*no retrieval at all\*\*/);
    expect(markdown).not.toMatch(/All (six|seven|eight) retrieved the identical ranking/);
  });
});
