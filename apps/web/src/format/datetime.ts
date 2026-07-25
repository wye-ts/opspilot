const PLACEHOLDER = "—";

function parseIso(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Never "Invalid Date" — an unparseable or absent value always renders the
// same em-dash placeholder used across the app for "no value".
export function formatDateTime(value: string | null): string {
  if (value === null) return PLACEHOLDER;
  const date = parseIso(value);
  if (date === null) return PLACEHOLDER;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// Run-level duration only — no per-event timestamp exists over the wire
// (AgentTraceEventSchema carries no time field), so this is never used for
// trace steps, only for run.startedAt/finishedAt.
export function formatDuration(startedAt: string, finishedAt: string | null): string {
  if (finishedAt === null) return PLACEHOLDER;
  const start = parseIso(startedAt);
  const end = parseIso(finishedAt);
  if (start === null || end === null) return PLACEHOLDER;

  const totalMs = end.getTime() - start.getTime();
  if (totalMs < 0) return PLACEHOLDER;

  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
