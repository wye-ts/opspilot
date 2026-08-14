import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Required-mode wiring for the authoritative cross-service parity suite
// (OpsPilot #61 Phase 3, final targeted fixes). Three claims are pinned:
//   4. CI invokes the required-mode path (the test:eval:cross-service script
//      that sets EVALUATION_SERVICE_REQUIRED=1) — never a generic vitest
//      command that would let an absent service skip the suite to zero
//      assertions and still pass.
//   5. The authoritative parity tests cannot silently pass with zero parity
//      assertions executed: running the real cross-service-parity.test.ts in
//      required mode against an absent service FAILS (non-zero exit), because
//      the fail-closed reachability probe throws instead of skipping.
// ---------------------------------------------------------------------------

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(THIS_DIR, "../../../..");
const WORKER_DIR = join(REPO_ROOT, "apps/worker");
const CI_WORKFLOW_PATH = join(REPO_ROOT, ".github/workflows/ci.yml");
const WORKER_PACKAGE_PATH = join(WORKER_DIR, "package.json");
const VITEST_BIN = join(REPO_ROOT, "node_modules/.bin/vitest");
const PARITY_TEST_REL = "src/evaluation/cross-service-parity.test.ts";

// Binds an ephemeral loopback port and closes it again, so nothing is
// listening at the returned URL — the deterministic "service absent" target.
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return `http://127.0.0.1:${port}`;
}

describe("cross-service parity — CI invokes the required-mode path (required test 4)", () => {
  it("the test:eval:cross-service script sets EVALUATION_SERVICE_REQUIRED=1", () => {
    const pkg = JSON.parse(readFileSync(WORKER_PACKAGE_PATH, "utf8")) as {
      scripts: Record<string, string>;
    };
    const script = pkg.scripts["test:eval:cross-service"];
    expect(script).toBeDefined();
    expect(script).toContain("EVALUATION_SERVICE_REQUIRED=1");
    // The script must target the parity suite (and the remote-failure tests),
    // not a generic whole-suite vitest run.
    expect(script).toContain("cross-service-parity.test.ts");
    expect(script).toContain("service-unavailable.test.ts");
  });

  it("the CI cross-service-parity job runs the required-mode script, never a generic vitest command", () => {
    const workflow = readFileSync(CI_WORKFLOW_PATH, "utf8");
    // The job that exercises the real boundary must invoke the script that
    // sets EVALUATION_SERVICE_REQUIRED=1.
    expect(workflow).toContain("test:eval:cross-service");
    // A direct `vitest run` of the parity file in CI would be exactly the
    // silent-skip path this fix removes.
    expect(workflow).not.toMatch(/vitest run .*cross-service-parity\.test\.ts/);
  });
});

describe("cross-service parity — cannot silently pass with zero assertions (required test 5)", () => {
  it("runs the real parity suite in required mode against an absent service and FAILS rather than skipping", async () => {
    expect(existsSync(VITEST_BIN)).toBe(true);
    const deadUrl = await closedPortUrl();

    const result = spawnSync(
      VITEST_BIN,
      ["run", PARITY_TEST_REL],
      {
        cwd: WORKER_DIR,
        env: {
          ...process.env,
          EVALUATION_SERVICE_REQUIRED: "1",
          EVALUATION_SERVICE_URL: deadUrl,
        },
        encoding: "utf8",
        timeout: 120_000,
      },
    );

    // If the subprocess could not be spawned, fail loudly rather than letting
    // a null status masquerade as a meaningful result.
    expect(result.error).toBeUndefined();

    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    // Required mode + absent service must FAIL the suite (non-zero exit), not
    // pass with the parity describe skipped to zero assertions.
    expect(result.status).not.toBe(0);
    // And the failure must be the fail-closed reachability probe, not some
    // unrelated error.
    expect(output).toMatch(/EVALUATION_SERVICE_REQUIRED|not reachable|failed/i);
  });
});
