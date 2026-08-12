import type { BadgeTone } from "../components/StatusBadge";

export interface RunStatusBadgePresentation {
  readonly tone: BadgeTone;
  readonly glyph: string;
  /**
   * Sentence-case display text ("Completed"/"Failed"/"Running") — never the
   * raw enum verbatim. Final UX Pilot fidelity pass: callers used to pass
   * `run.status` straight through, which rendered as oversized all-caps text
   * next to a restrained pill. Falls back to the raw status string for an
   * unrecognized value, since inventing a generic label would misrepresent it.
   */
  readonly label: string;
}

// Shared by CurrentInvestigation and the Progress Timeline header (same
// branches, same tone/glyph/label values) without duplicating the mapping.
// run.status is a loosely-typed `string`, not a narrowed union — the API
// mappers forward it as string (see api/types.ts's own comment on
// AgentRunOutcomeView), so this stays a soft switch/default, never exhaustive.
export function runStatusBadge(status: string): RunStatusBadgePresentation {
  switch (status) {
    case "COMPLETED":
      return { tone: "success", glyph: "✓", label: "Completed" };
    case "FAILED":
      return { tone: "danger", glyph: "✕", label: "Failed" };
    case "RUNNING":
      return { tone: "info", glyph: "●", label: "Running" };
    default:
      return { tone: "neutral", glyph: "—", label: status };
  }
}
