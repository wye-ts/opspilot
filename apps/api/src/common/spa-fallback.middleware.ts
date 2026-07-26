import path from "node:path";

import type { NextFunction, Request, Response } from "express";

// Three guards, all required (see docs/08-cicd-deployment.md and
// docs/10-engineering-challenges.md Challenge 5):
//   - non-GET/HEAD requests never receive a fallback body;
//   - a real /v1 or /v1/** API path always falls through to the API,
//     regardless of case (/V1/... included) — Express routing is
//     case-insensitive by default (case-sensitive routing is not enabled
//     anywhere in this app), so this guard must match that behavior or an
//     alternate-case request could reach Nest's API routes while this
//     middleware still believed it was a frontend path. A prefix lookalike
//     like /v1abc or /V1abc does NOT count as an API path — it does not
//     equal "/v1" and does not start with "/v1/" — so it remains eligible
//     for the SPA fallback below, same as any other frontend route;
//   - a path with a file extension falls through instead of receiving
//     index.html, so a missing built asset 404s rather than becoming a
//     blank page with a MIME-type console error (browsers send
//     Accept: */* for scripts, which would otherwise satisfy an
//     Accept-only check).
export function createSpaFallbackMiddleware(webDistDir: string) {
  const indexPath = path.join(webDistDir, "index.html");

  return function spaFallbackMiddleware(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    // Lowercased only for the API-prefix comparison — req.path itself is
    // left untouched for the extension check and for sendFile below, so
    // this never affects which file is actually served.
    const normalizedPath = req.path.toLowerCase();
    if (normalizedPath === "/v1" || normalizedPath.startsWith("/v1/")) {
      next();
      return;
    }

    if (path.extname(req.path) !== "") {
      next();
      return;
    }

    res.setHeader("Cache-Control", "no-cache");
    res.sendFile(indexPath, (err) => {
      if (err) next(err);
    });
  };
}
