import { describe, expect, it } from "vitest";
import { z } from "zod";

import { ApiError } from "../errors/api-error";
import { UuidParamSchema } from "./uuid-param.schema";
import { ZodParamValidationPipe, ZodValidationPipe } from "./zod-validation.pipe";

describe("ZodValidationPipe", () => {
  const schema = z.object({ ticketId: z.string().min(1), summary: z.string().min(1) }).strict();

  it("returns the parsed value for a valid body", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(pipe.transform({ ticketId: "T-1", summary: "s" })).toEqual({ ticketId: "T-1", summary: "s" });
  });

  it("throws REQUEST_BODY_INVALID for an invalid body", () => {
    const pipe = new ZodValidationPipe(schema);
    expect(() => pipe.transform({ ticketId: "" })).toThrow(ApiError);
    try {
      pipe.transform({ ticketId: "" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe("REQUEST_BODY_INVALID");
      expect(apiError.status).toBe(400);
    }
  });

  it("never leaks raw Zod issue text onto the thrown error's message", () => {
    const pipe = new ZodValidationPipe(schema);
    try {
      pipe.transform({ ticketId: 12345 });
      expect.unreachable();
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.message).toBe("The request body failed validation.");
      expect(apiError.message).not.toMatch(/ticketId|zod|issue/i);
    }
  });
});

describe("ZodParamValidationPipe", () => {
  it("returns the parsed value for a valid UUID string", () => {
    const pipe = new ZodParamValidationPipe(UuidParamSchema);
    const uuid = "0313ac34-6394-4f6d-9be1-ec277daa69dd";
    expect(pipe.transform(uuid)).toBe(uuid);
  });

  it("throws ROUTE_PARAMETER_INVALID for a malformed UUID string", () => {
    const pipe = new ZodParamValidationPipe(UuidParamSchema);
    try {
      pipe.transform("not-a-uuid");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe("ROUTE_PARAMETER_INVALID");
      expect(apiError.status).toBe(400);
    }
  });

  it("never leaks raw Zod issue text onto the thrown error's message", () => {
    const pipe = new ZodParamValidationPipe(UuidParamSchema);
    try {
      pipe.transform("not-a-uuid");
      expect.unreachable();
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.message).toBe("The request path contained an invalid identifier.");
    }
  });
});
