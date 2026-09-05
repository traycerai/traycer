import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import { buildTreeFromFlatRecords } from "@/lib/tree-utils";
import type { TreeNodeNested } from "@/lib/tree-types";

/**
 * The Background section's list, as a tree, and the numbers derived from it.
 *
 * Pure data shaping, kept out of the panel that renders it because a second
 * surface now has to agree with those numbers exactly: the compact chip that
 * stands in for the section when Layout ▸ Composer folds it away. A chip
 * saying "2 running" over a header saying "3" is the one way that pairing can
 * be wrong, so both read the count from here.
 */

export interface RememberedBackgroundNode {
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly parentTaskId: string | null;
}

interface BackgroundTreeRecord {
  readonly taskId: string;
  readonly item: BackgroundItem | null;
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly parentTaskId: string | null;
  readonly order: number;
}

export interface BackgroundTreeNode {
  readonly taskId: string;
  readonly item: BackgroundItem | null;
  readonly kind: BackgroundItem["kind"];
  readonly title: string;
  readonly children: ReadonlyArray<BackgroundTreeNode>;
}

function itemParentTaskId(item: BackgroundItem): string | null {
  return item.parentTaskId ?? null;
}

function rememberBackgroundItem(
  item: BackgroundItem,
): RememberedBackgroundNode {
  return {
    kind: item.kind,
    title: item.title,
    parentTaskId: itemParentTaskId(item),
  };
}

function rememberMissingParent(taskId: string): RememberedBackgroundNode {
  return {
    kind: "subagent",
    title: taskId,
    parentTaskId: null,
  };
}

// Collapse the host list to one row per task id. The host broadcasts a
// running-only list and removes an item atomically at its terminal, so this is
// a defensive guard: a transient duplicate (same `taskId`) must not render two
// rows with the same React key or two stop affordances for one task.
export function dedupeByTaskId(
  items: ReadonlyArray<BackgroundItem>,
): ReadonlyArray<BackgroundItem> {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.taskId)) return false;
    seen.add(item.taskId);
    return true;
  });
}

function parentChainContains(
  startTaskId: string,
  targetTaskId: string,
  recordByTaskId: ReadonlyMap<string, BackgroundTreeRecord>,
): boolean {
  let cursor: string | null = startTaskId;
  const seen = new Set<string>();
  while (cursor !== null) {
    if (cursor === targetTaskId) return true;
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = recordByTaskId.get(cursor)?.parentTaskId ?? null;
  }
  return false;
}

export function buildRememberedBackgroundNodes(
  items: ReadonlyArray<BackgroundItem>,
  previous: ReadonlyMap<string, RememberedBackgroundNode>,
): ReadonlyMap<string, RememberedBackgroundNode> {
  const next = new Map(
    items.map((item) => [item.taskId, rememberBackgroundItem(item)]),
  );
  const pendingParentIds: string[] = [];
  const queuedParentIds = new Set<string>();
  const enqueueParent = (taskId: string): void => {
    if (next.has(taskId) || queuedParentIds.has(taskId)) return;
    queuedParentIds.add(taskId);
    pendingParentIds.push(taskId);
  };
  items.forEach((item) => {
    const parentTaskId = itemParentTaskId(item);
    if (parentTaskId !== null) enqueueParent(parentTaskId);
  });
  let pendingIndex = 0;
  while (pendingIndex < pendingParentIds.length) {
    const taskId = pendingParentIds[pendingIndex];
    pendingIndex += 1;
    const remembered = previous.get(taskId) ?? rememberMissingParent(taskId);
    next.set(taskId, remembered);
    if (remembered.parentTaskId !== null) {
      enqueueParent(remembered.parentTaskId);
    }
  }
  return next;
}

function backgroundTreeNodeFromNested(
  node: TreeNodeNested<BackgroundTreeRecord>,
): BackgroundTreeNode {
  const data = node.data;
  return {
    taskId: data.taskId,
    item: data.item,
    kind: data.kind,
    title: data.title,
    children: Array.from(node.children ?? [])
      .sort(compareBackgroundTreeRecords)
      .map((child) => backgroundTreeNodeFromNested(child)),
  };
}

function compareBackgroundTreeRecords(
  left: TreeNodeNested<BackgroundTreeRecord>,
  right: TreeNodeNested<BackgroundTreeRecord>,
): number {
  return left.data.order - right.data.order;
}

export function buildBackgroundTree(
  items: ReadonlyArray<BackgroundItem>,
  rememberedByTaskId: ReadonlyMap<string, RememberedBackgroundNode>,
): ReadonlyArray<BackgroundTreeNode> {
  const itemByTaskId = new Map(items.map((item) => [item.taskId, item]));
  const itemOrderByTaskId = new Map(
    items.map((item, index) => [item.taskId, index]),
  );
  const records = Array.from(rememberedByTaskId.entries()).map(
    ([taskId, remembered], index): BackgroundTreeRecord => {
      const item = itemByTaskId.get(taskId) ?? null;
      const order = itemOrderByTaskId.get(taskId) ?? items.length + index;
      if (item === null) {
        return {
          taskId,
          item,
          kind: remembered.kind,
          title: remembered.title,
          parentTaskId: remembered.parentTaskId,
          order,
        };
      }
      return {
        taskId,
        item,
        kind: item.kind,
        title: item.title,
        parentTaskId: itemParentTaskId(item),
        order,
      };
    },
  );
  const recordByTaskId = new Map(
    records.map((record) => [record.taskId, record]),
  );

  return buildTreeFromFlatRecords(records, {
    getId: (record) => record.taskId,
    getParentId: (record) => {
      const parentTaskId = record.parentTaskId;
      if (parentTaskId === null) return null;
      if (parentChainContains(parentTaskId, record.taskId, recordByTaskId)) {
        return null;
      }
      return parentTaskId;
    },
    getData: (record) => record,
  })
    .sort(compareBackgroundTreeRecords)
    .map((node) => backgroundTreeNodeFromNested(node));
}

export function treeHasRunningTask(node: BackgroundTreeNode): boolean {
  if (node.item !== null && node.item.kind !== "wakeup") return true;
  return node.children.some((child) => treeHasRunningTask(child));
}

/**
 * The running half of the Background header's summary: how many rows the
 * section would show as running right now.
 *
 * It re-derives the tree from the DELIVERED items alone, where the panel's own
 * tree additionally carries forward parents it has seen before. That history
 * only ever MERGES roots - it supplies a vanished parent's own parent link, and
 * a remembered-only node has no item of its own to count - so this number can
 * come out HIGHER than the panel's, never lower. Two running children whose
 * parents have both dropped out of the delivered list are one group to a panel
 * that remembers their shared grandparent and two groups here.
 *
 * Rare, transient, and it converges on the panel's next render; recorded
 * because the direction of the skew is the part a future reader will take on
 * trust.
 */
export function backgroundRunningRowCount(input: {
  readonly items: ReadonlyArray<BackgroundItem>;
  readonly runningManagedCommandIds: ReadonlyArray<string>;
  readonly heldManagedCommandIds: ReadonlyArray<string>;
}): number {
  const items = dedupeByTaskId(input.items);
  const tree = buildBackgroundTree(
    items,
    buildRememberedBackgroundNodes(items, new Map()),
  );
  const held = new Set(input.heldManagedCommandIds);
  return (
    tree.filter(treeHasRunningTask).length +
    input.runningManagedCommandIds.filter((id) => !held.has(id)).length
  );
}

/**
 * What "Background" actually holds, counted the way the rows below render.
 * Managed commands join the running total rather than standing apart: "Stop
 * all" reaches them, and the rows below say which is which.
 *
 * Held shells get their own part instead of joining that total, and NOT because
 * nothing is running - a shell can be held and still running. It is because the
 * panel renders such a shell ONCE, as held, so counting it as running would
 * name a row that is not on screen. Every number here counts a group of rows a
 * person can see, which is the only version of this summary that stays true
 * however the two sets overlap.
 *
 * That does leave the running total narrower than "Stop all"'s reach, which
 * still covers every running shell including a held one. A superset is the safe
 * direction: the button never leaves a process alive that the header implied it
 * would stop.
 */
export function backgroundHeaderSummary(input: {
  readonly runningCount: number;
  readonly heldCount: number;
  readonly waitingWakeCount: number;
}): string {
  const parts: string[] = [];
  if (input.runningCount > 0) {
    parts.push(`${input.runningCount} running`);
  }
  if (input.heldCount > 0) {
    parts.push(`${input.heldCount} held`);
  }
  if (input.waitingWakeCount > 0) {
    parts.push(`${input.waitingWakeCount} waiting`);
  }
  return parts.length === 0 ? "0 running" : parts.join(" · ");
}
