// Thin re-export, co-located with the controller that consumes it — matches
// execute-agent-run-request.schema.ts's co-location convention. Re-exported
// as a plain const, matching this codebase's CommonJS/Vitest interop-safe
// value-export pattern (see @opspilot/contracts/src/index.ts) even though
// this file itself is only ever consumed by other apps/api ESM/TS source.
import { RecordApprovalDecisionInputSchema as _RecordApprovalDecisionInputSchema } from "@opspilot/contracts";

export const RecordApprovalDecisionInputSchema = _RecordApprovalDecisionInputSchema;
export type { RecordApprovalDecisionInput } from "@opspilot/contracts";
