/**
 * THE single DndContext for the app. Mounted once in `app-shell.tsx`,
 * wrapping the header tab strip and every route surface, so canvas tiles,
 * sidebar sources, rail items, header tabs, and tear-off all share one
 * context - no geometry bridges between provider islands.
 *
 * The provider holds ZERO React state: drag lifecycle handlers write into
 * the ephemeral `dnd-store` (narrow per-target selectors keep preview ticks
 * scoped to the hovered pane) and track the last resolved drop in a ref.
 * Collision detection + the collision-pass pointer stash live in
 * `root-dnd-collision.ts`; commits live in `root-dnd-commits.ts` and read
 * stores imperatively.
 */
import {
  ARTIFACT_TAB_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  readComposerAttachmentDropTargetData,
  readEpicCanvasDropTargetData,
  type ComposerAttachmentDropTargetData,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropPreview,
  type EpicCanvasDropTargetData,
  type PointLike,
  type RectLike,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import {
  EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
  EpicCanvasPointerSensor,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  clearLastCollisionPointerPoint,
  epicRootCollisionDetection,
  getLastCollisionPointerPoint,
  readActiveDragSource,
} from "@/components/epic-canvas/dnd/root-dnd-collision";
import {
  canDropOnHeaderStrip,
  commitHeaderStripDrop,
  commitResolvedCanvasDrop,
  commitSidebarReparentDrop,
  isCanvasDropCompatible,
  isLeftPanelDropNoop,
  resolveCanvasDropPreview,
  resolveOverlayTileForSource,
  type HeaderStripDropResult,
  type ResolvedEpicCanvasDrop,
} from "@/components/epic-canvas/dnd/root-dnd-commits";
import {
  clearSidebarReparentPreview,
  clearSpringLoad,
  readSidebarReparentTarget,
  updateSidebarReparentPreview,
  type LastReparentDrop,
  type ReparentRefs,
  type SpringLoadEntry,
} from "@/components/epic-canvas/dnd/root-dnd-reparent-preview";
import {
  readHeaderTabDragData,
  readHeaderTabSlotDropData,
  resolveHeaderStripDropIndex,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import {
  TOP_LEVEL_FILLABLE_TARGET,
  readTopLevelTabDropTarget,
  resolveValidatedTopLevelTabDrop,
  stripPairTargetForIndex,
  type TopLevelFillableTarget,
  type TopLevelStripPairTarget,
  type TopLevelTabDropTarget,
} from "@/components/layout/tabs/top-level-tab-dnd";
import {
  activatePreparedPairTabIntent,
  existingEpicTabIntent,
  navigateToTabIntent,
} from "@/lib/tab-navigation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import { type SplitStripItem } from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { v4 as uuidv4 } from "uuid";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import type { Modifier } from "@dnd-kit/core";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  insertionIndexForTarget,
  insertionIndexFromPointer,
  insertionOffsetsFor,
  overlayLeftForPointer,
  remapGeometryToSlots,
  resolveStripDragState,
  stripOffsetsFor,
  type MergeSide,
  type StripDragGeometry,
  type StripDragState,
} from "@/components/epic-canvas/dnd/strip-drag-model";
import {
  HEADER_STRIP_SCROLL_TEST_ID,
  measureHeaderStripGeometry,
  readHeaderStripContentOriginX,
  readHeaderStripSlots,
} from "@/components/layout/tabs/header-strip-geometry";
import { pointIsOutsideViewport } from "@/components/epic-canvas/dnd/viewport-release";
import {
  readTabDetachHandler,
  type TabDetachHandler,
} from "@/components/layout/tabs/tab-detach-channel";
import { appLogger } from "@/lib/logger";
import {
  armHeaderStripCommitHandoff,
  disarmHeaderStripCommitHandoff,
} from "@/components/layout/tabs/header-strip-commit-handoff";
import {
  armTileStripCommitHandoff,
  disarmTileStripCommitHandoff,
} from "@/components/epic-canvas/dnd/tile-strip-commit-handoff";
import {
  measureForeignTileStrip,
  measureTileStripGeometry,
  readTileStripSlots,
  readTileStripContentOriginX,
  tileStripGroupAtPoint,
} from "@/components/epic-canvas/dnd/tile-strip-geometry";

/**
 * How far below the header strip a release has to land before it detaches into
 * a new window. Measured from the strip's own bottom edge - a hard-coded y is
 * only ever right for one strip height.
 */
const HEADER_TAB_TEAR_OFF_THRESHOLD_PX = 24;

/** Smaller leave threshold prevents jitter from pumping the strip at the edge. */
const HEADER_TAB_TEAR_OFF_RELEASE_PX = 16;

/** Stable empty map so clearing offsets never churns store identity. */
const EMPTY_HEADER_OFFSETS: ReadonlyMap<string, number> = new Map();

/**
 * Strip geometry for the header-tab gesture in flight, or null.
 *
 * Module-scoped rather than a React ref, mirroring the collision pass's pointer
 * stash: the overlay modifier is a plain dnd-kit callback, not a React consumer,
 * and threading a ref into it is exactly the "ref read during render" shape the
 * hooks lint forbids. Cleared on drag end and cancel.
 */
let activeHeaderStripGeometry: StripDragGeometry | null = null;

/** Hysteresis latch for the header tear-off preview/commit boundary. */
let headerTearOffActive = false;

/**
 * Latest raw pointer x, tracked independently of dnd-kit's render cycle.
 *
 * The overlay mounts a frame after activation, and on that first frame dnd-kit's
 * transform is still zero - so a tab positioned from the transform paints at its
 * rest position while the pointer is already `activationDistance` away, which
 * reads as a lag on the first frame of every drag. Reading the live pointer
 * makes the first painted frame correct.
 *
 * Overlay presentation ONLY. The model keeps using the collision pass's pointer,
 * which is the scroll-corrected point that actually chose `over`.
 */
let latestPointerX: number | null = null;
let latestPointerY: number | null = null;

/**
 * Tile-drag geometry for the gesture in flight: the SOURCE group's strip, plus
 * which group's strip the pointer is currently over. Module-scoped for the same
 * reason the header's is - the overlay modifier is a dnd-kit callback, not a
 * React consumer.
 */
let activeTileDrag: {
  readonly groupId: string;
  readonly tileId: string;
  readonly geometry: StripDragGeometry;
} | null = null;

/**
 * A preview tile promoted by drag start, so a drag that commits nothing can
 * put it back.
 *
 * Promotion is state, so a tile left promoted by a cancel or neutral-corridor
 * release is a residual. A completed drop keeps the promotion; every no-commit
 * exit restores it.
 */
let promotedPreviewOnDrag: {
  readonly viewTabId: string;
  readonly groupId: string;
  readonly tileId: string;
} | null = null;

function restorePromotedPreview(): void {
  const promoted = promotedPreviewOnDrag;
  if (promoted === null) return;
  useEpicCanvasStore
    .getState()
    .restorePreviewInTab(promoted.viewTabId, promoted.groupId, promoted.tileId);
}

/** Prevent a measurement failure from flooding the log on every pointer move. */
let stripGeometryFailureReported = false;

function reportStripGeometryFailure(strip: "header" | "tile"): void {
  if (stripGeometryFailureReported) return;
  stripGeometryFailureReported = true;
  appLogger.warn(
    `[root-dnd] ${strip} strip geometry became unavailable; strip-model commits are disabled for this gesture`,
    { strip },
  );
}

function trackPointerX(event: PointerEvent): void {
  latestPointerX = event.clientX;
  latestPointerY = event.clientY;
}

/**
 * Viewport x of the last pointer PRESS.
 *
 * The grab offset must be measured from where the gesture was pressed, not
 * where it activated - activation happens `EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE`
 * later, and using that point makes the dragged object sit offset from the
 * spot the user grabbed. `activatorEvent` carries this, but only when it is
 * recognisably a `MouseEvent`; a `PointerEvent` constructed in another realm
 * fails that check and silently falls back to a stale collision point, which
 * is a several-tens-of-px error rather than a few. Capturing the press
 * directly removes the guesswork for every source.
 */
let lastPointerDownX: number | null = null;

function trackPointerDownX(event: PointerEvent): void {
  lastPointerDownX = event.clientX;
  latestPointerX = event.clientX;
  latestPointerY = event.clientY;
}

/** The press position for a starting gesture, most reliable source first. */
function grabPointerX(activatorEvent: Event): number {
  if (lastPointerDownX !== null) return lastPointerDownX;
  if (activatorEvent instanceof MouseEvent) return activatorEvent.clientX;
  return getLastCollisionPointerPoint()?.x ?? 0;
}

/**
/**
 * Tile overlay: pointer-derived, and deliberately NOT clamped to any strip.
 *
 * The header clamps because it has exactly one strip and a tab cannot leave it.
 * The canvas has a strip per group with canvas between them, and a tile
 * legitimately travels across that space to reach another group. Clamping to
 * whichever strip the pointer happens to be over pins the tile at one strip's
 * right edge and then snaps it to the next strip's left edge as the pointer
 * crosses - a visible fold, and the grab offset stops being constant exactly
 * during the cross-group gesture this sprint exists to get right.
 *
 * Unclamped, the tile is simply where the pointer is. Insertion stays sane
 * because `targetIndex` is bounded by the model, not by the overlay.
 */
function tileOverlayTransform(
  tile: NonNullable<typeof activeTileDrag>,
  transform: {
    readonly x: number;
    readonly y: number;
    readonly scaleX: number;
    readonly scaleY: number;
  },
): {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
} {
  const pointerX = latestPointerX ?? getLastCollisionPointerPoint()?.x ?? null;
  if (pointerX === null) return transform;
  const left = pointerX - tile.geometry.grabOffsetX;
  return { ...transform, x: left - tile.geometry.sourceInitialLeft };
}

/**
 * Canvas and rail sources drag an abstract chip, so centring it under the
 * cursor reads correctly. A header tab is not a chip - it is the tab itself, so
 * centring it would teleport it on the first frame and break the illusion that
 * the pointer is holding the object it grabbed.
 *
 * The header tab's position is derived from the POINTER rather than from the
 * drag delta, against the source's rect at drag start. Never against
 * `activeNodeRect`: that rect follows the source placeholder as the provisional
 * order slides it, and mixing it with a delta measured from the original
 * position pins the overlay partway through a drag.
 */
const rootDragOverlayModifier: Modifier = (args) => {
  const tile = activeTileDrag;
  if (tile !== null) return tileOverlayTransform(tile, args.transform);
  if (readHeaderTabDragData(args.active?.data.current) === null) {
    return snapCenterToCursor(args);
  }
  const geometry = activeHeaderStripGeometry;
  const pointerX = latestPointerX ?? getLastCollisionPointerPoint()?.x ?? null;
  // Sprint 01 is single-mode: the tab stays in the strip row for the whole
  // gesture, so crossing the tear-off threshold introduces no discontinuity.
  if (geometry === null || pointerX === null) {
    return { ...args.transform, y: 0 };
  }
  const strip = document.querySelector(
    `[data-testid="${HEADER_STRIP_SCROLL_TEST_ID}"]`,
  );
  const stripRect = strip === null ? null : strip.getBoundingClientRect();
  const left = overlayLeftForPointer({
    pointerX,
    grabOffsetX: geometry.grabOffsetX,
    sourceWidth: geometry.sourceWidth,
    stripLeft: stripRect?.left ?? Number.NEGATIVE_INFINITY,
    stripRight: stripRect?.right ?? Number.POSITIVE_INFINITY,
  });
  return { ...args.transform, x: left - geometry.sourceInitialLeft, y: 0 };
};

const ROOT_DRAG_OVERLAY_MODIFIERS = [rootDragOverlayModifier];

function readOverRect(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): RectLike | null {
  return event.over?.rect ?? null;
}

function findDroppableElement(id: string | number): Element | null {
  return document.querySelector(
    `[data-dnd-droppable-id="${CSS.escape(String(id))}"]`,
  );
}

type DragUpdateEvent = DragMoveEvent | DragOverEvent | DragEndEvent;

function compatibleCanvasTarget(
  source: EpicCanvasDragSourceData,
  target: EpicCanvasDropTargetData | null,
  point: PointLike | null,
): {
  readonly target: EpicCanvasDropTargetData;
  readonly point: PointLike;
} | null {
  if (target === null || point === null) return null;
  return isCanvasDropCompatible(source, target) ? { target, point } : null;
}

/**
 * Preview resolution for a typed canvas/rail source: header-slot hovers feed
 * the header strip index; everything else resolves through
 * `resolveCanvasDropPreview` and lands in the canvas preview + the
 * last-resolved-drop ref the commit reads at drag end.
 */
function updateCanvasSourcePreview(
  source: EpicCanvasDragSourceData,
  event: DragUpdateEvent,
  point: PointLike | null,
  refs: ReparentRefs,
): void {
  const dndStore = useEpicDndStore.getState();
  const over = event.over;
  const overData: unknown = over?.data.current;
  if (source.kind === SIDEBAR_NODE_DND_TYPE) {
    const reparentTarget =
      over === null ? null : readSidebarReparentTarget(overData);
    if (reparentTarget !== null) {
      updateSidebarReparentPreview(source, reparentTarget, refs);
      return;
    }
  }
  // Not over a sidebar target (or not a sidebar-node source): clear any reparent
  // highlight so switching from a row hover back to canvas works.
  clearSidebarReparentPreview(refs);
  if (updateArtifactTileStripPreview(source, point, refs)) return;
  clearDepartedArtifactStripState(source);
  if (updateHeaderStripTearOffPreview(source, event, point, refs)) {
    return;
  }
  dndStore.headerStripDropIndexChanged(null);
  const targetAtPoint = compatibleCanvasTarget(
    source,
    over === null ? null : readEpicCanvasDropTargetData(overData),
    point,
  );
  if (targetAtPoint === null) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
  const { target, point: resolvedPoint } = targetAtPoint;
  const preview = resolveCanvasDropPreview({
    source,
    target,
    point: resolvedPoint,
    targetRect: readOverRect(event),
    targetElement:
      target.kind === "left-panel-group" && over !== null
        ? findDroppableElement(over.id)
        : null,
    activeRect: event.active.rect.current.translated ?? null,
  });
  if (isLeftPanelDropNoop(source, preview)) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
  refs.lastResolved.current = { source, target, preview };
  dndStore.dropPreviewChanged(preview);
}

function clearDepartedArtifactStripState(
  source: EpicCanvasDragSourceData,
): void {
  if (source.kind !== ARTIFACT_TAB_DND_TYPE) return;
  useEpicDndStore.getState().headerStripDragStateChanged(null);
  preserveSourceTileStripGap();
}

function updateArtifactTileStripPreview(
  source: EpicCanvasDragSourceData,
  point: PointLike | null,
  refs: ReparentRefs,
): boolean {
  const ownsFrame =
    source.kind === ARTIFACT_TAB_DND_TYPE &&
    updateTileStripPreview(source, point, refs);
  if (ownsFrame) useEpicDndStore.getState().headerStripDropIndexChanged(null);
  return ownsFrame;
}

/** Fail shut when the strip model can no longer be mapped to live DOM slots. */
function rejectTileStripFrame(refs: ReparentRefs): true {
  reportStripGeometryFailure("tile");
  refs.lastResolved.current = null;
  const dndStore = useEpicDndStore.getState();
  dndStore.dropPreviewChanged(null);
  dndStore.headerStripDragStateChanged(null);
  dndStore.tileStripOffsetsChanged(new Map());
  return true;
}

/** Keep the dimmed source tile in place while it is outside every strip. */
function preserveSourceTileStripGap(): void {
  const dndStore = useEpicDndStore.getState();
  const drag = activeTileDrag;
  if (drag === null) {
    dndStore.tileStripOffsetsChanged(new Map());
    return;
  }
  const geometry = remapGeometryToSlots(
    drag.geometry,
    readTileStripSlots(drag.groupId),
  );
  if (geometry === null) {
    reportStripGeometryFailure("tile");
    dndStore.tileStripOffsetsChanged(new Map());
    return;
  }
  activeTileDrag = { ...drag, geometry };
  dndStore.tileStripOffsetsChanged(
    new Map([[drag.groupId, stripOffsetsFor(geometry, null)]]),
  );
}

/**
 * Canvas source hovering the HEADER strip (tear-off). This source owns no slot
 * there, so droppable hit-testing is stable and stays. Returns true when it
 * owns the frame.
 */
function updateHeaderStripTearOffPreview(
  source: EpicCanvasDragSourceData,
  event: DragUpdateEvent,
  point: PointLike | null,
  refs: ReparentRefs,
): boolean {
  const over = event.over;
  const headerSlot =
    over === null ? null : readHeaderTabSlotDropData(over.data.current);
  if (headerSlot === null || !canDropOnHeaderStrip(source) || point === null) {
    return false;
  }
  const dndStore = useEpicDndStore.getState();
  refs.lastResolved.current = null;
  dndStore.dropPreviewChanged(null);
  dndStore.headerStripDropIndexChanged(
    resolveHeaderStripDropIndex({
      slot: headerSlot,
      pointerX: point.x,
      slotRect: readOverRect(event),
      sourceIndex: null,
    }),
  );
  return true;
}

/**
 * Tile reorder / cross-group insertion, resolved from strip geometry rather
 * than droppable hit-testing. dnd-kit still supplies the TARGET identity - the
 * commit path is unchanged and already certified - but the INDEX comes from the
 * model, because hit-testing cannot survive the provisional order sliding the
 * dragged tile's own placeholder under the pointer.
 *
 * Returns true when it owns this frame (pointer over some strip), false to let
 * the pane-body path run.
 */
function updateTileStripPreview(
  source: EpicCanvasDragSourceData,
  point: PointLike | null,
  refs: ReparentRefs,
): boolean {
  const dndStore = useEpicDndStore.getState();
  const drag = activeTileDrag;
  // Initial measurement can be unavailable while the independent header-strip
  // tear-off path remains valid. Only a geometry that existed and then fails
  // to remap is a mid-gesture model failure that must own and cancel the frame.
  if (drag === null) return false;
  if (point === null) return false;
  const groupId = tileStripGroupAtPoint(point, source.viewTabId);
  if (groupId === null) return false;
  const offsets = new Map<string, ReadonlyMap<string, number>>();
  // null = the drag sits at its own source position: a no-op the commit would
  // refuse, so no insertion indicator is advertised - the same suppression the
  // header path applies to its drop index.
  let index: number | null;
  if (groupId === drag.groupId) {
    const contentOriginX = readTileStripContentOriginX(groupId);
    if (contentOriginX === null) return rejectTileStripFrame(refs);
    const slots = readTileStripSlots(groupId);
    const geometry = remapGeometryToSlots(drag.geometry, slots);
    if (geometry === null) return rejectTileStripFrame(refs);
    activeTileDrag = { ...drag, geometry };
    const next = resolveStripDragState({
      geometry,
      contentOriginX,
      pointerX: point.x,
      previous: dndStore.headerStripDragState,
    });
    dndStore.headerStripDragStateChanged(next);
    index =
      next.targetIndex === geometry.sourceIndex
        ? null
        : insertionIndexForTarget(geometry.sourceIndex, next.targetIndex);
    offsets.set(groupId, stripOffsetsFor(geometry, next.targetIndex));
  } else {
    const sourceGeometry = remapGeometryToSlots(
      drag.geometry,
      readTileStripSlots(drag.groupId),
    );
    if (sourceGeometry === null) return rejectTileStripFrame(refs);
    activeTileDrag = { ...drag, geometry: sourceGeometry };
    const foreign = measureForeignTileStrip(groupId);
    if (foreign === null) return rejectTileStripFrame(refs);
    index = insertionIndexFromPointer(
      foreign.slots,
      foreign.contentOriginX,
      point.x,
    );
    offsets.set(
      groupId,
      insertionOffsetsFor(foreign.slots, index, sourceGeometry.sourceWidth),
    );
    // Keep the source strip's dimmed origin placeholder until the cross-group
    // drop commits. The destination independently opens its insertion gap.
    offsets.set(drag.groupId, stripOffsetsFor(sourceGeometry, null));
    dndStore.headerStripDragStateChanged(null);
  }
  dndStore.tileStripOffsetsChanged(offsets);

  if (index === null) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return true;
  }
  const preview: EpicCanvasDropPreview = {
    kind: "artifact-tab-strip",
    groupId,
    index,
  };
  const target: EpicCanvasDropTargetData = {
    kind: "artifact-tab-strip-end",
    viewTabId: source.viewTabId,
    groupId,
    index,
  };
  refs.lastResolved.current = { source, target, preview };
  dndStore.dropPreviewChanged(preview);
  return true;
}

/**
 * Header-tab preview. The fillable-slot target still comes from droppable
 * hit-testing - it is a content-pane target with no source slot under it - but
 * the strip's own reorder/merge is resolved from the geometry model instead.
 * Hit-testing the strip cannot work once a provisional order moves the dragged
 * tab's own placeholder beneath the pointer.
 */
function updateHeaderTabSourcePreview(input: {
  readonly headerTab: HeaderTabDragData;
  readonly event: DragUpdateEvent;
  readonly point: PointLike | null;
  readonly publishStripState: (pointerX: number) => void;
}): void {
  const { headerTab, event, point } = input;
  const dndStore = useEpicDndStore.getState();
  const over = event.over;
  const topLevelTarget =
    over === null ? null : readTopLevelTabDropTarget(over.data.current);
  const validDrop =
    topLevelTarget === null
      ? null
      : resolveLiveTopLevelDrop(headerTab, topLevelTarget);
  if (validDrop !== null) {
    headerTearOffActive = false;
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  // Once the pointer visibly leaves the strip for tear-off, stop advertising a
  // reorder that the available detach handler may replace at release. Preview
  // and commit use the same point source and threshold predicate. Only the
  // fillable slot above outranks the tear-off: it is an explicit, visible
  // empty pane inviting the drop. (The invisible edge-split bands that used to
  // sit here lost that argument and were removed outright.)
  if (
    isHeaderTearOffPoint(
      currentReleasePointerPoint(),
      activeHeaderStripGeometry?.stripBottom ?? null,
    )
  ) {
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  if (point === null) {
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  input.publishStripState(point.x);
}

/** Resolve the model at `pointerX` and publish it. */
function publishHeaderStripDragState(input: {
  readonly headerTab: HeaderTabDragData;
  readonly geometry: StripDragGeometry | null;
  readonly pointerX: number;
}): void {
  const dndStore = useEpicDndStore.getState();
  const contentOriginX = readHeaderStripContentOriginX();
  const { headerTab } = input;
  const geometry =
    input.geometry === null
      ? null
      : remapGeometryToSlots(input.geometry, readHeaderStripSlots());
  activeHeaderStripGeometry = geometry;
  if (geometry === null || contentOriginX === null) {
    reportStripGeometryFailure("header");
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  const next = resolveStripDragState({
    geometry,
    contentOriginX,
    pointerX: input.pointerX,
    previous: dndStore.headerStripDragState,
  });
  dndStore.headerStripDragStateChanged(next);
  // Explicit per-item displacement, the same mechanism the tile strip uses.
  // No layout projection means no projection can be left mid-flight.
  dndStore.headerStripOffsetsChanged(
    stripOffsetsFor(geometry, next.targetIndex),
  );
  // A merge shows the pair highlight and nothing else - an insertion line
  // beside a highlighted merge target advertises two different outcomes for
  // one release. Plain reorder shows the line at the settled model boundary,
  // where the displacement gap is opening.
  dndStore.headerStripDropIndexChanged(
    next.kind !== "reorder" || next.targetIndex === geometry.sourceIndex
      ? null
      : insertionIndexForTarget(geometry.sourceIndex, next.targetIndex),
  );
  const pairTarget =
    next.kind === "merge"
      ? resolveStripPairTarget(headerTab, geometry, next)
      : null;
  dndStore.topLevelStripPairPreviewChanged(
    next.kind !== "merge" || pairTarget === null
      ? null
      : { targetRef: pairTarget.targetRef, side: next.targetSide },
  );
}

/**
 * The validated pair target a merge refers to, or null when the tabs-store
 * layout no longer permits pairing with that item.
 */
function resolveStripPairTarget(
  headerTab: HeaderTabDragData,
  geometry: StripDragGeometry,
  state: StripDragState,
): TopLevelStripPairTarget | null {
  if (state.kind !== "merge") {
    return null;
  }
  const index = geometry.slots.findIndex(
    (slot) => slot.itemId === state.targetItemId,
  );
  if (index < 0) return null;
  const target = stripPairTargetForIndex(index, layoutFromTabsStore());
  if (target === null) return null;
  return resolveLiveTopLevelDrop(headerTab, target) === null ? null : target;
}

function layoutFromTabsStore() {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  } as const;
}

function resolveLiveTopLevelDrop(
  headerTab: HeaderTabDragData,
  target: TopLevelTabDropTarget,
) {
  return resolveValidatedTopLevelTabDrop(
    headerTab,
    target,
    layoutFromTabsStore(),
  );
}

function fillTopLevelSlot(
  source: TabRef,
  target: TopLevelFillableTarget,
  activate: (ref: TabRef) => void,
): void {
  const layout = layoutFromTabsStore();
  const split =
    layout.items.find(
      (item): item is SplitStripItem =>
        item.kind === "split" && item.id === target.splitId,
    ) ?? null;
  if (split === null) return;
  const targetSide = target.side === "left" ? split.left : split.right;
  if (targetSide.kind === "tab") return;
  const focused = split.focusedSide === target.side;
  if (!tabCommandCoordinator.fillSplitSide({ ...target, ref: source })) return;
  if (!focused) return;
  activate(source);
}

function commitHeaderTabDrop(input: {
  readonly event: DragEndEvent;
  readonly navigate: UseNavigateResult<string>;
  readonly geometry: StripDragGeometry | null;
  readonly dragState: StripDragState | null;
}): void {
  const headerTab = readHeaderTabDragData(input.event.active.data.current);
  const target =
    input.event.over === null
      ? null
      : readTopLevelTabDropTarget(input.event.over.data.current);
  const validDrop =
    headerTab === null || target === null
      ? null
      : resolveLiveTopLevelDrop(headerTab, target);
  const activate = (ref: TabRef): void => {
    const tab = getHeaderTabs().find(
      (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
    );
    if (tab !== undefined) {
      navigateToTabIntent(input.navigate, tabResolveIntent(tab), undefined);
    }
  };
  if (validDrop?.target.kind === "top-level-fillable-slot") {
    fillTopLevelSlot(validDrop.source, validDrop.target, activate);
    return;
  }
  if (
    headerTab === null ||
    input.geometry === null ||
    input.dragState === null
  ) {
    return;
  }
  // A merge beats the reorder it is sitting on: both describe the same pointer
  // position, and which half of the neighbour the dragged tab's centre is on
  // is what distinguishes "combine with this tab" from "move next to it".
  if (input.dragState.kind === "merge") {
    const pairTarget = resolveStripPairTarget(
      headerTab,
      input.geometry,
      input.dragState,
    );
    if (pairTarget !== null) {
      commitHeaderStripPair(
        headerTab,
        pairTarget,
        input.dragState.targetSide,
        input.navigate,
      );
      return;
    }
  }
  if (input.dragState.targetIndex === input.geometry.sourceIndex) return;
  // Arm BEFORE the reorder is written: the strip items re-base their transform
  // against the new baseline in the layout effect of the render this causes, so
  // the flag has to be set by the time that render commits.
  armHeaderStripCommitHandoff();
  tabCommandCoordinator.reorderStripItem({
    itemId: headerTab.stripItemId,
    targetIndex: insertionIndexForTarget(
      input.geometry.sourceIndex,
      input.dragState.targetIndex,
    ),
  });
}

/**
 * Dropping A onto B pairs them with A on its APPROACH side - the side of B the
 * pointer was hovering, which is also the side the preview highlighted.
 * Dragging rightward onto B yields `A | B`; leftward yields `B | A`. The
 * dragged tab takes focus either way.
 */
function commitHeaderStripPair(
  headerTab: HeaderTabDragData,
  target: TopLevelStripPairTarget,
  side: MergeSide,
  navigate: UseNavigateResult<string>,
): void {
  const validDrop = resolveLiveTopLevelDrop(headerTab, target);
  if (validDrop === null) return;
  const sourceRef = validDrop.source;
  const sourceTab = getHeaderTabs().find(
    (tab) => tab.kind === sourceRef.kind && tab.id === sourceRef.id,
  );
  if (sourceTab === undefined) return;
  activatePreparedPairTabIntent(
    navigate,
    {
      left: side === "left" ? sourceRef : target.targetRef,
      right: side === "left" ? target.targetRef : sourceRef,
      focusedRef: sourceRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    tabResolveIntent(sourceTab),
    undefined,
  );
}

/**
 * Canvas tear-off onto the header strip. Source creation and authoritative
 * placement run inside ONE suppressed coordinator transaction: the source
 * store's synchronous reconciliation subscriber fires between them otherwise,
 * and with a stale legacy `stripOrder` it would rebuild the flat layout and
 * dissolve existing split groups before placement. Returns the committed drop
 * only when the new ref was also placed.
 */
function commitHeaderStripDropAtIndex(
  source: EpicCanvasDragSourceData,
  headerStripIndex: number,
): HeaderStripDropResult | null {
  let dropped: HeaderStripDropResult | null = null;
  const placedRef = tabCommandCoordinator.createSourceRefAtStripIndex(
    headerStripIndex,
    () => {
      dropped = commitHeaderStripDrop(source, headerStripIndex);
      return dropped === null ? null : { kind: "epic", id: dropped.tabId };
    },
  );
  return placedRef === null ? null : dropped;
}

/**
/**
 * Resolve whether this release should detach, and report the one state that is
 * never intentional.
 *
 * The channel's two negative states mean different things, which is why it has
 * three states rather than a boolean:
 *
 *   `null`                    no `TabDetachOwner` has published. Nothing here
 *                             can see whether a router is present, so this is
 *                             reported as an unexpected condition rather than
 *                             diagnosed as a defect - a caller that mounts the
 *                             provider deliberately without the owner is a
 *                             legitimate reader of this line.
 *   `{ isAvailable: false }`  an owner is present and says no (no desktop
 *                             bridge). Intentional, and silent.
 *
 * Without the report, a missing owner makes a tear-off fall through to ordinary
 * drop handling: the tab reorders instead of detaching, with no crash and no
 * warning.
 */
interface DetachRequest {
  readonly tab: HeaderTab;
  readonly handler: TabDetachHandler;
}

function resolveDetachRequest(detach: HeaderTab | null): DetachRequest | null {
  if (detach === null) return null;
  const handler = readTabDetachHandler();
  if (handler === null) {
    appLogger.warn(
      "[tab-detach] tear-off ignored: no detach owner has published a handler",
      { tabKind: detach.kind, tabId: detach.id },
    );
    return null;
  }
  return handler.isAvailable ? { tab: detach, handler } : null;
}

/**
 * The tab a release should tear off into a new window, or null to fall through
 * to the ordinary drop commit.
 *
 * A header tab tears off ONLY by being pulled clear of its strip, measured from
 * the strip's own rect. It must not tear off merely because the release landed
 * on no droppable: the geometry model gives every in-strip position a reorder
 * destination, so "no target" would turn an ordinary reorder into a new window.
 *
 * Of the top-level targets only a valid FILLABLE SLOT blocks a tear-off - the
 * same precedence the live preview applies: it is an explicit, visible empty
 * pane inviting the drop, and the preview has been advertising it.
 */
function resolveTearOff(input: {
  readonly event: DragEndEvent;
  readonly stripBottom: number | null;
  readonly canvasTearOffAllowed: boolean;
}): HeaderTab | null {
  const { event, stripBottom } = input;
  // The activator position plus the final delta keeps advancing after the
  // pointer has left every target, unlike collision coordinates. Used for
  // tear-off detection only - drop math still reads the collision point.
  const point = currentReleasePointerPoint();
  const headerTab = readHeaderTabDragData(event.active.data.current);
  if (headerTab !== null) {
    if (hasValidFillableSlotDrop(event, headerTab)) return null;
    if (!isHeaderTearOffPoint(point, stripBottom)) return null;
    return (
      getHeaderTabs().find(
        (tab) => tab.kind === headerTab.tabKind && tab.id === headerTab.tabId,
      ) ?? null
    );
  }
  const source = readActiveDragSource(event.active);
  if (source?.kind !== ARTIFACT_TAB_DND_TYPE) return null;
  if (!input.canvasTearOffAllowed) return null;
  const outsideViewport = pointIsOutsideViewport(point, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  if (!outsideViewport && !isAtViewportEdge(point)) {
    return null;
  }
  return (
    getHeaderTabs().find(
      (tab) => tab.kind === "epic" && tab.id === source.viewTabId,
    ) ?? null
  );
}

/** The final pointer source shared by tear-off preview and commit. */
function currentReleasePointerPoint(): PointLike | null {
  return latestPointerX === null || latestPointerY === null
    ? getLastCollisionPointerPoint()
    : { x: latestPointerX, y: latestPointerY };
}

/** Whether a header tab has visibly entered the tear-off region. */
function isHeaderTearOffPoint(
  point: PointLike | null,
  stripBottom: number | null,
): boolean {
  const outsideViewport = pointIsOutsideViewport(point, {
    width: window.innerWidth,
    height: window.innerHeight,
  });
  const pulledBelowStrip =
    point !== null &&
    stripBottom !== null &&
    point.y >
      stripBottom +
        (headerTearOffActive
          ? HEADER_TAB_TEAR_OFF_RELEASE_PX
          : HEADER_TAB_TEAR_OFF_THRESHOLD_PX);
  headerTearOffActive = outsideViewport || pulledBelowStrip;
  return headerTearOffActive;
}

function hasValidFillableSlotDrop(
  event: DragEndEvent,
  headerTab: HeaderTabDragData,
): boolean {
  const target =
    event.over === null
      ? null
      : readTopLevelTabDropTarget(event.over.data.current);
  return (
    target?.kind === TOP_LEVEL_FILLABLE_TARGET &&
    resolveLiveTopLevelDrop(headerTab, target) !== null
  );
}

function armTileHandoffForDrop(
  source: EpicCanvasDragSourceData,
  drop: ResolvedEpicCanvasDrop,
): void {
  if (
    source.kind === ARTIFACT_TAB_DND_TYPE &&
    drop.preview?.kind === "artifact-tab-strip"
  ) {
    armTileStripCommitHandoff(source.sourceGroupId);
    armTileStripCommitHandoff(drop.preview.groupId);
  }
}

interface AcceptedComposerDrop {
  readonly source: EpicCanvasDragSourceData;
  readonly target: ComposerAttachmentDropTargetData;
}

function acceptedComposerDrop(
  source: EpicCanvasDragSourceData | null,
  event: DragEndEvent,
): AcceptedComposerDrop | null {
  if (source === null) return null;
  const target = readComposerAttachmentDropTargetData(event.over?.data.current);
  return target?.accepts(source) === true ? { source, target } : null;
}

function commitOrdinaryDrop(input: {
  readonly event: DragEndEvent;
  readonly source: EpicCanvasDragSourceData | null;
  readonly navigate: UseNavigateResult<string>;
  readonly navigateNested: NavigateNestedFocus;
  readonly resolvedDrop: ResolvedEpicCanvasDrop | null;
}): boolean {
  const dndStore = useEpicDndStore.getState();
  const headerStripIndex = dndStore.headerStripDropIndex;
  const headerDragState = dndStore.headerStripDragState;
  if (input.source === null) {
    commitHeaderTabDrop({
      event: input.event,
      navigate: input.navigate,
      geometry: activeHeaderStripGeometry,
      dragState: headerDragState,
    });
    return false;
  }
  if (headerStripIndex !== null && canDropOnHeaderStrip(input.source)) {
    const result = commitHeaderStripDropAtIndex(input.source, headerStripIndex);
    if (result === null) return false;
    navigateToTabIntent(
      input.navigate,
      existingEpicTabIntent({
        epicId: result.epicId,
        tabId: result.tabId,
        focus: undefined,
      }),
      undefined,
    );
    return true;
  }
  const drop = input.resolvedDrop;
  if (drop === null) return false;
  armTileHandoffForDrop(input.source, drop);
  return commitResolvedCanvasDrop(drop, input.navigateNested);
}

/** Within a few px of any viewport edge - a canvas tile dragged off-window. */
function isAtViewportEdge(point: PointLike | null): boolean {
  if (point === null) return false;
  return (
    point.x <= 4 ||
    point.x >= window.innerWidth - 4 ||
    point.y <= 4 ||
    point.y >= window.innerHeight - 4
  );
}

interface RootDndProviderProps {
  readonly children: ReactNode;
}

export function RootDndProvider(props: RootDndProviderProps) {
  const navigate = useNavigate();
  const navigateNested = useEpicNestedFocusNavigation();
  // No detach hook here, deliberately. `useTabOpenInNewWindowFlow` reaches
  // `useRouterState`, which THROWS without a router where `useNavigate` above
  // only warns - calling it from this provider made the whole provider
  // router-REQUIRED and broke every provider-light mount. `TabDetachOwner`
  // owns that flow from the ROUTE tree and publishes it through
  // `tab-detach-channel`; this provider reads it at drag end and stays
  // router-optional.
  const lastResolvedDropRef = useRef<ResolvedEpicCanvasDrop | null>(null);
  const lastReparentDropRef = useRef<LastReparentDrop | null>(null);
  const springLoadRef = useRef<SpringLoadEntry | null>(null);
  const publishStripState = useCallback(
    (headerTab: HeaderTabDragData, pointerX: number) => {
      publishHeaderStripDragState({
        headerTab,
        geometry: activeHeaderStripGeometry,
        pointerX,
      });
    },
    [],
  );

  // Stable bundle (the inner refs never change identity) so the preview helpers
  // take one object instead of three positional ref params.
  const reparentRefs = useMemo<ReparentRefs>(
    () => ({
      lastResolved: lastResolvedDropRef,
      lastReparent: lastReparentDropRef,
      springLoad: springLoadRef,
    }),
    [],
  );
  // A spring-load timer armed mid-drag must not survive the provider: if it
  // unmounts (route change / epic close) before drag end/cancel clears it, the
  // pending `setTimeout` would fire and `expand()` a stale tab/panel.
  useEffect(() => {
    const handlePointerMove = (event: PointerEvent): void => {
      trackPointerX(event);
      const store = useEpicDndStore.getState();
      const headerTab = store.activeHeaderTab;
      if (
        headerTab !== null &&
        activeHeaderStripGeometry !== null &&
        event.clientY >= activeHeaderStripGeometry.stripTop &&
        event.clientY <= activeHeaderStripGeometry.stripBottom
      ) {
        // dnd-kit can coalesce a fast native sweep into activation + release
        // without an intermediate onDragMove. The capture stream is the raw
        // pointer source already used for release; publish the same point live
        // so neighbours move before pointer-up too.
        publishStripState(headerTab, event.clientX);
        return;
      }
      const source = store.activeSource;
      if (
        source !== null &&
        source.kind === ARTIFACT_TAB_DND_TYPE &&
        activeTileDrag !== null
      ) {
        updateTileStripPreview(
          source,
          { x: event.clientX, y: event.clientY },
          reparentRefs,
        );
      }
    };
    window.addEventListener("pointermove", handlePointerMove, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerdown", trackPointerDownX, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, {
        capture: true,
      });
      window.removeEventListener("pointerdown", trackPointerDownX, {
        capture: true,
      });
      latestPointerX = null;
      latestPointerY = null;
      lastPointerDownX = null;
    };
  }, [publishStripState, reparentRefs]);
  const sensors = useSensors(
    useSensor(EpicCanvasPointerSensor, {
      activationConstraint: {
        distance: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
      },
    }),
    useSensor(KeyboardSensor),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      // A handoff is normally consumed by the layout effect immediately after
      // commit. Defensively clear any arm left by a commit that removed its
      // whole strip before that boundary could run.
      disarmHeaderStripCommitHandoff();
      disarmTileStripCommitHandoff();
      stripGeometryFailureReported = false;
      headerTearOffActive = false;
      lastResolvedDropRef.current = null;
      lastReparentDropRef.current = null;
      clearSpringLoad(springLoadRef);
      const dndStore = useEpicDndStore.getState();
      const source = readActiveDragSource(event.active);
      if (source !== null) {
        dndStore.canvasDragStarted(source, resolveOverlayTileForSource(source));
        if (source.kind === ARTIFACT_TAB_DND_TYPE) {
          if (source.isPreview) {
            useEpicCanvasStore
              .getState()
              .promotePreviewInTab(source.viewTabId, source.sourceGroupId);
            promotedPreviewOnDrag = {
              viewTabId: source.viewTabId,
              groupId: source.sourceGroupId,
              tileId: source.tabId,
            };
          }
          const geometry = measureTileStripGeometry({
            groupId: source.sourceGroupId,
            tileItemId: source.tabId,
            pointerX: grabPointerX(event.activatorEvent),
          });
          activeTileDrag =
            geometry === null
              ? null
              : {
                  groupId: source.sourceGroupId,
                  tileId: source.tabId,
                  geometry,
                };
          dndStore.tileSourceWidthChanged(geometry?.sourceWidth ?? null);
          const activationPoint = currentReleasePointerPoint();
          if (geometry !== null && activationPoint !== null) {
            updateTileStripPreview(source, activationPoint, reparentRefs);
          }
        }
        return;
      }
      const headerTab = readHeaderTabDragData(event.active.data.current);
      if (headerTab !== null) {
        const geometry = measureHeaderStripGeometry({
          stripItemId: headerTab.stripItemId,
          pointerX: grabPointerX(event.activatorEvent),
        });
        activeHeaderStripGeometry = geometry;
        dndStore.headerTabDragStarted(
          headerTab,
          geometry?.slots[geometry.sourceIndex]?.width ?? null,
        );
        // The move that crosses the activation distance can itself span one or
        // more tabs. dnd-kit starts the drag from that event but does not emit
        // onDragMove for the same event, so seed the preview from the raw point
        // captured before activation instead of waiting for another move that
        // a quick gesture may never produce.
        if (geometry !== null && latestPointerX !== null) {
          publishStripState(headerTab, latestPointerX);
        }
      }
    },
    [publishStripState, reparentRefs],
  );

  const updateDropPreview = useCallback(
    (event: DragUpdateEvent) => {
      // SINGLE pointer source of truth, shared with the capture-phase native
      // pointermove handler: the raw tracked pointer, falling back to the
      // collision-pass point when no native event has arrived yet. Two update
      // paths publishing from two different pointer snapshots is what made a
      // fast drag flip between a fresh and a stale resolution every frame.
      // Never reconstruct the point from `activatorEvent` + `event.delta`
      // (scroll-adjusted; diverges under autoScroll).
      const point = currentReleasePointerPoint();
      const source = readActiveDragSource(event.active);
      if (source !== null) {
        updateCanvasSourcePreview(source, event, point, reparentRefs);
        return;
      }
      const headerTab = readHeaderTabDragData(event.active.data.current);
      if (headerTab !== null) {
        updateHeaderTabSourcePreview({
          headerTab,
          event,
          point,
          publishStripState: (pointerX) => {
            publishStripState(headerTab, pointerX);
          },
        });
      }
    },
    [publishStripState, reparentRefs],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      updateDropPreview(event);
    },
    [updateDropPreview],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      updateDropPreview(event);
    },
    [updateDropPreview],
  );

  // Handed to the imperative reparent commit so an RPC-routed move can
  // invalidate the moved node's record query on success - this provider is
  // the nearest hook context to that commit.
  const queryClient = useQueryClient();

  /**
   * THE single teardown for a gesture. Every exit from drag-end and drag-cancel
   * goes through this, and it is idempotent so a double call is harmless.
   *
   * It exists because the three near-duplicate teardown blocks it replaces had
   * already drifted - one statement was written twice at two indent levels -
   * and two early returns (sidebar reparent, composer attachment) performed
   * only PART of it. Both are ordinary supported gestures, and both left
   * module-scoped state alive into the NEXT drag:
   *
   *   `activeTileDrag`          `rootDragOverlayModifier` tests it BEFORE it
   *                             decides the drag kind, so the next drag of any
   *                             kind is positioned with a dead tile's grab
   *                             offset - the overlay sits at an arbitrary x for
   *                             the whole gesture.
   *   `promotedPreviewOnDrag`   a later Esc runs `restorePreviewInTab` against
   *                             a stale tile, re-marking an unrelated promoted
   *                             tile as a preview - the exact residual the
   *                             promote/restore pair exists to prevent.
   *
   * Extracting it makes the drift unrepresentable rather than merely absent.
   */
  const endGesture = useCallback(() => {
    clearSpringLoad(springLoadRef);
    lastResolvedDropRef.current = null;
    lastReparentDropRef.current = null;
    clearLastCollisionPointerPoint();
    activeHeaderStripGeometry = null;
    activeTileDrag = null;
    promotedPreviewOnDrag = null;
    latestPointerX = null;
    latestPointerY = null;
    lastPointerDownX = null;
    stripGeometryFailureReported = false;
    headerTearOffActive = false;
    useEpicDndStore.getState().dragEnded();
  }, []);

  useEffect(
    () => () => {
      restorePromotedPreview();
      endGesture();
    },
    [endGesture],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const source = readActiveDragSource(event.active);
      // Pointer-up can race the final collision update. Refresh first so an
      // explicit in-app target wins over the viewport-edge tear-off affordance
      // on overlapping edge pixels.
      updateDropPreview(event);
      const composerDrop = acceptedComposerDrop(source, event);
      const detach = resolveTearOff({
        event,
        stripBottom: activeHeaderStripGeometry?.stripBottom ?? null,
        canvasTearOffAllowed:
          lastReparentDropRef.current === null &&
          lastResolvedDropRef.current === null &&
          useEpicDndStore.getState().headerStripDropIndex === null &&
          composerDrop === null,
      });
      const detachRequest = resolveDetachRequest(detach);
      if (detachRequest !== null) {
        restorePromotedPreview();
        detachRequest.handler.requestOpen(detachRequest.tab);
        endGesture();
        return;
      }
      clearSpringLoad(springLoadRef);
      // A sidebar-row/panel reparent wins over the canvas/header commit:
      // commit it (with the canReparent re-check inside) and skip the rest.
      const reparent = lastReparentDropRef.current;
      if (reparent !== null) {
        restorePromotedPreview();
        // ENDING THE GESTURE IS NOT CONDITIONAL ON THE COMMIT SUCCEEDING.
        // `endGesture()` used to sit plainly after this call, so a throw out
        // of the commit skipped it and left the store mid-drag with stale
        // refs: a dead sidebar until the tree remounted. One ordinary drop
        // did it (a doc-only terminal agent onto a record-backed chat, where
        // the doc evaluator rejects what the projected gate allowed).
        //
        // Extracting `endGesture` widened this rather than closing it. The
        // skipped cleanup used to be four refs; it is now everything that
        // function clears - `activeTileDrag`, `promotedPreviewOnDrag`, the
        // replay latch - each of which its own doc describes corrupting the
        // NEXT drag when it survives this one.
        //
        // Rethrowing would defeat the point, since the cleanup is exactly
        // what has to survive the failure, so the error is logged and
        // swallowed and the commit's own handler owns anything user-facing.
        try {
          commitSidebarReparentDrop({
            epicId: reparent.epicId,
            sourceNodeId: reparent.sourceNodeId,
            newParentId: reparent.newParentId,
            panelId: reparent.panelId,
            viewTabId: reparent.viewTabId,
            queryClient,
          });
        } catch (error: unknown) {
          appLogger.error(
            "[epic-dnd] sidebar reparent commit threw; ending the gesture anyway",
            {
              epicId: reparent.epicId,
              sourceNodeId: reparent.sourceNodeId,
              newParentId: reparent.newParentId,
            },
            error,
          );
        } finally {
          endGesture();
        }
        return;
      }
      if (composerDrop !== null) {
        composerDrop.target.attach(composerDrop.source);
        endGesture();
        return;
      }
      const committed = commitOrdinaryDrop({
        event,
        source,
        navigate,
        navigateNested,
        resolvedDrop: lastResolvedDropRef.current,
      });
      if (!committed) restorePromotedPreview();
      endGesture();
    },
    [endGesture, navigate, navigateNested, queryClient, updateDropPreview],
  );

  const handleDragCancel = useCallback(() => {
    // Cancel means cancel: undo the drag-start promotion so no state survives
    // a gesture the user abandoned.
    restorePromotedPreview();
    endGesture();
  }, [endGesture]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={epicRootCollisionDetection}
      autoScroll={{ threshold: { x: 0.2, y: 0.2 } }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {props.children}
      <DragOverlay dropAnimation={null} modifiers={ROOT_DRAG_OVERLAY_MODIFIERS}>
        <EpicRootDragOverlayContent />
      </DragOverlay>
    </DndContext>
  );
}
