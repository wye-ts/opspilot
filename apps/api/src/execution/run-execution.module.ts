import { Module } from "@nestjs/common";

import { createAgentProviderFactory } from "./api-provider-factory";
import { AGENT_PROVIDER_FACTORY, RUN_EXECUTION_CONFIG } from "./execution.tokens";
import { logProviderEvent } from "./provider-event-log";
import { parseRunExecutionConfig, type RunExecutionConfig } from "./run-execution-config";

/**
 * Reads the environment exactly once, at module-instantiation time, and builds
 * the single provider factory — and, when live capability is configured, the
 * single Anthropic client — that this process uses.
 *
 * Any invalid configuration makes `parseRunExecutionConfig` throw during Nest's
 * DI phase. Because main.ts passes `abortOnError: false` to
 * `NestFactory.create`, that surfaces as a rejected promise into main.ts's
 * guarded bootstrap try/catch: the process logs its fixed startup-failure
 * message, closes the Prisma handle, and exits without ever binding a port.
 * Never a raw `process.exit`, never an unhandled rejection, and never a server
 * that comes up half-configured.
 *
 * Before PR 6B1 this module rejected `AGENT_RUN_PROVIDER_MODE=LIVE` outright.
 * It no longer does: LIVE is a per-request choice now, and whether the process
 * may serve it is a separate question answered by `liveCapability` and the
 * kill switch.
 */
@Module({
  providers: [
    {
      provide: RUN_EXECUTION_CONFIG,
      useFactory: (): RunExecutionConfig => parseRunExecutionConfig(process.env),
    },
    {
      provide: AGENT_PROVIDER_FACTORY,
      useFactory: (config: RunExecutionConfig) =>
        createAgentProviderFactory({
          liveCapability: config.liveCapability,
          logger: logProviderEvent,
        }),
      inject: [RUN_EXECUTION_CONFIG],
    },
  ],
  exports: [RUN_EXECUTION_CONFIG, AGENT_PROVIDER_FACTORY],
})
export class RunExecutionModule {}
