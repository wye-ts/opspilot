// A <details> disclosure for raw, sanitized technical identifiers. Used by
// Agent Activity to keep tool names / call ids out of the primary copy (§14).
// Only grounded identifiers ever reach here — never secrets, tokens, prompts,
// payloads, or stack traces.
export interface TechnicalDetailsRow {
  readonly label: string;
  readonly value: string;
}

export interface TechnicalDetailsProps {
  readonly rows: readonly TechnicalDetailsRow[];
}

export function TechnicalDetails({ rows }: TechnicalDetailsProps) {
  if (rows.length === 0) return null;
  return (
    <details className="technical-details">
      <summary>Technical details</summary>
      <dl className="technical-details-list">
        {rows.map((row, index) => (
          <div key={index} className="technical-details-row">
            <dt>{row.label}</dt>
            <dd className="mono">{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
