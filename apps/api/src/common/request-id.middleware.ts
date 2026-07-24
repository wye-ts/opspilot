import { randomUUID } from "node:crypto";

import type { NextFunction, Request, Response } from "express";

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

// Runs first in the middleware pipeline (see docs/12-agent-run-api.md), so
// every response — including malformed-body and oversized-body errors — has
// a stable request ID. Always server-generated; any inbound X-Request-Id is
// ignored, never trusted as a correlation identifier from the caller.
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const requestId = randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}
