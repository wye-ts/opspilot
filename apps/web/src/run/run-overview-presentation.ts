import type { BadgeTone } from "../components/StatusBadge";

export interface RunStatusBadgePresentation {
  readonly tone: BadgeTone;
  readonly glyph: string;
}

// Shared by CurrentInvestigation and InvestigationSummary (same branches,
// same tone/glyph values) without duplicating the mapping. run.status is a
// loosely-typed `string`, not a narrowed union — the API mappers forward it
// as string (see api/types.ts's own comment on AgentRunOutcomeView), so this
// stays a soft switch/default, never exhaustive.
export function runStatusBadge(status: string): RunStatusBadgePresentation {
  switch (status) {
    case "COMPLETED":
      return { tone: "success", glyph: "✓" };
    case "FAILED":
      return { tone: "danger", glyph: "✕" };
    case "RUNNING":
      return { tone: "info", glyph: "●" };
    default:
      return { tone: "neutral", glyph: "—" };
  }
}
