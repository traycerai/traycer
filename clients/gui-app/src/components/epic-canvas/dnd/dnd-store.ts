/**
 * Ephemeral drag state for the single root DndContext. Non-persisted by
 * design: every field is gesture-scoped and cleared on drag end/cancel.
 *
 * The root provider (`root-dnd-provider.tsx`) is the ONLY writer; it holds
 * zero React state so preview ticks never re-render the provider subtree.
 * Consumers subscribe through the narrow per-target selector hooks below so
 * a preview tick re-renders only the hovered pane/strip, never the whole
 * canvas.
 */
import { create } from "zustand";
import type {
  MergeSide,
  StripDragState,
} from "@/components/epic-canvas/dnd/strip-drag-model";
import {
  EPIC_CANVAS_DND_SOURCE_TYPES,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropPreview,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import type { HeaderTabDragData } from "@/components/layout/tabs/header-tab-dnd";
import type { TabRef } from "@/stores/tabs/types";
import type {
  DropPosition,
  EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import type { RootCreatePanelId } from "@/stores/epics/left-panel-store";

function matchingArtifactDropPreviewEqual(
  left: NonNullable<EpicCanvasDropPreview>,
  right: NonNullable<EpicCanvasDropPreview>,
): boolean {
  if (
    left.kind === "artifact-tab-strip" &&
    right.kind === "artifact-tab-strip"
  ) {
    return left.groupId === right.groupId && left.index === right.index;
  }
  if (
    left.kind === "artifact-tab-group-body" &&
    right.kind === "artifact-tab-group-body"
  ) {
    return left.groupId === right.groupId && left.position === right.position;
  }
  return false;
}

function matchingLeftPanelDropPreviewEqual(
  left: NonNullable<EpicCanvasDropPreview>,
  right: NonNullable<EpicCanvasDropPreview>,
): boolean {
  if (left.kind === "left-panel-rail" && right.kind === "left-panel-rail") {
    return (
      left.viewTabId === right.viewTabId &&
      left.panelId === right.panelId &&
      left.position === right.position
    );
  }
  if (
    left.kind === "left-panel-rail-list" &&
    right.kind === "left-panel-rail-list"
  ) {
    return left.viewTabId === right.viewTabId;
  }
  if (
    left.kind === "left-panel-section" &&
    right.kind === "left-panel-section"
  ) {
    return (
      left.viewTabId === right.viewTabId &&
      left.panelId === right.panelId &&
      left.position === right.position
    );
  }
  return false;
}

function matchingEpicCanvasDropPreviewEqual(
  left: NonNullable<EpicCanvasDropPreview>,
  right: NonNullable<EpicCanvasDropPreview>,
): boolean {
  if (left.kind === "empty-shell" && right.kind === "empty-shell") {
    return left.viewTabId === right.viewTabId;
  }
  return (
    matchingArtifactDropPreviewEqual(left, right) ||
    matchingLeftPanelDropPreviewEqual(left, right)
  );
}

export function epicCanvasDropPreviewEqual(
  left: EpicCanvasDropPreview,
  right: EpicCanvasDropPreview,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.kind !== right.kind) return false;
  return matchingEpicCanvasDropPreviewEqual(left, right);
}

const EMPTY_TILE_OFFSETS: ReadonlyMap<
  string,
  ReadonlyMap<string, number>
> = new Map();

/** Stable empty map so a strip with no offsets never re-renders on identity. */
const EMPTY_GROUP_OFFSETS: ReadonlyMap<string, number> = new Map();

function tileOffsetsEqual(
  left: ReadonlyMap<string, ReadonlyMap<string, number>>,
  right: ReadonlyMap<string, ReadonlyMap<string, number>>,
): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const [groupId, leftGroup] of left) {
    const rightGroup = right.get(groupId);
    if (rightGroup === undefined || rightGroup.size !== leftGroup.size) {
      return false;
    }
    for (const [tileId, value] of leftGroup) {
      if (rightGroup.get(tileId) !== value) return false;
    }
  }
  return true;
}

/**
 * A pair-into-split preview: the target strip tab, and the side of the pair
 * the dragged tab would occupy (its approach side).
 */
export interface TopLevelStripPairPreview {
  readonly targetRef: TabRef;
  readonly side: MergeSide;
}

/**
 * Structural equality so a resolve that produced the same gesture state does
 * not publish a new object every pointer move.
 */
function headerStripDragStateEqual(
  left: StripDragState | null,
  right: StripDragState | null,
): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  if (left.kind !== right.kind || left.targetIndex !== right.targetIndex) {
    return false;
  }
  if (left.kind === "reorder" || right.kind === "reorder") return true;
  return (
    left.targetItemId === right.targetItemId &&
    left.targetSide === right.targetSide
  );
}

/**
 * Whether every gesture-scoped field is already at rest.
 *
 * `dragEnded` fires on paths that may have written nothing, and re-setting a
 * store that is already idle would publish a new object and re-render every
 * narrow subscriber for nothing. Extracted so adding a gesture field is one
 * line here rather than another branch inside the action.
 */
function isDragStateIdle(state: EpicDndState): boolean {
  return (
    state.activeSource === null &&
    state.activeOverlayTile === null &&
    state.activeHeaderTab === null &&
    state.dropPreview === null &&
    state.headerStripDropIndex === null &&
    state.headerStripDragState === null &&
    state.headerStripSourceWidth === null &&
    state.headerStripOffsets.size === 0 &&
    state.tileStripOffsets.size === 0 &&
    state.tileSourceWidth === null &&
    state.topLevelStripPairPreview === null &&
    state.reparentTargetNodeId === null &&
    state.reparentTargetViewTabId === null &&
    state.reparentRootPanelId === null &&
    state.reparentRootViewTabId === null
  );
}

interface EpicDndState {
  /** Typed canvas/rail drag source, null when no canvas drag is active. */
  readonly activeSource: EpicCanvasDragSourceData | null;
  /**
   * Tile ref backing the drag-overlay chip, resolved ONCE at drag start
   * (content-derived; never re-resolved during the gesture).
   */
  readonly activeOverlayTile: EpicCanvasTileRef | null;
  /** Header-tab reorder source, null when no header-tab drag is active. */
  readonly activeHeaderTab: HeaderTabDragData | null;
  /** Current canvas-side drop preview (strip / body / empty-shell / rail). */
  readonly dropPreview: EpicCanvasDropPreview;
  /**
   * Insertion index into the header tab strip, for both header-tab reorder
   * and canvas-source tear-off hovers. Null when not hovering the strip.
   */
  readonly headerStripDropIndex: number | null;
  /**
   * Header-tab reorder/merge state from the strip geometry model. Header drags
   * resolve their insertion index from pointer geometry rather than droppable
   * hit-testing (see `header-strip-drag-model.ts`), so this - not
   * `headerStripDropIndex` - is what the strip renders a provisional order
   * from. `headerStripDropIndex` stays for canvas tear-off onto the strip,
   * which has no source slot and so cannot oscillate.
   */
  readonly headerStripDragState: StripDragState | null;
  /**
   * Measured width of the dragged strip item, so the overlay can render the tab
   * at its real size instead of a differently-shaped floating chip.
   */
  readonly headerStripSourceWidth: number | null;
  /**
   * Per-item x displacement for the HEADER strip while a header drag is in
   * flight. The header renders an explicit transform from this rather than a
   * provisional CSS `order` + layout projection, exactly as the tile strip
   * does - an absent id means that item sits at x 0.
   */
  readonly headerStripOffsets: ReadonlyMap<string, number>;
  /**
   * Per-tile x displacement while a tile drag is in flight, keyed by group then
   * tile id. Tile strips render an explicit transform from this rather than a
   * provisional CSS `order`; an absent group means every tile sits at x 0.
   */
  readonly tileStripOffsets: ReadonlyMap<string, ReadonlyMap<string, number>>;
  /**
   * Measured width of the dragged tile, so its overlay is the tile at its own
   * size rather than a differently-shaped chip. Tile widths are content-sized
   * and genuinely unequal, so this cannot be a constant.
   */
  readonly tileSourceWidth: number | null;
  /**
   * Strip tab a pair-into-split gesture is previewing against, and the side of
   * the resulting pair the DRAGGED tab would take - its approach side.
   */
  readonly topLevelStripPairPreview: TopLevelStripPairPreview | null;
  /**
   * Sidebar reparent preview (gesture-scoped, mutually exclusive with the
   * canvas `dropPreview`). `reparentTargetNodeId` is the hovered VALID row
   * target (new parent); `reparentRootPanelId` is the hovered VALID panel
   * empty-space (un-nest to root). Both null unless a `sidebar-node` is over a
   * sidebar target whose `canReparent` pre-flight passed.
   */
  readonly reparentTargetNodeId: string | null;
  readonly reparentTargetViewTabId: string | null;
  readonly reparentRootPanelId: RootCreatePanelId | null;
  readonly reparentRootViewTabId: string | null;
  readonly canvasDragStarted: (
    source: EpicCanvasDragSourceData,
    overlayTile: EpicCanvasTileRef | null,
  ) => void;
  readonly headerTabDragStarted: (
    tab: HeaderTabDragData,
    sourceWidth: number | null,
  ) => void;
  readonly dropPreviewChanged: (preview: EpicCanvasDropPreview) => void;
  readonly headerStripDropIndexChanged: (index: number | null) => void;
  readonly headerStripDragStateChanged: (state: StripDragState | null) => void;
  readonly tileStripOffsetsChanged: (
    offsets: ReadonlyMap<string, ReadonlyMap<string, number>>,
  ) => void;
  readonly headerStripOffsetsChanged: (
    offsets: ReadonlyMap<string, number>,
  ) => void;
  readonly tileSourceWidthChanged: (width: number | null) => void;
  readonly topLevelStripPairPreviewChanged: (
    preview: TopLevelStripPairPreview | null,
  ) => void;
  // Every field is required: the preview lands verbatim in `reparent*` state,
  // which is `string | null`. An omitted key reads as `undefined` and would
  // store a third value the readers below never compare against.
  readonly sidebarReparentPreviewChanged: (preview: {
    readonly targetNodeId: string | null;
    readonly targetViewTabId: string | null;
    readonly rootPanelId: RootCreatePanelId | null;
    readonly rootViewTabId: string | null;
  }) => void;
  readonly dragEnded: () => void;
}

export const useEpicDndStore = create<EpicDndState>()((set, get) => ({
  activeSource: null,
  activeOverlayTile: null,
  activeHeaderTab: null,
  dropPreview: null,
  headerStripDropIndex: null,
  headerStripDragState: null,
  headerStripSourceWidth: null,
  headerStripOffsets: EMPTY_GROUP_OFFSETS,
  tileStripOffsets: EMPTY_TILE_OFFSETS,
  tileSourceWidth: null,
  topLevelStripPairPreview: null,
  reparentTargetNodeId: null,
  reparentTargetViewTabId: null,
  reparentRootPanelId: null,
  reparentRootViewTabId: null,
  canvasDragStarted: (source, overlayTile) => {
    set({
      activeSource: source,
      activeOverlayTile: overlayTile,
      activeHeaderTab: null,
      dropPreview: null,
      headerStripDropIndex: null,
      headerStripDragState: null,
      headerStripSourceWidth: null,
      headerStripOffsets: EMPTY_GROUP_OFFSETS,
      tileStripOffsets: EMPTY_TILE_OFFSETS,
      tileSourceWidth: null,
      topLevelStripPairPreview: null,
      reparentTargetNodeId: null,
      reparentTargetViewTabId: null,
      reparentRootPanelId: null,
      reparentRootViewTabId: null,
    });
  },
  headerTabDragStarted: (tab, sourceWidth) => {
    set({
      activeSource: null,
      activeOverlayTile: null,
      activeHeaderTab: tab,
      dropPreview: null,
      headerStripDropIndex: null,
      headerStripDragState: null,
      headerStripSourceWidth: sourceWidth,
      headerStripOffsets: EMPTY_GROUP_OFFSETS,
      tileStripOffsets: EMPTY_TILE_OFFSETS,
      tileSourceWidth: null,
      topLevelStripPairPreview: null,
      reparentTargetNodeId: null,
      reparentTargetViewTabId: null,
      reparentRootPanelId: null,
      reparentRootViewTabId: null,
    });
  },
  dropPreviewChanged: (preview) => {
    if (epicCanvasDropPreviewEqual(get().dropPreview, preview)) return;
    set({ dropPreview: preview });
  },
  headerStripDropIndexChanged: (index) => {
    if (get().headerStripDropIndex === index) return;
    set({ headerStripDropIndex: index });
  },
  headerStripOffsetsChanged: (offsets) => {
    const current = get().headerStripOffsets;
    if (current.size === offsets.size) {
      let same = true;
      for (const [id, value] of offsets) {
        if (current.get(id) !== value) {
          same = false;
          break;
        }
      }
      if (same) return;
    }
    set({ headerStripOffsets: offsets });
  },
  tileSourceWidthChanged: (width) => {
    if (get().tileSourceWidth === width) return;
    set({ tileSourceWidth: width });
  },
  tileStripOffsetsChanged: (offsets) => {
    if (tileOffsetsEqual(get().tileStripOffsets, offsets)) return;
    set({ tileStripOffsets: offsets });
  },
  headerStripDragStateChanged: (next) => {
    const current = get().headerStripDragState;
    if (headerStripDragStateEqual(current, next)) return;
    set({ headerStripDragState: next });
  },
  topLevelStripPairPreviewChanged: (preview) => {
    const current = get().topLevelStripPairPreview;
    if (
      current === preview ||
      (current !== null &&
        preview !== null &&
        current.side === preview.side &&
        current.targetRef.kind === preview.targetRef.kind &&
        current.targetRef.id === preview.targetRef.id)
    ) {
      return;
    }
    set({ topLevelStripPairPreview: preview });
  },
  sidebarReparentPreviewChanged: (preview) => {
    const state = get();
    if (
      state.reparentTargetNodeId === preview.targetNodeId &&
      state.reparentTargetViewTabId === preview.targetViewTabId &&
      state.reparentRootPanelId === preview.rootPanelId &&
      state.reparentRootViewTabId === preview.rootViewTabId
    ) {
      return;
    }
    set({
      reparentTargetNodeId: preview.targetNodeId,
      reparentTargetViewTabId: preview.targetViewTabId,
      reparentRootPanelId: preview.rootPanelId,
      reparentRootViewTabId: preview.rootViewTabId,
    });
  },
  dragEnded: () => {
    if (isDragStateIdle(get())) {
      return;
    }
    set({
      activeSource: null,
      activeOverlayTile: null,
      activeHeaderTab: null,
      dropPreview: null,
      headerStripDropIndex: null,
      headerStripDragState: null,
      headerStripSourceWidth: null,
      headerStripOffsets: EMPTY_GROUP_OFFSETS,
      tileStripOffsets: EMPTY_TILE_OFFSETS,
      tileSourceWidth: null,
      topLevelStripPairPreview: null,
      reparentTargetNodeId: null,
      reparentTargetViewTabId: null,
      reparentRootPanelId: null,
      reparentRootViewTabId: null,
    });
  },
}));

// ── Narrow selector hooks ───────────────────────────────────────────────────
// One hook per consumer surface so a preview tick re-renders ONLY the
// hovered target. Do not subscribe to the whole store from components.

/** Canvas interaction shield: any typed canvas/rail drag locks the canvas. */
export function useEpicDndInteractionLocked(): boolean {
  return useEpicDndStore((s) => s.activeSource !== null);
}

function isCanvasOpenableSource(
  source: EpicCanvasDragSourceData | null,
): boolean {
  return source !== null && EPIC_CANVAS_DND_SOURCE_TYPES.includes(source.kind);
}

/**
 * True while a canvas-openable source (tab / sidebar node / terminal /
 * git-diff tile / workspace file) is being dragged. Pane drop zones mount
 * only then.
 */
export function useEpicDndCanvasDragActive(): boolean {
  return useEpicDndStore((s) => isCanvasOpenableSource(s.activeSource));
}

/** Per-pane body preview: edge/center position for THIS pane only. */
export function usePaneDropPreviewPosition(
  paneId: string,
): DropPosition | null {
  return useEpicDndStore((s) =>
    s.dropPreview?.kind === "artifact-tab-group-body" &&
    s.dropPreview.groupId === paneId
      ? s.dropPreview.position
      : null,
  );
}

/** Per-strip insertion indicator index for THIS pane's tab strip only. */
export function useTabStripDropIndex(groupId: string): number | null {
  return useEpicDndStore((s) =>
    s.dropPreview?.kind === "artifact-tab-strip" &&
    s.dropPreview.groupId === groupId
      ? s.dropPreview.index
      : null,
  );
}

export function useEmptyShellDropActive(viewTabId: string): boolean {
  return useEpicDndStore(
    (s) =>
      s.dropPreview?.kind === "empty-shell" &&
      s.dropPreview.viewTabId === viewTabId,
  );
}

/** Header strip insertion indicator (reorder + canvas tear-off hovers). */
export function useHeaderStripDropIndex(): number | null {
  return useEpicDndStore((s) => s.headerStripDropIndex);
}

export function useActiveHeaderTab(): HeaderTabDragData | null {
  return useEpicDndStore((s) => s.activeHeaderTab);
}

export function useHeaderStripOffsets(): ReadonlyMap<string, number> {
  return useEpicDndStore((s) => s.headerStripOffsets);
}

export function useTileStripOffsets(
  groupId: string,
): ReadonlyMap<string, number> {
  return useEpicDndStore(
    (s) => s.tileStripOffsets.get(groupId) ?? EMPTY_GROUP_OFFSETS,
  );
}

export function useHeaderStripDragState(): StripDragState | null {
  return useEpicDndStore((s) => s.headerStripDragState);
}

/**
 * For the one strip tab a pair-into-split drop would combine with: the side of
 * the pair the DRAGGED tab would take (its approach side). Null for every
 * other tab.
 */
export function useTopLevelStripPairPreview(
  refKind: string,
  refId: string,
): MergeSide | null {
  return useEpicDndStore((state) => {
    const preview = state.topLevelStripPairPreview;
    return preview !== null &&
      preview.targetRef.kind === refKind &&
      preview.targetRef.id === refId
      ? preview.side
      : null;
  });
}

type LeftPanelRailDropPreview = Extract<
  NonNullable<EpicCanvasDropPreview>,
  { readonly kind: "left-panel-rail" | "left-panel-rail-list" }
>;

/**
 * Rail-facing drop preview (icon before/after/combine + rail-end) for the
 * sidebar rail. Narrowed so canvas-side preview ticks (pane bodies, tab
 * strips, header strip) never re-render the rail.
 */
export function useLeftPanelRailDropPreview(
  viewTabId: string,
): LeftPanelRailDropPreview | null {
  return useEpicDndStore((s) =>
    (s.dropPreview?.kind === "left-panel-rail" ||
      s.dropPreview?.kind === "left-panel-rail-list") &&
    s.dropPreview.viewTabId === viewTabId &&
    s.activeSource?.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE &&
    s.activeSource.viewTabId === viewTabId
      ? s.dropPreview
      : null,
  );
}

/**
 * Active panel-section extraction drag (a section header dragged out of a
 * sidebar group), used by the rail to render its boundary drop-slot chip.
 * Null for rail-origin drags and every non-rail source; re-renders on drag
 * start/end only - never on preview ticks.
 */
export function useLeftPanelSectionDragSource(
  viewTabId: string,
): EpicCanvasLeftPanelRailDragData | null {
  return useEpicDndStore((s) =>
    s.activeSource?.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE &&
    s.activeSource.origin === "panel-section" &&
    s.activeSource.viewTabId === viewTabId
      ? s.activeSource
      : null,
  );
}

/**
 * True while THIS sidebar row is the active valid reparent drop target. Each
 * row subscribes by its own `nodeId`, so a reparent-preview tick re-renders
 * only the hovered row (and the one it just left), never the whole tree.
 */
export function useSidebarReparentTargetActive(
  viewTabId: string,
  nodeId: string,
): boolean {
  return useEpicDndStore(
    (s) =>
      s.reparentTargetViewTabId === viewTabId &&
      s.reparentTargetNodeId === nodeId,
  );
}

/**
 * True while THIS panel's empty space is the active valid un-nest-to-root drop
 * target. Scoped per panel so only the hovered panel body re-renders.
 */
export function useSidebarReparentRootActive(
  viewTabId: string,
  panelId: RootCreatePanelId,
): boolean {
  return useEpicDndStore(
    (s) =>
      s.reparentRootViewTabId === viewTabId &&
      s.reparentRootPanelId === panelId,
  );
}
