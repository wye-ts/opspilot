export const AGENT_RUN_SERVICE = "AGENT_RUN_SERVICE";
export const TOOL_REGISTRY = "TOOL_REGISTRY";
// Called DETERMINISTIC_PROVIDER_FACTORY before PR 6B1. The factory now builds
// either provider, chosen per run, so the old name described only half of what
// it does.
export const AGENT_PROVIDER_FACTORY = "AGENT_PROVIDER_FACTORY";
export const RUN_EXECUTION_CONFIG = "RUN_EXECUTION_CONFIG";
export const LIVE_RUN_ADMISSION = "LIVE_RUN_ADMISSION";
export const USAGE_HOOKS = "USAGE_HOOKS";
// Issue #72 §2.2: the single RunbookRetriever this process uses, built once
// at module-init from the default (on-disk) runbook corpus — never
// constructed per-run. See AgentRuntimeModule for the factory that fails
// container startup loudly on a corpus-load failure.
export const RUNBOOK_RETRIEVER = "RUNBOOK_RETRIEVER";
