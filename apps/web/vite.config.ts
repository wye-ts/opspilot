// defineConfig comes from "vitest/config", NOT "vite" — this is what makes
// the `test` block below type-checked without a separate vitest.config.ts.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Server-side only. Read by Vite's proxy in the Node process — it never
// reaches the browser and can never cause a cross-origin request. Browser
// code only ever calls relative /v1/... paths (see src/api/http-client.ts).
const API_PROXY_TARGET = "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // @opspilot/contracts is a workspace-linked package whose dist/ is CommonJS
    // (a deliberate shape for Vitest's CJS interop). Without pre-bundling, Vite
    // serves that raw CJS through /@fs/ and the browser's ESM loader cannot find
    // its named exports (blank page, "does not provide an export named X").
    // Pre-bundling it via esbuild converts CJS -> ESM with working named exports.
    include: ["@opspilot/contracts"],
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/v1": { target: API_PROXY_TARGET },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4173,
    proxy: {
      "/v1": { target: API_PROXY_TARGET },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
