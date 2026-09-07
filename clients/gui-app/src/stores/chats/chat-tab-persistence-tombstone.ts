/**
 * Every durable write checks this fence; prefix tombstones add as one batch so a
 * batch larger than the cap cannot prune itself mid-transaction.
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

/**
 * Batch form of `tombstoneEpicPrefix` - tombstones every prefix in `epicKeyPrefixes` as one atomic
 * add, so pruning back to the cap never evicts a prefix from THIS batch to make room for another
 */
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
