import opspilotContracts from "@opspilot/contracts";
import opspilotDatabase from "@opspilot/database";
import opspilotAgentRuntime from "@opspilot/agent-runtime";
import opspilotProviderClaude from "@opspilot/provider-claude";

// Real executable proof, run via the exact same tsx invocation style as every
// worker demo — a Vitest test proves Vitest's own module loader (vite-node)
// handles this interop; it does not prove apps/worker's actual tsx runtime
// does, since the two are similar but not necessarily identical. This
// script is the actual acceptance gate for the ESM(worker)<->CommonJS
// (shared packages) default-import interop design (see
// docs/11-agent-run-persistence.md / the Agent Run API plan).
const checks: Array<[string, boolean]> = [
  ["@opspilot/contracts ResolutionReportSchema", typeof opspilotContracts.ResolutionReportSchema === "object"],
  ["@opspilot/database createPrismaClient", typeof opspilotDatabase.createPrismaClient === "function"],
  ["@opspilot/database PersistenceError", typeof opspilotDatabase.PersistenceError === "function"],
  ["@opspilot/agent-runtime createAgentRunService", typeof opspilotAgentRuntime.createAgentRunService === "function"],
  ["@opspilot/agent-runtime FakeLlmProvider", typeof opspilotAgentRuntime.FakeLlmProvider === "function"],
  ["@opspilot/agent-runtime AgentRunServiceError", typeof opspilotAgentRuntime.AgentRunServiceError === "function"],
  // PR 6B1 relocated the Claude adapter into its own package, so it now has to
  // clear the same interop bar. A class, a function, and a plain constant are
  // checked separately: the getter-forwarding failure this script exists to
  // catch does not discriminate between them, but a partial barrel rewrite
  // would.
  ["@opspilot/provider-claude ClaudeLlmProvider", typeof opspilotProviderClaude.ClaudeLlmProvider === "function"],
  ["@opspilot/provider-claude createLlmProviderFactory", typeof opspilotProviderClaude.createLlmProviderFactory === "function"],
  ["@opspilot/provider-claude parseProviderConfig", typeof opspilotProviderClaude.parseProviderConfig === "function"],
  ["@opspilot/provider-claude requireSupportedClaudeModel", typeof opspilotProviderClaude.requireSupportedClaudeModel === "function"],
  ["@opspilot/provider-claude ProviderConfigError", typeof opspilotProviderClaude.ProviderConfigError === "function"],
  ["@opspilot/provider-claude SUPPORTED_CLAUDE_MODEL", opspilotProviderClaude.SUPPORTED_CLAUDE_MODEL === "claude-sonnet-5"],
];

const failures = checks.filter(([, ok]) => !ok);

if (failures.length > 0) {
  console.error("CommonJS/ESM interop smoke check FAILED:");
  for (const [label] of failures) console.error(`  - ${label}`);
  process.exitCode = 1;
} else {
  console.log(`CommonJS/ESM interop smoke check passed (${checks.length} checks).`);
}
