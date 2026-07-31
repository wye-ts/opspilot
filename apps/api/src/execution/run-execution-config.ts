import {
  parseProviderConfig,
  ProviderConfigError,
  type EnvRecord,
  type LiveCapability,
  type AgentRunProviderMode,
} from "@opspilot/provider-claude";

import { createLiveRunAccessPolicy, type LiveRunAccessPolicy } from "./live-run-access";
import { parseUsdDecimalToNanoUsd } from "./nano-usd";
import { DEFAULT_PROVIDER_DEADLINE_MS } from "./run-abort-context";

/**
 * The safeguards that stand between a public HTTP request and a paid Anthropic
 * call. Every one is bounded, every one has a default that is safe on its own,
 * and none of them is a substitute for the kill switch.
 *
 * Honest scope, stated here because the numbers invite over-reading:
 *
 *   - `maxConcurrency` and the rate limit are PER PROCESS. On the free
 *     single-instance plan that is also the global limit; on any multi-instance
 *     plan it is not.
 *   - `dailyLimit` is a HARD cap: it is reserved inside the same transaction
 *     that creates the run, before any provider call.
 *   - `dailyCostCeilingNanoUsd` is POST-RUN accounting on an ESTIMATE, not a
 *     hard cap on money. It stops *subsequent* runs once crossed, so the
 *     OBSERVED RECONCILED ESTIMATE can cross the ceiling by at most one
 *     in-flight logical run — a bound that holds only because `maxConcurrency`
 *     is pinned to exactly 1 (see REQUIRED_MAX_CONCURRENCY).
 *
 *     ACTUAL PROVIDER BILLING MAY BE HIGHER. An ambiguous network outcome or a
 *     process termination can leave real spend that no estimate ever observed.
 *     The hard control is the daily run COUNT, not the dollar figure.
 */
export interface LiveRunSafeguardConfig {
  /** Per-turn output ceiling for an API LIVE run — the exact, hard bound on output spend. */
  readonly maxOutputTokens: number;
  readonly maxAttemptsPerJob: number;
  /**
   * Concurrent live runs, PER PROCESS. Always exactly 1 in this release — see
   * REQUIRED_MAX_CONCURRENCY for why it is a fixed invariant rather than a
   * tunable range.
   */
  readonly maxConcurrency: number;
  readonly rateLimitMax: number;
  readonly rateLimitWindowMs: number;
  readonly dailyLimit: number;
  readonly dailyCostCeilingNanoUsd: bigint;
}

/**
 * Everything the run path needs to decide *how* a request executes, resolved
 * once at startup from the environment.
 *
 * The four concepts are kept separate deliberately, because they answer
 * different questions and a deployment can be in any combination of them:
 *
 *   defaultRequestMode  what a request that omits `providerMode` gets
 *   requested run mode  what THIS request asked for (per request; not here)
 *   liveCapability      whether this process CAN execute a live run at all
 *   liveAgentRunsEnabled whether it MAY start new live runs right now
 *
 * A server can be capable but switched off, or switched on but incapable, and
 * each produces a different, specific rejection. Collapsing any two of them
 * would make one of those rejections unrepresentable.
 */
export interface RunExecutionConfig {
  readonly defaultRequestMode: AgentRunProviderMode;
  readonly liveCapability: LiveCapability;
  /**
   * The live kill switch. Defaults to FALSE — a capable, correctly configured
   * deployment still refuses live runs until someone deliberately turns them
   * on. Adding a credential is therefore not sufficient to start spending
   * money; that takes a second, separate action.
   */
  readonly liveAgentRunsEnabled: boolean;
  readonly providerDeadlineMs: number;
  /**
   * Whether a LIVE request must present the shared demo token, and the only
   * means of checking one. Never carries the token value as a readable
   * property — see live-run-access.ts.
   */
  readonly liveRunAccess: LiveRunAccessPolicy;
  readonly liveRunSafeguards: LiveRunSafeguardConfig;
  /**
   * How many reverse-proxy hops in front of this process may be trusted to
   * have set `X-Forwarded-For`. A NUMBER, passed to `app.set("trust proxy", n)`.
   *
   * Never `true`: that makes Express take the LEFTMOST `X-Forwarded-For` entry,
   * which is whatever the client chose to send, so every rate-limit bucket
   * becomes client-selectable and the limiter stops limiting anything.
   *
   * REQUIRES EMPIRICAL VERIFICATION on Render before this value is trusted —
   * see docs/08-cicd-deployment.md.
   */
  readonly trustProxyHops: number;
}

const MIN_PROVIDER_DEADLINE_MS = 5_000;
const MAX_PROVIDER_DEADLINE_MS = 600_000;

// Defaults and ranges from docs/reviews/19-protected-live-claude-api-plan.md
// §6.2. The ranges exist to catch an operator typo — a stray zero on the daily
// limit is the difference between a demo and a bill — not to express policy.
export const LIVE_RUN_DEFAULTS = {
  maxOutputTokens: 1024,
  maxAttemptsPerJob: 2,
  maxConcurrency: 1,
  rateLimitMax: 2,
  rateLimitWindowMs: 60_000,
  dailyLimit: 10,
  dailyCostCeilingUsd: "1.00",
  trustProxyHops: 1,
} as const;

/**
 * Concurrent live runs is pinned to exactly 1 — NOT a tunable range.
 *
 * The daily cost ceiling is post-run accounting: a run reserves its slot, spends,
 * and only then contributes to the accumulated figure that closes the gate. The
 * documented guarantee is that the OBSERVED RECONCILED ESTIMATE can cross the
 * ceiling by at most one in-flight logical run, and that is true only at
 * concurrency 1.
 *
 * With N concurrent runs, all N can observe an accumulated cost below the
 * ceiling, all N reserve, and all N execute before any of them reconciles — so
 * the overrun bound becomes N bounded runs, not one. Accepting 2..4 while
 * documenting a one-run bound would make the safety claim false for three of the
 * four accepted values.
 *
 * Pinning it is the stronger and simpler choice for a first public release, and
 * it costs nothing here: the deployment is a free single-instance plan, the
 * lease is reject-never-queue, and 1 was the approved initial value. Raising it
 * later means re-deriving and re-documenting the overrun bound as a deliberate
 * act, which is exactly the review this constant forces.
 */
export const REQUIRED_MAX_CONCURRENCY = 1;

const LIVE_RUN_RANGES = {
  maxOutputTokens: { min: 256, max: 4096 },
  maxAttemptsPerJob: { min: 1, max: 10 },
  rateLimitMax: { min: 1, max: 60 },
  rateLimitWindowMs: { min: 1_000, max: 3_600_000 },
  dailyLimit: { min: 1, max: 1_000 },
  trustProxyHops: { min: 0, max: 5 },
} as const;

// An upper bound on the configurable ceiling, so a mistyped
// LIVE_RUN_DAILY_COST_CEILING_USD cannot authorize an unbounded post-run
// accounting window. Not a spend guarantee — see LiveRunSafeguardConfig.
const MAX_DAILY_COST_CEILING_NANO_USD = 1_000n * 1_000_000_000n;

/**
 * Only the exact lowercase strings are accepted. "True", "TRUE", "1", and
 * "yes" all fail startup rather than being guessed at, because guessing wrong
 * on this particular variable means either a dead feature or unintended spend
 * — and a typo that silently means `false` is indistinguishable from a
 * deliberate `false` until someone notices the demo does not work.
 *
 * Mirrors docker/entrypoint.sh's handling of RUN_MIGRATIONS_ON_START, which
 * takes the same position for the same reason.
 */
function parseStrictBoolean(raw: string | undefined, fallback: boolean, variableName: string): boolean {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  if (raw === "true") return true;
  if (raw === "false") return false;

  throw new ProviderConfigError(`${variableName} must be exactly 'true' or 'false'.`);
}

function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  variableName: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  // Number(), not parseInt(): parseInt("120s") yields 120, quietly accepting a
  // typo as a valid configuration.
  const value = Number(raw.trim());
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ProviderConfigError(`${variableName} must be an integer between ${min} and ${max}.`);
  }

  return value;
}

/**
 * Parses the dollar ceiling into exact integer nanoUSD.
 *
 * Never through a float — see parseUsdDecimalToNanoUsd. A ceiling of zero is
 * rejected: it would close the cost gate permanently, which is indistinguishable
 * from a typo, and the kill switch already expresses "no live runs" clearly.
 */
function parseCostCeilingNanoUsd(raw: string | undefined, variableName: string): bigint {
  const trimmed = raw?.trim();
  const effective =
    trimmed === undefined || trimmed === "" ? LIVE_RUN_DEFAULTS.dailyCostCeilingUsd : trimmed;

  const nanoUsd = parseUsdDecimalToNanoUsd(effective);
  if (nanoUsd === null) {
    throw new ProviderConfigError(
      `${variableName} must be a decimal USD amount such as '1.00', with at most 9 decimal places.`,
    );
  }

  if (nanoUsd <= 0n || nanoUsd > MAX_DAILY_COST_CEILING_NANO_USD) {
    throw new ProviderConfigError(`${variableName} must be greater than 0 and at most 1000 USD.`);
  }

  return nanoUsd;
}

/**
 * Accepts only the exact string "1" (or an absent/empty value, which defaults to
 * 1). Every other value — including in-range-looking ones like "2" — fails
 * startup rather than silently weakening the documented overrun guarantee.
 *
 * The message names the variable and never the supplied value, matching every
 * other parser here.
 */
function parseRequiredMaxConcurrency(raw: string | undefined, variableName: string): number {
  if (raw === undefined || raw.trim() === "") {
    return REQUIRED_MAX_CONCURRENCY;
  }

  if (raw.trim() === String(REQUIRED_MAX_CONCURRENCY)) {
    return REQUIRED_MAX_CONCURRENCY;
  }

  throw new ProviderConfigError(
    `${variableName} must be exactly '1' in this release. The documented cost-ceiling ` +
      "bound — that the observed reconciled estimate can cross the ceiling by at most one " +
      "in-flight logical run — holds only at a concurrency of 1.",
  );
}

function parseLiveRunSafeguards(env: EnvRecord): LiveRunSafeguardConfig {
  return {
    maxOutputTokens: parseBoundedInteger(
      env.LIVE_RUN_MAX_OUTPUT_TOKENS,
      LIVE_RUN_DEFAULTS.maxOutputTokens,
      LIVE_RUN_RANGES.maxOutputTokens.min,
      LIVE_RUN_RANGES.maxOutputTokens.max,
      "LIVE_RUN_MAX_OUTPUT_TOKENS",
    ),
    maxAttemptsPerJob: parseBoundedInteger(
      env.LIVE_RUN_MAX_ATTEMPTS_PER_JOB,
      LIVE_RUN_DEFAULTS.maxAttemptsPerJob,
      LIVE_RUN_RANGES.maxAttemptsPerJob.min,
      LIVE_RUN_RANGES.maxAttemptsPerJob.max,
      "LIVE_RUN_MAX_ATTEMPTS_PER_JOB",
    ),
    maxConcurrency: parseRequiredMaxConcurrency(
      env.LIVE_RUN_MAX_CONCURRENCY,
      "LIVE_RUN_MAX_CONCURRENCY",
    ),
    rateLimitMax: parseBoundedInteger(
      env.LIVE_RUN_RATE_LIMIT_MAX,
      LIVE_RUN_DEFAULTS.rateLimitMax,
      LIVE_RUN_RANGES.rateLimitMax.min,
      LIVE_RUN_RANGES.rateLimitMax.max,
      "LIVE_RUN_RATE_LIMIT_MAX",
    ),
    rateLimitWindowMs: parseBoundedInteger(
      env.LIVE_RUN_RATE_LIMIT_WINDOW_MS,
      LIVE_RUN_DEFAULTS.rateLimitWindowMs,
      LIVE_RUN_RANGES.rateLimitWindowMs.min,
      LIVE_RUN_RANGES.rateLimitWindowMs.max,
      "LIVE_RUN_RATE_LIMIT_WINDOW_MS",
    ),
    dailyLimit: parseBoundedInteger(
      env.LIVE_RUN_DAILY_LIMIT,
      LIVE_RUN_DEFAULTS.dailyLimit,
      LIVE_RUN_RANGES.dailyLimit.min,
      LIVE_RUN_RANGES.dailyLimit.max,
      "LIVE_RUN_DAILY_LIMIT",
    ),
    dailyCostCeilingNanoUsd: parseCostCeilingNanoUsd(
      env.LIVE_RUN_DAILY_COST_CEILING_USD,
      "LIVE_RUN_DAILY_COST_CEILING_USD",
    ),
  };
}

/**
 * Resolves the access policy, and refuses the one combination that would put a
 * tokenless LIVE path in front of the public internet.
 *
 * The token is optional *as long as LIVE cannot actually be served*. That is
 * the shipped state — kill switch off, no credential, no token — and it is the
 * state CI and local development run in. But a deployment that has both a
 * credential and the switch on is one HTTP request away from spending money on
 * behalf of an anonymous caller, and this milestone ships no public tokenless
 * mode. So that combination fails startup rather than serving.
 *
 * Failing startup rather than resolving to "LIVE unavailable" is deliberate: an
 * operator who set the switch to `true` clearly intended live runs, and
 * silently disabling them would be the same misleading half-configured state
 * that parseProviderConfig already refuses for a partial Anthropic config.
 */
function parseLiveRunAccess(
  env: EnvRecord,
  liveCapability: LiveCapability,
  liveAgentRunsEnabled: boolean,
): LiveRunAccessPolicy {
  const rawToken = env.LIVE_RUN_ACCESS_TOKEN?.trim();
  const hasToken = rawToken !== undefined && rawToken !== "";

  if (!hasToken) {
    if (liveCapability.kind === "present" && liveAgentRunsEnabled) {
      throw new ProviderConfigError(
        "LIVE_RUN_ACCESS_TOKEN is required when LIVE_AGENT_RUNS_ENABLED=true and Anthropic " +
          "configuration is present. This release ships no tokenless public LIVE mode.",
      );
    }

    return { kind: "absent" };
  }

  return createLiveRunAccessPolicy(rawToken);
}

/**
 * Refuses opaque SDK retries on the protected public LIVE path.
 *
 * The Anthropic SDK surfaces only the FINAL attempt of a retried request. With
 * retries enabled, an earlier attempt can reach Anthropic, be billed, and never
 * appear in the usage collector — so no run's cost figure can be claimed as
 * complete. The collector now marks every such success `possibleUnobservedCost`
 * (see createRunProviderUsageCollector), which is honest but degrades the whole
 * public path: EVERY live run would report an unknown cost, and every run would
 * increment `pricing_unknown_runs` and close the day's cost gate.
 *
 * The right fix is upstream of the accounting. The per-job LIVE attempt limit is
 * already an explicit, durable, observable retry boundary — a retry allocates a
 * new AgentRun row, counts against the job's cap, and reserves its own budget
 * slot. An opaque in-SDK retry inside one logical attempt is the same spend with
 * none of those properties. So the protected path takes the explicit one and
 * forbids the opaque one.
 *
 * Scoped to the PROTECTED PUBLIC path only: this fires when capability is present
 * AND the kill switch is on. A worker or manually operated flow — kill switch off
 * — keeps the provider package's own default and range, because there the
 * operator is present, the spend is theirs, and no public caller is exposed to
 * the ambiguity.
 *
 * The message names the variable and never its value, like every other
 * configuration failure here.
 */
function assertNoOpaqueRetriesOnProtectedLivePath(
  liveCapability: LiveCapability,
  liveAgentRunsEnabled: boolean,
): void {
  if (liveCapability.kind !== "present" || !liveAgentRunsEnabled) {
    return;
  }

  // Read from the already-parsed capability rather than re-parsing the raw
  // string: parseProviderConfig has validated the range and applied the default,
  // so this cannot disagree with the value the client is actually built with.
  if (liveCapability.anthropic.maxRetries !== 0) {
    throw new ProviderConfigError(
      "ANTHROPIC_MAX_RETRIES must be exactly 0 when LIVE_AGENT_RUNS_ENABLED=true and Anthropic " +
        "configuration is present. An earlier retried attempt may have reached the provider and " +
        "may have been billed, without being observable, so a live run's " +
        "cost could not be reported honestly. Use the per-job live attempt limit instead.",
    );
  }
}

/**
 * Parses a plain environment record — never `process.env` directly — so the
 * whole surface is unit-testable without mutating ambient state.
 *
 * Every failure throws. A throw here happens during Nest's dependency-injection
 * phase, which (because main.ts passes `abortOnError: false`) surfaces as a
 * rejected bootstrap promise: the process logs a fixed startup-failure message
 * and exits without ever binding a port. There is no configuration this
 * function accepts by degrading it to something weaker.
 */
export function parseRunExecutionConfig(env: EnvRecord): RunExecutionConfig {
  const providerConfig = parseProviderConfig(env);

  const liveAgentRunsEnabled = parseStrictBoolean(
    env.LIVE_AGENT_RUNS_ENABLED,
    false,
    "LIVE_AGENT_RUNS_ENABLED",
  );

  // Access policy FIRST, then the retry invariant. Both guard the same servable
  // combination, so an operator who has just switched LIVE on can trip either —
  // and "you are one request away from anonymous paid execution" is the more
  // urgent of the two messages to surface. Ordering them here rather than
  // relying on evaluation order inside the object literal below makes that a
  // decision rather than an accident.
  const liveRunAccess = parseLiveRunAccess(
    env,
    providerConfig.liveCapability,
    liveAgentRunsEnabled,
  );

  assertNoOpaqueRetriesOnProtectedLivePath(providerConfig.liveCapability, liveAgentRunsEnabled);

  return {
    defaultRequestMode: providerConfig.defaultRequestMode,
    liveCapability: providerConfig.liveCapability,
    liveAgentRunsEnabled,
    providerDeadlineMs: parseBoundedInteger(
      env.AGENT_RUN_PROVIDER_DEADLINE_MS,
      DEFAULT_PROVIDER_DEADLINE_MS,
      MIN_PROVIDER_DEADLINE_MS,
      MAX_PROVIDER_DEADLINE_MS,
      "AGENT_RUN_PROVIDER_DEADLINE_MS",
    ),
    liveRunAccess,
    liveRunSafeguards: parseLiveRunSafeguards(env),
    trustProxyHops: parseBoundedInteger(
      env.TRUST_PROXY_HOPS,
      LIVE_RUN_DEFAULTS.trustProxyHops,
      LIVE_RUN_RANGES.trustProxyHops.min,
      LIVE_RUN_RANGES.trustProxyHops.max,
      "TRUST_PROXY_HOPS",
    ),
  };
}
