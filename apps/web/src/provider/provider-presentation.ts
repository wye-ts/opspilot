import type { CapabilitiesView } from "../api/types";

export type ProviderModeChoice = "FAKE" | "LIVE";

/**
 * The grounded current-model display name — the exact model identifier the
 * provider layer already reports for live runs (`claude-sonnet-5`). Shown as
 * secondary, read-only metadata only while LIVE is genuinely available; it is
 * never a claim that a model executed, only that this is the configured model.
 */
export const CURRENT_MODEL_LABEL = "claude-sonnet-5";

export type AvailabilityPillTone = "success" | "warning" | "neutral";

export interface AvailabilityPill {
  readonly text: string;
  readonly tone: AvailabilityPillTone;
}

export interface ProviderCardPresentation {
  readonly mode: ProviderModeChoice;
  /** The primary execution-mode label — `Demo` or `Live`, never `Live Claude`. */
  readonly label: string;
  /** Secondary supporting copy beneath the label. */
  readonly supportingCopy: string;
  /** Truthful availability pill, or `null` when none should render. */
  readonly pill: AvailabilityPill | null;
  /** Whether this mode can be selected right now. */
  readonly disabled: boolean;
  /**
   * Short truthful reason shown when unavailable — a disabled card is
   * explained, never hidden, so the feature reads as protected rather than
   * absent.
   */
  readonly unavailableReason: string | null;
  /**
   * Read-only current-model metadata. Only ever set for LIVE, and only when
   * LIVE is genuinely available.
   */
  readonly currentModel: string | null;
}

const DEMO_SUPPORTING_COPY = "Deterministic · Fast · No model cost";
const LIVE_SUPPORTING_COPY = "Real model execution";

const DEMO_UNAVAILABLE_REASON = null;
const LIVE_UNAVAILABLE_REASON = "Temporarily unavailable — the deterministic demo is always available.";
const VISITOR_QUOTA_EXHAUSTED_REASON =
  "You've already used today's live trial run — the deterministic demo is always available.";

/**
 * Pure capabilities -> provider-card presentation mapping, tested
 * independently of React (see provider/provider-presentation.test.ts).
 *
 * Availability is separate from mode identity: the Demo card is always
 * selectable; the Live card's availability collapses the same way the form's
 * old radio help text did — liveAgentRuns !== AVAILABLE, or this visitor's
 * own public-trial quota already used — into one "cannot be offered" state
 * with distinct truthful reasons.
 */
export function presentProviders(capabilities: CapabilitiesView | null): {
  readonly demo: ProviderCardPresentation;
  readonly live: ProviderCardPresentation;
} {
  const isPublicTrial = capabilities?.liveAccess === "PUBLIC_TRIAL";
  const visitorRunsRemaining = isPublicTrial ? (capabilities?.visitorRunsRemaining ?? 0) : null;
  const liveUnavailableOutright = capabilities?.liveAgentRuns !== "AVAILABLE";
  const liveQuotaUsed = isPublicTrial && visitorRunsRemaining === 0;
  const liveAvailable = !liveUnavailableOutright && !liveQuotaUsed;

  const liveUnavailableReason =
    liveQuotaUsed && isPublicTrial ? VISITOR_QUOTA_EXHAUSTED_REASON : LIVE_UNAVAILABLE_REASON;

  const livePill: AvailabilityPill | null =
    liveAvailable && isPublicTrial && visitorRunsRemaining === 1
      ? { text: "Daily trial available", tone: "success" }
      : liveAvailable
        ? { text: "Available", tone: "success" }
        : liveQuotaUsed && isPublicTrial
          ? { text: "Daily trial used", tone: "warning" }
          : { text: "Temporarily unavailable", tone: "neutral" };

  return {
    demo: {
      mode: "FAKE",
      label: "Demo",
      supportingCopy: DEMO_SUPPORTING_COPY,
      pill: { text: "Available", tone: "success" },
      disabled: false,
      unavailableReason: DEMO_UNAVAILABLE_REASON,
      currentModel: null,
    },
    live: {
      mode: "LIVE",
      label: "Live",
      supportingCopy: LIVE_SUPPORTING_COPY,
      pill: livePill,
      disabled: !liveAvailable,
      unavailableReason: liveAvailable ? null : liveUnavailableReason,
      currentModel: liveAvailable ? `${CURRENT_MODEL_LABEL} · Current model` : null,
    },
  };
}
