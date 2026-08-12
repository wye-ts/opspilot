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
      {/* Final UX Pilot fidelity pass, HQ item 7 — a custom chevron that
          rotates on open, replacing the bare native disclosure marker
          (hidden via CSS). Shared by Agent Activity and Run Details, so
          fixing it here fixes both consistently in one place. Final polish
          pass — an inline SVG stroke-chevron (consistent weight at any
          size) replaces the earlier "▸" glyph, which read as a tiny,
          font-dependent, native-marker-like mark rather than a deliberate
          icon. */}
      <summary>
        <span className="technical-details-chevron" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
        {/* Its own element, not a bare text node beside the glyph above, so
            `getByText("Technical details")` and `textContent === "Technical
            details"` assertions keep matching this exactly (App.visual-polish.test.tsx). */}
        <span>Technical details</span>
      </summary>
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
