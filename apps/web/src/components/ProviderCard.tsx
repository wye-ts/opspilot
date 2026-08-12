import type { ProviderCardPresentation } from "../provider/provider-presentation";

export interface ProviderCardProps {
  readonly presentation: ProviderCardPresentation;
  readonly name: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  /** Form-level lock while a workflow is in flight. */
  readonly disabled: boolean;
}

// Whole-card radio option: the label wraps the input, so the entire card is
// the hit target and keyboard/radio semantics come from the native input.
// A disabled (unavailable) card is explained, never hidden — see
// presentProviders' unavailableReason.
export function ProviderCard({ presentation, name, checked, onChange, disabled }: ProviderCardProps) {
  const className = ["provider-card", checked ? "provider-card--selected" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <label
      className={className}
      data-mode={presentation.mode}
      aria-disabled={presentation.disabled || disabled}
    >
      <input
        type="radio"
        name={name}
        value={presentation.mode}
        checked={checked}
        disabled={presentation.disabled || disabled}
        onChange={onChange}
        className="provider-card-radio"
      />
      <span className="provider-card-body">
        <span className="provider-card-heading">
          <span className="provider-card-label">{presentation.label}</span>
          {presentation.pill !== null ? (
            <span className={`availability-pill availability-pill--${presentation.pill.tone}`}>
              <span className="availability-pill-dot" aria-hidden="true" />
              {presentation.pill.text}
            </span>
          ) : null}
        </span>
        <span className="provider-card-copy">{presentation.supportingCopy}</span>
        {presentation.currentModel !== null ? (
          <span className="provider-card-model">{presentation.currentModel}</span>
        ) : null}
        {presentation.unavailableReason !== null ? (
          <span className="provider-card-unavailable">{presentation.unavailableReason}</span>
        ) : null}
      </span>
    </label>
  );
}
