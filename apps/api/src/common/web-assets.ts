import { existsSync } from "node:fs";
import path from "node:path";

// baseDir must be the CALLER's own __dirname (main.ts passes its own), not
// this module's — a default parameter of `= __dirname` would silently
// capture *this file's* directory (apps/api/dist/common/) instead of
// main.js's (apps/api/dist/), since default-parameter expressions close
// over the declaring module, not the call site. From apps/api/dist/main.js,
// two ".." hops land on apps/web/dist — true both in the repository and in
// the runtime image, which preserves the monorepo layout (see
// docs/08-cicd-deployment.md). WEB_DIST_DIR overrides this for any layout
// that does not match.
export function resolveWebDistDir(baseDir: string): string {
  return process.env.WEB_DIST_DIR ?? path.resolve(baseDir, "../../web/dist");
}

// Static serving and the SPA fallback are both skipped entirely when no
// build is present (see docs/08-cicd-deployment.md), so local `pnpm
// api:start` alongside `vite dev` is unaffected.
export function isWebDistServable(webDistDir: string): boolean {
  return existsSync(path.join(webDistDir, "index.html"));
}
