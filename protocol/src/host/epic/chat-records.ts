import { z } from "zod";

/**
 * The epic's chat RECORDS, as its owning host's chat registry holds them.
 *
 * ## Why this method exists at all
 *
 * The renderer's chat record set - which chats exist, what they are called,
 * where they sit in the agent tree, whether they are archived - had exactly one
 * producer: the epic Y.Doc's `chats` map. That was true while the document was
 * the registry. It stopped being true in chat-sync-v2: creation no longer writes
 * a doc record (ticket 19, single-write) and the upgrade sweep DELETES the
 * records that are already published (ticket 20). "No doc record" became the
 * ordinary steady state, and the renderer's record layer became a shrinking set
 * of pre-upgrade frozen entries converging on empty - so a migrated chat lost
 * its tree row, its rename/archive affordances, and (through a record-gated
 * subscribe) its live open, on its own owning host.
 *
 * This read is the missing half: the host serves the store-backed rows, and the
 * client folds them into the same record table the doc projection feeds. The
 * document keeps whatever frozen entries it still has - the client's union is
 * what makes the two populations one list.
 *
 * ## What a row is, and what it deliberately is not
 *
 * One row per LIVE chat, field-for-field what the registry row carries and
 * nothing derived. Deleted chats are absent (the registry holds a tombstone;
 * nothing outside the store wants one). `runSettingsSummary` is the registry's
 * own settings summary - the harness id and only the harness id, because that
 * is all the row holds; the full run-settings tuple lives in the chat's own
 * stream, not in a list read.
 *
 * ## Scope: the VIEWER'S own chats
 *
 * Chats are private to their owners, so the response carries only rows owned by
 * the calling identity. That is the same boundary the projector already applies
 * client-side, moved to where it belongs, and it is what keeps this from being
 * an enumeration oracle: an epic the caller cannot see and an epic in which they
 * own no chats answer identically.
 *
 * ## Optional, with a degrade story
 *
 * Registered `degrade: { kind: "unsupported" }` and not on the released floor.
 * A host predating this method answers `E_HOST_UNSUPPORTED`, and the client's
 * contract is DOC-ONLY MODE: the record table is exactly the doc projection,
 * which is precisely how that host's own records behave. There is no failure to
 * render, because there is nothing the user could do about it except upgrade the
 * host they are already talking to.
 */
export const listChatRecordsRequestSchema = z.object({
  epicId: z.string().min(1),
});
export type ListChatRecordsRequest = z.infer<
  typeof listChatRecordsRequestSchema
>;

/**
 * One chat, as the owning host's registry knows it.
 *
 * `archivedAt` rather than an `isArchived` flag: the renderer's projection
 * carries the timestamp (a record written before the field existed reads as
 * `null` = active), and collapsing it to a boolean here would force the client
 * to invent a timestamp on the way back into that shape.
 */
export const chatRecordSummarySchema = z.object({
  chatId: z.string().min(1),
  ownerUserId: z.string(),
  /** The host that MINTED the chat - the registry's `originHostId`. */
  originHostId: z.string(),
  title: z.string(),
  isTitleEditedByUser: z.boolean(),
  parentChatId: z.string().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  /** Archive timestamp, or `null` for an active chat. */
  archivedAt: z.number().int().nonnegative().nullable(),
  /**
   * The registry's run-settings SUMMARY: the harness id, or `null` when the
   * chat has no settings (or was written before the field existed). Not the
   * settings tuple - the registry does not hold one.
   */
  runSettingsSummary: z.string().nullable(),
});
export type ChatRecordSummary = z.infer<typeof chatRecordSummarySchema>;

export const listChatRecordsResponseSchema = z.object({
  chats: z.array(chatRecordSummarySchema),
});
export type ListChatRecordsResponse = z.infer<
  typeof listChatRecordsResponseSchema
>;
