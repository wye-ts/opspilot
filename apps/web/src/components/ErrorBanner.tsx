export interface DisplayableError {
  readonly code: string;
  readonly message: string;
  readonly requestId: string | null;
}

export interface ErrorBannerProps {
  readonly error: DisplayableError;
  readonly onDismiss: () => void;
}

// role="alert" — an error interrupts, unlike the polite notice region. The
// message is always safe to display verbatim: it comes either from the
// API's closed error catalog or from one of http-client's two synthetic
// codes — never a raw response body, cause, or stack.
export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  return (
    <div className="error-banner" role="alert">
      <div className="error-banner-body">
        <p className="error-banner-message">{error.message}</p>
        <p className="error-banner-meta">
          <span className="mono">{error.code}</span>
          {error.requestId !== null ? <span className="mono error-banner-request-id"> · {error.requestId}</span> : null}
        </p>
      </div>
      <button type="button" className="error-banner-dismiss" onClick={onDismiss} aria-label="Dismiss error">
        ×
      </button>
    </div>
  );
}
