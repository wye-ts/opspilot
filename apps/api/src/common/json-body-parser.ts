import express, { type NextFunction, type Request, type Response } from "express";

import { ApiError, buildErrorEnvelope } from "../errors/api-error";

// type: "*/*" is mandatory: express.json()'s default type predicate only
// matches application/json and would skip a text/plain (or any other
// non-JSON content-type) body entirely, leaving req.body undefined and
// letting it slip past the empty-body run endpoint as if no body had been
// sent at all (see docs/12-agent-run-api.md).
export const jsonBodyParser = express.json({
  limit: "32kb",
  type: "*/*",
});

// Express four-argument error middleware — normalizes every body-parser
// failure into the same stable envelope the Nest exception filter produces.
// Never forwards the raw parser error, its stack, or the offending body.
export function jsonParserErrorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void {
  if (!err) {
    next();
    return;
  }

  const requestId = req.requestId ?? "unknown";
  const errorType = (err as { type?: unknown }).type;
  const apiError =
    errorType === "entity.too.large"
      ? new ApiError("REQUEST_BODY_TOO_LARGE", { cause: err })
      : new ApiError("REQUEST_BODY_INVALID", { cause: err });

  res.status(apiError.status).json(buildErrorEnvelope(apiError, requestId));
}
