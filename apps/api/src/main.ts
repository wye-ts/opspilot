import "reflect-metadata";

import path from "node:path";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient } from "@opspilot/database";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "./common/json-body-parser";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { requestIdMiddleware } from "./common/request-id.middleware";
import { resolveServerConfig } from "./common/server-config";
import { createSpaFallbackMiddleware } from "./common/spa-fallback.middleware";
import { isWebDistServable, resolveWebDistDir } from "./common/web-assets";
import { closeOnBootstrapFailure, createSafeClose } from "./persistence/safe-close";

const STARTUP_FAILURE_MESSAGE = "OpsPilot API failed to start.";
const ASSETS_DIR_NAME = "assets";
const INDEX_HTML = "index.html";

async function bootstrap(): Promise<void> {
  // The single outer-owned Prisma handle for the whole process — main.ts is
  // the only production code path that calls createPrismaClient() (see
  // docs/12-agent-run-api.md). Nest never creates a second client or pool.
  const handle = createPrismaClient();
  const safeClose = createSafeClose(handle);

  let app: NestExpressApplication | undefined;
  try {
    const { host, port } = resolveServerConfig();

    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(handle, safeClose), {
      abortOnError: false,
      logger: false,
      bodyParser: false,
    });

    // Raw Express middleware, registered before Nest routing, in this exact
    // order (see docs/12-agent-run-api.md and docs/08-cicd-deployment.md):
    //   1. server-generated request ID
    //   2. static React assets (conditional — only when a build is present)
    //   3. guarded SPA fallback (conditional, same guard)
    //   4. JSON parser, 32 KB
    //   5. parser-error normalization
    //   6. Nest routes
    app.use(requestIdMiddleware);

    const webDistDir = resolveWebDistDir(__dirname);
    if (isWebDistServable(webDistDir)) {
      app.useStaticAssets(webDistDir, {
        index: INDEX_HTML,
        setHeaders: (res, filePath) => {
          const relativePath = path.relative(webDistDir, filePath);
          if (relativePath === INDEX_HTML) {
            res.setHeader("Cache-Control", "no-cache");
          } else if (relativePath.startsWith(`${ASSETS_DIR_NAME}${path.sep}`)) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          }
        },
      });
      app.use(createSpaFallbackMiddleware(webDistDir));
    }

    app.use(jsonBodyParser);
    app.use(jsonParserErrorHandler);

    app.setGlobalPrefix("v1");
    app.useGlobalFilters(new AllExceptionsFilter());
    app.useGlobalInterceptors(new LoggingInterceptor());

    // SIGINT/SIGTERM trigger Nest's normal onModuleDestroy lifecycle (see
    // PrismaLifecycleService), which calls the same guarded safeClose() —
    // so stopping the dev server (Ctrl+C) closes the pg pool cleanly
    // instead of dropping the connection.
    app.enableShutdownHooks(["SIGINT", "SIGTERM"]);

    await app.listen(port, host);
    console.log(`OpsPilot API listening on http://${host}:${port}`);
  } catch {
    await closeOnBootstrapFailure(app, safeClose);
    console.error(STARTUP_FAILURE_MESSAGE);
    process.exitCode = 1;
  }
}

bootstrap().catch(() => {
  // Only reachable if a failure occurred before bootstrap()'s own try block
  // (e.g. createPrismaClient() itself throwing) — nothing was opened in
  // that case, so there is nothing further to close.
  console.error(STARTUP_FAILURE_MESSAGE);
  process.exitCode = 1;
});
