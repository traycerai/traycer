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
  getPaneCorridorPositionFromPoint,
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
  EdgeSplitDwellMachine,
  edgeSplitBrowserTimer,
  type EdgeSplitDwellState,
} from "@/components/layout/tabs/edge-split-dwell";
import {
  TOP_LEVEL_EDGE_SPLIT_TARGET,
  TOP_LEVEL_STRIP_PAIR_TARGET,
  readTopLevelTabDropTarget,
  resolveValidatedTopLevelTabDrop,
  stripPairTargetForIndex,
  type TopLevelDwellTarget,
  type TopLevelEdgeSplitTarget,
  type TopLevelFillableTarget,
  type TopLevelStripPairTarget,
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
import {
  getTabCommandLedger,
  subscribeToTabCommandLedger,
} from "@/stores/tabs/tab-command-coordinator";
import { subscribeTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import { subscribeTabStructuralLocks } from "@/stores/tabs/tab-structural-lock";
import { type SplitStripItem } from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTab, TabRef } from "@/stores/tabs/types";
import { v4 as uuidv4 } from "uuid";
import {
  DndContext,
  DragOverlay,
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
  MERGE_DWELL_MS,
  MERGE_STILLNESS_PX,
  insertionIndexForTarget,
  insertionIndexFromPointer,
  insertionOffsetsFor,
  overlayLeftForPointer,
  remapGeometryToSlots,
  resolveStripDragState,
  stripOffsetsFor,
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
  DwellLatch,
  browserDwellTimer,
} from "@/components/epic-canvas/dnd/dwell-latch";
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

/** Pointer must settle this long over a pane body before it arms. */
const PANE_BODY_ARM_DWELL_MS = 220;

/** Movement budget during that settle, in px. */
const PANE_BODY_ARM_STILLNESS_PX = 6;

/**
 * Re-runs the canvas preview with the last drag event, so a latch that wakes
 * itself can make the armed state visible without further pointer input.
 */
let replayCanvasPreview: (() => void) | null = null;

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

/** Last header-drag inputs, so a self-waking latch can re-resolve at them. */
let lastHeaderDrag: {
  readonly headerTab: HeaderTabDragData;
  readonly pointerX: number;
} | null = null;

/**
 * The header merge dwell, on the shared latch.
 *
 * Previously a bespoke `setTimeout` in the provider driving a pure model that
 * owned no timer - the exact shape that let the gesture die silently when the
 * pointer held still. Module-scoped for the same reason the geometry is: these
 * are gesture singletons, not React state.
 */
let headerMergeLatch: DwellLatch | null = null;

function headerMergeDwell(): DwellLatch {
  headerMergeLatch ??= new DwellLatch({
    dwellMs: MERGE_DWELL_MS,
    stillnessPx: MERGE_STILLNESS_PX,
    timer: browserDwellTimer,
    onChange: (state) => {
      if (state.kind !== "fired") return;
      const pending = lastHeaderDrag;
      if (pending === null) return;
      // Re-resolve at the SAME pointer x: the model compares elapsed time
      // against its own arming timestamp, so this is what turns a hold into a
      // preview without any further pointer input.
      publishHeaderStripDragState({
        headerTab: pending.headerTab,
        geometry: activeHeaderStripGeometry,
        pointerX: pending.pointerX,
      });
    },
  });
  return headerMergeLatch;
}

/**
 * The pane-body dwell, on the shared latch.
 *
 * The pane body has no neutral region under the old geometry and ~84% of it
 * commits a split, so a tile crossing to another group must not arm anything
 * in passing. The latch owns its timer, which is what makes a *held* pointer
 * arm at all - a stationary pointer emits no events, and this exact gesture
 * died silently once for that reason.
 */
let paneBodyLatch: DwellLatch | null = null;

function paneBodyDwell(): DwellLatch {
  paneBodyLatch ??= new DwellLatch({
    dwellMs: PANE_BODY_ARM_DWELL_MS,
    stillnessPx: PANE_BODY_ARM_STILLNESS_PX,
    timer: browserDwellTimer,
    onChange: (state) => {
      // Re-run the preview when the latch wakes itself, so the armed state
      // becomes visible without further pointer input.
      if (state.kind === "fired") replayCanvasPreview?.();
    },
  });
  return paneBodyLatch;
}

/**
 * Whether the pane-body target is armed for the point given. Only artifact-tab
 * (tile) drags are gated: they are the only source that must transit a body to
 * reach a legitimate alternative target. A sidebar or rail drag has no such
 * transit requirement and keeps its immediate positional preview.
 */
function updatePaneBodyArm(
  groupId: string,
  point: PointLike | null,
  nowMs: number,
): boolean {
  const state = paneBodyDwell().observe({
    key: point === null ? null : groupId,
    point,
    nowMs,
  });
  return state.kind === "fired";
}

/**
 * A tile crossing a pane body that has not armed yet. Both the preview and the
 * commit consult this, so they can never disagree about whether the body
 * gesture is live.
 */
function isUnarmedPaneBodyTransit(
  source: EpicCanvasDragSourceData,
  target: EpicCanvasDropTargetData,
  point: PointLike | null,
  targetRect: RectLike | null,
): boolean {
  if (source.kind !== ARTIFACT_TAB_DND_TYPE) return false;
  if (target.kind !== "artifact-tab-group-body") return false;
  if (
    point === null ||
    targetRect === null ||
    getPaneCorridorPositionFromPoint(point, targetRect) === null
  ) {
    paneBodyDwell().reset();
    return true;
  }
  return !updatePaneBodyArm(target.groupId, point, performance.now());
}

function resetPaneBodyDwellOutsideTarget(
  source: EpicCanvasDragSourceData,
  target: EpicCanvasDropTargetData | null,
): void {
  if (
    source.kind === ARTIFACT_TAB_DND_TYPE &&
    target?.kind !== "artifact-tab-group-body"
  ) {
    paneBodyDwell().reset();
  }
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
    paneBodyDwell().reset();
    return;
  }
  dndStore.headerStripDropIndexChanged(null);
  const targetAtPoint = compatibleCanvasTarget(
    source,
    over === null ? null : readEpicCanvasDropTargetData(overData),
    point,
  );
  resetPaneBodyDwellOutsideTarget(source, targetAtPoint?.target ?? null);
  if (targetAtPoint === null) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
  const { target, point: resolvedPoint } = targetAtPoint;
  // B1 - preview and commit must arm together. A tile crossing a pane body en
  // route to another strip is TRANSIT: it neither previews nor commits the
  // body gesture. Suppressing the preview while still committing would be
  // Sprint 01's F2 (a merge that fired having shown nothing) in a zone that is
  // ~84% of every pane instead of a 16px band.
  if (
    isUnarmedPaneBodyTransit(source, target, resolvedPoint, readOverRect(event))
  ) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
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
  closeSourceTileStripGap();
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

/** Close the source strip's gap while an artifact tile is outside every strip. */
function closeSourceTileStripGap(): void {
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
  // Over a strip: the body gesture is not a candidate this frame.
  paneBodyDwell().reset();

  const offsets = new Map<string, ReadonlyMap<string, number>>();
  let index: number;
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
      nowMs: performance.now(),
    });
    dndStore.headerStripDragStateChanged(next);
    index = insertionIndexForTarget(geometry.sourceIndex, next.targetIndex);
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
    // The tile has left its own strip, so that strip closes the gap rather
    // than holding a slot open for something no longer in it.
    offsets.set(drag.groupId, stripOffsetsFor(sourceGeometry, null));
    dndStore.headerStripDragStateChanged(null);
  }
  dndStore.tileStripOffsetsChanged(offsets);

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
 * Header-tab preview. Edge-split and fillable-slot targets still come from
 * droppable hit-testing - they are content-pane targets with no source slot
 * under them - but the strip's own reorder/merge is resolved from the geometry
 * model instead. Hit-testing the strip cannot work once a provisional order
 * moves the dragged tab's own placeholder beneath the pointer.
 */
function updateHeaderTabSourcePreview(input: {
  readonly headerTab: HeaderTabDragData;
  readonly event: DragUpdateEvent;
  readonly point: PointLike | null;
  readonly edgeDwell: EdgeSplitDwellMachine;
  readonly publishStripState: (pointerX: number) => void;
}): void {
  const { headerTab, event, point, edgeDwell } = input;
  const dndStore = useEpicDndStore.getState();
  const over = event.over;
  const topLevelTarget =
    over === null ? null : readTopLevelTabDropTarget(over.data.current);
  const validDrop =
    topLevelTarget === null ||
    topLevelTarget.kind === TOP_LEVEL_STRIP_PAIR_TARGET
      ? null
      : resolveLiveTopLevelDrop(headerTab, topLevelTarget);
  if (validDrop !== null) {
    headerTearOffActive = false;
    headerMergeDwell().reset();
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    if (validDrop.target.kind === "top-level-fillable-slot") {
      edgeDwell.reset();
      return;
    }
    edgeDwell.setTargetValidator(
      (candidate) => resolveLiveTopLevelDrop(headerTab, candidate) !== null,
    );
    edgeDwell.observe(validDrop.target);
    return;
  }
  // Once the pointer visibly leaves the strip for tear-off, stop advertising a
  // reorder that the available detach handler may replace at release. Preview
  // and commit use the same point source and threshold predicate.
  if (
    isHeaderTearOffPoint(
      currentReleasePointerPoint(),
      activeHeaderStripGeometry?.stripBottom ?? null,
    )
  ) {
    headerMergeDwell().reset();
    edgeDwell.reset();
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  // The dwell machine owns edge splits only; strip merge lives in the model, so
  // the two can never disagree about where a boundary is.
  edgeDwell.reset();
  if (point === null) {
    headerMergeDwell().reset();
    dndStore.headerStripDropIndexChanged(null);
    dndStore.headerStripDragStateChanged(null);
    dndStore.headerStripOffsetsChanged(EMPTY_HEADER_OFFSETS);
    dndStore.topLevelStripPairPreviewChanged(null);
    return;
  }
  input.publishStripState(point.x);
}

/**
 * Resolve the model at `pointerX` and publish it.
 *
 * Returns the milliseconds until the merge dwell would fire, or null when
 * nothing is pending. A stationary pointer emits NO pointer events, so without
 * a timer driving this the dwell only advances when something else happens to
 * resolve the model - which means the merge commits on release having never
 * once been previewed.
 */
function publishHeaderStripDragState(input: {
  readonly headerTab: HeaderTabDragData;
  readonly geometry: StripDragGeometry | null;
  readonly pointerX: number;
}): string | null {
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
    return null;
  }
  const nowMs = performance.now();
  const next = resolveStripDragState({
    geometry,
    contentOriginX,
    pointerX: input.pointerX,
    previous: dndStore.headerStripDragState,
    nowMs,
  });
  dndStore.headerStripDragStateChanged(next);
  // Explicit per-item displacement, the same mechanism the tile strip uses.
  // No layout projection means no projection can be left mid-flight.
  dndStore.headerStripOffsetsChanged(
    stripOffsetsFor(geometry, next.targetIndex),
  );
  // The legacy insertion-line index is for canvas tear-off only; a header-tab
  // drag shows its destination by moving the tabs, not by drawing a line.
  dndStore.headerStripDropIndexChanged(null);
  dndStore.topLevelStripPairPreviewChanged(
    next.kind === "merge-preview"
      ? (resolveStripPairTarget(headerTab, geometry, next)?.targetRef ?? null)
      : null,
  );
  if (next.kind !== "merge-armed") return null;
  return `${next.targetItemId}:${next.armedAtMs}`;
}

/**
 * The validated pair target a merge preview refers to, or null when the layout
 * no longer permits it (the same validation the dwell machine applied).
 */
function resolveStripPairTarget(
  headerTab: HeaderTabDragData,
  geometry: StripDragGeometry,
  state: StripDragState,
): TopLevelStripPairTarget | null {
  if (state.kind !== "merge-preview" && state.kind !== "merge-armed") {
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
  target: TopLevelDwellTarget | TopLevelFillableTarget,
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
  readonly edgeDwell: EdgeSplitDwellMachine;
  readonly geometry: StripDragGeometry | null;
  readonly dragState: StripDragState | null;
}): void {
  const headerTab = readHeaderTabDragData(input.event.active.data.current);
  const target =
    input.event.over === null
      ? null
      : readTopLevelTabDropTarget(input.event.over.data.current);
  const validDrop =
    headerTab === null ||
    target === null ||
    target.kind === TOP_LEVEL_STRIP_PAIR_TARGET
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
  if (validDrop?.target.kind === "top-level-edge-split") {
    commitHeaderEdgeSplit(
      validDrop.source,
      validDrop.target,
      input.edgeDwell,
      input.navigate,
    );
    return;
  }
  if (
    headerTab === null ||
    input.geometry === null ||
    input.dragState === null
  ) {
    return;
  }
  // A merge preview beats the reorder it is sitting on: both describe the same
  // pointer position, and the dwell is what distinguishes "combine with this
  // tab" from "move next to it".
  if (input.dragState.kind === "merge-preview") {
    const pairTarget = resolveStripPairTarget(
      headerTab,
      input.geometry,
      input.dragState,
    );
    if (pairTarget !== null) {
      commitHeaderStripPair(headerTab, pairTarget, input.navigate);
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
 * Dropping A onto B yields `B | A`: the tab that stayed put keeps the left
 * side, the dragged one lands where it was released and takes focus.
 */
function commitHeaderStripPair(
  headerTab: HeaderTabDragData,
  target: TopLevelStripPairTarget,
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
      left: target.targetRef,
      right: sourceRef,
      focusedRef: sourceRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    tabResolveIntent(sourceTab),
    undefined,
  );
}

function commitHeaderEdgeSplit(
  sourceRef: TabRef,
  target: TopLevelEdgeSplitTarget,
  edgeDwell: EdgeSplitDwellMachine,
  navigate: UseNavigateResult<string>,
): void {
  // `commit` only succeeds for a target equal to this one (same kind, ref and
  // side), so the already-narrowed `target` describes the committed geometry.
  if (edgeDwell.commit(target) === null) {
    return;
  }
  const sourceTab = getHeaderTabs().find(
    (tab) => tab.kind === sourceRef.kind && tab.id === sourceRef.id,
  );
  if (sourceTab === undefined) return;
  activatePreparedPairTabIntent(
    navigate,
    {
      left: target.side === "left" ? sourceRef : target.targetRef,
      right: target.side === "right" ? sourceRef : target.targetRef,
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
    if (hasValidTopLevelDrop(event, headerTab)) return null;
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

function hasValidTopLevelDrop(
  event: DragEndEvent,
  headerTab: HeaderTabDragData,
): boolean {
  const target =
    event.over === null
      ? null
      : readTopLevelTabDropTarget(event.over.data.current);
  return target !== null && resolveLiveTopLevelDrop(headerTab, target) !== null;
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
  readonly edgeDwell: EdgeSplitDwellMachine;
  readonly resolvedDrop: ResolvedEpicCanvasDrop | null;
}): boolean {
  const dndStore = useEpicDndStore.getState();
  const headerStripIndex = dndStore.headerStripDropIndex;
  const headerDragState = dndStore.headerStripDragState;
  if (input.source === null) {
    commitHeaderTabDrop({
      event: input.event,
      navigate: input.navigate,
      edgeDwell: input.edgeDwell,
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
  // Strip geometry and content origin are re-read while dragging because the
  // strip can scroll or change layout without a corresponding pointer move.
  // A stationary pointer emits no events, so the merge dwell needs its own
  // timer or it can only ever fire on release - committing a split that was
  // never previewed.
  const clearMergeDwellTimer = useCallback(() => {
    headerMergeDwell().reset();
  }, []);

  const publishStripState = useCallback(
    (headerTab: HeaderTabDragData, pointerX: number) => {
      lastHeaderDrag = { headerTab, pointerX };
      const dwellKey = publishHeaderStripDragState({
        headerTab,
        geometry: activeHeaderStripGeometry,
        pointerX,
      });
      // A pending dwell means the model is armed; hand it to the latch, which
      // owns the timer that will wake it.
      headerMergeDwell().observe({
        key:
          dwellKey === null
            ? null
            : `merge:${headerTab.stripItemId}:${dwellKey}`,
        point: { x: pointerX, y: 0 },
        nowMs: performance.now(),
      });
    },
    [],
  );

  const edgeDwell = useMemo(
    () =>
      new EdgeSplitDwellMachine((state: EdgeSplitDwellState) => {
        const store = useEpicDndStore.getState();
        const target = state.kind === "preview" ? state.target : null;
        const pairTarget =
          target?.kind === TOP_LEVEL_STRIP_PAIR_TARGET ? target : null;
        store.topLevelEdgeSplitPreviewChanged(
          target?.kind === TOP_LEVEL_EDGE_SPLIT_TARGET ? target : null,
        );
        store.topLevelStripPairPreviewChanged(pairTarget?.targetRef ?? null);
        if (pairTarget !== null) store.headerStripDropIndexChanged(null);
      }, edgeSplitBrowserTimer),
    [],
  );
  // Stable bundle (the inner refs never change identity) so the preview helpers
  // take one object instead of three positional ref params.
  const reparentRefsRef = useRef<ReparentRefs>({
    lastResolved: lastResolvedDropRef,
    lastReparent: lastReparentDropRef,
    springLoad: springLoadRef,
  });
  const reparentRefs = reparentRefsRef.current;
  // A spring-load timer armed mid-drag must not survive the provider: if it
  // unmounts (route change / epic close) before drag end/cancel clears it, the
  // pending `setTimeout` would fire and `expand()` a stale tab/panel.
  useEffect(() => {
    window.addEventListener("pointermove", trackPointerX, {
      capture: true,
      passive: true,
    });
    window.addEventListener("pointerdown", trackPointerDownX, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointermove", trackPointerX, {
        capture: true,
      });
      window.removeEventListener("pointerdown", trackPointerDownX, {
        capture: true,
      });
      latestPointerX = null;
      latestPointerY = null;
      lastPointerDownX = null;
    };
  }, []);
  useEffect(() => {
    // A coordinator transaction fires a mid-transaction notify while
    // suppressionDepth is still 1 (before the layout write lands), for which
    // resolveValidatedTopLevelTabDrop always returns null. Revalidating
    // against that transient state would reset a valid, stationary dwell on
    // every unrelated transaction. Only settled notifies (suppressionDepth
    // back at 0) reflect a state a dwell target should be judged against.
    const revalidate = (): void => {
      if (getTabCommandLedger().suppressionDepth > 0) return;
      edgeDwell.revalidate();
    };
    const unsubscribeTabs = useTabsStore.subscribe(revalidate);
    const unsubscribeLocks = subscribeTabStructuralLocks(revalidate);
    const unsubscribeLedger = subscribeToTabCommandLedger(revalidate);
    const unsubscribeCompatibility = subscribeTabSplitCompatibility(revalidate);
    return () => {
      unsubscribeTabs();
      unsubscribeLocks();
      unsubscribeLedger();
      unsubscribeCompatibility();
    };
  }, [edgeDwell]);
  const sensors = useSensors(
    useSensor(EpicCanvasPointerSensor, {
      activationConstraint: {
        distance: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
      },
    }),
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
      edgeDwell.reset();
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
      }
    },
    [edgeDwell],
  );

  const updateDropPreview = useCallback(
    (event: DragUpdateEvent) => {
      // SINGLE pointer source of truth: the point stashed by the collision
      // pass that produced `event.over`. Never reconstruct it from
      // `activatorEvent` + `event.delta` (scroll-adjusted; diverges under
      // autoScroll).
      const point = getLastCollisionPointerPoint();
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
          edgeDwell,
          publishStripState: (pointerX) => {
            publishStripState(headerTab, pointerX);
          },
        });
      }
    },
    [edgeDwell, publishStripState, reparentRefs],
  );

  // The dwell timer re-runs the preview with the last event, so a stationary
  // pointer still arms.
  useEffect(() => {
    return () => {
      replayCanvasPreview = null;
      paneBodyDwell().reset();
    };
  }, []);

  /**
   * What a self-firing dwell replays when it wakes with no pointer input.
   *
   * EVERY update handler refreshes this, not just `onDragMove`. dnd-kit's
   * `over` lags by one event: on the frame the pointer enters a new droppable,
   * `onDragMove` still carries the PREVIOUS target and `onDragOver` fires
   * immediately after with the correct one. Capturing only the move event meant
   * that on a fast entry - one event landing inside a pane body, then a hold -
   * the latch armed and fired correctly 220ms later, and replayed a stale
   * `over` pointing at the strip the pointer had already left. The preview
   * never appeared, and by B1 lockstep the drop committed nothing.
   *
   * The other two dwells never had this: the header merge republishes from
   * `lastHeaderDrag` and the edge split from the target it holds. Both replay
   * STATE. This one replays an EVENT, so the event it holds must be the latest
   * one, whichever handler delivered it.
   */
  const rememberReplay = useCallback(
    (event: DragUpdateEvent) => {
      replayCanvasPreview = () => {
        updateDropPreview(event);
      };
    },
    [updateDropPreview],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      rememberReplay(event);
      updateDropPreview(event);
    },
    [rememberReplay, updateDropPreview],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      rememberReplay(event);
      updateDropPreview(event);
    },
    [rememberReplay, updateDropPreview],
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
    edgeDwell.reset();
    clearMergeDwellTimer();
    paneBodyDwell().reset();
    lastResolvedDropRef.current = null;
    lastReparentDropRef.current = null;
    clearLastCollisionPointerPoint();
    activeHeaderStripGeometry = null;
    activeTileDrag = null;
    lastHeaderDrag = null;
    promotedPreviewOnDrag = null;
    latestPointerX = null;
    latestPointerY = null;
    lastPointerDownX = null;
    // Cleared here rather than only on unmount: the latch that consumes it is
    // reset above, so a replay left armed can only ever re-run a dead gesture's
    // event. "Unreachable today" is the reasoning that already failed once in
    // this function.
    replayCanvasPreview = null;
    stripGeometryFailureReported = false;
    headerTearOffActive = false;
    useEpicDndStore.getState().dragEnded();
  }, [clearMergeDwellTimer, edgeDwell]);

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
        commitSidebarReparentDrop({
          epicId: reparent.epicId,
          sourceNodeId: reparent.sourceNodeId,
          newParentId: reparent.newParentId,
          panelId: reparent.panelId,
          viewTabId: reparent.viewTabId,
          queryClient,
        });
        endGesture();
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
        edgeDwell,
        resolvedDrop: lastResolvedDropRef.current,
      });
      if (!committed) restorePromotedPreview();
      endGesture();
    },
    [
      edgeDwell,
      endGesture,
      navigate,
      navigateNested,
      queryClient,
      updateDropPreview,
    ],
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
