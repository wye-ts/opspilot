import { All, Controller, NotFoundException } from "@nestjs/common";

// A dedicated catch-all route, registered last in the module graph (see
// app.module.ts), so every specific endpoint route continues to match
// first. "*splat" — not a bare "*" — is required by Express 5's
// path-to-regexp v8 wildcard syntax; a bare "*" throws at route
// registration time. Any request that reaches this handler matched none
// of the four defined endpoints, so it always throws Nest's own
// NotFoundException, which AllExceptionsFilter maps to the fixed
// ROUTE_NOT_FOUND ApiError (see docs/12-agent-run-api.md).
@Controller()
export class NotFoundController {
  @All("*splat")
  handleUnknownRoute(): never {
    throw new NotFoundException();
  }
}
