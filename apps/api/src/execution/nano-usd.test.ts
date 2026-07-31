import { describe, expect, it } from "vitest";

import {
  NANO_USD_PER_USD,
  formatNanoUsdAsUsdString,
  parseUsdDecimalToNanoUsd,
} from "./nano-usd";

describe("parseUsdDecimalToNanoUsd", () => {
  it.each([
    ["1.00", 1_000_000_000n],
    ["1", 1_000_000_000n],
    ["1.0", 1_000_000_000n],
    ["0.5", 500_000_000n],
    ["0.000000001", 1n],
    ["0", 0n],
    ["10.25", 10_250_000_000n],
    ["1000", 1_000_000_000_000n],
    ["0.017956", 17_956_000n],
  ])("parses %o as %o nanoUSD", (raw, expected) => {
    expect(parseUsdDecimalToNanoUsd(raw)).toBe(expected);
  });

  it("never routes the value through a float", () => {
    // Number("0.1") * 1e9 is 100000000.00000001 — the exact failure this
    // function exists to avoid. String concatenation into BigInt cannot drift.
    expect(parseUsdDecimalToNanoUsd("0.1")).toBe(100_000_000n);
    expect(parseUsdDecimalToNanoUsd("0.3")).toBe(300_000_000n);
    expect(parseUsdDecimalToNanoUsd("0.7")).toBe(700_000_000n);
  });

  it("preserves precision beyond Number.MAX_SAFE_INTEGER", () => {
    // 20,000,000 USD in nanoUSD is 2e16, past 2^53. A float-based parse would
    // silently lose the low digits.
    const parsed = parseUsdDecimalToNanoUsd("20000000.000000007");

    expect(parsed).toBe(20_000_000_000_000_007n);
    expect(parsed).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER));
  });

  it.each([
    ["-1.00", "a sign"],
    ["+1.00", "a leading plus"],
    ["1e9", "exponent notation"],
    [".5", "an empty integer part"],
    ["1.", "a trailing separator"],
    ["1.0000000001", "more than nine decimal places"],
    ["1,00", "a comma separator"],
    ["$1.00", "a currency symbol"],
    ["1 00", "interior whitespace"],
    ["abc", "letters"],
    ["", "an empty string"],
    ["Infinity", "a non-finite word"],
    ["NaN", "NaN"],
  ])("rejects %o (%s)", (raw) => {
    expect(parseUsdDecimalToNanoUsd(raw)).toBeNull();
  });

  it("agrees with the nanoUSD-per-USD constant", () => {
    expect(parseUsdDecimalToNanoUsd("1")).toBe(NANO_USD_PER_USD);
  });
});

describe("formatNanoUsdAsUsdString", () => {
  it.each([
    [1_000_000_000n, "1.000000"],
    [17_956_000n, "0.017956"],
    [0n, "0.000000"],
    [1n, "0.000000"],
    [204_800_000n, "0.204800"],
    [1_234_567_891n, "1.234567"],
  ])("formats %o nanoUSD as %o", (nanoUsd, expected) => {
    expect(formatNanoUsdAsUsdString(nanoUsd)).toBe(expected);
  });

  it("returns a string, never a number, so money never becomes a JSON number", () => {
    const formatted = formatNanoUsdAsUsdString(17_956_000n);

    expect(typeof formatted).toBe("string");
    expect(JSON.parse(JSON.stringify({ estimatedCostUsd: formatted }))).toEqual({
      estimatedCostUsd: "0.017956",
    });
  });

  it("truncates rather than rounding up, so a displayed cost never overstates the accounted one", () => {
    // 0.0000009999 USD would round to 0.000001; truncation keeps it at zero.
    expect(formatNanoUsdAsUsdString(999n)).toBe("0.000000");
    expect(formatNanoUsdAsUsdString(1_999_999n)).toBe("0.001999");
  });

  it("survives values beyond Number.MAX_SAFE_INTEGER intact", () => {
    expect(formatNanoUsdAsUsdString(20_000_000_000_000_007n)).toBe("20000000.000000");
  });

  it("honours an explicit precision", () => {
    expect(formatNanoUsdAsUsdString(1_234_567_891n, 9)).toBe("1.234567891");
    expect(formatNanoUsdAsUsdString(1_234_567_891n, 2)).toBe("1.23");
    expect(formatNanoUsdAsUsdString(1_234_567_891n, 0)).toBe("1");
  });

  it("rejects a precision finer than nanoUSD", () => {
    expect(() => formatNanoUsdAsUsdString(1n, 10)).toThrow(/between 0 and 9/);
    expect(() => formatNanoUsdAsUsdString(1n, -1)).toThrow(/between 0 and 9/);
  });

  it("round-trips a parsed ceiling back to its configured text", () => {
    const parsed = parseUsdDecimalToNanoUsd("1.00");
    if (parsed === null) throw new Error("expected '1.00' to parse");

    expect(formatNanoUsdAsUsdString(parsed, 2)).toBe("1.00");
  });
});
