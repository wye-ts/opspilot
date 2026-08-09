import { describe, expect, it } from "vitest";

import { checkToolAvailability } from "./tool-availability";

describe("checkToolAvailability", () => {
  it("reports an entry for git, pnpm, and docker without throwing", () => {
    const entries = checkToolAvailability();
    const byTool = Object.fromEntries(entries.map((e) => [e.tool, e]));
    expect(Object.keys(byTool).sort()).toEqual(["docker", "git", "pnpm"]);
    // git must be available in this dev/test environment (the harness itself depends on it).
    expect(byTool.git?.available).toBe(true);
    expect(typeof byTool.git?.version).toBe("string");
  });
});
