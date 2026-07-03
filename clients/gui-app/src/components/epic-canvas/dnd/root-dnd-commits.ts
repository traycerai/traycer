/**
 * Drop resolution + commit logic for the single root DndContext. Every
 * function here is called from the root provider's drag handlers and reads
 * the target stores imperatively (`getState()`): the root provider mounts at
 * the app shell, outside any epic session provider, so epic/tab scope comes
 * from the drag payloads (`epicId` / `viewTabId`) instead of React context.
 *
 * Preview state is owned by `dnd-store.ts`; the commit consumes the LAST
 * resolved drop (pointer-up can race the final collision update), which the
 * provider tracks in a ref and hands in here.
 */
import { v4 as uuidv4 } from "uuid";
import {
  ARTIFACT_TAB_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  PANEL_NODE_FAMILY,
  SIDEBAR_NODE_DND_TYPE,
  TERMINAL_TILE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  getArtifactTabDropIndexFromPoint,
  getEpicCanvasDropPreview,
  getLeftPanelGroupDropPreview,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropPreview,
  type EpicCanvasDropTargetData,
  type LeftPanelSectionRect,
  type PointLike,
  type RectLike,
} from "@/components/epic-canvas/dnd/dnd";
import { computeTabDropIndex } from "@/components/epic-canvas/dnd/tab-strip-drop-preview";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { findPaneById } from "@/stores/epics/canvas/tile-tree";
import {
  isGitDiffTileRef,
  makeOpenableNodeRef,
  type EpicCanvasTileRef,
  type EpicNodeRef,
  type GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import {
  areLeftPanelGroupsEqual,
  moveLeftPanelGroup,
  moveLeftPanelGroupToEnd,
  moveLeftPanelGroupToPanelPosition,
  moveLeftPanelToEnd,
  moveLeftPanelToGroup,
  moveLeftPanelToGroupPosition,
  moveLeftPanelToPanelPosition,
  useLeftPanelStore,
  type LeftPanelGroup,
  type LeftPanelId,
  type RootCreatePanelId,
} from "@/stores/epics/left-panel-store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { canReparent } from "@/lib/epic-y-mutations";
import { resolveReparentNode } from "@/lib/reparent-rules";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import { getHostBindingSnapshot } from "@/lib/host/runtime";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { copyEpicSidebarTabState } from "@/lib/epics/copy-epic-sidebar-tab-state";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";

export interface ResolvedEpicCanvasDrop {
  readonly source: EpicCanvasDragSourceData;
  readonly target: EpicCanvasDropTargetData;
  readonly preview: EpicCanvasDropPreview;
}

export function canDropOnHeaderStrip(
  source: EpicCanvasDragSourceData | null,
): source is Extract<
  EpicCanvasDragSourceData,
  {
    readonly kind:
      | typeof ARTIFACT_TAB_DND_TYPE
      | typeof SIDEBAR_NODE_DND_TYPE
      | typeof TERMINAL_TILE_DND_TYPE
      | typeof GIT_DIFF_TILE_DND_TYPE
      | typeof WORKSPACE_FILE_DND_TYPE
      | typeof CHAT_ARTIFACT_DND_TYPE;
  }
> {
  // Every openable canvas source can tear off into a new header tab. A
  // chat-artifact belongs here alongside sidebar nodes / workspace files:
  // collision already offers it the header slot (via EPIC_CANVAS_DND_SOURCE_TYPES
  // -> CANVAS_TARGET_KINDS), so omitting it here would leave the header strip a
  // silent dead zone (preview + commit both gate on this predicate).
  return (
    source?.kind === ARTIFACT_TAB_DND_TYPE ||
    source?.kind === SIDEBAR_NODE_DND_TYPE ||
    source?.kind === TERMINAL_TILE_DND_TYPE ||
    source?.kind === GIT_DIFF_TILE_DND_TYPE ||
    source?.kind === WORKSPACE_FILE_DND_TYPE ||
    source?.kind === CHAT_ARTIFACT_DND_TYPE
  );
}

function activeHostIdOrPlaceholder(): string {
  return (
    getHostBindingSnapshot()?.hostClient.getActiveHostId() ??
    UNKNOWN_HOST_PLACEHOLDER
  );
}

/**
 * Single source of truth for "openable (non-tab) source -> tile ref": the
 * header-strip commit, the canvas-drop commit, and the drag overlay all map
 * the same way. Sidebar nodes resolve against the live epic session via the
 * module-scoped registry (`peek`, never `acquire` - dragging must not extend
 * a session's lifetime).
 */
export function sourceToTileRef(
  source: EpicCanvasDragSourceData,
): EpicNodeRef | GitDiffTileRef | null {
  if (source.kind === SIDEBAR_NODE_DND_TYPE) {
    const handle = getOpenEpicRegistry().peek(source.epicId);
    if (handle === null) return null;
    return epicNodeRefForNodeId(
      handle.store.getState(),
      source.nodeId,
      activeHostIdOrPlaceholder(),
    );
  }
  if (source.kind === TERMINAL_TILE_DND_TYPE) return source.tile;
  if (source.kind === GIT_DIFF_TILE_DND_TYPE) return source.tile;
  if (source.kind === WORKSPACE_FILE_DND_TYPE) return source.ref;
  if (source.kind === CHAT_ARTIFACT_DND_TYPE) {
    // Mint a FRESH instanceId per call (constraint C2): the payload carries
    // artifact identity only, so two drags of the same card never reuse an
    // instanceId and collide in `tilesByInstanceId`.
    return makeOpenableNodeRef({ ...source.artifact, instanceId: uuidv4() });
  }
  return null;
}

/**
 * Resolves the drag-overlay chip's tile ref at drag start. Artifact tabs
 * look up their live payload in the canvas store; openable sources share
 * `sourceToTileRef`; rail items have no tile (the overlay renders the panel
 * chip from the payload instead).
 */
export function resolveOverlayTileForSource(
  source: EpicCanvasDragSourceData,
): EpicCanvasTileRef | null {
  if (source.kind === ARTIFACT_TAB_DND_TYPE) {
    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[source.viewTabId];
    if (canvas === undefined) return null;
    const pane = findPaneById(canvas.root, source.sourceGroupId);
    if (pane === null || !pane.tabInstanceIds.includes(source.tabId)) {
      return null;
    }
    return canvas.tilesByInstanceId[source.tabId] ?? null;
  }
  return sourceToTileRef(source);
}

// ── Preview resolution ──────────────────────────────────────────────────────

function getElementRect(element: Element): RectLike {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function getLeftPanelSectionRect(
  groupElement: Element,
  panelId: LeftPanelId,
): LeftPanelSectionRect | null {
  const sectionElement = groupElement.querySelector(
    `[data-left-panel-section-id="${panelId}"]`,
  );
  if (sectionElement === null) return null;
  return {
    panelId,
    rect: getElementRect(sectionElement),
  };
}

export interface ResolveCanvasDropPreviewInput {
  readonly source: EpicCanvasDragSourceData;
  readonly target: EpicCanvasDropTargetData;
  readonly point: PointLike;
  readonly targetRect: RectLike | null;
  /**
   * The droppable's DOM element - only required for `left-panel-group`
   * targets (section-rect scanning); every other target resolves from
   * `targetRect` alone.
   */
  readonly targetElement: Element | null;
  /** Translated rect of the dragged chip (tab-over-tab center math). */
  readonly activeRect: RectLike | null;
}

export function resolveCanvasDropPreview(
  input: ResolveCanvasDropPreviewInput,
): EpicCanvasDropPreview {
  const { source, target, point, targetRect, targetElement, activeRect } =
    input;
  if (target.kind === "left-panel-group") {
    if (source.kind !== LEFT_PANEL_RAIL_ITEM_DND_TYPE) return null;
    if (targetElement === null) return null;
    const sectionRects: ReadonlyArray<LeftPanelSectionRect> =
      target.panelIds.flatMap((panelId) => {
        if (source.origin === "panel-section" && source.panelId === panelId) {
          return [];
        }
        const sectionRect = getLeftPanelSectionRect(targetElement, panelId);
        return sectionRect === null ? [] : [sectionRect];
      });
    return getLeftPanelGroupDropPreview(target, sectionRects, point);
  }
  if (
    target.kind === "artifact-tab" &&
    source.kind === ARTIFACT_TAB_DND_TYPE &&
    activeRect !== null &&
    targetRect !== null
  ) {
    // Tab-over-tab: paseo chip-center comparison instead of raw pointer x.
    return {
      kind: "artifact-tab-strip",
      groupId: target.groupId,
      index: computeTabDropIndex({
        overIndex: target.index,
        activeRect,
        overRect: targetRect,
      }),
    };
  }
  if (
    target.kind === "artifact-tab" ||
    target.kind === "artifact-tab-strip-end"
  ) {
    return {
      kind: "artifact-tab-strip",
      groupId: target.groupId,
      index: getArtifactTabDropIndexFromPoint(target, targetRect, point.x) ?? 0,
    };
  }
  return getEpicCanvasDropPreview(target, targetRect, point);
}

type LeftPanelRailDragSource = Extract<
  EpicCanvasDragSourceData,
  { readonly kind: typeof LEFT_PANEL_RAIL_ITEM_DND_TYPE }
>;

/**
 * Single source of truth for "left-panel drop → next rail groups". Both the
 * preview-time noop check and the drag-end commit resolve through this pure
 * function, so they can never disagree on what a drop does. Returns the next
 * groups (structurally equal to `groups` for a no-op position, e.g. combining
 * a section into its own group) or null when the preview is not a left-panel
 * preview.
 */
export function resolveLeftPanelGroupsForDrop(
  source: LeftPanelRailDragSource,
  preview: NonNullable<EpicCanvasDropPreview>,
  groups: ReadonlyArray<LeftPanelGroup>,
): ReadonlyArray<LeftPanelGroup> | null {
  if (preview.kind === "left-panel-rail") {
    if (source.origin === "rail") {
      return moveLeftPanelGroup(
        groups,
        source.panelId,
        preview.panelId,
        preview.position,
      );
    }
    if (preview.position === "combine") {
      return moveLeftPanelToGroup(groups, source.panelId, preview.panelId);
    }
    return moveLeftPanelToGroupPosition(
      groups,
      source.panelId,
      preview.panelId,
      preview.position,
    );
  }
  if (preview.kind === "left-panel-section") {
    return source.origin === "rail"
      ? moveLeftPanelGroupToPanelPosition(
          groups,
          source.panelId,
          preview.panelId,
          preview.position,
        )
      : moveLeftPanelToPanelPosition(
          groups,
          source.panelId,
          preview.panelId,
          preview.position,
        );
  }
  if (preview.kind === "left-panel-rail-list") {
    return source.origin === "rail"
      ? moveLeftPanelGroupToEnd(groups, source.panelId)
      : moveLeftPanelToEnd(groups, source.panelId);
  }
  return null;
}

export function isLeftPanelDropNoop(
  source: EpicCanvasDragSourceData,
  preview: EpicCanvasDropPreview,
): boolean {
  if (source.kind !== LEFT_PANEL_RAIL_ITEM_DND_TYPE) return false;
  if (preview === null) return false;
  const currentGroups = useLeftPanelStore.getState().getPanelGroups();
  const nextGroups = resolveLeftPanelGroupsForDrop(
    source,
    preview,
    currentGroups,
  );
  return (
    nextGroups !== null && areLeftPanelGroupsEqual(currentGroups, nextGroups)
  );
}

// ── Commits ─────────────────────────────────────────────────────────────────

function commitArtifactTabDrop(
  source: Extract<
    EpicCanvasDragSourceData,
    { readonly kind: typeof ARTIFACT_TAB_DND_TYPE }
  >,
  target: EpicCanvasDropTargetData,
  preview: NonNullable<EpicCanvasDropPreview>,
): void {
  if (preview.kind === "empty-shell") return;
  const canvasStore = useEpicCanvasStore.getState();
  if (preview.kind === "artifact-tab-strip") {
    canvasStore.moveTabOnTabStrip(source.viewTabId, {
      sourcePaneId: source.sourceGroupId,
      tabId: source.tabId,
      targetPaneId: preview.groupId,
      targetIndex: preview.index,
    });
  }
  if (
    preview.kind === "artifact-tab-group-body" &&
    preview.position === "center"
  ) {
    canvasStore.moveTabOnTabStrip(source.viewTabId, {
      sourcePaneId: source.sourceGroupId,
      tabId: source.tabId,
      targetPaneId: preview.groupId,
      targetIndex:
        target.kind === "artifact-tab-group-body" ? target.tabCount : 0,
    });
  }
  if (
    preview.kind === "artifact-tab-group-body" &&
    preview.position !== "center"
  ) {
    canvasStore.splitPaneWithTab(source.viewTabId, {
      sourcePaneId: source.sourceGroupId,
      tabId: source.tabId,
      targetPaneId: preview.groupId,
      position: preview.position,
    });
  }
}

/**
 * Shared canvas placement for every "open a tile ref" source kind (sidebar
 * node, git-diff tile, workspace file). The tab-strip / split actions are
 * already polymorphic over `EpicCanvasTileRef`; only the empty-shell open
 * differs per kind. `artifact-tab` and left-panel sources keep their own
 * commit paths because they are structurally different (move-vs-open /
 * separate store).
 */
function placeResolvedCanvasTile(
  tile: EpicNodeRef | GitDiffTileRef,
  target: EpicCanvasDropTargetData,
  preview: NonNullable<EpicCanvasDropPreview>,
): void {
  if (
    preview.kind === "left-panel-rail" ||
    preview.kind === "left-panel-rail-list" ||
    preview.kind === "left-panel-section"
  ) {
    return;
  }
  const canvasStore = useEpicCanvasStore.getState();
  if (preview.kind === "empty-shell") {
    if (target.kind !== "empty-shell") return;
    if (isGitDiffTileRef(tile)) {
      canvasStore.openTileInTab(target.viewTabId, tile);
      return;
    }
    canvasStore.openTileInTab(target.viewTabId, tile);
    return;
  }
  if (target.kind === "empty-shell") return;
  if (
    target.kind === "left-panel-rail-item" ||
    target.kind === "left-panel-rail-list" ||
    target.kind === "left-panel-group"
  ) {
    return;
  }
  if (preview.kind === "artifact-tab-strip") {
    canvasStore.insertNodeOnTabStrip(
      target.viewTabId,
      preview.groupId,
      preview.index,
      tile,
    );
    return;
  }
  if (preview.position === "center") {
    canvasStore.insertNodeOnTabStrip(
      target.viewTabId,
      preview.groupId,
      target.kind === "artifact-tab-group-body" ? target.tabCount : 0,
      tile,
    );
    return;
  }
  canvasStore.splitPaneWithNode(
    target.viewTabId,
    preview.groupId,
    preview.position,
    tile,
  );
}

export function commitResolvedCanvasDrop(drop: ResolvedEpicCanvasDrop): void {
  if (drop.preview === null) return;
  if (drop.source.kind === ARTIFACT_TAB_DND_TYPE) {
    commitArtifactTabDrop(drop.source, drop.target, drop.preview);
    return;
  }
  if (drop.source.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE) {
    const leftPanelStore = useLeftPanelStore.getState();
    const nextGroups = resolveLeftPanelGroupsForDrop(
      drop.source,
      drop.preview,
      leftPanelStore.getPanelGroups(),
    );
    if (nextGroups !== null) {
      leftPanelStore.applyPanelGroups(nextGroups);
    }
    return;
  }
  const tile = sourceToTileRef(drop.source);
  if (tile !== null) {
    placeResolvedCanvasTile(tile, drop.target, drop.preview);
  }
}

export interface HeaderStripDropResult {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Drop of a canvas source onto the header tab strip. An existing artifact
 * tab tears off into a fresh header tab (clone semantics: new instance ids,
 * copied sidebar state); every other openable source opens in a new header
 * tab at the insertion index. Returns the new header tab for navigation.
 */
export function commitHeaderStripDrop(
  source: EpicCanvasDragSourceData,
  insertIndex: number,
): HeaderStripDropResult | null {
  if (!canDropOnHeaderStrip(source)) return null;
  const canvasStore = useEpicCanvasStore.getState();
  if (source.kind === ARTIFACT_TAB_DND_TYPE) {
    const tabId = canvasStore.tearOffTabIntoNewHeaderTab({
      sourceTabId: source.viewTabId,
      sourcePaneId: source.sourceGroupId,
      sourceTileTabId: source.tabId,
      insertIndex,
    });
    if (tabId === null) return null;
    copyEpicSidebarTabState(source.viewTabId, tabId);
    return { epicId: source.epicId, tabId };
  }
  const tile = sourceToTileRef(source);
  if (tile === null) return null;
  // Single store write: the new header tab lands directly at `insertIndex`
  // (mirrors `tearOffTabIntoNewHeaderTab`), so the tab-sync subscriber never
  // observes a transient appended-at-the-end order.
  const tabId = canvasStore.openTileInNewTab(source.epicId, tile, insertIndex);
  if (tabId === null) return null;
  copyEpicSidebarTabState(source.viewTabId, tabId);
  return { epicId: source.epicId, tabId };
}

export interface SidebarReparentDropInput {
  readonly epicId: string;
  readonly sourceNodeId: string;
  /** The new parent (a row's nodeId) or null to un-nest to root. */
  readonly newParentId: string | null;
  /** The panel the drop landed in - gates a root (un-nest) drop by family. */
  readonly panelId: RootCreatePanelId;
  /** The canvas tab the drop happened in - scopes the new-parent expand. */
  readonly viewTabId: string;
}

/**
 * Imperative reparent commit for a `sidebar-node` released on a reparent
 * target. Resolves the live epic session via the registry (`peek`, never
 * `acquire`), RE-RUNS `canReparent` against the current doc (Decision D: this
 * closes the drag-over→drag-end TOCTOU and keeps the throwing store action
 * unreachable), then flips `parentId` through the standard `reparentArtifact`
 * action (`LOCAL_ORIGIN`, replicated over the Y stream). Silent no-op when the
 * session is gone or the re-check fails - matching the "invalid drop = silent
 * cancel" rule.
 */
export function commitSidebarReparentDrop(
  input: SidebarReparentDropInput,
): void {
  const handle = getOpenEpicRegistry().peek(input.epicId);
  if (handle === null) return;
  const doc = handle.store.getState().doc;
  if (!canReparent(doc, input.sourceNodeId, input.newParentId).ok) return;
  // A root (un-nest) drop is family-agnostic at the doc level, so `canReparent`
  // alone permits it. Mirror the preview's panel-family gate here too so a
  // cross-panel empty-space drop is a silent no-op (matching the no-highlight
  // preview), not an un-nest into the wrong panel.
  if (
    input.newParentId === null &&
    resolveReparentNode(doc, input.sourceNodeId)?.family !==
      PANEL_NODE_FAMILY[input.panelId]
  ) {
    return;
  }
  handle.store
    .getState()
    .reparentArtifact(input.sourceNodeId, input.newParentId);
  // Reveal the moved node under its new parent: a quick drop onto a collapsed
  // or previously-leaf row only flips `parentId`, and spring-load only fires
  // after a 450ms hover on rows that already had children - so without this the
  // node would appear to vanish until the user manually expands the parent.
  // `expand` is idempotent (no-op for an already-expanded parent); a root
  // (un-nest) drop has no parent to expand.
  if (input.newParentId !== null) {
    useEpicSidebarExpansionStore
      .getState()
      .expand(input.viewTabId, input.panelId, input.newParentId);
  }
}
