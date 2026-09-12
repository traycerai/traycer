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
 * One published row, as both the registry and the listing address it.
 * `CloudChatSummary` satisfies this, so callers pass the summary itself.
 */
export interface CloudDraftRowRef {
  readonly ownerHostId: string;
  readonly identity: CloudChatIdentity;
}

/**
 * Chat ids are host-minted, so identity is the `(task, owner, chat)` TRIPLE -
 * two hosts can mint the same chat id under one task. `ownerHostId` leads it
 * here because that triple identifies a row to the SERVER, which resolves one
 * row per identity, while this map caches MANY hosts' rows at once: two hosts'
 * rows arriving under one triple would otherwise overwrite each other's kind,
 * and a host-bound draft could be listed as portable. The listing's React key
 * is this same string, which is what keeps it unique across hosts and stable
 * across head revisions.
 */
export function cloudDraftIdentityKey(row: CloudDraftRowRef): string {
  const { identity } = row;
  return `${row.ownerHostId}:${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
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
  row: CloudDraftRowRef,
  kind: DraftKind,
): void {
  const key = cloudDraftIdentityKey(row);
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
