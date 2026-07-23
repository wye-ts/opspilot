import { defineConfig } from "vitest/config";

// Integration test files share one physical Postgres test database and
// serialize cleanup between them (TRUNCATE in afterEach) — fileParallelism
// must stay off so two files never truncate/race against each other.
export default defineConfig({
  test: {
    include: ["**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
