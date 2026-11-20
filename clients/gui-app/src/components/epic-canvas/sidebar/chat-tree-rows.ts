import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { EpicTreeIndex } from "@/lib/epic-selectors";
import {
  sortNodeIdsWithClock,
  type NodeComparator,
  type NodeSortClock,
} from "@/lib/epic-sort";
import type {
  UnifiedChatEntry,
  UnifiedCloudChatEntry,
} from "@/lib/chats/unified-chat-list";

/**
 * The chat tree as the flat list of rows it draws, in the order it draws them.
 *
 * The sidebar used to render the tree recursively - a row's `<li>` held a
 * `<ul role="group">` of its children - which mounted every row of the task at
 * once. The virtual list renders a window of THIS list instead, so the list has
 * to say everything the nesting used to: which rows are drawn (a collapsed
 * branch draws none of its descendants), in which order, how deep, and where
 * each row sits in the group it would have been a child of.
 *
 * It is the same tree the recursive rendering drew, built from the same inputs
 * by the same rules - see {@link flattenChatTreeRows}.
 */
interface ChatTreeRowBase {
  /**
   * The row's identity: React key, the virtualizer's item key, and the pin
   * key. A child's key is its parent's key, `/`, then its own, so a row that
   * moves to another parent is a different row - it leaves one place and
   * appears in the other, exactly as an element moving between two `<ul>`s
   * did - while a row that keeps its parent keeps its key when siblings
   * reorder around it.
   */
  readonly key: string;
  readonly parentKey: string | null;
  /** 0 for a root row. */
  readonly depth: number;
  /** 1-based position among the rows of the group it is drawn in. */
  readonly posInSet: number;
  readonly setSize: number;
  /** Whether the row has children that would be drawn when it is expanded. */
  readonly hasChildren: boolean;
  /**
   * The row's expansion as its component reads it. A local row reports its
   * own membership in the expanded set whether or not it has children (the
   * chevron and the archive affordance read it that way); a cloud row reports
   * an open branch only when it has one.
   */
  readonly expanded: boolean;
}

export interface ChatTreeLocalRow extends ChatTreeRowBase {
  readonly kind: "local";
  readonly nodeId: string;
}

export interface ChatTreeCloudRow extends ChatTreeRowBase {
  readonly kind: "cloud";
  /** `chat.identity.chatId`: what the row publishes as `data-sidebar-node-id`. */
  readonly nodeId: string;
  readonly chat: CloudChatSummary;
  /** The id the panel's expansion store keys this branch by. */
  readonly expansionId: string;
}

interface ChatTreePendingRow extends ChatTreeRowBase {
  readonly kind: "pending";
  readonly nodeId: null;
  readonly name: string;
}

export type ChatTreeRow =
  | ChatTreeLocalRow
  | ChatTreeCloudRow
  | ChatTreePendingRow;

export interface ChatTreeRowModel {
  readonly rows: readonly ChatTreeRow[];
  /**
   * Moves exactly when the sequence of row keys changes: a row added,
   * removed, reordered, or shown or hidden by a branch toggling. A row whose
   * own facts change without moving leaves it alone.
   */
  readonly revision: number;
  readonly indexByKey: ReadonlyMap<string, number>;
}

/** A root "being created" row, in the order the panel lists them. */
export interface ChatTreePendingRootInput {
  readonly key: string;
  readonly name: string;
}

export const PENDING_LOCAL_ROOT_KEY = "pending:local-root";
export const PENDING_ACKNOWLEDGED_ROOT_KEY = "pending:ack-root";

export function pendingPreAckRowKey(tempId: string): string {
  return `pending:pre-ack:${tempId}`;
}

export function pendingCreateRowKey(id: string): string {
  return `pending:create:${id}`;
}

function childRowKey(parentKey: string, ownKey: string): string {
  return `${parentKey}/${ownKey}`;
}

/** The local-child key segment, the same form a local root key takes. */
function localChildSegment(nodeId: string): string {
  return `local:${nodeId}`;
}

type TreeFilterFn = (type: string | null | undefined) => boolean;

export interface FlattenChatTreeRowsInput {
  /**
   * The interleaved root list (`mergeChatListEntries`): local roots and cloud
   * rows, cloud rows already nested under their orchestrators.
   */
  readonly listEntries: readonly UnifiedChatEntry[];
  readonly pendingRoots: readonly ChatTreePendingRootInput[];
  readonly tree: EpicTreeIndex;
  readonly expandedIds: ReadonlySet<string>;
  /**
   * The panel's combined visibility (filter, search, reveal and archive
   * hiding); `null` when nothing narrows the tree.
   */
  readonly visibleIds: ReadonlySet<string> | null;
  readonly treeFilter: TreeFilterFn;
  readonly comparator: NodeComparator | null;
  readonly clock: NodeSortClock | null;
}

/** A row before its group is complete: it learns its place once its siblings are known. */
interface PlannedRow {
  readonly build: (posInSet: number, setSize: number) => ChatTreeRow;
  readonly children: readonly PlannedRow[];
}

/** Where a row sits in the tree. */
interface RowPlacement {
  readonly key: string;
  readonly parentKey: string | null;
  readonly depth: number;
}

/**
 * The rows the chat tree draws, in preorder.
 *
 * Each group is what the recursive rendering put in that `<ul>`:
 *
 * - The root group is `listEntries` - local roots and cloud rows in their one
 *   interleaved order - followed by the pending-create rows.
 * - A local row's children are its children in the tree that pass the panel's
 *   node-kind filter and visibility, sorted by the panel's comparator and
 *   clock, exactly as the row's own `useFilteredPanelChildIds` listed them.
 * - A cloud row's children are its `children` entries.
 *
 * A branch's children are listed only while it is expanded. A local root the
 * tree no longer holds, or whose kind the panel does not draw, draws nothing -
 * the row component returned `null` for it.
 */
export function flattenChatTreeRows(
  input: FlattenChatTreeRowsInput,
): readonly ChatTreeRow[] {
  const { tree } = input;

  const visibleLocalChildIds = (nodeId: string): readonly string[] => {
    if (!Object.hasOwn(tree.childrenByParent, nodeId)) return [];
    const childIds = tree.childrenByParent[nodeId];
    if (childIds.length === 0) return childIds;
    const filtered = childIds.filter((childId) => {
      if (!Object.hasOwn(tree.nodeById, childId)) return false;
      if (!input.treeFilter(tree.nodeById[childId].type)) return false;
      return input.visibleIds === null || input.visibleIds.has(childId);
    });
    return sortNodeIdsWithClock(
      filtered,
      tree.nodeById,
      input.comparator,
      input.clock,
    );
  };

  // `ancestors` guards a malformed parent cycle: the recursive rendering
  // would never have finished one, and a list must not either.
  const planLocal = (
    nodeId: string,
    at: RowPlacement,
    ancestors: ReadonlySet<string>,
  ): PlannedRow | null => {
    const { key, parentKey, depth } = at;
    if (!Object.hasOwn(tree.nodeById, nodeId)) return null;
    if (!input.treeFilter(tree.nodeById[nodeId].type)) return null;
    const childIds = visibleLocalChildIds(nodeId);
    const expanded = input.expandedIds.has(nodeId);
    const hasChildren = childIds.length > 0;
    const children: PlannedRow[] = [];
    if (hasChildren && expanded && !ancestors.has(nodeId)) {
      const nextAncestors = new Set(ancestors).add(nodeId);
      for (const childId of childIds) {
        const child = planLocal(
          childId,
          {
            key: childRowKey(key, localChildSegment(childId)),
            parentKey: key,
            depth: depth + 1,
          },
          nextAncestors,
        );
        if (child !== null) children.push(child);
      }
    }
    return {
      build: (posInSet, setSize) => ({
        kind: "local",
        key,
        parentKey,
        depth,
        posInSet,
        setSize,
        nodeId,
        hasChildren,
        expanded,
      }),
      children,
    };
  };

  const planCloud = (
    entry: UnifiedCloudChatEntry,
    key: string,
    parentKey: string | null,
    depth: number,
  ): PlannedRow => {
    const hasChildren = entry.children.length > 0;
    const expanded = hasChildren && input.expandedIds.has(entry.key);
    return {
      build: (posInSet, setSize) => ({
        kind: "cloud",
        key,
        parentKey,
        depth,
        posInSet,
        setSize,
        nodeId: entry.chat.identity.chatId,
        chat: entry.chat,
        expansionId: entry.key,
        hasChildren,
        expanded,
      }),
      children: expanded
        ? entry.children.map((child) =>
            planCloud(child, childRowKey(key, child.key), key, depth + 1),
          )
        : [],
    };
  };

  const roots: PlannedRow[] = [];
  for (const entry of input.listEntries) {
    if (entry.kind === "local") {
      const planned = planLocal(
        entry.nodeId,
        { key: entry.key, parentKey: null, depth: 0 },
        new Set(),
      );
      if (planned !== null) roots.push(planned);
    } else {
      roots.push(planCloud(entry, entry.key, null, 0));
    }
  }
  for (const pending of input.pendingRoots) {
    roots.push({
      build: (posInSet, setSize) => ({
        kind: "pending",
        key: pending.key,
        parentKey: null,
        depth: 0,
        posInSet,
        setSize,
        nodeId: null,
        name: pending.name,
        hasChildren: false,
        expanded: false,
      }),
      children: [],
    });
  }

  const rows: ChatTreeRow[] = [];
  const emit = (group: readonly PlannedRow[]): void => {
    group.forEach((planned, index) => {
      rows.push(planned.build(index + 1, group.length));
      emit(planned.children);
    });
  };
  emit(roots);
  return rows;
}

/**
 * Whether two summaries of the same chat say the same thing. A list rebuilt
 * with equal content must leave its rows as they were: the row model keeps
 * the previous rows only when nothing they draw changed, and re-renders until
 * it does. `identity` is not compared because the row key already carries it.
 */
function sameCloudChat(a: CloudChatSummary, b: CloudChatSummary): boolean {
  if (a === b) return true;
  const bEntries = Object.entries(b);
  const bValues = new Map(bEntries);
  const aEntries = Object.entries(a);
  return (
    aEntries.length === bEntries.length &&
    aEntries.every(
      ([field, value]) =>
        field === "identity" ||
        (bValues.has(field) && Object.is(value, bValues.get(field))),
    )
  );
}

function sameRow(a: ChatTreeRow, b: ChatTreeRow): boolean {
  if (
    a.kind !== b.kind ||
    a.key !== b.key ||
    a.parentKey !== b.parentKey ||
    a.depth !== b.depth ||
    a.posInSet !== b.posInSet ||
    a.setSize !== b.setSize ||
    a.hasChildren !== b.hasChildren ||
    a.expanded !== b.expanded ||
    a.nodeId !== b.nodeId
  ) {
    return false;
  }
  if (a.kind === "cloud" && b.kind === "cloud") {
    return a.expansionId === b.expansionId && sameCloudChat(a.chat, b.chat);
  }
  if (a.kind === "pending" && b.kind === "pending") return a.name === b.name;
  return true;
}

/**
 * `next`, with every row that equals its predecessor of the same key replaced
 * by that predecessor, so a row whose facts did not change is the same object
 * and a memoised consumer of it does not re-render.
 */
export function stabilizeChatTreeRows(
  previous: readonly ChatTreeRow[],
  next: readonly ChatTreeRow[],
): readonly ChatTreeRow[] {
  if (previous.length === 0) return next.length === 0 ? previous : next;
  const previousByKey = new Map<string, ChatTreeRow>();
  for (const row of previous) previousByKey.set(row.key, row);
  let changed = previous.length !== next.length;
  const stable = next.map((row, index) => {
    const before = previousByKey.get(row.key);
    const kept = before !== undefined && sameRow(before, row) ? before : row;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? stable : previous;
}

/** Whether two row lists draw the same keys in the same order. */
export function sameRowKeySequence(
  a: readonly ChatTreeRow[],
  b: readonly ChatTreeRow[],
): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].key !== b[index].key) return false;
  }
  return true;
}

export function indexRowsByKey(
  rows: readonly ChatTreeRow[],
): ReadonlyMap<string, number> {
  const indexByKey = new Map<string, number>();
  rows.forEach((row, index) => indexByKey.set(row.key, index));
  return indexByKey;
}
