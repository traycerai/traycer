/**
 * Ticket 15 review round 3 (finding: chat-delete/epic-access-loss durable
 * resurrection): a chat's mutation-driven deletion and the canvas sweep's
 * own promote-then-evict pass (store.ts) race - the sweep runs first
 * (synchronous, on tab close) and the deletion's `onSuccess` fires later
 * (after the host round-trip), so a naive "delete durable state" call in
 * `onSuccess` can be immediately resurrected by ANY later write racing
 * against it (not just the sweep - any commit path). A tombstone makes
 * deletion terminal regardless of who runs last: every durable write goes
 * through `createChatDurableCache`, which checks this fence before writing.
 *
 * Bounded (FIFO) so a session that deletes many chats without reopening any
 * of them doesn't grow this without limit; reopening a chat clears its own
 * tombstone explicitly, so the cap only matters for chats deleted and never
 * revisited again in the same session.
 *
 * `evictChatTabPersistenceForEpic` (called from `handleEpicAccessLoss`,
 * which - unlike a chat delete - is not necessarily terminal: access can be
 * regained) tombstones by EPIC PREFIX, not an exact chat key, so it needs
 * its own clear counterpart - `clearChatKeyTombstone` only ever touches the
 * exact-key set and cannot undo a prefix tombstone. `clearEpicPrefixTombstone`
 * fills that gap; a chat tile mounting under a given epic is the signal that
 * the epic is open/accessible again, so it clears both.
 *
 * Ticket 15 review round 4 (finding 3): the epic-prefix set is bounded the
 * same FIFO way as the exact-key set, for the same reason - a session that
 * loses access to many epics without any of them being reopened should not
 * grow this (and `isChatKeyTombstoned`'s per-write linear scan over it)
 * without limit.
 *
 * Ticket 15 review round 4 (finding 6, PLAUSIBLE, accepted): `tombstoneChatKey`
 * fires from `epic.deleteChat`'s `onSuccess` (use-epic-chat-mutations.ts) -
 * AFTER a real host round-trip, not synchronously with the delete click.
 * `clearChatKeyTombstone` fires from a chat tile's mount effect
 * (chat-messages.tsx). If a user closes chat X, starts deleting it, and
 * reopens the SAME (epicId, chatId) before the delete's `onSuccess` lands,
 * the reopen's clear can run BEFORE the tombstone is even set - the later
 * tombstone then wins, permanently blocking durable writes for a chat that
 * is, at that moment, sitting open and live in a real tile.
 *
 * Accepted, not guarded, because the reopen requires `useChatById` (the
 * local epic-doc `chats.byId` projection `ChatTile` gates its render on) to
 * still resolve non-null for a chatId whose delete RPC is in flight -
 * `ChatTile` renders the loading/dead-tile branch instead of ever mounting
 * `ChatMessages` once that projection reflects the removal, which for a
 * host-applied delete typically arrives close to (often before) the RPC's
 * own response. Reopening therefore needs the deleted chatId to still look
 * live in the LOCAL doc for the whole round-trip - a narrow window, and
 * shrinking it further would mean touching the delete-mutation's request
 * ordering or the epic-doc sync path, both outside this ticket's persistence
 * mechanism (tombstone set + initialized-marker set only).
 *
 * Ticket 15 review round 5 (item 2): a fence must survive its own
 * transaction. `handleEpicAccessLoss` tombstones every epic in one batch,
 * THEN the canvas sweep runs (writing durable state back for whichever of
 * those epics still had open tiles) - so within a single access-loss batch
 * larger than `TOMBSTONE_LIMIT`, plain FIFO pruning could evict epic 0's
 * fresh tombstone (added first in the batch) to make room for epic 500's,
 * before the sweep ever gets to epic 0. `tombstoneEpicPrefixes` makes the
 * whole batch a single atomic add: pruning skips every prefix in the
 * CURRENT batch, only evicting older entries from PRIOR calls - so a batch
 * larger than the cap transiently grows past it rather than half-expiring
 * itself mid-transaction. `tombstoneEpicPrefix` (singular) is the same
 * operation for a batch of one.
 */
const TOMBSTONE_LIMIT = 500;

const tombstonedChatKeys = new Set<string>();
const tombstonedEpicPrefixes = new Set<string>();

function pruneTombstonedChatKeys(): void {
  while (tombstonedChatKeys.size > TOMBSTONE_LIMIT) {
    const oldest = tombstonedChatKeys.values().next().value;
    if (typeof oldest !== "string") return;
    tombstonedChatKeys.delete(oldest);
  }
}

function pruneTombstonedEpicPrefixes(
  protectedPrefixes: ReadonlySet<string>,
): void {
  if (tombstonedEpicPrefixes.size <= TOMBSTONE_LIMIT) return;
  for (const prefix of tombstonedEpicPrefixes) {
    if (tombstonedEpicPrefixes.size <= TOMBSTONE_LIMIT) return;
    if (protectedPrefixes.has(prefix)) continue;
    tombstonedEpicPrefixes.delete(prefix);
  }
}

export function tombstoneChatKey(chatKey: string): void {
  tombstonedChatKeys.add(chatKey);
  pruneTombstonedChatKeys();
}

export function tombstoneEpicPrefix(epicKeyPrefix: string): void {
  tombstoneEpicPrefixes([epicKeyPrefix]);
}

/** Batch form of `tombstoneEpicPrefix` - tombstones every prefix in
 *  `epicKeyPrefixes` as one atomic add, so pruning back to the cap never
 *  evicts a prefix from THIS batch to make room for another one in it. */
export function tombstoneEpicPrefixes(
  epicKeyPrefixes: ReadonlyArray<string>,
): void {
  const batch = new Set(epicKeyPrefixes);
  for (const prefix of batch) tombstonedEpicPrefixes.add(prefix);
  pruneTombstonedEpicPrefixes(batch);
}

export function isChatKeyTombstoned(chatKey: string): boolean {
  if (tombstonedChatKeys.has(chatKey)) return true;
  for (const prefix of tombstonedEpicPrefixes) {
    if (chatKey.startsWith(prefix)) return true;
  }
  return false;
}

export function clearChatKeyTombstone(chatKey: string): void {
  tombstonedChatKeys.delete(chatKey);
}

export function clearEpicPrefixTombstone(epicId: string): void {
  tombstonedEpicPrefixes.delete(`${epicId}:`);
}
