import { z } from "zod";

/**
 * Which cloud row each LOCAL chat publishes into.
 *
 * ## Why this is not part of the cloud-chat byte pipe
 *
 * `epic/cloud-chat.ts` is a pass-through: the host forwards cloud bytes it is
 * not allowed to interpret. This is the opposite kind of read - it answers from
 * the host's OWN durable fork-redirect state and never touches the cloud - so it
 * lives beside that surface rather than inside it, and it is registered
 * separately: the byte pipe is unconditional (every host has a bearer), while
 * this needs an installed chat-sync publisher and is therefore absent on the
 * RPC-only path.
 *
 * ## What the mapping is for
 *
 * A chat has two identities and they diverge exactly once, at a fork:
 *
 * - the local `chatId` - host-minted, stable for life, the thing tabs bind and
 *   deep links name (`agentId` IS `chatId`);
 * - the `publicationChatId` - the cloud row the chat's content actually lands
 *   in. Equal to `chatId` until the local lineage steps aside into a derived
 *   clone row, and different forever after.
 *
 * A client listing a task's chats holds both a LOCAL tree and a CLOUD list, and
 * has to fold the second into the first without ever showing one chat twice.
 * Folding on `chatId` equality is the obvious rule and it is wrong in precisely
 * the geometry a fork produces: after the local lineage steps aside, the cloud
 * row carrying `chatId` belongs to the OTHER host's lineage (a genuinely
 * different chat that must render on its own), while the row the local chat
 * really backs up to carries the derived clone id and would render as a
 * phantom second copy. Both errors show up at once - the real other-host chat
 * disappears and a duplicate of your own appears - which is why the fold has to
 * be on publication identity and cannot be approximated client-side: the clone
 * id is derived server-side from content digests the client never holds.
 *
 * ## Degradation
 *
 * Optional and unreleased. A host without it answers `E_HOST_UNSUPPORTED`, and
 * the client's contract is to fall back to folding on `chatId` equality - the
 * behaviour it had before this method existed. That is wrong only for a chat
 * that has actually forked, which is the case this method exists to fix, and
 * being wrong the old way beats rendering nothing.
 */

export const listChatPublicationTargetsRequestSchema = z.object({
  /** In the 3.0 model an epic id IS the task id; there is no mapping layer. */
  epicId: z.string().min(1),
  /**
   * The local chats to resolve, so the host answers a bounded question instead
   * of enumerating its whole registry. A client asks for the ids its tree
   * actually renders.
   */
  chatIds: z.array(z.string().min(1)),
});
export type ListChatPublicationTargetsRequest = z.infer<
  typeof listChatPublicationTargetsRequestSchema
>;

/**
 * One chat whose publication has MOVED.
 *
 * Only redirected chats appear. A chat publishing under its own id is the
 * overwhelmingly common case and carries no information - the caller's fallback
 * (`publicationChatId ?? chatId`) is already correct for it - so listing it
 * would be a per-chat row restating the request.
 *
 * A redirect the host cannot read is omitted rather than guessed at. That
 * degrades to the same fallback, which is the conservative direction here: a
 * missing entry can only fail to fold a row (one extra row, visibly labelled by
 * its owning host), while a fabricated one would fold away a chat that is
 * really there.
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
