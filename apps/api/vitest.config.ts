import { configDefaults, defineConfig } from "vitest/config";

// Excludes the top-level test/ directory (HTTP transport + Postgres
// integration suites) from the default `test` run — see
// vitest.integration.config.ts for those.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/**", "**/*.integration.test.ts"],
  },
});
