import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Ledger consistency between the two documents that report this measurement.
 *
 * Review found the cost table saying "five rounds / 25 billed runs" while the
 * body of the same section described six rounds and 30 — and the entry claimed
 * a consistency test already guarded it, which was itself false. Three
 * consecutive review rounds found this class of drift on the previous spike
 * before a test replaced manual checking; this is that test for these figures.
 *
 * Derived from the documents rather than from constants here: a test that
 * restates the numbers would agree with itself while the prose drifted.
 */
const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function read(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), "utf8");
}

const CHALLENGE = (() => {
  const full = read("docs/10-engineering-challenges.md");
  const start = full.indexOf("## 17. Challenge 15");
  expect(start).toBeGreaterThan(-1);
  return full.slice(start);
})();

const REVIEW = read("docs/reviews/48-completion-rate-after-106-107-115.md");

describe("billed-run ledger agrees across both documents", () => {
  it("states the same billed-run count in each", () => {
    const counts = (text: string): string[] => [
      ...new Set(
        [...text.matchAll(/(\d+) billed runs/g)].flatMap((match) =>
          match[1] === undefined ? [] : [match[1]],
        ),
      ),
    ];
    // The challenge entry additionally quotes the WRONG figures when narrating
    // the drift review caught, so compare the corrected claim, not every
    // number that appears.
    expect(counts(REVIEW)).toEqual(["30"]);
    expect(CHALLENGE).toContain("Thirty billed runs across six rounds");
  });

  it("states the same cost in each", () => {
    const costs = (text: string): string[] => [
      ...new Set([...text.matchAll(/≈ \$\d\.\d|roughly \$\d\.\d/g)].map((m) => m[0].slice(-4))),
    ];
    expect(costs(CHALLENGE)).toEqual(costs(REVIEW));
  });
});

describe("round C is recorded as void in both documents", () => {
  // The 5/5 round ran under maxRetries: 2. Presenting it as support would be
  // selecting the round with the most permissive configuration — the exact
  // error these documents exist to record.
  it("never cites 5/5 as evidence for the .describe() change", () => {
    for (const text of [CHALLENGE, REVIEW]) {
      const cites5of5 = /5\/5[^.]{0,80}(support|evidence|confirm|shows)/i.test(text);
      expect(cites5of5).toBe(false);
    }
  });

  it("says plainly that the fix has no supporting observation", () => {
    expect(REVIEW).toMatch(/no supporting observation/i);
    expect(CHALLENGE).toMatch(/no supporting observation/i);
  });
});

describe("the entry does not claim guards it lacks", () => {
  // The original text asserted a documentation-consistency test covered these
  // figures. It did not exist. If a future edit reinstates that claim, the
  // reference must be to a real file.
  it("only claims a ledger test by naming the file that implements it", () => {
    // Span the whole sentence: the file name sits after a "." inside
    // `...ledger.test.ts`, so stopping at the first period truncated it.
    // Check the SENTENCE that makes the claim, not a fixed-size window: a
    // 240-character window swallowed the qualifying sentence that follows, so
    // an injected "covers every figure in this entry" still satisfied both
    // conditions. Third over-wide matcher this investigation — the lesson is
    // to bound a pattern by the structure (a sentence) rather than by a
    // character count.
    const sentences = CHALLENGE.split(/(?<=\.)\s+/);
    const claims = sentences.filter((sentence) =>
      /documentation-consistency test/i.test(sentence),
    );
    expect(claims.length).toBeGreaterThan(0);
    for (const claim of claims) {
      // The claim sentence must attribute the test to the spike it actually
      // covers. A blanket "covers every figure in this entry" does not.
      expect(claim).toMatch(/exists for the tool-usage spike/i);
      expect(claim).not.toMatch(/every figure|this entry|automatically/i);
    }
    // And the entry must state plainly that these figures are unguarded.
    expect(CHALLENGE).toMatch(/No equivalent test covers this\s+document's figures/i);
  });
});
