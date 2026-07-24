import { z } from "zod";

export const TicketContextSchema = z
  .object({
    ticketId: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

export type TicketContext = z.infer<typeof TicketContextSchema>;
