// The only shape the v1 cross-language contract may carry for tool inputs
// (EvaluationExpectations.tool.expectedExecuted[].input and
// ObservedFacts.tools.executed[].input) — fixing an independent-review
// finding that both previously used `unknown`, so a value that can't
// actually survive a JSON round-trip (BigInt, Date, a class instance,
// undefined nested inside an array) could be accepted locally and either
// throw unexplainably at serialization time or silently change identity
// after being parsed back out.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class NonJsonSafeValueError extends Error {
  constructor(
    public readonly path: string,
    public readonly reason: string,
  ) {
    super(`Value at "${path}" is not JSON-safe: ${reason}`);
  }
}

// Deep-validates and deep-copies `value` into a JsonValue, throwing
// NonJsonSafeValueError on the first non-JSON-safe value encountered —
// never silently drops, coerces, or reinterprets a value the way
// JSON.stringify does (e.g. silently turning `undefined` into `null` inside
// an array, or silently dropping a BigInt-typed property with no error
// until much later).
export function toJsonValue(value: unknown, path = "$"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new NonJsonSafeValueError(path, `non-finite number (${String(value)})`);
    }
    return value;
  }

  if (Array.isArray(value)) {
    // A sparse array (e.g. `Array(1)`, or `[1, , 3]`) is not a stable JSON
    // value: Array.prototype.map/every skip holes, so a hole silently
    // survives local comparison as a distinct thing from `null`, while
    // JSON.stringify materializes every hole as `null`. That divergence is
    // exactly what would let local TypeScript scoring and a JSON-serialized
    // scorer (a future Python service, or even just this same array
    // round-tripped through JSON) disagree on the same input. Reject before
    // copying rather than silently converting the hole to `null`.
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new NonJsonSafeValueError(`${path}[${index}]`, "sparse array (missing index) is not JSON-safe");
      }
    }
    return value.map((entry, index) => toJsonValue(entry, `${path}[${index}]`));
  }

  if (typeof value === "object") {
    // Reject anything that isn't a plain object literal — Date, Map, Set,
    // RegExp, class instances, etc. all silently change shape or lose data
    // across a real JSON boundary even though `typeof x === "object"`.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      const ctorName =
        prototype !== null ? ((prototype as { constructor?: { name?: string } }).constructor?.name ?? "unknown") : "null-prototype object";
      throw new NonJsonSafeValueError(path, `not a plain object (${ctorName})`);
    }

    const result: Record<string, JsonValue> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (entryValue === undefined) {
        throw new NonJsonSafeValueError(`${path}.${key}`, "undefined is not JSON-safe");
      }
      // Plain assignment (`result[key] = ...`) would invoke the inherited
      // Object.prototype.__proto__ accessor for a key literally named
      // "__proto__" instead of creating an own property, silently dropping
      // a legal JSON key. Object.defineProperty always creates an own data
      // property regardless of key name, which is what plain assignment
      // already does for every other key.
      Object.defineProperty(result, key, {
        value: toJsonValue(entryValue, `${path}.${key}`),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }

  throw new NonJsonSafeValueError(path, `unsupported type "${typeof value}"`);
}
