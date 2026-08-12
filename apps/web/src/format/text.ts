// "MEDIUM" -> "Medium", "IN_PROGRESS" -> "In progress" — sentence-case
// display text for a SCREAMING_SNAKE_CASE enum value, never the raw enum
// verbatim. Matches the convention already established by runStatusBadge
// (run-overview-presentation.ts) for run status; shared here so every other
// enum-backed label (suggested-action priority/status, resolution report
// category) reads the same way instead of re-deriving the same transform.
export function humanizeEnum(value: string): string {
  const lower = value.toLowerCase().replace(/_/g, " ");
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
