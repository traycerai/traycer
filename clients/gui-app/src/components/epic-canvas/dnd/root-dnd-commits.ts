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
  ACTIVE_AGENT_DND_TYPE,
  ARTIFACT_TAB_DND_TYPE,
  BROWSER_TILE_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  EPIC_CANVAS_DND_SOURCE_TYPES,
  GIT_DIFF_TILE_DND_TYPE,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  MANAGED_COMMAND_OUTPUT_DND_TYPE,
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
  makeOpenableNodeRef,
  type BrowserSessionTileRef,
  type EpicCanvasTileRef,
  type EpicNodeRef,
  type GitDiffTileRef,
  type ManagedCommandOutputTileRef,
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
import type { QueryClient } from "@tanstack/react-query";
import {
  getEpicSessionHandleHostClient,
  getEpicSessionHandleHostId,
  getOpenEpicRegistry,
} from "@/lib/registries/epic-session-registry";
import { invalidateEpicChatRecords } from "@/hooks/chats/use-epic-chat-records";
import { invalidateEpicTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import {
  canReparentProjected,
  type ProjectedReparentNode,
} from "@/lib/reparent-projection-rules";
import type { OpenEpicState } from "@/stores/epics/open-epic/store";
import { appLogger } from "@/lib/logger";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toHostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { epicNodeRefForNodeId } from "@/lib/epic-selectors";
import { copyEpicSidebarTabState } from "@/lib/epics/copy-epic-sidebar-tab-state";
import { useEpicSidebarExpansionStore } from "@/stores/epics/epic-sidebar-expansion-store";
import type { NavigateNestedFocus } from "@/lib/epic-nested-focus-navigation";

export interface ResolvedEpicCanvasDrop {
  readonly source: EpicCanvasDragSourceData;
  readonly target: EpicCanvasDropTargetData;
  readonly preview: EpicCanvasDropPreview;
}

/** Reject cross-pane drops before preview or mutation under the root DnD tree. */
export function isCanvasDropCompatible(
  source: EpicCanvasDragSourceData,
  target: EpicCanvasDropTargetData,
): boolean {
  // Direct unit callers predate pane-scoped target data. Runtime targets are
  // parsed through `readEpicCanvasDropTargetData`, which requires this field.
  if (target.viewTabId === undefined) return true;
  if (source.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE) {
    return (
      (target.kind === "left-panel-rail-item" ||
        target.kind === "left-panel-rail-list" ||
        target.kind === "left-panel-group") &&
      target.viewTabId === source.viewTabId
    );
  }
  if (source.viewTabId !== target.viewTabId) return false;
  return true;
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
      | typeof BROWSER_TILE_DND_TYPE
      | typeof GIT_DIFF_TILE_DND_TYPE
      | typeof WORKSPACE_FILE_DND_TYPE
      | typeof CHAT_ARTIFACT_DND_TYPE
      | typeof ACTIVE_AGENT_DND_TYPE
      | typeof MANAGED_COMMAND_OUTPUT_DND_TYPE;
  }
> {
  // Every openable canvas source can tear off into a new header tab. The
  // self-describing chat-artifact and active-agent sources belong here beside
  // sidebar nodes / workspace files: collision already offers them the header
  // slot (via EPIC_CANVAS_DND_SOURCE_TYPES -> CANVAS_TARGET_KINDS), so omitting
  // either would leave the header strip a silent dead zone.
  return source !== null && EPIC_CANVAS_DND_SOURCE_TYPES.includes(source.kind);
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
):
  | EpicNodeRef
  | GitDiffTileRef
  | ManagedCommandOutputTileRef
  | BrowserSessionTileRef
  | null {
  if (source.kind === SIDEBAR_NODE_DND_TYPE) {
    const handle = getOpenEpicRegistry().peek(source.epicId);
    if (handle === null) return null;
    // The payload's host, never the app-wide one. The sidebar producers stamp
    // the Epic SESSION's host (or the row's owner host) into `source.hostId`
    // precisely because chats and artifacts carry no intrinsic host id, and
    // the ref minted here is bound for life: this root provider mounts at the
    // app shell, so during an A->B re-point the app-wide client already
    // answers B while the dragged row still belongs to the A-backed Epic.
    return epicNodeRefForNodeId(
      handle.store.getState(),
      source.nodeId,
      source.hostId,
    );
  }
  if (source.kind === TERMINAL_TILE_DND_TYPE) return source.tile;
  if (source.kind === BROWSER_TILE_DND_TYPE) return source.tile;
  if (source.kind === GIT_DIFF_TILE_DND_TYPE) return source.tile;
  // The ref was minted at the menu row; the drop dedupes on its content id
  // (the command id), so an already-open output window moves rather than
  // doubling.
  if (source.kind === MANAGED_COMMAND_OUTPUT_DND_TYPE) return source.tile;
  if (source.kind === WORKSPACE_FILE_DND_TYPE) return source.ref;
  if (source.kind === CHAT_ARTIFACT_DND_TYPE) {
    // Mint a FRESH instanceId per call (constraint C2): the payload carries
    // artifact identity only, so two drags of the same card never reuse an
    // instanceId and collide in `tilesByInstanceId`.
    return makeOpenableNodeRef({ ...source.artifact, instanceId: uuidv4() });
  }
  if (source.kind === ACTIVE_AGENT_DND_TYPE) {
    // The payload preserves the agent's bound host; never substitute the app's
    // currently selected host for a chat or terminal-agent tile.
    return makeOpenableNodeRef({ ...source.agent, instanceId: uuidv4() });
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
  return getEpicCanvasDropPreview(
    target,
    targetRect,
    point,
    source.kind === ARTIFACT_TAB_DND_TYPE,
  );
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
  navigateNested: NavigateNestedFocus,
): boolean {
  if (preview.kind === "empty-shell") return false;
  const canvasStore = useEpicCanvasStore.getState();
  if (preview.kind === "artifact-tab-strip") {
    navigateNested(source.epicId, source.viewTabId, () =>
      canvasStore.prepareMoveActiveTabOnTabStripFocusTarget(source.viewTabId, {
        sourcePaneId: source.sourceGroupId,
        tabId: source.tabId,
        targetPaneId: preview.groupId,
        targetIndex: preview.index,
      }),
    );
    return true;
  }
  if (
    preview.kind === "artifact-tab-group-body" &&
    preview.position === "center"
  ) {
    navigateNested(source.epicId, source.viewTabId, () =>
      canvasStore.prepareMoveActiveTabOnTabStripFocusTarget(source.viewTabId, {
        sourcePaneId: source.sourceGroupId,
        tabId: source.tabId,
        targetPaneId: preview.groupId,
        targetIndex:
          target.kind === "artifact-tab-group-body" ? target.tabCount : 0,
      }),
    );
    return true;
  }
  if (
    preview.kind === "artifact-tab-group-body" &&
    preview.position !== "center"
  ) {
    const position = preview.position;
    navigateNested(source.epicId, source.viewTabId, () =>
      canvasStore.prepareSplitPaneWithTabFocusTarget(source.viewTabId, {
        sourcePaneId: source.sourceGroupId,
        tabId: source.tabId,
        targetPaneId: preview.groupId,
        position,
      }),
    );
    return true;
  }
  return false;
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
  resolved: {
    readonly epicId: string;
    readonly tile:
      | EpicNodeRef
      | GitDiffTileRef
      | ManagedCommandOutputTileRef
      | BrowserSessionTileRef;
    readonly target: EpicCanvasDropTargetData;
    readonly preview: NonNullable<EpicCanvasDropPreview>;
  },
  navigateNested: NavigateNestedFocus,
): boolean {
  const { epicId, tile, target, preview } = resolved;
  if (
    preview.kind === "left-panel-rail" ||
    preview.kind === "left-panel-rail-list" ||
    preview.kind === "left-panel-section"
  ) {
    return false;
  }
  const canvasStore = useEpicCanvasStore.getState();
  if (preview.kind === "empty-shell") {
    if (target.kind !== "empty-shell") return false;
    navigateNested(epicId, target.viewTabId, () =>
      canvasStore.prepareOpenTileInTabFocusTarget(target.viewTabId, tile),
    );
    return true;
  }
  if (target.kind === "empty-shell") return false;
  if (
    target.kind === "left-panel-rail-item" ||
    target.kind === "left-panel-rail-list" ||
    target.kind === "left-panel-group"
  ) {
    return false;
  }
  if (preview.kind === "artifact-tab-strip") {
    navigateNested(epicId, target.viewTabId, () =>
      canvasStore.prepareInsertNodeOnTabStripFocusTarget(
        target.viewTabId,
        preview.groupId,
        preview.index,
        tile,
      ),
    );
    return true;
  }
  if (preview.position === "center") {
    navigateNested(epicId, target.viewTabId, () =>
      canvasStore.prepareInsertNodeOnTabStripFocusTarget(
        target.viewTabId,
        preview.groupId,
        target.kind === "artifact-tab-group-body" ? target.tabCount : 0,
        tile,
      ),
    );
    return true;
  }
  const position = preview.position;
  navigateNested(epicId, target.viewTabId, () =>
    canvasStore.prepareSplitPaneWithNodeFocusTarget(
      target.viewTabId,
      preview.groupId,
      position,
      tile,
    ),
  );
  return true;
}

export function commitResolvedCanvasDrop(
  drop: ResolvedEpicCanvasDrop,
  navigateNested: NavigateNestedFocus,
): boolean {
  if (drop.preview === null) return false;
  if (!isCanvasDropCompatible(drop.source, drop.target)) return false;
  if (drop.source.kind === ARTIFACT_TAB_DND_TYPE) {
    return commitArtifactTabDrop(
      drop.source,
      drop.target,
      drop.preview,
      navigateNested,
    );
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
      return true;
    }
    return false;
  }
  const tile = sourceToTileRef(drop.source);
  if (tile !== null) {
    return placeResolvedCanvasTile(
      {
        epicId: drop.source.epicId,
        tile,
        target: drop.target,
        preview: drop.preview,
      },
      navigateNested,
    );
  }
  return false;
}

export interface HeaderStripDropResult {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Drop of a canvas source onto the header tab strip. An existing artifact
 * tab tears off into a fresh header tab (MOVE semantics: `tearOffTabIntoNew
 * HeaderTab` preserves the tile's own instanceId, only the new header tab
 * record gets a fresh id; sidebar state is copied); every other openable
 * source opens in a new header tab at the insertion index. Returns the new
 * header tab for navigation.
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
  /**
   * The app's query client, handed in by the DnD provider (this module is
   * imperative and has no hook context). A reparent that goes through the
   * host RPC invalidates the moved node's record query on success, exactly
   * as the hook-based chat mutations do - without it a successful drop on a
   * host whose push stream is disconnected or unsupported sat under its old
   * parent until the next 20s poll.
   */
  readonly queryClient: QueryClient;
}

/**
 * Whether this node's parent pointer still lives in the epic Y.Doc rather than
 * on the host's record plane.
 *
 * Only terminal agents can answer yes. A migrated host serves its own rows
 * through `epic.listTuiAgents` AND evicts their doc entries, so a terminal
 * agent that is absent from the record slice is one whose binding host has not
 * migrated - either it predates `epic.listTuiAgents` entirely, or it is a
 * foreign binding host whose entries this host only relays. Both keep their
 * pointer in the doc, and both predate the `epic.reparentChat` terminal-agent
 * arm, so routing them to the RPC would hand an already-released `@1.0` a
 * `chatId` naming no chat: a host error where the doc write used to work.
 *
 * Chats never answer yes. `epic.reparentChat@1.0` has routed chats since
 * chats-off-YJS, and the host resolves a pre-migration chat through the same
 * storage seam, so the RPC is correct for a chat on every host that has the
 * method at all.
 *
 * ## ABSENCE STOPPED BEING THE TEST at `epic.listTuiAgents@1.1`
 *
 * "Absent from the record slice" was a sound proxy only while the record slice
 * was registry-only. `@1.1` serves the doc-resident remainder too - it has to,
 * because `epic.subscribe@2` has no doc replica to union those agents in from
 * - so a foreign-bound agent now ARRIVES as a record and absence goes quiet.
 *
 * Read literally, this function would then answer `false` for exactly the
 * agents it exists to catch, and route them to `epic.reparentChat` with an id
 * naming no registry chat: the host error described above, reintroduced by a
 * change that was fixing a different symptom. The row carries `docResident`
 * precisely so the distinction survives the union, and both tests are kept -
 * absence still covers a `@1.0` host, which sends no marker at all.
 */
function isDocOnlyTerminalAgent(
  state: OpenEpicState,
  node: ProjectedReparentNode,
): boolean {
  if (node.type !== "terminal-agent") return false;
  // Read the UNION, not the record slice. Absence from `tuiAgentRecords` is
  // still a doc-only tell on a `@1.0` host, but it is the union that holds
  // every agent the user can actually grab, and its `docResident` answers for
  // both planes on every host version.
  //
  // `Object.hasOwn` rather than an `=== undefined` compare, for the same
  // reason the record-slice version used it: `byId` is a `Record<string, T>`,
  // so indexing it types as `T` even though a miss is plainly reachable here
  // - a node id the union does not carry. The undefined check is unreachable
  // to the type system and reachable at runtime, which is exactly the shape
  // `no-unnecessary-condition` refuses to let through.
  const byId = state.tuiAgents.byId;
  if (!Object.hasOwn(byId, node.id)) return true;
  return byId[node.id].docResident;
}

/**
 * Imperative reparent commit for a `sidebar-node` released on a reparent
 * target. Resolves the live epic session via the registry (`peek`, never
 * `acquire`), RE-RUNS `canReparent` against the projected tree (Decision D:
 * this closes the drag-over→drag-end TOCTOU), then persists:
 *   - registry-backed agents → `epic.reparentChat`, under an optimistic
 *     overlay patch (`beginReparentMutation`) so the row moves at drop time
 *     rather than a record round-trip later
 *   - artifacts → local `reparentArtifact` (Y stream) **and**
 *     `epic.reparentArtifact` (host cloud-sync / the persist path that
 *     survives dropping the doc arm). Dual-write is safe: host `update()`
 *     skips `validateReparent` when `parentId` is already the target, then
 *     LWW-sets the same value (same shape as `epic.renameArtifact`).
 *   - doc-only terminal agents → local `reparentArtifact` only (Q1)
 * Silent no-op when the session is gone or the re-check fails - matching
 * the "invalid drop = silent cancel" rule.
 *
 * `reparentArtifact` can still throw, and this file does not assume it cannot.
 * Task 4.3 moved the store's own validation onto the SAME projected evaluator
 * the gate above uses, so a rejection here would mean two reads of one tree
 * disagreed - which nothing enforces. The throw is caught in the doc-write
 * branch below, and `handleDragEnd` additionally ends the drag in a `finally`
 * so no future escape from this function can strand the session.
 */
export function commitSidebarReparentDrop(
  input: SidebarReparentDropInput,
): void {
  const handle = getOpenEpicRegistry().peek(input.epicId);
  if (handle === null) return;
  // Evaluated against the PROJECTED tree, not the doc maps: a registry-backed
  // chat or terminal agent has no doc entry, and the doc evaluator would call
  // a row the user is plainly dragging `missing-node`. See
  // `reparent-projection-rules.ts`.
  const state = handle.store.getState();
  const evaluation = canReparentProjected(
    state.tree,
    input.sourceNodeId,
    input.newParentId,
  );
  if (!evaluation.ok) return;
  // A root (un-nest) drop is family-agnostic at the tree level, so the
  // evaluation alone permits it. Mirror the preview's panel-family gate here
  // too so a cross-panel empty-space drop is a silent no-op (matching the
  // no-highlight preview), not an un-nest into the wrong panel.
  if (
    input.newParentId === null &&
    evaluation.node.family !== PANEL_NODE_FAMILY[input.panelId]
  ) {
    return;
  }
  if (
    evaluation.node.family === "agent" &&
    !isDocOnlyTerminalAgent(state, evaluation.node)
  ) {
    // The agent family's parent pointer lives on the HOST's record (chat
    // registry row, or the terminal agent's tenant row), not on the doc: a
    // doc write would land on an entry that no longer exists or, for a
    // pre-migration entry, lose to the row in the union. `epic.reparentChat`
    // routes by id on the host - a chat or a terminal agent alike - and the
    // record channel (push delta, else the poll) brings the moved pointer
    // back into the tree. Refusals (`E_AGENT_NOT_LOCAL` for a row another
    // host owns) are the host's answer and are surfaced as a toast, the same
    // way the hook-based chat mutations surface theirs.
    const client = getEpicSessionHandleHostClient(handle);
    if (client === null) return;
    const sessionHostId = getEpicSessionHandleHostId(handle);
    const movedNodeType = evaluation.node.type;
    // The optimistic overlay (Phase 1.1): a registry-backed row has no doc
    // entry, so without this the drop had no local feedback and the node sat
    // under its old parent until the record round-trip - the one branch of
    // this commit that was pure RPC. `begin` re-evaluates against the same
    // projected tree the gate above read, synchronously, so it cannot refuse
    // a move that gate accepted; `null` (same parent, viewer) makes retire a
    // no-op.
    const requestId = handle.store
      .getState()
      .beginReparentMutation(input.sourceNodeId, input.newParentId);
    const retire = (outcome: "landed" | "failed"): void => {
      if (requestId === null) return;
      handle.store.getState().retirePendingMutation(requestId, outcome);
    };
    void client
      .request("epic.reparentChat", {
        epicId: input.epicId,
        chatId: input.sourceNodeId,
        newParentId: input.newParentId,
      })
      .then(() => {
        // The commit landed in the host's registry. The push stream brings
        // the moved pointer back when it is live; when it is disconnected,
        // unsupported, or (for a terminal agent) negotiated below @1.1, only
        // the 20s poll would - so re-ask now, the way every hook-based record
        // mutation does on success. Scoped to the session's host: that is
        // the client the request was sent on.
        //
        // "landed" keeps the overlay patch applied until the refreshed rows
        // actually arrive - the ack is proof the host holds the new parent -
        // so the row never snaps back under the old one while the refetch
        // (or, on a refetch failure, the next poll) is in flight. The
        // projection's dead sweep forgets the stamp once the row catches up.
        if (movedNodeType === "terminal-agent") {
          invalidateEpicTuiAgentRecords(input.queryClient, sessionHostId);
        } else {
          invalidateEpicChatRecords(input.queryClient, sessionHostId);
        }
        retire("landed");
      })
      .catch((error: unknown) => {
        retire("failed");
        toastFromHostError(
          toHostRpcError(error, "epic.reparentChat"),
          "Couldn't move this agent.",
        );
      });
  } else {
    // Artifacts, whose pointer has always lived in the doc - and the one
    // agent-family case that still does, a doc-only terminal agent. The Y
    // write stays until the doc arm dies; artifacts additionally dual-write
    // `epic.reparentArtifact` so persist does not depend on that arm.
    // Doc-only TUI stays Y-only until listTuiAgents is on the floor (Q1):
    // this RPC names an artifact id, not a tuiAgents map entry.
    // As of task 4.3 `reparentArtifact` validates against the PROJECTED TREE
    // too - the same `evaluateProjectedReparent` the gate above called, on the
    // same `state.tree`, reached synchronously with nothing able to mutate it
    // in between. So the pairing that used to wedge a drag session:
    //
    //   a doc-only terminal agent  ->  dropped onto a RECORD-BACKED chat
    //
    // now commits. Both nodes are in the projected tree, same family, no cycle;
    // the parent's missing DOC entry no longer decides anything, because the
    // write resolves the dragged NODE's entry and the parent is only a value
    // being written.
    //
    // The catch stays. "Both callers use one evaluator on one tree" is a
    // property of this file's current control flow, not an invariant anything
    // checks - one `await` introduced above, or one caller that reads the tree
    // earlier and passes it down, reopens the gap. 4.3a is the record of what
    // that gap costs: an uncaught throw escaped `handleDragEnd` before
    // `dragEnded()` ran and left a dead sidebar until remount, from one
    // ordinary drop. The guard is a branch; the failure is unrecoverable
    // without a remount.
    //
    // A rejection is logged, never toasted: an invalid drop is a silent cancel
    // by this file's own rule, and two reads of one tree disagreeing is an
    // internal invariant mismatch the user cannot act on.
    let mutated = false;
    try {
      mutated = handle.store
        .getState()
        .reparentArtifact(input.sourceNodeId, input.newParentId);
    } catch (error: unknown) {
      appLogger.error(
        "[epic-dnd] doc reparent rejected after the projected gate passed",
        {
          epicId: input.epicId,
          sourceNodeId: input.sourceNodeId,
          newParentId: input.newParentId,
          nodeType: evaluation.node.type,
        },
        error,
      );
      return;
    }
    if (mutated && evaluation.node.family === "artifact") {
      const artifactClient = getEpicSessionHandleHostClient(handle);
      if (artifactClient !== null) {
        void artifactClient
          .request("epic.reparentArtifact", {
            epicId: input.epicId,
            artifactId: input.sourceNodeId,
            newParentId: input.newParentId,
          })
          .catch((error: unknown) => {
            toastFromHostError(
              toHostRpcError(error, "epic.reparentArtifact"),
              "Couldn't move this artifact.",
            );
          });
      }
    }
  }
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
