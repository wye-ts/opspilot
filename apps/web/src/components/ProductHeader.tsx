// The OpsPilot product header. Carries ONLY product identity + the source
// link — never run state (Demo/Live/Running/Complete/Failed), which belongs
// to the Current investigation / Progress surfaces once a job exists (§4,
// §12 of the implementation prompt).
export function ProductHeader() {
  return (
    <header className="product-header">
      <div className="product-header-inner">
        <div className="product-header-brand">
          <span className="product-header-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <line x1="15.3" y1="15.3" x2="21" y2="21" />
            </svg>
          </span>
          <span className="product-header-title">OpsPilot</span>
          <span className="product-header-divider" aria-hidden="true" />
          <span className="product-header-tagline">AI Operations Investigator</span>
        </div>
        <a
          className="product-header-source"
          href="https://github.com/wye-ts/opspilot"
          target="_blank"
          rel="noopener noreferrer"
        >
          View source ↗
        </a>
      </div>
    </header>
  );
}
