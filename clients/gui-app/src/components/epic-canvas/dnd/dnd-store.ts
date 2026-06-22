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
import {
  EPIC_CANVAS_DND_SOURCE_TYPES,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropPreview,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import type { HeaderTabDragData } from "@/components/layout/tabs/header-tab-dnd";
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
    return left.panelId === right.panelId && left.position === right.position;
  }
  if (
    left.kind === "left-panel-rail-list" &&
    right.kind === "left-panel-rail-list"
  ) {
    return true;
  }
  if (
    left.kind === "left-panel-section" &&
    right.kind === "left-panel-section"
  ) {
    return left.panelId === right.panelId && left.position === right.position;
  }
  return false;
}

function matchingEpicCanvasDropPreviewEqual(
  left: NonNullable<EpicCanvasDropPreview>,
  right: NonNullable<EpicCanvasDropPreview>,
): boolean {
  if (left.kind === "empty-shell" && right.kind === "empty-shell") return true;
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
   * Sidebar reparent preview (gesture-scoped, mutually exclusive with the
   * canvas `dropPreview`). `reparentTargetNodeId` is the hovered VALID row
   * target (new parent); `reparentRootPanelId` is the hovered VALID panel
   * empty-space (un-nest to root). Both null unless a `sidebar-node` is over a
   * sidebar target whose `canReparent` pre-flight passed.
   */
  readonly reparentTargetNodeId: string | null;
  readonly reparentRootPanelId: RootCreatePanelId | null;
  readonly canvasDragStarted: (
    source: EpicCanvasDragSourceData,
    overlayTile: EpicCanvasTileRef | null,
  ) => void;
  readonly headerTabDragStarted: (tab: HeaderTabDragData) => void;
  readonly dropPreviewChanged: (preview: EpicCanvasDropPreview) => void;
  readonly headerStripDropIndexChanged: (index: number | null) => void;
  readonly sidebarReparentPreviewChanged: (preview: {
    readonly targetNodeId: string | null;
    readonly rootPanelId: RootCreatePanelId | null;
  }) => void;
  readonly dragEnded: () => void;
}

export const useEpicDndStore = create<EpicDndState>()((set, get) => ({
  activeSource: null,
  activeOverlayTile: null,
  activeHeaderTab: null,
  dropPreview: null,
  headerStripDropIndex: null,
  reparentTargetNodeId: null,
  reparentRootPanelId: null,
  canvasDragStarted: (source, overlayTile) => {
    set({
      activeSource: source,
      activeOverlayTile: overlayTile,
      activeHeaderTab: null,
      dropPreview: null,
      headerStripDropIndex: null,
      reparentTargetNodeId: null,
      reparentRootPanelId: null,
    });
  },
  headerTabDragStarted: (tab) => {
    set({
      activeSource: null,
      activeOverlayTile: null,
      activeHeaderTab: tab,
      dropPreview: null,
      headerStripDropIndex: null,
      reparentTargetNodeId: null,
      reparentRootPanelId: null,
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
  sidebarReparentPreviewChanged: (preview) => {
    const state = get();
    if (
      state.reparentTargetNodeId === preview.targetNodeId &&
      state.reparentRootPanelId === preview.rootPanelId
    ) {
      return;
    }
    set({
      reparentTargetNodeId: preview.targetNodeId,
      reparentRootPanelId: preview.rootPanelId,
    });
  },
  dragEnded: () => {
    const state = get();
    if (
      state.activeSource === null &&
      state.activeOverlayTile === null &&
      state.activeHeaderTab === null &&
      state.dropPreview === null &&
      state.headerStripDropIndex === null &&
      state.reparentTargetNodeId === null &&
      state.reparentRootPanelId === null
    ) {
      return;
    }
    set({
      activeSource: null,
      activeOverlayTile: null,
      activeHeaderTab: null,
      dropPreview: null,
      headerStripDropIndex: null,
      reparentTargetNodeId: null,
      reparentRootPanelId: null,
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

export function useEmptyShellDropActive(): boolean {
  return useEpicDndStore((s) => s.dropPreview?.kind === "empty-shell");
}

/** Header strip insertion indicator (reorder + canvas tear-off hovers). */
export function useHeaderStripDropIndex(): number | null {
  return useEpicDndStore((s) => s.headerStripDropIndex);
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
export function useLeftPanelRailDropPreview(): LeftPanelRailDropPreview | null {
  return useEpicDndStore((s) =>
    s.dropPreview?.kind === "left-panel-rail" ||
    s.dropPreview?.kind === "left-panel-rail-list"
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
export function useLeftPanelSectionDragSource(): EpicCanvasLeftPanelRailDragData | null {
  return useEpicDndStore((s) =>
    s.activeSource?.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE &&
    s.activeSource.origin === "panel-section"
      ? s.activeSource
      : null,
  );
}

/**
 * True while THIS sidebar row is the active valid reparent drop target. Each
 * row subscribes by its own `nodeId`, so a reparent-preview tick re-renders
 * only the hovered row (and the one it just left), never the whole tree.
 */
export function useSidebarReparentTargetActive(nodeId: string): boolean {
  return useEpicDndStore((s) => s.reparentTargetNodeId === nodeId);
}

/**
 * True while THIS panel's empty space is the active valid un-nest-to-root drop
 * target. Scoped per panel so only the hovered panel body re-renders.
 */
export function useSidebarReparentRootActive(
  panelId: RootCreatePanelId,
): boolean {
  return useEpicDndStore((s) => s.reparentRootPanelId === panelId);
}
