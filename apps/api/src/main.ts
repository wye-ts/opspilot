import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient } from "@opspilot/database";

import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/all-exceptions.filter";
import { jsonBodyParser, jsonParserErrorHandler } from "./common/json-body-parser";
import { LoggingInterceptor } from "./common/logging.interceptor";
import { requestIdMiddleware } from "./common/request-id.middleware";
import { closeOnBootstrapFailure, createSafeClose } from "./persistence/safe-close";

const STARTUP_FAILURE_MESSAGE = "OpsPilot API failed to start.";
const DEFAULT_PORT = 3000;
const HOST = "127.0.0.1";

async function bootstrap(): Promise<void> {
  // The single outer-owned Prisma handle for the whole process — main.ts is
  // the only production code path that calls createPrismaClient() (see
  // docs/12-agent-run-api.md). Nest never creates a second client or pool.
  const handle = createPrismaClient();
  const safeClose = createSafeClose(handle);

  let app: NestExpressApplication | undefined;
  try {
    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(handle, safeClose), {
      abortOnError: false,
      logger: false,
      bodyParser: false,
    });

    // Raw Express middleware, registered before Nest routing, in this exact
    // order (see docs/12-agent-run-api.md):
    //   1. server-generated request ID
    //   2. JSON parser, 32 KB
    //   3. parser-error normalization
    //   4. Nest routes
    app.use(requestIdMiddleware);
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

    const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
    await app.listen(port, HOST);
    console.log(`OpsPilot API listening on http://${HOST}:${port}`);
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
