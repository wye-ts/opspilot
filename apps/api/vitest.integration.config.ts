import { defineConfig } from "vitest/config";

// The mocked HTTP-transport suite and the real-PostgreSQL suite both live
// here. The PostgreSQL suite shares one physical test database with
// packages/database's own integration suite (see
// docs/12-agent-run-api.md) — fileParallelism must stay off so no two
// integration files race against each other.
export default defineConfig({
  test: {
    include: ["test/**/*.integration.test.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
