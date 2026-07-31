import { Module } from "@nestjs/common";
import { isLiveRunBudgetOpen, type PrismaClientHandle } from "@opspilot/database";

import { PRISMA_CLIENT_HANDLE } from "../persistence/prisma.tokens";
import { createAgentProviderFactory } from "./api-provider-factory";
import {
  AGENT_PROVIDER_FACTORY,
  LIVE_RUN_ADMISSION,
  RUN_EXECUTION_CONFIG,
  USAGE_HOOKS,
} from "./execution.tokens";
import { createLiveRunAdmissionController } from "./live-run-admission";
import { logLiveRunAdmissionDecision } from "./live-run-budget-log";
import { logProviderEvent } from "./provider-event-log";
import { parseRunExecutionConfig, type RunExecutionConfig } from "./run-execution-config";
import { createApiUsageHooks } from "./usage-hooks";

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
 *
 * PR 6B2 adds the admission controller and the usage hooks. Both are singletons
 * deliberately: the rate limiter's buckets and the concurrency semaphore's
 * counter ARE the safeguard state, so a per-request instance would reset them on
 * every call and enforce nothing at all.
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
    {
      provide: USAGE_HOOKS,
      useFactory: () => createApiUsageHooks(),
    },
    {
      provide: LIVE_RUN_ADMISSION,
      // Takes an `isBudgetOpen` callback rather than the Prisma handle itself, so
      // live-run-admission.ts stays free of persistence concerns and is
      // unit-testable with no database at all.
      useFactory: (config: RunExecutionConfig, handle: PrismaClientHandle) =>
        createLiveRunAdmissionController({
          config,
          isBudgetOpen: (budget) => isLiveRunBudgetOpen(handle.prisma, budget),
          // The production sink for the one-line-per-decision admission record.
          // Passed explicitly rather than left to the default so this module —
          // the single place the real controller is built — states what the
          // deployment actually logs.
          logDecision: logLiveRunAdmissionDecision,
        }),
      inject: [RUN_EXECUTION_CONFIG, PRISMA_CLIENT_HANDLE],
    },
  ],
  exports: [RUN_EXECUTION_CONFIG, AGENT_PROVIDER_FACTORY, USAGE_HOOKS, LIVE_RUN_ADMISSION],
})
export class RunExecutionModule {}
