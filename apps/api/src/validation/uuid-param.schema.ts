import { z } from "zod";

// @Param("jobId", pipe) passes a plain string, not an object — this schema
// is never wrapped in z.object({ jobId: ... }) (see docs/12-agent-run-api.md).
export const UuidParamSchema = z.string().uuid();
