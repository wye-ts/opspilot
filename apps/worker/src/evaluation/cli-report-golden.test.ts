import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderEvaluationResolution, resolveEvaluationRun } from "./run-eval";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-report-golden.txt");

// Captured from `pnpm --filter @opspilot/worker run eval` against the real
// 15-case dataset before the Phase 1 (OpsPilot #61) refactor. Every check
// name/order/pass value and every metric denominator must be unaffected by
// splitting observation from scoring and moving from inline reason prose to
// CheckReasonCode — this is the end-to-end proof of that invariant (see the
// OpsPilot #61 Phase 1 plan, "byte-identical" requirement).
describe("CLI report — byte-identical against the pre-refactor golden output", () => {
  it("renders exactly the captured golden text for the real 15-case dataset", async () => {
    const resolution = await resolveEvaluationRun();
    const rendered = renderEvaluationResolution(resolution);

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    const goldenWithoutTrailingNewline = golden.endsWith("\n") ? golden.slice(0, -1) : golden;

    expect(rendered.output).toBe(goldenWithoutTrailingNewline);
    expect(rendered.isError).toBe(false);
    expect(rendered.exitCode).toBe(0);
  });
});
