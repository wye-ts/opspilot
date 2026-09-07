import { Module } from "@nestjs/common";
import {
  createAgentRunService,
  createPrismaAgentRunRepository,
  getServiceStatusTool,
  InMemoryKeywordRunbookRetriever,
  InMemoryToolRegistry,
  loadDefaultRunbookCorpus,
  type RunbookRetriever,
} from "@opspilot/agent-runtime";
import type { PrismaClientHandle } from "@opspilot/database";

import { PRISMA_CLIENT_HANDLE } from "../persistence/prisma.tokens";
import { AGENT_RUN_SERVICE, RUNBOOK_RETRIEVER, TOOL_REGISTRY } from "./execution.tokens";

// The AgentRunService is built from the one outer-owned PrismaClientHandle —
// never constructed a second time inside a controller (see
// docs/12-agent-run-api.md). The tool registry carries only the
// deterministic get_service_status tool.
//
// Issue #72 §2.2: RUNBOOK_RETRIEVER is the one RunbookRetriever this process
// uses — built ONCE here, from the default on-disk runbook corpus, never
// per-run. `useFactory` returning a Promise is a supported Nest DI shape:
// module construction awaits it before the provider is considered ready, so
// AgentRunsController never observes a partially-loaded retriever.
//
// Deliberately UNCAUGHT: loadDefaultRunbookCorpus() rejecting (e.g.
// RunbookLoadError("DIRECTORY_NOT_FOUND") when runbooks/ did not make it
// into the image) propagates out of this factory during Nest's DI phase.
// Because main.ts passes `abortOnError: false` to NestFactory.create, that
// surfaces as a rejected bootstrap promise — the process logs its fixed
// startup-failure message and exits without ever binding a port (the same
// fail-closed posture RunExecutionModule's parseRunExecutionConfig already
// uses). A caught fallback to "no retriever" would silently reproduce
// today's invisible RAG gap under a new disguise.
@Module({
  providers: [
    {
      provide: AGENT_RUN_SERVICE,
      useFactory: (handle: PrismaClientHandle) => {
        const repository = createPrismaAgentRunRepository(handle.prisma);
        return createAgentRunService(repository);
      },
      inject: [PRISMA_CLIENT_HANDLE],
    },
    {
      provide: TOOL_REGISTRY,
      useValue: new InMemoryToolRegistry([getServiceStatusTool]),
    },
    {
      provide: RUNBOOK_RETRIEVER,
      useFactory: async (): Promise<RunbookRetriever> => {
        const corpusLoad = await loadDefaultRunbookCorpus();
        return new InMemoryKeywordRunbookRetriever(corpusLoad.chunks);
      },
    },
  ],
  exports: [AGENT_RUN_SERVICE, TOOL_REGISTRY, RUNBOOK_RETRIEVER],
})
export class AgentRuntimeModule {}
