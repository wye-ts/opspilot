import { Module } from "@nestjs/common";

import { createDeterministicProviderFactory } from "./deterministic-provider-factory";
import { DETERMINISTIC_PROVIDER_FACTORY } from "./execution.tokens";

// Reads AGENT_RUN_PROVIDER_MODE exactly once, at module-instantiation time.
// An unsupported value (e.g. LIVE) makes this provider's factory throw
// during Nest's DI phase, which — because main.ts passes
// abortOnError: false to NestFactory.create — propagates as a rejected
// promise into main.ts's guarded bootstrap try/catch rather than a raw
// process.exit or an unhandled rejection.
@Module({
  providers: [
    {
      provide: DETERMINISTIC_PROVIDER_FACTORY,
      useFactory: () => createDeterministicProviderFactory(process.env.AGENT_RUN_PROVIDER_MODE),
    },
  ],
  exports: [DETERMINISTIC_PROVIDER_FACTORY],
})
export class DeterministicExecutionModule {}
