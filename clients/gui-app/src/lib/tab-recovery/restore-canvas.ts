import { v4 as uuidv4 } from "uuid";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import type {
  TileLayoutNode,
  TilePane,
  SizesByGroupId,
} from "@/stores/epics/canvas/tile-tree";

function shape(node: TileLayoutNode | null): string {
  if (node === null) return "empty";
  return node.kind === "pane"
    ? node.id
    : `${node.id}:${node.direction}[${node.children.map(shape).join(",")}]`;
}

function emptyPane(id: string): TilePane {
  return {
    kind: "pane",
    id,
    tabInstanceIds: [],
    activeTabId: null,
    previewTabId: null,
    activationHistory: [],
  };
}

function nodesById(root: TileLayoutNode | null): Map<string, TileLayoutNode> {
  const nodes = new Map<string, TileLayoutNode>();
  const visit = (node: TileLayoutNode): void => {
    nodes.set(node.id, node);
    if (node.kind === "group") node.children.forEach(visit);
  };
  if (root !== null) visit(root);
  return nodes;
}

interface StructureRecoveryContext {
  readonly sizes: Record<string, readonly number[] | undefined>;
  readonly oldSizes: SizesByGroupId;
  readonly wantedPanes: ReadonlySet<string>;
}

/** Reinsert only a recognizable closed region; tab edits and resizing are irrelevant. */
function restoreStructure(
  before: TileLayoutNode | null,
  after: TileLayoutNode | null,
  current: TileLayoutNode | null,
  context: StructureRecoveryContext,
): TileLayoutNode | null {
  const { sizes, oldSizes, wantedPanes } = context;
  if (before === null || shape(before) === shape(after)) return current;
  const live = nodesById(current);
  const rebuild = (node: TileLayoutNode): TileLayoutNode | null => {
    const existing = live.get(node.id);
    if (node.kind === "pane") {
      if (existing?.kind === "pane") return existing;
      return wantedPanes.has(node.id) ? emptyPane(node.id) : null;
    }
    const children = node.children.flatMap((child) => {
      const restored = rebuild(child);
      return restored === null ? [] : [restored];
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0];
    if (
      existing?.kind !== "group" ||
      existing.children.map((child) => child.id).join() !==
        children.map((child) => child.id).join()
    ) {
      sizes[node.id] = oldSizes[node.id];
    }
    return { ...node, children };
  };
  if (shape(after) === shape(current)) return rebuild(before);
  if (
    before.kind !== "group" ||
    after?.kind !== "group" ||
    current?.kind !== "group" ||
    before.id !== after.id ||
    after.id !== current.id ||
    before.direction !== current.direction
  )
    return current;
  // Child order is the structural address. A moved or newly split anchor is
  // intentionally not followed into a different part of the canvas.
  const children = current.children.map((child, index) => {
    const closedChild = after.children.at(index);
    if (closedChild === undefined || child.id !== closedChild.id) return child;
    // A removed sibling shifts array indices; a collapsed group promotes its
    // surviving descendant. Match that stable identity to its original branch.
    const oldChild = before.children.find((candidate) =>
      nodesById(candidate).has(closedChild.id),
    );
    if (oldChild === undefined) return child;
    return restoreStructure(oldChild, closedChild, child, context) ?? child;
  });
  return { ...current, children };
}

function mapPanes(
  root: TileLayoutNode,
  visit: (pane: TilePane) => TilePane,
): TileLayoutNode {
  return root.kind === "pane"
    ? visit(root)
    : {
        ...root,
        children: root.children.map((child) => mapPanes(child, visit)),
      };
}

function restoredTabIndex(
  originalOrder: readonly string[],
  currentOrder: readonly string[],
  id: string,
): number {
  const oldIndex = originalOrder.indexOf(id);
  const following = originalOrder
    .slice(oldIndex + 1)
    .find((candidate) => currentOrder.includes(candidate));
  if (following !== undefined) return currentOrder.indexOf(following);
  const preceding = originalOrder
    .slice(0, oldIndex)
    .findLast((candidate) => currentOrder.includes(candidate));
  if (preceding !== undefined) return currentOrder.indexOf(preceding) + 1;
  return Math.min(oldIndex, currentOrder.length);
}

interface RestoredTarget {
  readonly paneId: string;
  readonly instanceId: string;
  readonly preferred: boolean;
}

function preferredRestoredTarget(
  targets: readonly RestoredTarget[],
): RestoredTarget | null {
  return targets.find((target) => target.preferred) ?? targets.at(0) ?? null;
}

interface CanvasRecoveryOptions {
  readonly instanceIds: readonly string[];
  readonly paneIds?: readonly string[];
  readonly focus: boolean;
}

function restoredActivePaneId(
  root: TileLayoutNode,
  currentId: string | null,
  fallbackId: string,
  targetId: string | null,
): string {
  return targetId ?? findPaneById(root, currentId ?? "")?.id ?? fallbackId;
}

interface PreparedCanvasRecovery {
  readonly root: TileLayoutNode;
  readonly sizes: Record<string, readonly number[] | undefined>;
  readonly missing: ReadonlySet<string>;
  readonly originalPanes: readonly TilePane[];
  readonly recoveredPanes: readonly string[];
}

function prepareCanvasRecovery(
  current: EpicCanvasState,
  before: EpicCanvasState,
  after: EpicCanvasState,
  options: CanvasRecoveryOptions,
): PreparedCanvasRecovery | null {
  const { instanceIds } = options;
  const liveIds = new Set(
    collectPanes(current.root).flatMap((pane) => pane.tabInstanceIds),
  );
  const missing = new Set(
    instanceIds.filter(
      (id) => !liveIds.has(id) && before.tilesByInstanceId[id] !== undefined,
    ),
  );
  const missingPanes = (options.paneIds ?? []).filter(
    (id) =>
      findPaneById(current.root, id) === null &&
      findPaneById(before.root, id) !== null,
  );
  if (missing.size === 0 && missingPanes.length === 0) return null;
  const originalPanes = collectPanes(before.root);
  const wantedPanes = new Set(
    originalPanes
      .filter((pane) => pane.tabInstanceIds.some((id) => missing.has(id)))
      .map((pane) => pane.id),
  );
  for (const id of missingPanes) wantedPanes.add(id);
  const sizes = { ...current.sizesByGroupId };
  const root =
    restoreStructure(before.root, after.root, current.root, {
      sizes,
      oldSizes: before.sizesByGroupId,
      wantedPanes,
    }) ?? emptyPane(uuidv4());
  const recoveredPanes = missingPanes.filter(
    (id) => findPaneById(root, id) !== null,
  );
  // Empty splits have no content to fall back with when their structural
  // anchor has changed. Do not invent a placeholder in the active pane.
  if (missing.size === 0 && recoveredPanes.length === 0) return null;
  return { root, sizes, missing, originalPanes, recoveredPanes };
}

function recoveryFocusPaneId(
  target: RestoredTarget | null,
  recoveredPanes: readonly string[],
  previousId: string | null,
): string | null {
  return (
    target?.paneId ??
    recoveredPanes.find((id) => id === previousId) ??
    recoveredPanes.at(0) ??
    null
  );
}

/** Restore view identities, never content snapshots or processes. */
export function restoreClosedCanvas(
  current: EpicCanvasState,
  before: EpicCanvasState,
  after: EpicCanvasState,
  options: CanvasRecoveryOptions,
): EpicCanvasState {
  const prepared = prepareCanvasRecovery(current, before, after, options);
  if (prepared === null) return current;
  const { sizes, missing, originalPanes, recoveredPanes } = prepared;
  const { focus } = options;
  let root = prepared.root;
  const panes = collectPanes(root);
  const fallback =
    panes.find((pane) => pane.id === current.activePaneId) ?? panes[0];
  const tiles = { ...current.tilesByInstanceId };
  const restoredTargets: RestoredTarget[] = [];
  for (const original of originalPanes) {
    const ids = original.tabInstanceIds.filter((id) => missing.has(id));
    if (ids.length === 0) continue;
    const destinationId = findPaneById(root, original.id)?.id ?? fallback.id;
    root = mapPanes(root, (pane) => {
      if (pane.id !== destinationId) return pane;
      const order = [...pane.tabInstanceIds];
      for (const id of ids) {
        const index = restoredTabIndex(original.tabInstanceIds, order, id);
        order.splice(index, 0, id);
        tiles[id] = before.tilesByInstanceId[id];
        restoredTargets.push({
          paneId: pane.id,
          instanceId: id,
          preferred:
            original.id === before.activePaneId && original.activeTabId === id,
        });
      }
      const activeTabId =
        pane.activeTabId ??
        (original.activeTabId !== null && ids.includes(original.activeTabId)
          ? original.activeTabId
          : ids[0]);
      return {
        ...pane,
        tabInstanceIds: order,
        activeTabId,
        activationHistory: [
          activeTabId,
          ...pane.activationHistory.filter((id) => id !== activeTabId),
        ],
      };
    });
  }
  const target = preferredRestoredTarget(restoredTargets);
  if (focus && target !== null) {
    root = mapPanes(root, (pane) =>
      pane.id === target.paneId
        ? {
            ...pane,
            activeTabId: target.instanceId,
            activationHistory: [
              target.instanceId,
              ...pane.activationHistory.filter(
                (id) => id !== target.instanceId,
              ),
            ],
          }
        : pane,
    );
  }
  const groups = nodesById(root);
  return {
    root,
    tilesByInstanceId: tiles,
    activePaneId: restoredActivePaneId(
      root,
      current.activePaneId,
      fallback.id,
      focus
        ? recoveryFocusPaneId(target, recoveredPanes, before.activePaneId)
        : null,
    ),
    sizesByGroupId: Object.fromEntries(
      Object.entries(sizes).filter(([id]) => groups.get(id)?.kind === "group"),
    ),
  };
}
