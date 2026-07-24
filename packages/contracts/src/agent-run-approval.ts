import { z } from "zod";

export const ApprovalDecisionSchema = z.enum(["APPROVED", "REJECTED"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const RecordApprovalDecisionInputSchema = z
  .object({
    decision: ApprovalDecisionSchema,
    reviewerName: z.string().trim().min(1).max(100),
    note: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();
export type RecordApprovalDecisionInput = z.infer<typeof RecordApprovalDecisionInputSchema>;
