/**
 * Collision detection for the single root DndContext: pointer-only hit
 * testing, source→target compatibility filtering, the priority ladder for
 * overlapping targets, and the collision-pass pointer stash that the
 * provider's preview/commit math reads. Kept out of the provider component
 * file so the table stays unit-testable and the .tsx file exports only the
 * component.
 */
import {
  pointerWithin,
  type Active,
  type CollisionDetection,
} from "@dnd-kit/core";
import {
  EPIC_CANVAS_DND_SOURCE_TYPES,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  isRecord,
  readEpicCanvasDragSourceData,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropTargetData,
  type PointLike,
} from "@/components/epic-canvas/dnd/dnd";
import {
  getPierreDragHost,
  isPierreHostData,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  HEADER_TAB_DND_TYPE,
  HEADER_TAB_SLOT_DND_TYPE,
} from "@/components/layout/tabs/header-tab-dnd";

/**
 * Resolves the typed canvas source from the active draggable: Pierre hosts
 * carry a stable marker as `data` and their per-press payload in the module
 * registry (resolved by the sensor at pointer-down); every other source
 * attaches its payload directly.
 */
export function readActiveDragSource(
  active: Active,
): EpicCanvasDragSourceData | null {
  const data: unknown = active.data.current;
  if (isPierreHostData(data)) {
    return getPierreDragHost(String(active.id))?.payload ?? null;
  }
  return readEpicCanvasDragSourceData(data);
}

function readDndDataKind(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return typeof value.kind === "string" ? value.kind : null;
}

function readActiveDragKind(active: Active): string | null {
  return (
    readActiveDragSource(active)?.kind ?? readDndDataKind(active.data.current)
  );
}

/** Every drop-target kind the root context can resolve a collision against. */
type EpicRootDropTargetKind =
  EpicCanvasDropTargetData["kind"] | typeof HEADER_TAB_SLOT_DND_TYPE;

const LEFT_PANEL_TARGET_KINDS: ReadonlyArray<EpicRootDropTargetKind> = [
  "left-panel-rail-item",
  "left-panel-rail-list",
  "left-panel-group",
];

const CANVAS_TARGET_KINDS: ReadonlyArray<EpicRootDropTargetKind> = [
  HEADER_TAB_SLOT_DND_TYPE,
  "artifact-tab",
  "artifact-tab-strip-end",
  "artifact-tab-group-body",
  "empty-shell",
];

// Only a `sidebar-node` drag may resolve a reparent target. It keeps every
// canvas open-as-tile target too (disambiguated by drop region: a row/panel
// reparents, canvas/pane/tab/header opens a tile).
const SIDEBAR_NODE_TARGET_KINDS: ReadonlyArray<EpicRootDropTargetKind> = [
  ...CANVAS_TARGET_KINDS,
  "sidebar-reparent-row",
  "sidebar-reparent-panel",
];

function targetKindsForSourceKind(
  sourceKind: string | null,
): ReadonlyArray<EpicRootDropTargetKind> {
  if (sourceKind === null) return [];
  if (sourceKind === HEADER_TAB_DND_TYPE) return [HEADER_TAB_SLOT_DND_TYPE];
  if (sourceKind === LEFT_PANEL_RAIL_ITEM_DND_TYPE) {
    return LEFT_PANEL_TARGET_KINDS;
  }
  if (sourceKind === SIDEBAR_NODE_DND_TYPE) {
    return SIDEBAR_NODE_TARGET_KINDS;
  }
  if (EPIC_CANVAS_DND_SOURCE_TYPES.includes(sourceKind)) {
    return CANVAS_TARGET_KINDS;
  }
  return [];
}

/**
 * Priority rank per target kind for overlapping hits (lower wins): tab chips
 * beat their strip's trailing zone, rail icons beat the rail background, and
 * small chrome targets beat the large body/empty-shell surfaces (which share
 * one rank). `satisfies` keeps the ladder exhaustive over every root drop
 * target kind, so a renamed or newly added kind fails compile here instead
 * of silently dead-zoning its drops.
 */
const TARGET_KIND_PRIORITY = {
  [HEADER_TAB_SLOT_DND_TYPE]: 0,
  "artifact-tab": 1,
  "artifact-tab-strip-end": 2,
  "left-panel-rail-item": 3,
  "left-panel-rail-list": 4,
  "left-panel-group": 5,
  "artifact-tab-group-body": 6,
  "empty-shell": 6,
  // Sidebar reparent targets: the row beats the panel so hovering a row picks
  // the row and only true empty space picks the panel (root drop). Sidebar and
  // canvas occupy disjoint regions, so ranking below the canvas chrome is moot
  // for cross-group overlaps - only row-vs-panel matters.
  "sidebar-reparent-row": 7,
  "sidebar-reparent-panel": 8,
} as const satisfies Record<EpicRootDropTargetKind, number>;

function isEpicRootDropTargetKind(
  kind: string,
): kind is EpicRootDropTargetKind {
  return Object.hasOwn(TARGET_KIND_PRIORITY, kind);
}

function readDropTargetKind(value: unknown): EpicRootDropTargetKind | null {
  const kind = readDndDataKind(value);
  return kind !== null && isEpicRootDropTargetKind(kind) ? kind : null;
}

/**
 * Pointer point from the most recent collision pass. @dnd-kit/core's event
 * `delta` is scroll-adjusted (it folds in the scroll delta since drag start)
 * while collision detection receives `pointerCoordinates` = activation
 * coordinates + translate, and droppable rects report live viewport
 * coordinates - so with autoScroll enabled, reconstructing the pointer as
 * `activatorEvent.clientX/Y + delta` drifts by the scroll amount once
 * anything scrolls mid-drag. The collision pass's pointer is the exact point
 * that picked `over`, so every preview/commit computation reads it from here
 * and can never disagree with the hit test. Cleared on drag end/cancel.
 */
let lastCollisionPointerPoint: PointLike | null = null;

export function getLastCollisionPointerPoint(): PointLike | null {
  return lastCollisionPointerPoint;
}

export function clearLastCollisionPointerPoint(): void {
  lastCollisionPointerPoint = null;
}

/**
 * Pointer-only hit testing with a priority ladder for overlapping targets
 * (see `TARGET_KIND_PRIORITY`). Targets incompatible with the active source
 * kind are dropped up front so e.g. a rail drag never lights up a pane body.
 */
export const epicRootCollisionDetection: CollisionDetection = (args) => {
  lastCollisionPointerPoint = args.pointerCoordinates;
  const activeKind = readActiveDragKind(args.active);
  const compatibleKinds = targetKindsForSourceKind(activeKind);
  if (compatibleKinds.length === 0) return [];
  const kindByContainerId = new Map<
    string | number,
    EpicRootDropTargetKind | null
  >(
    args.droppableContainers.map((container) => [
      container.id,
      readDropTargetKind(container.data.current),
    ]),
  );
  const rankedHits = pointerWithin(args).flatMap((hit) => {
    const kind = kindByContainerId.get(hit.id) ?? null;
    if (kind === null || !compatibleKinds.includes(kind)) return [];
    return [{ hit, rank: TARGET_KIND_PRIORITY[kind] }];
  });
  const topRank = rankedHits.reduce(
    (best, entry) => Math.min(best, entry.rank),
    Number.POSITIVE_INFINITY,
  );
  return rankedHits
    .filter((entry) => entry.rank === topRank)
    .map((entry) => entry.hit);
};
