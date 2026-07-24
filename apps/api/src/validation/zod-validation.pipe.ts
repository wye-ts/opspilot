import { Injectable, type PipeTransform } from "@nestjs/common";
import type { ZodType } from "zod";

import { ApiError } from "../errors/api-error";

// Validates a request body. Never leaks raw Zod issues — a failed parse
// always throws the fixed REQUEST_BODY_INVALID ApiError.
@Injectable()
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError("REQUEST_BODY_INVALID", { cause: result.error });
    }
    return result.data;
  }
}

// Validates one route parameter, passed as a plain string by
// @Param(name, pipe) — never wrapped in an object. Never leaks raw Zod
// issues — a failed parse always throws the fixed ROUTE_PARAMETER_INVALID
// ApiError.
@Injectable()
export class ZodParamValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new ApiError("ROUTE_PARAMETER_INVALID", { cause: result.error });
    }
    return result.data;
  }
}
