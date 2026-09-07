import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  DEFAULT_SORT_MODE,
  makeNodeComparator,
  type NodeComparator,
  type SortableNode,
} from "@/lib/epic-sort";

/**
 * One agents list per task: fold on publication identity, not `chatId` (a fork would keep a phantom clone and drop the other host's lineage).
 * An older host with an empty publication map degrades to the `chatId` fold.
 */

/** `local:` / `cloud:` prefixes keep the two key spaces from ever colliding. */
const LOCAL_KEY_PREFIX = "local:";
const CLOUD_KEY_PREFIX = "cloud:";

export interface UnifiedLocalChatEntry {
  readonly kind: "local";
  readonly key: string;
  /** The epic-tree node id. Renders through the ordinary tree row. */
  readonly nodeId: string;
}

export interface UnifiedCloudChatEntry {
  readonly kind: "cloud";
  readonly key: string;
  readonly chat: CloudChatSummary;
}

export type UnifiedChatEntry = UnifiedLocalChatEntry | UnifiedCloudChatEntry;

/** A row key over the whole identity TRIPLE. */
export function cloudChatRowKey(identity: {
  readonly taskId: string;
  readonly ownerUserId: string;
  readonly chatId: string;
}): string {
  return `${CLOUD_KEY_PREFIX}${identity.taskId}:${identity.ownerUserId}:${identity.chatId}`;
}

export function localChatRowKey(nodeId: string): string {
  return `${LOCAL_KEY_PREFIX}${nodeId}`;
}

/** Which cloud row each local chat's content actually lands in. */
export function publishedCloudChatIds(
  localChatIds: readonly string[],
  publicationChatIdByChatId: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  return new Set(
    localChatIds.map(
      (chatId) => publicationChatIdByChatId.get(chatId) ?? chatId,
    ),
  );
}

/** The cloud rows that are NOT some local chat's backup, i.e. the chats this device can only read. */
export function selectUnfoldedCloudChats(input: {
  readonly chats: readonly CloudChatSummary[];
  readonly localChatIds: readonly string[];
  readonly publicationChatIdByChatId: ReadonlyMap<string, string>;
}): readonly CloudChatSummary[] {
  const published = publishedCloudChatIds(
    input.localChatIds,
    input.publicationChatIdByChatId,
  );
  return input.chats.filter((chat) => !foldsIntoLocalEntry(chat, published));
}

/** The folded cloud counterpart of each local chat, keyed by the LOCAL id. */
export function indexOwnCloudChatsByLocalId(input: {
  readonly chats: readonly CloudChatSummary[];
  readonly localChatIds: readonly string[];
  readonly publicationChatIdByChatId: ReadonlyMap<string, string>;
}): ReadonlyMap<string, CloudChatSummary> {
  const ownByPublishedId = new Map<string, CloudChatSummary>();
  for (const chat of input.chats) {
    if (!cloudRowIsViewersOwn(chat)) continue;
    ownByPublishedId.set(chat.identity.chatId, chat);
  }
  const byLocalId = new Map<string, CloudChatSummary>();
  for (const localChatId of input.localChatIds) {
    const publishedId =
      input.publicationChatIdByChatId.get(localChatId) ?? localChatId;
    const chat = ownByPublishedId.get(publishedId);
    if (chat === undefined) continue;
    byLocalId.set(localChatId, chat);
  }
  return byLocalId;
}

/** Whether this cloud row is one of THIS viewer's local chats' backups. */
function foldsIntoLocalEntry(
  chat: CloudChatSummary,
  publishedByThisViewer: ReadonlySet<string>,
): boolean {
  if (!cloudRowIsViewersOwn(chat)) return false;
  return publishedByThisViewer.has(chat.identity.chatId);
}

/** Whether this cloud row is one of the VIEWER's own chats. */
export function cloudRowIsViewersOwn(chat: CloudChatSummary): boolean {
  return chat.isOwnedByViewer;
}

/** The cloud's content-activity clock for one chat row. */
export function cloudChatLastActiveAt(chat: CloudChatSummary): number {
  return chat.publishedAt ?? chat.metadataUpdatedAt;
}

/** The best content-activity clock for a row already present in the local tree. */
export function chatRowLastActiveAt(input: {
  readonly recordUpdatedAt: number;
  readonly ownerHostId: string | null;
  readonly sessionHostId: string | null;
  readonly cloudChat: CloudChatSummary | null;
}): number {
  const isForeignRecord =
    input.ownerHostId !== null &&
    input.sessionHostId !== null &&
    input.ownerHostId !== input.sessionHostId;
  return isForeignRecord && input.cloudChat !== null
    ? cloudChatLastActiveAt(input.cloudChat)
    : input.recordUpdatedAt;
}

/**
 * The sort keys a cloud row contributes, in the shape the shared comparator already reads so one ordering rule covers both kinds of row.
 */
export function cloudChatSortable(chat: CloudChatSummary): SortableNode {
  return {
    id: cloudChatRowKey(chat.identity),
    title: chat.title ?? "",
    createdAt: chat.createdAt,
    updatedAt: cloudChatLastActiveAt(chat),
  };
}

/** The single ordered list: local roots and cloud-only rows, interleaved. */
export function mergeChatListEntries(input: {
  readonly localRootIds: readonly string[];
  readonly nodeById: Readonly<Record<string, SortableNode>>;
  readonly cloudChats: readonly CloudChatSummary[];
  readonly comparator: NodeComparator | null;
}): readonly UnifiedChatEntry[] {
  const compare = input.comparator ?? makeNodeComparator(DEFAULT_SORT_MODE);
  const rows: { entry: UnifiedChatEntry; sortable: SortableNode }[] = [];
  for (const nodeId of input.localRootIds) {
    // Root ids are drawn from the same tree as `nodeById`, so every id
    // resolves; a defensive skip here would hide a projector bug instead.
    rows.push({
      entry: { kind: "local", key: localChatRowKey(nodeId), nodeId },
      sortable: input.nodeById[nodeId],
    });
  }
  for (const chat of input.cloudChats) {
    rows.push({
      entry: {
        kind: "cloud",
        key: cloudChatRowKey(chat.identity),
        chat,
      },
      sortable: cloudChatSortable(chat),
    });
  }
  rows.sort((a, b) => compare(a.sortable, b.sortable));
  return rows.map((row) => row.entry);
}
