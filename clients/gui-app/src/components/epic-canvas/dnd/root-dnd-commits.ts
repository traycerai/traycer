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
  CHAT_ARTIFACT_DND_TYPE,
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
  return (
    source?.kind === ARTIFACT_TAB_DND_TYPE ||
    source?.kind === SIDEBAR_NODE_DND_TYPE ||
    source?.kind === TERMINAL_TILE_DND_TYPE ||
    source?.kind === GIT_DIFF_TILE_DND_TYPE ||
    source?.kind === WORKSPACE_FILE_DND_TYPE ||
    source?.kind === CHAT_ARTIFACT_DND_TYPE ||
    source?.kind === ACTIVE_AGENT_DND_TYPE ||
    source?.kind === MANAGED_COMMAND_OUTPUT_DND_TYPE
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
): EpicNodeRef | GitDiffTileRef | ManagedCommandOutputTileRef | null {
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
  navigateNested: NavigateNestedFocus,
): void {
  if (preview.kind === "empty-shell") return;
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
  resolved: {
    readonly epicId: string;
    readonly tile: EpicNodeRef | GitDiffTileRef | ManagedCommandOutputTileRef;
    readonly target: EpicCanvasDropTargetData;
    readonly preview: NonNullable<EpicCanvasDropPreview>;
  },
  navigateNested: NavigateNestedFocus,
): void {
  const { epicId, tile, target, preview } = resolved;
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
    navigateNested(epicId, target.viewTabId, () =>
      canvasStore.prepareOpenTileInTabFocusTarget(target.viewTabId, tile),
    );
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
    navigateNested(epicId, target.viewTabId, () =>
      canvasStore.prepareInsertNodeOnTabStripFocusTarget(
        target.viewTabId,
        preview.groupId,
        preview.index,
        tile,
      ),
    );
    return;
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
    return;
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
}

export function commitResolvedCanvasDrop(
  drop: ResolvedEpicCanvasDrop,
  navigateNested: NavigateNestedFocus,
): void {
  if (drop.preview === null) return;
  if (!isCanvasDropCompatible(drop.source, drop.target)) return;
  if (drop.source.kind === ARTIFACT_TAB_DND_TYPE) {
    commitArtifactTabDrop(
      drop.source,
      drop.target,
      drop.preview,
      navigateNested,
    );
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
    placeResolvedCanvasTile(
      {
        epicId: drop.source.epicId,
        tile,
        target: drop.target,
        preview: drop.preview,
      },
      navigateNested,
    );
  }
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
 */
function isDocOnlyTerminalAgent(
  state: OpenEpicState,
  node: ProjectedReparentNode,
): boolean {
  return (
    node.type === "terminal-agent" &&
    !Object.hasOwn(state.tuiAgentRecords.byId, node.id)
  );
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
        if (movedNodeType === "terminal-agent") {
          invalidateEpicTuiAgentRecords(input.queryClient, sessionHostId);
        } else {
          invalidateEpicChatRecords(input.queryClient, sessionHostId);
        }
      })
      .catch((error: unknown) => {
        toastFromHostError(
          toHostRpcError(error, "epic.reparentChat"),
          "Couldn't move this agent.",
        );
      });
  } else {
    // Artifacts, whose pointer has always lived in the doc - and the one
    // agent-family case that still does, a doc-only terminal agent. Both are
    // the same Y write they were before the record channel existed; see
    // `isDocOnlyTerminalAgent`.
    handle.store
      .getState()
      .reparentArtifact(input.sourceNodeId, input.newParentId);
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
