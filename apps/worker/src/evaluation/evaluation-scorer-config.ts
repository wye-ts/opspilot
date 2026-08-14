// Scorer selection configuration for the evaluation CLI, read from the
// environment (see apps/worker/.env.example). Mirrors the fail-closed env
// parsing conventions of packages/provider-claude/src/claude-config.ts: a
// plain EnvRecord (never process.env directly, so it is unit-testable),
// strict validation, and error messages that name the offending variable but
// never interpolate its value.
//
// Modes (OpsPilot #61 Phase 4 default cutover): "service" (the default when
// EVALUATION_SCORER is unset/empty) posts the normalized v1 suite to the
// Python/FastAPI evaluation service over HTTP — the default, authoritative
// scorer. "local" is now an explicit-only opt-in: it runs LocalEvaluationScorer,
// the frozen v1 migration/parity oracle, in-process (see LocalEvaluationScorer
// in evaluation-scorer.ts). There is deliberately NO automatic fallback
// between the two in either direction — an unreachable service fails the
// evaluation (see service-unavailable.test.ts) rather than silently scoring
// locally, and EVALUATION_SERVICE_URL remains required whenever the selected
// mode is "service", whether selected explicitly or by default.
import type { EvaluationScorerSelection } from "./evaluation-scorer";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

// Sane bounded bounds for the single remote-scoring request timeout,
// mirroring the bounds used for provider timeouts in claude-config.ts.
export const DEFAULT_EVALUATION_SERVICE_TIMEOUT_MS = 15_000;
export const MIN_EVALUATION_SERVICE_TIMEOUT_MS = 1_000;
export const MAX_EVALUATION_SERVICE_TIMEOUT_MS = 600_000;

export class EvaluationScorerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluationScorerConfigError";
  }
}

// Resolves EVALUATION_SCORER / EVALUATION_SERVICE_URL /
// EVALUATION_SERVICE_TIMEOUT_MS into an EvaluationScorerSelection. Fails
// closed on: an unknown scorer mode, service mode without an absolute http(s)
// URL, or an out-of-bounds timeout. Resolves to the SERVICE selection when
// EVALUATION_SCORER is unset/empty (OpsPilot #61 Phase 4 default cutover) —
// including the same required-URL fail-closed check as an explicit
// EVALUATION_SCORER=service, so a default-mode run with no
// EVALUATION_SERVICE_URL configured still fails clearly instead of silently
// resolving to local.
export function resolveScorerSelectionFromEnv(env: EnvRecord): EvaluationScorerSelection {
  const rawMode = env.EVALUATION_SCORER?.trim();
  const mode = rawMode === undefined || rawMode === "" ? "service" : rawMode;

  if (mode === "local") return { scorerMode: "LOCAL" };

  if (mode !== "service") {
    throw new EvaluationScorerConfigError("EVALUATION_SCORER must be exactly 'local' or 'service'.");
  }

  const serviceUrl = env.EVALUATION_SERVICE_URL?.trim();
  if (serviceUrl === undefined || serviceUrl === "") {
    throw new EvaluationScorerConfigError("EVALUATION_SERVICE_URL is required when EVALUATION_SCORER=service.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(serviceUrl);
  } catch {
    throw new EvaluationScorerConfigError(
      "EVALUATION_SERVICE_URL must be an absolute http(s) URL when EVALUATION_SCORER=service.",
    );
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new EvaluationScorerConfigError(
      "EVALUATION_SERVICE_URL must be an absolute http(s) URL when EVALUATION_SCORER=service.",
    );
  }

  return {
    scorerMode: "SERVICE",
    serviceUrl,
    timeoutMs: parseServiceTimeoutMs(env.EVALUATION_SERVICE_TIMEOUT_MS),
  };
}

function parseServiceTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_EVALUATION_SERVICE_TIMEOUT_MS;
  const value = Number(raw.trim());
  if (
    !Number.isInteger(value) ||
    value < MIN_EVALUATION_SERVICE_TIMEOUT_MS ||
    value > MAX_EVALUATION_SERVICE_TIMEOUT_MS
  ) {
    throw new EvaluationScorerConfigError(
      `EVALUATION_SERVICE_TIMEOUT_MS must be an integer between ${MIN_EVALUATION_SERVICE_TIMEOUT_MS} and ${MAX_EVALUATION_SERVICE_TIMEOUT_MS}.`,
    );
  }
  return value;
}
