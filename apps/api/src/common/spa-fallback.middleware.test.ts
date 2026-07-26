import path from "node:path";

import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";

import { createSpaFallbackMiddleware } from "./spa-fallback.middleware";

const WEB_DIST_DIR = "/app/apps/web/dist";
const INDEX_PATH = path.join(WEB_DIST_DIR, "index.html");

function buildReqRes(
  method: string,
  reqPath: string,
): { req: Request; res: Response; next: NextFunction; setHeader: ReturnType<typeof vi.fn>; sendFile: ReturnType<typeof vi.fn> } {
  const setHeader = vi.fn();
  const sendFile = vi.fn();
  const req = { method, path: reqPath } as unknown as Request;
  const res = { setHeader, sendFile } as unknown as Response;
  const next = vi.fn();
  return { req, res, next, setHeader, sendFile };
}

describe("createSpaFallbackMiddleware", () => {
  const middleware = createSpaFallbackMiddleware(WEB_DIST_DIR);

  it("serves index.html for /", () => {
    const { req, res, next, setHeader, sendFile } = buildReqRes("GET", "/");

    middleware(req, res, next);

    expect(sendFile).toHaveBeenCalledWith(INDEX_PATH, expect.any(Function));
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "no-cache");
    expect(next).not.toHaveBeenCalled();
  });

  it("serves index.html for a deep link", () => {
    const { req, res, sendFile } = buildReqRes("GET", "/deep/link");

    middleware(req, res, vi.fn());

    expect(sendFile).toHaveBeenCalledWith(INDEX_PATH, expect.any(Function));
  });

  it.each(["/v1", "/v1/", "/v1/nope", "/V1", "/V1/", "/V1/health/live", "/v1/health/live"])(
    "falls through to the API for %s",
    (reqPath) => {
      const { req, res, next, sendFile } = buildReqRes("GET", reqPath);

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(sendFile).not.toHaveBeenCalled();
    },
  );

  it.each(["/v1abc", "/V1abc"])(
    "does not treat %s as an API path — it is a prefix lookalike, not a real /v1 route, regardless of case",
    (reqPath) => {
      const { req, res, next, sendFile } = buildReqRes("GET", reqPath);

      middleware(req, res, next);

      expect(sendFile).toHaveBeenCalledWith(INDEX_PATH, expect.any(Function));
      expect(next).not.toHaveBeenCalled();
    },
  );

  it("falls through for a path with a file extension, e.g. a missing asset", () => {
    const { req, res, next, sendFile } = buildReqRes("GET", "/missing.js");

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("falls through for non-GET/HEAD requests", () => {
    const { req, res, next, sendFile } = buildReqRes("POST", "/unknown");

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(sendFile).not.toHaveBeenCalled();
  });

  it("serves index.html for HEAD requests to extensionless paths", () => {
    const { req, res, sendFile } = buildReqRes("HEAD", "/deep/link");

    middleware(req, res, vi.fn());

    expect(sendFile).toHaveBeenCalledWith(INDEX_PATH, expect.any(Function));
  });

  it("forwards a sendFile error to next()", () => {
    const { req, res, next, sendFile } = buildReqRes("GET", "/");
    const boom = new Error("boom");
    sendFile.mockImplementation((_path: string, cb: (err?: Error) => void) => cb(boom));

    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(boom);
  });
});
