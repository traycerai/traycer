import { z } from "zod";

/**
 * Local publication health for one epic.
 *
 * This is deliberately a host-only read. The host compares its durable chat
 * store with the publication receipt it already owns and the client renders
 * that answer on the same machine. Nothing is reported to the cloud and an
 * older host degrades by omitting the indicator entirely.
 */
export const chatBackupStatusRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ChatBackupStatusRequest = z.infer<
  typeof chatBackupStatusRequestSchema
>;

export const chatBackupHaltCauseSchema = z.enum([
  "conflict",
  "quarantined",
  "repair-pending",
  "forked-lineage",
  "too-large",
  "escalation",
  "plan-ineligible",
]);
export type ChatBackupHaltCause = z.infer<typeof chatBackupHaltCauseSchema>;

export const chatBackupPublicationStatusSchema = z.enum([
  "current",
  "behind",
  "unknown",
]);
export type ChatBackupPublicationStatus = z.infer<
  typeof chatBackupPublicationStatusSchema
>;

export const chatBackupStatusRowSchema = z.object({
  chatId: z.string().min(1),
  /** Null only for a halted chat whose local projection cannot be read. */
  durableSeq: z.number().int().nonnegative().nullable(),
  /** Null when this host has no acknowledged publication witness. */
  publishedSeq: z.number().int().nonnegative().nullable(),
  /** Unknown means the local-only evidence cannot prove current or behind. */
  status: chatBackupPublicationStatusSchema,
  halted: z
    .object({
      cause: chatBackupHaltCauseSchema,
      since: z.number().int().nonnegative(),
    })
    .nullable(),
  /** Timestamp from the existing durable publication receipt. */
  lastPublishedAt: z.number().int().nonnegative().nullable(),
});
export type ChatBackupStatusRow = z.infer<typeof chatBackupStatusRowSchema>;

export const chatBackupStatusResponseSchema = z.object({
  chats: z.array(chatBackupStatusRowSchema),
});
export type ChatBackupStatusResponse = z.infer<
  typeof chatBackupStatusResponseSchema
>;
