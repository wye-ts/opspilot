import { describe, expect, it } from "vitest";

import { InvalidPortError, resolveServerConfig } from "./server-config";

describe("resolveServerConfig", () => {
  it("defaults to 127.0.0.1:3000 when HOST and PORT are unset", () => {
    expect(resolveServerConfig({})).toEqual({ host: "127.0.0.1", port: 3000 });
  });

  it("reads HOST from the environment", () => {
    expect(resolveServerConfig({ HOST: "0.0.0.0" })).toEqual({ host: "0.0.0.0", port: 3000 });
  });

  it("reads a valid PORT from the environment", () => {
    expect(resolveServerConfig({ PORT: "8080" })).toEqual({ host: "127.0.0.1", port: 8080 });
  });

  it("accepts the boundary values 1 and 65535", () => {
    expect(resolveServerConfig({ PORT: "1" }).port).toBe(1);
    expect(resolveServerConfig({ PORT: "65535" }).port).toBe(65535);
  });

  it("treats an empty PORT as unset", () => {
    expect(resolveServerConfig({ PORT: "" }).port).toBe(3000);
  });

  it.each([["abc"], ["3.5"], ["-1"], ["0"], ["65536"], [" 3000"], ["3000 "], ["0x10"]])(
    "rejects an invalid PORT value %j",
    (rawPort) => {
      expect(() => resolveServerConfig({ PORT: rawPort })).toThrow(InvalidPortError);
    },
  );
});
