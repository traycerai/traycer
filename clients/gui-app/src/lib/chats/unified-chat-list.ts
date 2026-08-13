import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  DEFAULT_SORT_MODE,
  makeNodeComparator,
  type NodeComparator,
  type SortableNode,
} from "@/lib/epic-sort";

/**
 * One agents list per task, across every host - the sidebar's whole ordering
 * and de-duplication rule, as data.
 *
 * ## Hosts are a property of a chat, not a place chats live
 *
 * Before the sync pivot every device opened the same live Y.Doc, so every
 * device rendered every chat identically: one flat list, one surface. The
 * pivot removed that substrate and a "your other devices" section appeared to
 * cover the gap. This restores the original semantics on the new architecture -
 * local rows and cloud rows interleave by recency in a single list, and the
 * owning host is row metadata (a chip, and a lock when that host is out of
 * reach) rather than a heading that sorts chats by which machine they are on.
 *
 * ## Why the fold is on PUBLICATION identity and not on `chatId`
 *
 * A task's cloud list and its local tree overlap: most cloud rows are the
 * backup of a chat already on screen, and drawing both would show one chat
 * twice. The obvious fold - drop a cloud row whose `chatId` matches a local
 * one - is right until a chat forks, and at a fork it is wrong in both
 * directions at the same time:
 *
 * | After a fork | `chatId` fold | publication fold |
 * | --- | --- | --- |
 * | the row the local chat now backs up to (a derived clone id) | kept - renders as a phantom second copy of your own chat | folded |
 * | the row still carrying `chatId`, owned by the OTHER host's lineage | folded - a real chat on another machine disappears | kept, locked while that host is unreachable |
 *
 * Both errors land together, which is why this cannot be patched with a
 * title-or-host heuristic: after the local lineage steps aside the two rows
 * share a title and differ only in an id the client cannot derive (the clone
 * id is a server-side digest of content the client never holds). The mapping
 * has to be asked for - see `epic.listChatPublicationTargets`.
 *
 * A host that predates that method leaves the map empty, which degrades this
 * to exactly the `chatId` fold above: correct for every chat that has not
 * forked, and wrong the old way for one that has. That beats rendering
 * nothing, and it is the only behaviour an older host can support.
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

/**
 * A row key over the whole identity TRIPLE.
 *
 * `chatId` alone is host-minted and two hosts can mint the same one under a
 * task - which is not a hypothetical here, it is precisely what a fork leaves
 * behind - so keying on it would collapse two genuinely different rows into one
 * React element and swap their content when the list reorders.
 */
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

/**
 * Which cloud row each local chat's content actually lands in.
 *
 * The map holds only the chats whose publication has MOVED; everything else
 * publishes under its own id and the `?? chatId` fallback covers it. Absent
 * (older host, request in flight) is a legal input and produces the pre-fork
 * behaviour described above.
 */
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

/**
 * The cloud rows that are NOT some local chat's backup, i.e. the chats this
 * device can only read.
 */
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

/**
 * The folded cloud counterpart of each local chat, keyed by the LOCAL id.
 *
 * Visibility lives on the cloud row. After a fork the local chat publishes
 * into a derived clone id, so a lookup on `chatId` equality would miss the
 * row that actually carries this chat's visibility. The publication map is
 * the same one the unfold uses; an empty map degrades to `chatId` equality.
 *
 * Only the viewer's own rows can fold — another owner's row that happens to
 * share a host-minted id is a different chat.
 */
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

/**
 * Whether this cloud row is one of THIS viewer's local chats' backups.
 *
 * The owner check is not a refinement of the id check - it is the other half of
 * the identity, and without it the fold is unsound. Cloud identity is the
 * `taskId + ownerUserId + chatId` triple precisely because `chatId` is
 * host-minted and not unique under a task, and the cloud list deliberately
 * carries every task-visible chat including OTHER people's. A collaborator's
 * genuinely different chat that happens to share a host-minted id with one of
 * mine would be folded away by an id-only rule and vanish from the only agent
 * list there now is - the failure the one-list restoration makes total.
 *
 * A local chat is by construction the viewer's own, so only a row the viewer
 * owns can be a local chat's publication target. Another owner's row is never
 * folded, whatever its id.
 */
function foldsIntoLocalEntry(
  chat: CloudChatSummary,
  publishedByThisViewer: ReadonlySet<string>,
): boolean {
  if (!cloudRowIsViewersOwn(chat)) return false;
  return publishedByThisViewer.has(chat.identity.chatId);
}

/**
 * Whether this cloud row is one of the VIEWER's own chats.
 *
 * The single owner test, shared by everything that has to decide whether a
 * local record and a cloud row are the same chat. A local chat is by
 * construction the viewer's, so a row the viewer does not own can never be one
 * - not for folding, and not for judging presence.
 */
export function cloudRowIsViewersOwn(chat: CloudChatSummary): boolean {
  return chat.isOwnedByViewer;
}

/**
 * The sort keys a cloud row contributes, in the shape the shared comparator
 * already reads so one ordering rule covers both kinds of row.
 *
 * `updatedAt` prefers `publishedAt` because that is the row's last real
 * activity - the moment its owning host last pushed content. `metadataUpdatedAt`
 * moves on a rename or an archive too, so it would float a chat nobody has
 * touched above one that just streamed a turn. A row that has never published
 * has no better answer than its metadata stamp.
 */
export function cloudChatSortable(chat: CloudChatSummary): SortableNode {
  return {
    id: cloudChatRowKey(chat.identity),
    title: chat.title ?? "",
    createdAt: chat.createdAt,
    updatedAt: chat.publishedAt ?? chat.metadataUpdatedAt,
  };
}

/**
 * The single ordered list: local roots and cloud-only rows, interleaved.
 *
 * `comparator` is `null` for the default mode, where the projector has already
 * ordered the local roots. That order cannot simply be preserved once foreign
 * rows are mixed in, so the default's own comparator is materialized instead -
 * `DEFAULT_SORT_MODE` is exactly what `compareNodes` sorts the projection by,
 * so re-applying it reproduces the incoming local order rather than perturbing
 * it, and gives the cloud rows a place in it.
 *
 * Local rows keep their tree identity: only ROOTS take part in the interleave,
 * and a nested child still renders under its parent. A cloud row is always a
 * leaf - the cloud list carries `parentChatId`, but the parent it names is a
 * chat on another machine that this device may not be able to see at all, and a
 * row that silently reparents itself as its sibling loads is worse than a flat
 * one.
 */
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
