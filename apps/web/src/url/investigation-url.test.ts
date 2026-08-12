import { describe, expect, it } from "vitest";
import {
  isUuid,
  readJobParam,
  urlWithTransientParamsRemoved,
  withJobParam,
  withoutJobParam,
} from "./investigation-url";

const VALID_UUID = "0313ac34-6394-4f6d-9be1-ec277daa69dd";

describe("isUuid", () => {
  // Independent review Finding 7 (Codex review): the plan/docs document a v4
  // contract, and the client must actually enforce it — not any hyphenated
  // hexadecimal UUID, which would let a nil or non-v4 id through to a
  // real "no longer available" round trip instead of a zero-request
  // invalid-link notice.
  it("accepts a valid v4 UUID, lowercase", () => {
    expect(isUuid(VALID_UUID)).toBe(true);
  });

  it("accepts a valid v4 UUID, uppercase", () => {
    expect(isUuid(VALID_UUID.toUpperCase())).toBe(true);
  });

  it("rejects the nil UUID", () => {
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(false);
  });

  it("rejects a v1 UUID (version nibble 1)", () => {
    expect(isUuid("0313ac34-6394-1f6d-9be1-ec277daa69dd")).toBe(false);
  });

  it("rejects a v5 UUID (version nibble 5)", () => {
    expect(isUuid("0313ac34-6394-5f6d-9be1-ec277daa69dd")).toBe(false);
  });

  it("rejects an invalid variant nibble (must be 8/9/a/b)", () => {
    expect(isUuid("0313ac34-6394-4f6d-ffff-ec277daa69dd")).toBe(false);
    expect(isUuid("0313ac34-6394-4f6d-0be1-ec277daa69dd")).toBe(false);
  });

  it("rejects a truncated UUID", () => {
    expect(isUuid("0313ac34-6394-4f6d-9be1-ec277daa69d")).toBe(false); // 31 chars
  });

  it("rejects non-UUID strings", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("123")).toBe(false);
  });
});

describe("readJobParam", () => {
  it("reads job from a search string", () => {
    expect(readJobParam(`?job=${VALID_UUID}`)).toBe(VALID_UUID);
  });

  it("returns null when absent", () => {
    expect(readJobParam("")).toBeNull();
    expect(readJobParam("?other=1")).toBeNull();
  });
});

describe("withJobParam", () => {
  it("sets the job param", () => {
    expect(withJobParam(VALID_UUID)).toBe(`job=${VALID_UUID}`);
  });

  it("preserves other params", () => {
    const result = withJobParam(VALID_UUID, "?other=1");
    expect(result).toContain("other=1");
    expect(result).toContain(`job=${VALID_UUID}`);
  });

  it("replaces an existing job param", () => {
    const result = withJobParam(VALID_UUID, "?job=old-id");
    expect(result).toContain(`job=${VALID_UUID}`);
    expect(result).not.toContain("old-id");
  });
});

describe("withoutJobParam", () => {
  it("removes the job param", () => {
    expect(withoutJobParam(`?job=${VALID_UUID}`)).toBe("");
  });

  it("preserves other params", () => {
    const result = withoutJobParam(`?job=${VALID_UUID}&other=1`);
    expect(result).toBe("other=1");
    expect(result).not.toContain("job");
  });
});

describe("urlWithTransientParamsRemoved", () => {
  // Fix: the previous `?${withoutJobParam(...)}` pattern serialized an empty
  // search as a bare `/?`. The canonical URL carries NO `?` at all when the
  // resulting search is empty.
  it("produces the bare pathname — no `?` — when nothing remains", () => {
    expect(urlWithTransientParamsRemoved("/", `?job=${VALID_UUID}`)).toBe("/");
  });

  it("also strips the app-owned approval-demo flag, leaving no bare `?`", () => {
    expect(urlWithTransientParamsRemoved("/", "?approval-demo=1")).toBe("/");
    expect(urlWithTransientParamsRemoved("/", `?approval-demo=1&job=${VALID_UUID}`)).toBe("/");
  });

  it("preserves unrelated query parameters", () => {
    const result = urlWithTransientParamsRemoved("/", `?job=${VALID_UUID}&debug=1`);
    expect(result).toBe("/?debug=1");
    expect(result).not.toContain("job");
  });

  it("preserves the pathname for non-root routes", () => {
    expect(urlWithTransientParamsRemoved("/investigations", `?job=${VALID_UUID}`)).toBe("/investigations");
  });

  it("is a no-op when the search is already empty", () => {
    expect(urlWithTransientParamsRemoved("/", "")).toBe("/");
    expect(urlWithTransientParamsRemoved("/", undefined)).toBe("/");
  });

  it("keeps unrelated params alongside the pathname", () => {
    const result = urlWithTransientParamsRemoved("/investigations", "?job=1&utm=x&approval-demo=1");
    expect(result).toBe("/investigations?utm=x");
  });
});
