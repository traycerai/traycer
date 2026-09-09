import type { ChatRecordHeadStamp } from "@traycer/protocol/host/epic/chat-records";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import {
  DEFAULT_SORT_MODE,
  makeNodeComparator,
  type NodeComparator,
  type NodeSortClock,
  type SortableNode,
} from "@/lib/epic-sort";
import { chatRecordKey } from "@/stores/epics/open-epic/chat-record-head";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

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

/** The cloud's content-activity clock for one chat row. */
export function cloudChatLastActiveAt(chat: CloudChatSummary): number {
  return chat.publishedAt ?? chat.metadataUpdatedAt;
}

/**
 * The best content-activity clock for a row already present in the local tree.
 *
 * The serving host's own record comes straight from its chat store and is the
 * freshest answer. A record replicated from a different owner host carries a
 * metadata timestamp instead, so a publication clock is authoritative: the
 * record row's own head (`recordHeadPublishedAt`, pushed by the record stream
 * as the owner publishes) first, then the cloud list's `publishedAt` (polled,
 * so it can lag the head by up to its stale window), then that list's
 * metadata stamp for a row that has never published. Sorting and the idle-time
 * chip both read this one value, so a chat that just streamed a turn floats
 * to where its chip says it belongs.
 */
export function chatRowLastActiveAt(input: {
  readonly recordUpdatedAt: number;
  readonly ownerHostId: string | null;
  readonly sessionHostId: string | null;
  readonly cloudChat: CloudChatSummary | null;
  /** `record.head.publishedAt` off the epic's record row, or `null`. */
  readonly recordHeadPublishedAt: number | null;
}): number {
  const isForeignRecord =
    input.ownerHostId !== null &&
    input.sessionHostId !== null &&
    input.ownerHostId !== input.sessionHostId;
  if (!isForeignRecord) return input.recordUpdatedAt;
  if (input.recordHeadPublishedAt !== null) return input.recordHeadPublishedAt;
  return input.cloudChat !== null
    ? cloudChatLastActiveAt(input.cloudChat)
    : input.recordUpdatedAt;
}

/**
 * A cloud-only row's content clock: the record head when the epic's record
 * table holds one for this identity, else the cloud list's own answer. The
 * record head arrives by push and is the fresher of the two; the list is what
 * the row exists on at all.
 */
export function cloudChatRowLastActiveAt(
  chat: CloudChatSummary,
  recordHeadPublishedAt: number | null,
): number {
  return recordHeadPublishedAt ?? cloudChatLastActiveAt(chat);
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
    updatedAt: cloudChatLastActiveAt(chat),
  };
}

function recordHeadPublishedAt(
  recordHeads: Readonly<Record<string, ChatRecordHeadStamp>>,
  ownerUserId: string | null,
  chatId: string,
): number | null {
  if (ownerUserId === null) return null;
  const key = chatRecordKey(ownerUserId, chatId);
  return Object.hasOwn(recordHeads, key) ? recordHeads[key].publishedAt : null;
}

/**
 * The content clock each LOCAL chat sorts by, keyed by node id, for every
 * chat in the projection - roots and nested children alike, since a child
 * list is sorted by the same rule as the root list and a foreign chat is
 * nested under its parent exactly as often as it is a root.
 *
 * Computed with the rule the row's idle-time chip renders
 * (`chatRowLastActiveAt`), so the order and the chip cannot disagree about
 * which chat moved last. Only chats whose clock differs from the projection's
 * own `updatedAt` are entered - a foreign record, owned by another host, whose
 * `updatedAt` is a metadata replica. `recordHeads` is the epic's record table
 * (`OpenEpicState.chatRecordHeads`, keyed by `chatRecordKey`), pushed as
 * owners publish.
 */
export function localChatLastActiveAtById(input: {
  readonly chatsById: Readonly<Record<string, ChatProjection>>;
  readonly recordHeads: Readonly<Record<string, ChatRecordHeadStamp>>;
  readonly sessionHostId: string | null;
  readonly ownCloudChatByLocalId: ReadonlyMap<string, CloudChatSummary>;
}): NodeSortClock {
  const byId = new Map<string, number>();
  for (const nodeId of Object.keys(input.chatsById)) {
    const chat = input.chatsById[nodeId];
    const lastActiveAt = chatRowLastActiveAt({
      recordUpdatedAt: chat.updatedAt,
      ownerHostId: chat.hostId,
      sessionHostId: input.sessionHostId,
      cloudChat: input.ownCloudChatByLocalId.get(nodeId) ?? null,
      recordHeadPublishedAt: recordHeadPublishedAt(
        input.recordHeads,
        chat.userId,
        nodeId,
      ),
    });
    if (lastActiveAt !== chat.updatedAt) byId.set(nodeId, lastActiveAt);
  }
  return byId;
}

/**
 * The content clock each row of the interleaved ROOT list sorts by, keyed by
 * the entry key `mergeChatListEntries` mints: every local override from
 * `localChatLastActiveAtById` re-keyed as a local row, plus each cloud row
 * whose record head the epic's record table holds
 * (`cloudChatRowLastActiveAt`). A nested local chat is entered too and simply
 * never looked up, which is cheaper than filtering to roots here and lets
 * the two maps stay one computation apart rather than two rules.
 */
export function chatListLastActiveAtByKey(input: {
  readonly localLastActiveAtById: NodeSortClock;
  readonly recordHeads: Readonly<Record<string, ChatRecordHeadStamp>>;
  readonly cloudChats: readonly CloudChatSummary[];
}): ReadonlyMap<string, number> {
  const byKey = new Map<string, number>();
  for (const [nodeId, lastActiveAt] of input.localLastActiveAtById) {
    byKey.set(localChatRowKey(nodeId), lastActiveAt);
  }
  for (const chat of input.cloudChats) {
    const publishedAt = recordHeadPublishedAt(
      input.recordHeads,
      chat.identity.ownerUserId,
      chat.identity.chatId,
    );
    if (publishedAt === null) continue;
    byKey.set(
      cloudChatRowKey(chat.identity),
      cloudChatRowLastActiveAt(chat, publishedAt),
    );
  }
  return byKey;
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
 * `lastActiveAtByKey` overrides a row's `updatedAt` sort key, keyed by the
 * entry key this function mints (`localChatRowKey` / `cloudChatRowKey`). It
 * carries the SAME value the row's idle-time chip renders - a foreign record's
 * publication clock (`chatRowLastActiveAt`), a cloud row's record head
 * (`cloudChatRowLastActiveAt`) - so the order and the chip cannot disagree
 * about which chat moved last. A row absent from it sorts by its own stamp.
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
  readonly lastActiveAtByKey: ReadonlyMap<string, number>;
}): readonly UnifiedChatEntry[] {
  const compare = input.comparator ?? makeNodeComparator(DEFAULT_SORT_MODE);
  const withLastActiveAt = (
    key: string,
    sortable: SortableNode,
  ): SortableNode => {
    const lastActiveAt = input.lastActiveAtByKey.get(key);
    return lastActiveAt === undefined || lastActiveAt === sortable.updatedAt
      ? sortable
      : { ...sortable, updatedAt: lastActiveAt };
  };
  const rows: { entry: UnifiedChatEntry; sortable: SortableNode }[] = [];
  for (const nodeId of input.localRootIds) {
    // Root ids are drawn from the same tree as `nodeById`, so every id
    // resolves; a defensive skip here would hide a projector bug instead.
    const key = localChatRowKey(nodeId);
    rows.push({
      entry: { kind: "local", key, nodeId },
      sortable: withLastActiveAt(key, input.nodeById[nodeId]),
    });
  }
  for (const chat of input.cloudChats) {
    const key = cloudChatRowKey(chat.identity);
    rows.push({
      entry: { kind: "cloud", key, chat },
      sortable: withLastActiveAt(key, cloudChatSortable(chat)),
    });
  }
  rows.sort((a, b) => compare(a.sortable, b.sortable));
  return rows.map((row) => row.entry);
}
