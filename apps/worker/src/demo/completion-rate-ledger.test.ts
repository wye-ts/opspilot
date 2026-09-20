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
      // Full figure, not a fixed-width slice: `slice(-4)` compared only the
      // first decimal digit, so $4.8 and $4.89 read as equal.
      ...new Set(
        [...text.matchAll(/(?:≈|roughly) \$(\d+\.\d+)/g)].flatMap((m) =>
          m[1] === undefined ? [] : [m[1]],
        ),
      ),
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

  // This assertion used to require both documents to say the fix had NO
  // supporting observation. That was true when written and is now false: the
  // change has since been measured. The guard is rewritten rather than
  // deleted, because the claim that actually needs pinning is the boundary of
  // what the measurement shows — a shape that stopped recurring, NOT a
  // completion rate.
  it("records that the fix shipped before it was measured", () => {
    // Hard-wrapped prose: tolerate a newline anywhere inside the phrase.
    expect(REVIEW).toMatch(/no\s+supporting\s+observation\s+at\s+all/i);
    expect(CHALLENGE).toMatch(/shipped with no supporting observation/i);
  });

  it("never presents the post-fix runs as a completion rate", () => {
    // Each document words the boundary differently; pin each to its own text
    // rather than forcing a shared phrase.
    expect(REVIEW).toMatch(/\*\*A completion rate\.\*\*/);
    expect(REVIEW).toMatch(/not\s+comparable\s+to\s+the\s+2\/8\s+deployed\s+baseline/i);
    expect(CHALLENGE).toMatch(/it\s+is\s+not\s+a\s+completion\s+rate/i);
  });

  it("states how many invocations never reached the model", () => {
    // `toContain("35")` passed even with the table zeroed, because 35 appears
    // elsewhere in the document — a guard that cannot fail is not a guard.
    // Pin the ledger row itself.
    expect(REVIEW).toMatch(/issue #125\) \| 35 \|/);
    expect(REVIEW).toMatch(/\*\*Reached the model\*\* \| \*\*14\*\* \|/);
    expect(CHALLENGE).toMatch(/35 of the 49/);
  });
});

describe("claims about verification match reality", () => {
  // The entry once asserted a consistency test covered these figures when none
  // did. The fix was to BUILD the guard, so the correct assertion now is that
  // the entry names the test that exists rather than that it disclaims one.
  // The earlier version of this test pinned the disclaimer in place, which
  // would have forced a true statement to be described as absent.
  it("names the guard that now covers these figures", () => {
    expect(CHALLENGE).toContain("completion-rate-ledger.test.ts");
  });

  it("does not reinstate the disclaimer the guard has made false", () => {
    expect(CHALLENGE).not.toMatch(/No equivalent test covers this\s+document's figures/i);
  });

  it("keeps the sequence honest: the claim preceded the mechanism", () => {
    expect(CHALLENGE).toMatch(/originally claimed the same\s+guard covered these figures when it did not/i);
  });
});

describe("the round table accounts for every billed round", () => {
  // Review found the table listing five rounds directly above a claim of six.
  // The table is the ledger; if it disagrees with the total, one of the
  // rounds someone paid for is missing from the record.
  it("lists six rounds totalling thirty invocations", () => {
    // Rounds 1-2 have no letter; 3-6 do. Built against the actual table text.
    const rows = [...CHALLENGE.matchAll(/^\| (\d)(?: \([A-D]\))? \| (\d)\/(\d) \|/gm)];
    expect(rows).toHaveLength(6);
    const invocations = rows.reduce((sum, row) => sum + Number(row[3]), 0);
    // Rounds A and D excluded one provider-side run each from their
    // denominators, so the denominators sum to 28 across 30 invocations.
    expect(invocations).toBe(28);
    expect(CHALLENGE).toContain("Thirty billed runs across six rounds");
  });
});

describe("denominators are labelled, not conflated", () => {
  // Excluding provider failures is right for judging report quality and wrong
  // for a completion rate. Review found 2/4 and a pooled 6/9 compared directly
  // against the 2/8 baseline, which counts every invocation — a comparison
  // between two differently-built denominators.
  it("never compares a pooled report-bearing figure to the baseline", () => {
    const conflated = /6\/9[^.]{0,60}(baseline|2\/8)/i.test(REVIEW);
    expect(conflated).toBe(false);
  });

  it("labels the round table's figures as report-bearing", () => {
    expect(CHALLENGE).toMatch(/Reported \(report-bearing\)/);
    // Hard-wrapped prose: "not" and "comparable" sit on different lines, so
    // the pattern has to tolerate the newline. Checked against the real file.
    expect(CHALLENGE).toMatch(/not\s+comparable to the 2\/8 deployed baseline/i);
  });

  it("states the end-to-end pooled figure against the baseline", () => {
    expect(REVIEW).toMatch(/6\/10 \(60%\)/);
  });
});

describe("stated percentages match their stated denominators", () => {
  // Falsification found this gap: restoring the conflated "50% and 80%,
  // pooled 67%" passed every existing guard, because nothing checked the
  // percentages against the ledger. Those are 2/4 and 6/9 — report-bearing
  // ratios — printed where end-to-end rates belong.
  it("uses end-to-end percentages in the point-estimate paragraph", () => {
    const paragraph = REVIEW.slice(REVIEW.indexOf("Any point estimate of the rate"));
    const claim = paragraph.slice(0, 400);
    expect(claim).toMatch(/40% and 80% end-to-end/);
    expect(claim).toMatch(/Pooled 60% \(6\/10\)/);
    // The report-bearing readings may be MENTIONED, but only as the
    // superseded figures they are.
    if (/\b67%/.test(claim)) {
      expect(claim).toMatch(/previously|superseded|report-bearing/i);
    }
  });

  it("never states a bare 50% for round A", () => {
    const paragraph = REVIEW.slice(REVIEW.indexOf("Any point estimate of the rate"), REVIEW.indexOf("Any point estimate of the rate") + 400);
    expect(paragraph).not.toMatch(/gave\s+50% and 80%/);
  });
});

describe("the excluded run is accounted for in both denominators", () => {
  // The prose said TICKET-4004 was "excluded from the denominator" while the
  // headline figures counted it in 2/5 and 6/10 — the document contradicting
  // its own ledger.
  it("states which denominator excludes it and which counts it", () => {
    // Anchored on the sentence itself: TICKET-4004 first appears in the
    // per-ticket table, so "first occurrence + N chars" read the wrong passage.
    const anchor = REVIEW.indexOf("`TICKET-4004` in round A failed");
    expect(anchor).toBeGreaterThan(-1);
    const passage = REVIEW.slice(anchor, anchor + 500);
    expect(passage).toMatch(/counted in\s+the end-to-end denominator/i);
    expect(passage).toMatch(/excluded from the report-bearing denominator/i);
    expect(passage).not.toMatch(/\*\*excluded\s+from the denominator\*\*/i);
  });
});

describe("round 2 is compared against the deployed retry policy", () => {
  // The deployed LIVE path is pinned to ZERO retries by a boot assertion;
  // DEFAULT_MAX_RETRIES = 1 is the non-live default. Citing the latter
  // understated the correction as 2 -> 1 when it was 2 -> 0.
  it("cites the zero-retry requirement, not the non-live default", () => {
    const passage = REVIEW.slice(REVIEW.indexOf("**Round 2 —"), REVIEW.indexOf("**Round 2 —") + 700);
    expect(passage).toMatch(/assertNoOpaqueRetriesOnProtectedLivePath/);
    expect(passage).toMatch(/2 -> 0, not 2 -> 1|zero/i);
  });
});
