import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { renderEvaluationResolution, resolveEvaluationRun } from "./run-eval";

const GOLDEN_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli-report-golden.txt");

// Captured from `pnpm --filter @opspilot/worker run eval` (EVALUATION_SCORER=local)
// against the real 20-case dataset (the 15 original Phase 1 cases plus the five
// Issue #59 Checkpoint B additions). The golden captures the 15 metrics — the
// six v1 ratios unchanged, plus the nine #59 ratios each rendered as
// `numerator/denominator (n/a_count n/a)` — and the fixed application-authored
// N/A lines (`~ <check>: <message>`) emitted per case. This file is the
// end-to-end proof that splitting observation from scoring, moving from inline
// reason prose to CheckReasonCode, and adding the nine metrics left the case
// lines and the six v1 denominators byte-identical (see the OpsPilot #61 Phase 1
// plan, "byte-identical" requirement, and Checkpoint B §11).
describe("CLI report — byte-identical against the captured golden output", () => {
  it("renders exactly the captured golden text for the real 20-case dataset", async () => {
    const resolution = await resolveEvaluationRun();
    const rendered = renderEvaluationResolution(resolution);

    const golden = readFileSync(GOLDEN_PATH, "utf8");
    const goldenWithoutTrailingNewline = golden.endsWith("\n") ? golden.slice(0, -1) : golden;

    expect(rendered.output).toBe(goldenWithoutTrailingNewline);
    expect(rendered.isError).toBe(false);
    expect(rendered.exitCode).toBe(0);
  });
});
