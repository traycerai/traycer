import type {
  DropPosition,
  EpicTerminalRef,
  GitDiffTileRef,
  WorkspaceFileRef,
} from "@/stores/epics/canvas/types";
import {
  isGitDiffTileRef,
  isWorkspaceFileRef,
} from "@/stores/epics/canvas/types";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { parseTileRef } from "@/stores/epics/canvas/tile-schema";
import { resolveSplitDropPosition } from "@/components/epic-canvas/dnd/pane-drop-geometry";
import {
  LEFT_PANEL_IDS,
  ROOT_CREATE_PANEL_IDS,
  type LeftPanelId,
  type RootCreatePanelId,
} from "@/stores/epics/left-panel-store";
import type { NodeFamily } from "@/lib/reparent-rules";

/**
 * Each root-create panel owns exactly one node family. Single source of truth
 * for the panel→family mapping shared by the reparent preview gate
 * (`root-dnd-provider`) and the drag-end commit re-check (`root-dnd-commits`),
 * so the two cannot drift.
 */
export const PANEL_NODE_FAMILY: Readonly<
  Record<RootCreatePanelId, NodeFamily>
> = {
  chats: "agent",
  artifacts: "artifact",
};

export const ARTIFACT_TAB_DND_TYPE = "artifact-tab";
export const SIDEBAR_NODE_DND_TYPE = "sidebar-node";
export const TERMINAL_TILE_DND_TYPE = "terminal-tile";
export const GIT_DIFF_TILE_DND_TYPE = "git-diff-tile";
export const WORKSPACE_FILE_DND_TYPE = "workspace-file";
export const CHAT_ARTIFACT_DND_TYPE = "chat-artifact";
export const LEFT_PANEL_RAIL_ITEM_DND_TYPE = "left-panel-rail-item";
export const EPIC_CANVAS_DND_SOURCE_TYPES = [
  ARTIFACT_TAB_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  TERMINAL_TILE_DND_TYPE,
  GIT_DIFF_TILE_DND_TYPE,
  WORKSPACE_FILE_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
];

export interface RectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface PointLike {
  readonly x: number;
  readonly y: number;
}

export interface LeftPanelSectionRect {
  readonly panelId: LeftPanelId;
  readonly rect: RectLike;
}

interface LeftPanelGroupBoundary {
  readonly panelId: LeftPanelId;
  readonly position: Exclude<LeftPanelRailDropPosition, "combine">;
  readonly y: number;
}

/**
 * Every canvas-openable source carries the epic + view-tab it is dragged
 * FROM. The root DndContext lives at the app shell (outside any epic
 * session provider), so commits resolve their epic/tab scope from the
 * payloads instead of from React context.
 */
export interface EpicCanvasArtifactTabDragData {
  readonly kind: typeof ARTIFACT_TAB_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly sourceGroupId: string;
  readonly tabId: string;
  readonly isPreview: boolean;
}

export interface EpicCanvasSidebarNodeDragData {
  readonly kind: typeof SIDEBAR_NODE_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly nodeId: string;
}

export interface EpicCanvasTerminalTileDragData {
  readonly kind: typeof TERMINAL_TILE_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly tile: EpicTerminalRef;
}

export interface EpicCanvasGitDiffTileDragData {
  readonly kind: typeof GIT_DIFF_TILE_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly tile: GitDiffTileRef;
}

export interface EpicCanvasWorkspaceFileDragData {
  readonly kind: typeof WORKSPACE_FILE_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly ref: WorkspaceFileRef;
}

export interface EpicCanvasLeftPanelRailDragData {
  readonly kind: typeof LEFT_PANEL_RAIL_ITEM_DND_TYPE;
  readonly panelId: LeftPanelId;
  readonly origin: "rail" | "panel-section";
}

/**
 * A same-epic artifact reference dragged out of a chat message (a block
 * card or an inline chip). Self-describing: it carries the artifact's
 * IDENTITY so `sourceToTileRef` builds the tile ref directly, with no
 * lookup against the sidebar-tree projection or open-epic registry. No
 * `instanceId` - that is minted per drop at commit time (constraint C2).
 */
export interface EpicCanvasChatArtifactDragData {
  readonly kind: typeof CHAT_ARTIFACT_DND_TYPE;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly artifact: {
    readonly id: string;
    readonly type: EpicArtifactKind;
    readonly name: string;
    readonly hostId: string;
  };
}

export type EpicCanvasDragSourceData =
  | EpicCanvasArtifactTabDragData
  | EpicCanvasSidebarNodeDragData
  | EpicCanvasTerminalTileDragData
  | EpicCanvasGitDiffTileDragData
  | EpicCanvasWorkspaceFileDragData
  | EpicCanvasChatArtifactDragData
  | EpicCanvasLeftPanelRailDragData;

export type LeftPanelRailDropPosition = "before" | "after" | "combine";

/**
 * Canvas drop targets carry the view-tab (and, for the empty shell, the
 * epic) that owns them so the root-level commit can address the right
 * canvas without React context.
 */
export type EpicCanvasDropTargetData =
  | {
      readonly kind: "empty-shell";
      readonly epicId: string;
      readonly viewTabId: string;
    }
  | {
      readonly kind: "artifact-tab";
      readonly viewTabId: string;
      readonly groupId: string;
      readonly tabId: string;
      readonly index: number;
    }
  | {
      readonly kind: "artifact-tab-strip-end";
      readonly viewTabId: string;
      readonly groupId: string;
      readonly index: number;
    }
  | {
      readonly kind: "artifact-tab-group-body";
      readonly viewTabId: string;
      readonly groupId: string;
      readonly tabCount: number;
    }
  | {
      readonly kind: "left-panel-rail-item";
      readonly panelId: LeftPanelId;
    }
  | {
      readonly kind: "left-panel-rail-list";
    }
  | {
      readonly kind: "left-panel-group";
      readonly panelIds: ReadonlyArray<LeftPanelId>;
    }
  | {
      /**
       * A sidebar tree row as a reparent drop target. `nodeId` is the new
       * parent; `panelId` scopes the spring-load `expand(viewTabId, panelId,
       * nodeId)` to the row's tree (chats vs artifacts). Same-family validity
       * is decided by the preview-time `canReparent` pre-flight, NOT here.
       */
      readonly kind: "sidebar-reparent-row";
      readonly epicId: string;
      readonly viewTabId: string;
      readonly nodeId: string;
      readonly panelId: RootCreatePanelId;
    }
  | {
      /** A panel body's empty space → un-nest the dragged node to root. */
      readonly kind: "sidebar-reparent-panel";
      readonly epicId: string;
      readonly viewTabId: string;
      readonly panelId: RootCreatePanelId;
    };

type EpicCanvasLeftPanelDropTargetData =
  | {
      readonly kind: "left-panel-rail-item";
      readonly panelId: LeftPanelId;
    }
  | {
      readonly kind: "left-panel-rail-list";
    }
  | {
      readonly kind: "left-panel-group";
      readonly panelIds: ReadonlyArray<LeftPanelId>;
    };

export type EpicCanvasDropPreview =
  | {
      readonly kind: "artifact-tab-strip";
      readonly groupId: string;
      readonly index: number;
    }
  | {
      readonly kind: "artifact-tab-group-body";
      readonly groupId: string;
      readonly position: DropPosition;
    }
  | {
      readonly kind: "empty-shell";
    }
  | {
      readonly kind: "left-panel-rail";
      readonly panelId: LeftPanelId;
      readonly position: LeftPanelRailDropPosition;
    }
  | {
      readonly kind: "left-panel-rail-list";
    }
  | {
      readonly kind: "left-panel-section";
      readonly panelId: LeftPanelId;
      readonly position: Exclude<LeftPanelRailDropPosition, "combine">;
    }
  | null;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

export function getArtifactTabDragId(groupId: string, tabId: string): string {
  return `artifact-tab:${groupId}:${tabId}`;
}

export function getArtifactTabDropId(groupId: string, tabId: string): string {
  return `artifact-tab-target:${groupId}:${tabId}`;
}

export function getArtifactTabStripEndDropId(groupId: string): string {
  return `artifact-tab-strip-end:${groupId}`;
}

export function getArtifactTabGroupBodyDropId(groupId: string): string {
  return `artifact-tab-group-body:${groupId}`;
}

export function getSidebarNodeDragId(nodeId: string): string {
  return `sidebar-node:${nodeId}`;
}

export function getTerminalTileDragId(sessionId: string): string {
  return `terminal-tile:${sessionId}`;
}

export function getGitDiffTileDragId(tileId: string): string {
  return `git-diff-tile:${tileId}`;
}

export function getWorkspaceFileDragId(fileId: string): string {
  return `workspace-file:${fileId}`;
}

/**
 * The same artifact can appear many times in one thread (repeated update
 * cards, multiple inline mentions), so the drag id keys on a per-occurrence
 * value the caller supplies (a `useId()`), NOT the artifact id - otherwise
 * dnd-kit's registry collides on duplicate ids (constraint C3).
 */
export function getChatArtifactDragId(occurrenceKey: string): string {
  return `chat-artifact:${occurrenceKey}`;
}

export function getLeftPanelRailDragId(panelId: string): string {
  return `left-panel-rail:${panelId}`;
}

export function getLeftPanelSectionDragId(panelId: string): string {
  return `left-panel-section:${panelId}`;
}

export function getLeftPanelRailDropId(panelId: string): string {
  return `left-panel-rail-target:${panelId}`;
}

export function getLeftPanelRailListDropId(epicId: string): string {
  return `left-panel-rail-list-target:${epicId}`;
}

export function getLeftPanelGroupDropId(
  epicId: string,
  panelId: string,
): string {
  return `left-panel-group-target:${epicId}:${panelId}`;
}

export function getEmptyShellDropId(epicId: string, tabId: string): string {
  return `empty-shell:${epicId}:${tabId}`;
}

export function getSidebarReparentRowDropId(nodeId: string): string {
  return `sidebar-reparent-row:${nodeId}`;
}

export function getSidebarReparentPanelDropId(
  panelId: RootCreatePanelId,
): string {
  return `sidebar-reparent-panel:${panelId}`;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isLeftPanelId(value: unknown): value is LeftPanelId {
  return LEFT_PANEL_IDS.some((panelId) => panelId === value);
}

function isRootCreatePanelId(value: unknown): value is RootCreatePanelId {
  return ROOT_CREATE_PANEL_IDS.some((panelId) => panelId === value);
}

function readLeftPanelIds(value: unknown): ReadonlyArray<LeftPanelId> | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return null;
  if (!value.every(isLeftPanelId)) return null;
  if (new Set(value).size !== value.length) return null;
  return value;
}

function isLeftPanelRailDragOrigin(
  value: unknown,
): value is EpicCanvasLeftPanelRailDragData["origin"] {
  return value === "rail" || value === "panel-section";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

interface CanvasSourceScope {
  readonly epicId: string;
  readonly viewTabId: string;
}

function readCanvasSourceScope(
  value: Record<string, unknown>,
): CanvasSourceScope | null {
  if (!isNonEmptyString(value.epicId) || !isNonEmptyString(value.viewTabId)) {
    return null;
  }
  return { epicId: value.epicId, viewTabId: value.viewTabId };
}

function readArtifactTabSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  if (
    scope === null ||
    !isNonEmptyString(value.sourceGroupId) ||
    !isNonEmptyString(value.tabId) ||
    typeof value.isPreview !== "boolean"
  ) {
    return null;
  }
  return {
    kind: ARTIFACT_TAB_DND_TYPE,
    ...scope,
    sourceGroupId: value.sourceGroupId,
    tabId: value.tabId,
    isPreview: value.isPreview,
  };
}

function readSidebarNodeSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  if (scope === null || !isNonEmptyString(value.nodeId)) {
    return null;
  }
  return { kind: SIDEBAR_NODE_DND_TYPE, ...scope, nodeId: value.nodeId };
}

function readGitDiffTileSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  const ref = parseTileRef(value.tile);
  if (scope === null || ref === null || !isGitDiffTileRef(ref)) return null;
  return { kind: GIT_DIFF_TILE_DND_TYPE, ...scope, tile: ref };
}

function readTerminalTileSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  const ref = parseTileRef(value.tile);
  if (scope === null || ref === null || ref.type !== "terminal") return null;
  return { kind: TERMINAL_TILE_DND_TYPE, ...scope, tile: ref };
}

function readWorkspaceFileSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  const ref = parseTileRef(value.ref);
  if (scope === null || ref === null || !isWorkspaceFileRef(ref)) return null;
  return { kind: WORKSPACE_FILE_DND_TYPE, ...scope, ref };
}

function readChatArtifactSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  const scope = readCanvasSourceScope(value);
  if (scope === null || !isRecord(value.artifact)) return null;
  const artifact = value.artifact;
  if (
    !isNonEmptyString(artifact.id) ||
    !isNonEmptyString(artifact.name) ||
    !isNonEmptyString(artifact.hostId) ||
    typeof artifact.type !== "string" ||
    !isEpicArtifactKind(artifact.type)
  ) {
    return null;
  }
  return {
    kind: CHAT_ARTIFACT_DND_TYPE,
    ...scope,
    artifact: {
      id: artifact.id,
      type: artifact.type,
      name: artifact.name,
      hostId: artifact.hostId,
    },
  };
}

function readLeftPanelRailItemSource(
  value: Record<string, unknown>,
): EpicCanvasDragSourceData | null {
  if (!isLeftPanelId(value.panelId)) return null;
  if (!isLeftPanelRailDragOrigin(value.origin)) return null;
  return {
    kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
    panelId: value.panelId,
    origin: value.origin,
  };
}

export function readEpicCanvasDragSourceData(
  value: unknown,
): EpicCanvasDragSourceData | null {
  if (!isRecord(value)) return null;
  if (value.kind === ARTIFACT_TAB_DND_TYPE) return readArtifactTabSource(value);
  if (value.kind === SIDEBAR_NODE_DND_TYPE) return readSidebarNodeSource(value);
  if (value.kind === TERMINAL_TILE_DND_TYPE)
    return readTerminalTileSource(value);
  if (value.kind === GIT_DIFF_TILE_DND_TYPE)
    return readGitDiffTileSource(value);
  if (value.kind === WORKSPACE_FILE_DND_TYPE)
    return readWorkspaceFileSource(value);
  if (value.kind === CHAT_ARTIFACT_DND_TYPE)
    return readChatArtifactSource(value);
  if (value.kind === LEFT_PANEL_RAIL_ITEM_DND_TYPE)
    return readLeftPanelRailItemSource(value);
  return null;
}

export function readEpicCanvasDropTargetData(
  value: unknown,
): EpicCanvasDropTargetData | null {
  if (!isRecord(value)) return null;
  if (value.kind === "empty-shell") {
    if (!isNonEmptyString(value.epicId) || !isNonEmptyString(value.viewTabId)) {
      return null;
    }
    return {
      kind: "empty-shell",
      epicId: value.epicId,
      viewTabId: value.viewTabId,
    };
  }
  const sidebarReparentTarget = readSidebarReparentDropTargetData(value);
  if (sidebarReparentTarget !== null) return sidebarReparentTarget;
  const leftPanelTarget = readLeftPanelDropTargetData(value);
  if (leftPanelTarget !== null) return leftPanelTarget;
  if (!isNonEmptyString(value.groupId) || !isNonEmptyString(value.viewTabId)) {
    return null;
  }

  if (value.kind === "artifact-tab") {
    if (!isNonEmptyString(value.tabId) || !isNonNegativeInteger(value.index)) {
      return null;
    }
    return {
      kind: "artifact-tab",
      viewTabId: value.viewTabId,
      groupId: value.groupId,
      tabId: value.tabId,
      index: value.index,
    };
  }

  if (value.kind === "artifact-tab-strip-end") {
    if (!isNonNegativeInteger(value.index)) return null;
    return {
      kind: "artifact-tab-strip-end",
      viewTabId: value.viewTabId,
      groupId: value.groupId,
      index: value.index,
    };
  }

  if (value.kind === "artifact-tab-group-body") {
    if (!isNonNegativeInteger(value.tabCount)) return null;
    return {
      kind: "artifact-tab-group-body",
      viewTabId: value.viewTabId,
      groupId: value.groupId,
      tabCount: value.tabCount,
    };
  }

  return null;
}

type EpicCanvasSidebarReparentDropTargetData = Extract<
  EpicCanvasDropTargetData,
  { readonly kind: "sidebar-reparent-row" | "sidebar-reparent-panel" }
>;

function readSidebarReparentDropTargetData(
  value: Record<string, unknown>,
): EpicCanvasSidebarReparentDropTargetData | null {
  if (
    value.kind !== "sidebar-reparent-row" &&
    value.kind !== "sidebar-reparent-panel"
  ) {
    return null;
  }
  if (
    !isNonEmptyString(value.epicId) ||
    !isNonEmptyString(value.viewTabId) ||
    !isRootCreatePanelId(value.panelId)
  ) {
    return null;
  }
  if (value.kind === "sidebar-reparent-row") {
    if (!isNonEmptyString(value.nodeId)) return null;
    return {
      kind: "sidebar-reparent-row",
      epicId: value.epicId,
      viewTabId: value.viewTabId,
      nodeId: value.nodeId,
      panelId: value.panelId,
    };
  }
  return {
    kind: "sidebar-reparent-panel",
    epicId: value.epicId,
    viewTabId: value.viewTabId,
    panelId: value.panelId,
  };
}

function readLeftPanelDropTargetData(
  value: Record<string, unknown>,
): EpicCanvasLeftPanelDropTargetData | null {
  if (value.kind === "left-panel-rail-item") {
    if (!isLeftPanelId(value.panelId)) return null;
    return {
      kind: "left-panel-rail-item",
      panelId: value.panelId,
    };
  }
  if (value.kind === "left-panel-rail-list") {
    return {
      kind: "left-panel-rail-list",
    };
  }
  if (value.kind === "left-panel-group") {
    const panelIds = readLeftPanelIds(value.panelIds);
    if (panelIds === null) return null;
    return {
      kind: "left-panel-group",
      panelIds,
    };
  }
  return null;
}

/** Edge-side drop positions - the four half-splits (canonical in tile-tree.ts). */
export type { EdgeDropPosition } from "@/stores/epics/canvas/types";

/**
 * Drop-zone detection over a pane body. Delegates to the paseo-ported
 * 15%-edge / 40%-center hit testing (`pane-drop-geometry.ts`). Never
 * returns `null` - every point inside the group's body resolves to one of
 * the five zones.
 */
export function getEdgeDropPositionFromPoint(
  point: PointLike,
  rect: RectLike,
): DropPosition {
  return resolveSplitDropPosition({
    width: rect.width,
    height: rect.height,
    x: point.x - rect.left,
    y: point.y - rect.top,
  });
}

export function getArtifactTabDropIndexFromPoint(
  target: EpicCanvasDropTargetData,
  rect: RectLike | null,
  pointerX: number,
): number | null {
  if (target.kind === "empty-shell") return null;
  if (target.kind === "artifact-tab-group-body") return null;
  if (target.kind === "left-panel-rail-item") return null;
  if (target.kind === "left-panel-rail-list") return null;
  if (target.kind === "left-panel-group") return null;
  if (target.kind === "sidebar-reparent-row") return null;
  if (target.kind === "sidebar-reparent-panel") return null;
  if (target.kind === "artifact-tab-strip-end") return target.index;
  if (rect === null) return target.index;
  if (pointerX < rect.left + rect.width / 2) return target.index;
  return target.index + 1;
}

export function getLeftPanelRailDropPositionFromPoint(
  point: PointLike,
  rect: RectLike | null,
): LeftPanelRailDropPosition {
  if (rect === null) return "combine";
  const y = point.y - rect.top;
  if (y < rect.height * 0.3) return "before";
  if (y > rect.height * 0.7) return "after";
  return "combine";
}

function getRectBottom(rect: RectLike): number {
  return rect.top + rect.height;
}

function makeLeftPanelGroupBoundary(
  panelId: LeftPanelId,
  position: Exclude<LeftPanelRailDropPosition, "combine">,
  y: number,
): LeftPanelGroupBoundary {
  return {
    panelId,
    position,
    y,
  };
}

export function getLeftPanelGroupDropPreview(
  target: Extract<
    EpicCanvasDropTargetData,
    { readonly kind: "left-panel-group" }
  >,
  sectionRects: ReadonlyArray<LeftPanelSectionRect>,
  point: PointLike,
): EpicCanvasDropPreview {
  const orderedSections = target.panelIds.flatMap((panelId) => {
    const section = sectionRects.find((item) => item.panelId === panelId);
    return section === undefined ? [] : [section];
  });
  const firstSection = orderedSections.at(0);
  const lastSection = orderedSections.at(-1);
  if (firstSection === undefined || lastSection === undefined) return null;

  const boundaries: ReadonlyArray<LeftPanelGroupBoundary> = [
    makeLeftPanelGroupBoundary(
      firstSection.panelId,
      "before",
      firstSection.rect.top,
    ),
    ...orderedSections.slice(1).map((section, sectionIndex) => {
      const previousSection = orderedSections[sectionIndex];
      return makeLeftPanelGroupBoundary(
        section.panelId,
        "before",
        (getRectBottom(previousSection.rect) + section.rect.top) / 2,
      );
    }),
    makeLeftPanelGroupBoundary(
      lastSection.panelId,
      "after",
      getRectBottom(lastSection.rect),
    ),
  ];
  const nearestBoundary = boundaries.reduce((nearest, boundary) =>
    Math.abs(boundary.y - point.y) < Math.abs(nearest.y - point.y)
      ? boundary
      : nearest,
  );
  return {
    kind: "left-panel-section",
    panelId: nearestBoundary.panelId,
    position: nearestBoundary.position,
  };
}

export function getEpicCanvasDropPreview(
  target: EpicCanvasDropTargetData,
  rect: RectLike | null,
  point: PointLike,
): EpicCanvasDropPreview {
  if (target.kind === "empty-shell") {
    return {
      kind: "empty-shell",
    };
  }
  if (target.kind === "artifact-tab-group-body") {
    return {
      kind: "artifact-tab-group-body",
      groupId: target.groupId,
      position:
        rect === null ? "center" : getEdgeDropPositionFromPoint(point, rect),
    };
  }
  if (target.kind === "left-panel-rail-item") {
    return {
      kind: "left-panel-rail",
      panelId: target.panelId,
      position: getLeftPanelRailDropPositionFromPoint(point, rect),
    };
  }
  if (target.kind === "left-panel-rail-list") {
    return {
      kind: "left-panel-rail-list",
    };
  }
  if (target.kind === "left-panel-group") return null;
  // Sidebar reparent targets render their own row/panel highlight (via the
  // dnd-store reparent selectors), never a canvas drop preview.
  if (target.kind === "sidebar-reparent-row") return null;
  if (target.kind === "sidebar-reparent-panel") return null;
  return {
    kind: "artifact-tab-strip",
    groupId: target.groupId,
    index: getArtifactTabDropIndexFromPoint(target, rect, point.x) ?? 0,
  };
}
