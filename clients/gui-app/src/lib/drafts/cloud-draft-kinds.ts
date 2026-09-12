import type { DraftKind } from "@traycer/protocol/host";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";

/**
 * Which surface each published draft in the personal scope belongs to.
 *
 * `CloudChatSummary` carries no kind - the wire `kind` lives INSIDE the head
 * document, which only the byte-pipe read decodes - so a surface that renders
 * rows from the directory alone cannot tell a portable landing draft from a
 * host-bound chat composer one. The ingest already reads every foreign head,
 * so it records what it decoded here and the listing filters on it rather
 * than paying for a second read of the same bytes.
 *
 * A row whose head has not been read yet is absent from this map, and the
 * listing treats absent as "not known to be openable" - it stays hidden. That
 * is the same hide-not-fail contract the section already has for a missing
 * capability, and it is the safe direction: showing an unread row lists chat
 * drafts again on every head-read failure.
 */
const kindByIdentity = new Map<string, DraftKind>();
const listeners = new Set<() => void>();

/**
 * Chat ids are host-minted, so identity is the `(task, owner, chat)` TRIPLE -
 * two hosts can mint the same chat id under one task.
 */
export function cloudDraftIdentityKey(identity: CloudChatIdentity): string {
  return `${identity.taskId}\u0000${identity.ownerUserId}\u0000${identity.chatId}`;
}

/**
 * A snapshot whose reference changes only when a kind actually changes, so
 * `useSyncExternalStore` consumers re-render on a real discovery and never on
 * a repeated read of an unchanged map. Never `kindByIdentity` itself: a held
 * reference into the mutable map would change contents under a consumer that
 * `Object.is`-compared it and saw no move.
 */
let snapshot: ReadonlyMap<string, DraftKind> = new Map();

export function recordCloudDraftKind(
  identity: CloudChatIdentity,
  kind: DraftKind,
): void {
  const key = cloudDraftIdentityKey(identity);
  if (kindByIdentity.get(key) === kind) return;
  kindByIdentity.set(key, kind);
  snapshot = new Map(kindByIdentity);
  for (const listener of listeners) listener();
}

export function cloudDraftKindsSnapshot(): ReadonlyMap<string, DraftKind> {
  return snapshot;
}

export function subscribeCloudDraftKinds(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetCloudDraftKindsForTests(): void {
  kindByIdentity.clear();
  snapshot = new Map();
  for (const listener of listeners) listener();
}
