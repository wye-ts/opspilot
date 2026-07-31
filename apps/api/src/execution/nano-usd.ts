/**
 * nanoUSD — integer billionths of a US dollar — is the only representation the
 * money path uses.
 *
 * $1.00 is 1_000_000_000n. The unit is fine enough that per-token Anthropic
 * rates are exact integers (claude-sonnet-5's $10/MTok output rate is exactly
 * 10_000 nanoUSD per token), which is the whole reason for it: costs can be
 * summed across turns and days with no rounding drift, and no floating-point
 * value ever participates in an accounting decision.
 */
export const NANO_USD_PER_USD = 1_000_000_000n;
export const NANO_USD_DECIMAL_PLACES = 9;

/**
 * Parses a decimal USD string into exact integer nanoUSD.
 *
 * Deliberately string-based, character by character: `Number("0.1") * 1e9`
 * yields 100000000.00000001, and any float intermediate would put a rounding
 * error into a spend ceiling. This function never constructs a float — the
 * integer and fractional digit groups are concatenated and handed to `BigInt`.
 *
 * Accepts `"1"`, `"1.0"`, `"1.00"`, `"0.5"`, and up to nine fractional digits.
 * Rejects a sign, exponent notation, whitespace inside the number, an empty
 * integer part (`".5"`), and more than nine fractional digits — the last
 * because sub-nanoUSD precision cannot be represented, and silently truncating
 * it would make the parsed ceiling quietly differ from the configured one.
 */
export function parseUsdDecimalToNanoUsd(raw: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(raw);
  if (match === null) {
    return null;
  }

  const [, whole, fraction = ""] = match;
  const paddedFraction = fraction.padEnd(NANO_USD_DECIMAL_PLACES, "0");

  return BigInt(`${whole}${paddedFraction}`);
}

/**
 * Formats integer nanoUSD as a fixed-precision decimal USD string.
 *
 * A STRING, never a number: `estimatedCostUsd` crosses the HTTP boundary as
 * text so no consumer can reintroduce float error, and so a `bigint` is never
 * handed to `JSON.stringify` (which throws on one). Six decimal places —
 * micro-dollars — because a two-turn demo run costs on the order of $0.01 and
 * `"0.02"` would round away most of the signal.
 */
export function formatNanoUsdAsUsdString(nanoUsd: bigint, decimalPlaces = 6): string {
  if (decimalPlaces < 0 || decimalPlaces > NANO_USD_DECIMAL_PLACES) {
    throw new Error(`decimalPlaces must be between 0 and ${NANO_USD_DECIMAL_PLACES}.`);
  }

  const negative = nanoUsd < 0n;
  const magnitude = negative ? -nanoUsd : nanoUsd;

  const whole = magnitude / NANO_USD_PER_USD;
  const fraction = magnitude % NANO_USD_PER_USD;

  const sign = negative ? "-" : "";
  if (decimalPlaces === 0) {
    return `${sign}${whole}`;
  }

  // Truncates rather than rounds. A displayed cost must never read higher than
  // the value actually accounted for.
  const fractionDigits = fraction.toString().padStart(NANO_USD_DECIMAL_PLACES, "0").slice(0, decimalPlaces);

  return `${sign}${whole}.${fractionDigits}`;
}
