import { type ArgumentsHost, Catch, type ExceptionFilter, NotFoundException } from "@nestjs/common";
import type { Request, Response } from "express";

import { ApiError, buildErrorEnvelope } from "../errors/api-error";

// The only exception filter registered — catches everything (@Catch() with
// no arguments) so a raw exception can never reach a response body, stack,
// or log line. Any exception that is not already an ApiError is normalized
// to a fixed code (see docs/12-agent-run-api.md):
//   - Nest's own NotFoundException (thrown by the catch-all route for any
//     unmatched path, see common/not-found.controller.ts) maps to the
//     fixed ROUTE_NOT_FOUND ApiError — never NotFoundException's own
//     .message/.getResponse() body, which is discarded entirely.
//   - anything else maps to a fixed INTERNAL_ERROR.
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();
    const requestId = request.requestId ?? "unknown";

    const apiError = this.toApiError(exception);

    response.status(apiError.status).json(buildErrorEnvelope(apiError, requestId));
  }

  private toApiError(exception: unknown): ApiError {
    if (exception instanceof ApiError) return exception;
    if (exception instanceof NotFoundException) return new ApiError("ROUTE_NOT_FOUND", { cause: exception });
    return new ApiError("INTERNAL_ERROR", { cause: exception });
  }
}
