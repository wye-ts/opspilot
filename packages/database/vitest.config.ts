import { configDefaults, defineConfig } from "vitest/config";

// Excludes *.integration.test.ts (which require real PostgreSQL) from the
// default `test` run — see vitest.integration.config.ts for those.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
});
