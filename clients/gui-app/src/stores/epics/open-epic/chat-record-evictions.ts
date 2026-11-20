import type { ChatRecordSummaryV14 } from "@traycer/protocol/host/epic/chat-records";

/**
 * Which chats the epic's serving host has dropped the records of (cold
 * eviction), as its last `epic.listChatRecords@1.4` snapshot said.
 *
 * ## A plane of its own, like the publication head
 *
 * `evicted` is LIST-ONLY: the `host.chatRecords.subscribe` row does not carry
 * it, because a drop or a bring-back writes no registry row. The host moves
 * the list's stamp instead, so the next poll answers a snapshot. A stream
 * upsert therefore says nothing about it, and the record table, whose rows
 * the stream replaces whole, is the wrong home for it. It is folded here, on
 * the main thread, from the snapshot rows alone, and kept across every
 * `unchanged` answer and stream delta until the next snapshot restates it.
 *
 * ## Keyed by `chatId` alone
 *
 * Only a row the serving host holds as its OWN can be `evicted: true`: a
 * replica is not that host's to drop. A host never holds two own rows with
 * one `chatId`, so the id names the chat. A reader pairs it with the serving
 * host, since the fact is about that host's records.
 */

/** One snapshot row's say about the chat's records. */
export type ChatRecordEvictionRow = Pick<
  ChatRecordSummaryV14,
  "chatId" | "evicted"
>;

export const EMPTY_EVICTED_CHAT_IDS: ReadonlySet<string> = new Set();

/**
 * The set a snapshot states, or the SAME set when it states what is held,
 * so a quiet poll publishes no new identity.
 */
export function evictedChatIdsOfSnapshot(
  held: ReadonlySet<string>,
  rows: readonly ChatRecordEvictionRow[],
): ReadonlySet<string> {
  const next = new Set<string>();
  for (const row of rows) {
    if (row.evicted) next.add(row.chatId);
  }
  if (next.size === held.size && [...next].every((id) => held.has(id))) {
    return held;
  }
  return next.size === 0 ? EMPTY_EVICTED_CHAT_IDS : next;
}
