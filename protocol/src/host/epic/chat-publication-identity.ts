import { z } from "zod";

/** Which cloud row each LOCAL chat publishes into. */

export const listChatPublicationTargetsRequestSchema = z.object({
  /** In the 3.0 model an epic id IS the task id; there is no mapping layer. */
  epicId: z.string().min(1),
  /**
   * The local chats to resolve, so the host answers a bounded question instead of enumerating its whole registry.
   */
  chatIds: z.array(z.string().min(1)),
});
export type ListChatPublicationTargetsRequest = z.infer<
  typeof listChatPublicationTargetsRequestSchema
>;

/**
 * One chat whose publication has MOVED.
 * A redirect the host cannot read is omitted rather than guessed at.
 */
export const chatPublicationTargetSchema = z.object({
  chatId: z.string().min(1),
  publicationChatId: z.string().min(1),
});
export type ChatPublicationTarget = z.infer<typeof chatPublicationTargetSchema>;

export const listChatPublicationTargetsResponseSchema = z.object({
  redirected: z.array(chatPublicationTargetSchema),
});
export type ListChatPublicationTargetsResponse = z.infer<
  typeof listChatPublicationTargetsResponseSchema
>;
