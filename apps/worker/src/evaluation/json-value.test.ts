import { describe, expect, it } from "vitest";

import { NonJsonSafeValueError, toJsonValue } from "./json-value";

describe("toJsonValue", () => {
  it("accepts and deep-copies plain JSON-safe values unchanged", () => {
    expect(toJsonValue(null)).toBeNull();
    expect(toJsonValue("s")).toBe("s");
    expect(toJsonValue(true)).toBe(true);
    expect(toJsonValue(42)).toBe(42);
    expect(toJsonValue([1, "a", null, true])).toEqual([1, "a", null, true]);
    expect(toJsonValue({ a: 1, b: { c: [1, 2, 3] } })).toEqual({ a: 1, b: { c: [1, 2, 3] } });
  });

  it("rejects BigInt (the independent review's reproduction case)", () => {
    expect(() => toJsonValue({ count: 1n })).toThrow(NonJsonSafeValueError);
  });

  it("rejects non-finite numbers (NaN, Infinity)", () => {
    expect(() => toJsonValue(Number.NaN)).toThrow(NonJsonSafeValueError);
    expect(() => toJsonValue(Number.POSITIVE_INFINITY)).toThrow(NonJsonSafeValueError);
  });

  it("rejects undefined, at the top level and nested inside an object", () => {
    expect(() => toJsonValue(undefined)).toThrow(NonJsonSafeValueError);
    expect(() => toJsonValue({ a: undefined })).toThrow(NonJsonSafeValueError);
  });

  it("rejects undefined nested inside an array, rather than silently coercing it to null the way JSON.stringify does", () => {
    expect(() => toJsonValue([1, undefined, 2])).toThrow(NonJsonSafeValueError);
  });

  it("rejects a Date instance", () => {
    expect(() => toJsonValue({ when: new Date() })).toThrow(NonJsonSafeValueError);
  });

  it("rejects a Map/Set instance", () => {
    expect(() => toJsonValue(new Map())).toThrow(NonJsonSafeValueError);
    expect(() => toJsonValue(new Set())).toThrow(NonJsonSafeValueError);
  });

  it("rejects a class instance (not a plain object literal)", () => {
    class Point {
      constructor(
        public x: number,
        public y: number,
      ) {}
    }
    expect(() => toJsonValue(new Point(1, 2))).toThrow(NonJsonSafeValueError);
  });

  it("rejects a function", () => {
    expect(() => toJsonValue(() => "x")).toThrow(NonJsonSafeValueError);
  });

  it("rejects a symbol", () => {
    expect(() => toJsonValue(Symbol("x"))).toThrow(NonJsonSafeValueError);
  });

  it("normalizes an own __proto__ key as an ordinary JSON property instead of dropping it via the inherited accessor", () => {
    const parsed: unknown = JSON.parse('{"__proto__":{"enabled":true},"service":"api"}');
    const normalized = toJsonValue(parsed);

    expect(Object.prototype.hasOwnProperty.call(normalized, "__proto__")).toBe(true);
    expect((normalized as Record<string, unknown>).__proto__).toEqual({ enabled: true });
    expect((normalized as Record<string, unknown>).service).toBe("api");
    expect(JSON.stringify(normalized)).toBe('{"__proto__":{"enabled":true},"service":"api"}');
  });

  it("round-trips an own __proto__ key through JSON.parse -> toJsonValue -> JSON.stringify -> JSON.parse", () => {
    const original: unknown = JSON.parse('{"__proto__":{"enabled":true},"service":"api"}');
    const roundTripped: unknown = JSON.parse(JSON.stringify(toJsonValue(original)));

    expect(Object.prototype.hasOwnProperty.call(roundTripped, "__proto__")).toBe(true);
    expect((roundTripped as Record<string, unknown>).__proto__).toEqual({ enabled: true });
    expect((roundTripped as Record<string, unknown>).service).toBe("api");
  });

  it("rejects a sparse array (Codex MAJOR: local-vs-serialized scorer divergence)", () => {
    expect(() => toJsonValue(Array(1))).toThrow(NonJsonSafeValueError);
  });

  it("rejects a sparse array nested inside an object", () => {
    expect(() => toJsonValue({ items: Array(1) })).toThrow(NonJsonSafeValueError);
  });

  it("rejects a sparse array with a hole in the middle, not just a trailing hole", () => {
    const withHole: unknown[] = [];
    withHole[0] = 1;
    withHole[2] = 3;
    expect(withHole.length).toBe(3);
    expect(() => toJsonValue(withHole)).toThrow(NonJsonSafeValueError);
  });

  it("accepts a dense array containing an explicit null — only a missing index (a hole) is rejected, not the null value itself", () => {
    expect(toJsonValue([1, null, 3])).toEqual([1, null, 3]);
    expect(() => toJsonValue([1, null, 3])).not.toThrow();
  });

  it("a dense nested array/object value survives a JSON round-trip unchanged", () => {
    const value = { a: [1, { b: [null, "x", { c: 2 }] }, 3], d: null };
    const normalized = toJsonValue(value);
    const roundTripped: unknown = JSON.parse(JSON.stringify(normalized));

    expect(normalized).toEqual(value);
    expect(roundTripped).toEqual(value);
  });

  it("error identifies the exact path of the offending value, not just that something failed", () => {
    let caught: unknown;
    try {
      toJsonValue({ a: { b: [{ c: 1n }] } }, "root");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(NonJsonSafeValueError);
    expect((caught as NonJsonSafeValueError).path).toBe("root.a.b[0].c");
  });
});
