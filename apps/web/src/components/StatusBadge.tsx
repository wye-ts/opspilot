export type BadgeTone = "neutral" | "info" | "success" | "danger";

export interface StatusBadgeProps {
  readonly tone: BadgeTone;
  readonly glyph: string;
  readonly label: string;
}

// Shared by run status (this PR) and approval status (PR 4B). Status is
// never communicated by color alone — every badge renders a text label and
// a leading glyph; color is redundant reinforcement only.
export function StatusBadge({ tone, glyph, label }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge-${tone}`}>
      <span aria-hidden="true">{glyph}</span> {label}
    </span>
  );
}
