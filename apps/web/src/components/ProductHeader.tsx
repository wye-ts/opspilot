// The OpsPilot product header. Carries ONLY product identity + the source
// link — never run state (Demo/Live/Running/Complete/Failed), which belongs
// to the Current investigation / Progress surfaces once a job exists (§4,
// §12 of the implementation prompt).
//
// The mark is the approved OpsPilot brand symbol (apps/web/public/brand/),
// rendered as a decorative image with an empty alt — the "OpsPilot" wordmark
// below it is the real text, so a screen reader hears the product name once,
// never twice. The SVG is served directly, not rasterized.
export function ProductHeader() {
  return (
    <header className="product-header">
      <div className="product-header-inner">
        <div className="product-header-brand">
          <img
            className="product-header-mark"
            src="/brand/opspilot-mark.svg"
            alt=""
          />
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
