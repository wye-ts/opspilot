import { z } from "zod";

export const IncidentCategorySchema = z.enum([
  "SERVICE_DEGRADATION",
  "RATE_LIMITING",
  "AUTHENTICATION",
  "CONFIGURATION",
  "DATA_QUALITY",
  "UNKNOWN",
]);

export const EvidenceReferenceSchema = z
  .object({
    evidenceId: z.string().min(1).max(128),
    sourceType: z.enum(["RAG_CHUNK", "TOOL_EXECUTION"]),
    finding: z.string().min(1).max(500),
  })
  .strict();

const UpdateTicketStatusActionSchema = z
  .object({
    type: z.literal("UPDATE_TICKET_STATUS"),
    payload: z
      .object({
        status: z.enum([
          "OPEN",
          "IN_PROGRESS",
          "WAITING_ON_CUSTOMER",
          "RESOLVED",
        ]),
        reason: z.string().min(1).max(500),
      })
      .strict(),
  })
  .strict();

const CreateEscalationActionSchema = z
  .object({
    type: z.literal("CREATE_ESCALATION"),
    payload: z
      .object({
        team: z.string().min(1).max(100),
        reason: z.string().min(1).max(500),
        priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]),
      })
      .strict(),
  })
  .strict();

const DraftCustomerReplyActionSchema = z
  .object({
    type: z.literal("DRAFT_CUSTOMER_REPLY"),
    payload: z
      .object({
        subject: z.string().min(1).max(200),
        body: z.string().min(1).max(4000),
      })
      .strict(),
  })
  .strict();

export const SuggestedActionSchema = z.discriminatedUnion("type", [
  UpdateTicketStatusActionSchema,
  CreateEscalationActionSchema,
  DraftCustomerReplyActionSchema,
]);

export const ResolutionReportSchema = z
  .object({
    category: IncidentCategorySchema,

    summary: z.string().min(1).max(1000),

    rootCause: z.string().min(1).max(1500),

    customerImpact: z.string().min(1).max(1000),

    recommendedResolution: z.string().min(1).max(2000),

    confidence: z.number().min(0).max(1),

    evidence: z.array(EvidenceReferenceSchema).min(1).max(10),

    suggestedActions: z.array(SuggestedActionSchema).max(3),
  })
  .strict();

export type IncidentCategory = z.infer<typeof IncidentCategorySchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;
export type ResolutionReport = z.infer<typeof ResolutionReportSchema>;
