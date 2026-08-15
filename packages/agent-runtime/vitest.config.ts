import { configDefaults, defineConfig } from "vitest/config";

// Excludes *.integration.test.ts (which require real PostgreSQL) from the
// default `test` run — see vitest.integration.config.ts for those. Without
// this config vitest's default include pattern picks up the integration suite
// and tries to run it without DATABASE_URL.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
