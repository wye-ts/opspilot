import { defineConfig } from "vitest/config";

// Integration test files share one physical Postgres test database with
// packages/database's and apps/api's own integration suites and serialize
// cleanup between them (TRUNCATE in afterEach) — fileParallelism must stay
// off so no two integration files ever truncate/race against each other.
// Run the combined suites via the root `test:integration:sequential` script.
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
