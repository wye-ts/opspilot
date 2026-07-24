import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import type { Observable } from "rxjs";

// Logs exactly once per completed response, after the response has actually
// finished (res.once("finish", ...)) — not from an RxJS tap({ error })
// using the in-flight response status, since an exception filter may not
// have assigned the final 4xx/5xx status yet at that point (see
// docs/12-agent-run-api.md). Only safe, fixed-shape fields are ever logged:
// never the request body, response body, ticket summary, report, trace
// payload, provider content, raw error, SQL, or secrets.
//
// `route` is deliberately request.route?.path ?? request.path, never
// request.originalUrl — originalUrl includes the raw query string, which
// could carry a secret-shaped value (e.g. a sentinel appended by a caller,
// or an accidental credential) that has no business being logged. Neither
// of the current four endpoints accepts query parameters, but the logger
// must stay query-safe regardless of what a caller sends.
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<Request>();
    const response = httpContext.getResponse<Response>();
    const startedAt = Date.now();

    response.once("finish", () => {
      console.log(
        JSON.stringify({
          method: request.method,
          route: request.route?.path ?? request.path,
          status: response.statusCode,
          durationMs: Date.now() - startedAt,
          requestId: request.requestId ?? "unknown",
        }),
      );
    });

    return next.handle();
  }
}
