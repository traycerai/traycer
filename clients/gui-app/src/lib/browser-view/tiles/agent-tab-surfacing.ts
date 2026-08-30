import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { collectPanes, findPaneById } from "@/stores/epics/canvas/tile-tree";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  isBrowserSessionTileRef,
  type EpicCanvasState,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import { convertBrowserTabToPip, getPipSnapshot } from "../pip/pip-store";
import {
  useSettingsStore,
  type AgentTabSurfacingMode,
} from "@/stores/settings/settings-store";

type AgentTabSurfacableAction = "float" | "tile" | "suppress";

type AgentTabSuppressReason =
  | "mode-off"
  | "manual-pip-active"
  | "pip-epic-hidden";

interface AgentTabDisposition {
  readonly action: AgentTabSurfacableAction;
  readonly suppressReason: AgentTabSuppressReason | null;
}

/**
 * Pure decision table. Contract:
 * - `off` suppresses presentation only. Electron tab creation and its ready
 *   acknowledgement remain part of the host-owned lifecycle transaction.
 * - `pip` floats the tab unless the user converted a PiP manually (never
 *   stomp explicit user intent) or the epic surface is hidden (a floating
 *   overlay nobody can see arms nothing); both fall back to suppression.
 *   An existing AGENT-origin PiP is replaced latest-wins.
 * - `tile` always places a canvas tile, even in a hidden epic: layout
 *   mutations are fine where an overlay would be invisible.
 */
export function decideAgentTabDisposition(input: {
  readonly mode: AgentTabSurfacingMode;
  readonly epicVisible: boolean;
  readonly manualPipActive: boolean;
}): AgentTabDisposition {
  if (input.mode === "off") {
    return { action: "suppress", suppressReason: "mode-off" };
  }
  if (input.mode === "tile") return { action: "tile", suppressReason: null };
  if (input.manualPipActive) {
    return { action: "suppress", suppressReason: "manual-pip-active" };
  }
  if (!input.epicVisible) {
    return { action: "suppress", suppressReason: "pip-epic-hidden" };
  }
  return { action: "float", suppressReason: null };
}

/**
 * Per-window registry of which epic surfaces are currently visible. Epic
 * surfaces stay mounted (retained) while their route is inactive, so mount
 * state alone cannot answer visibility; `EpicSurface` reports its
 * `activity.visible` here instead.
 */
const visibleEpicSurfaces = new Set<string>();

export function setEpicSurfaceVisibility(
  epicId: string,
  visible: boolean,
): void {
  if (visible) visibleEpicSurfaces.add(epicId);
  else visibleEpicSurfaces.delete(epicId);
}

export function isEpicSurfaceVisible(epicId: string): boolean {
  return visibleEpicSurfaces.has(epicId);
}

/** A manual (user-initiated) conversion must never be stomped by the agent. */
export function isManualPipActive(epicId: string): boolean {
  const snapshot = getPipSnapshot(epicId);
  return (
    snapshot.target?.origin === "manual" ||
    snapshot.pendingTarget?.origin === "manual"
  );
}

function trackAgentTabSurfaced(disposition: AgentTabDisposition): void {
  Analytics.getInstance().track(AnalyticsEvent.AgentTabSurfaced, {
    disposition: disposition.action,
    disposition_reason: disposition.suppressReason,
  });
}

// ---------------------------------------------------------------------------
// Canvas placement
// ---------------------------------------------------------------------------

/**
 * The pane that already hosts a canvas tile of `sessionId`, if any. Used for
 * smart grouping: consecutive agent opens of one session become tabs of that
 * session's pane instead of spawning a fresh split per open.
 */
export function findPaneIdHostingSessionTile(
  canvas: EpicCanvasState,
  sessionId: string,
): string | null {
  if (canvas.root === null) return null;
  const paneIdByInstanceId = new Map<string, string>();
  for (const pane of collectPanes(canvas.root)) {
    for (const instanceId of pane.tabInstanceIds) {
      paneIdByInstanceId.set(instanceId, pane.id);
    }
  }
  for (const tile of Object.values(canvas.tilesByInstanceId)) {
    if (tile === undefined) continue;
    if (!isBrowserSessionTileRef(tile) || tile.sessionId !== sessionId) {
      continue;
    }
    const paneId = paneIdByInstanceId.get(tile.instanceId);
    if (paneId !== undefined) return paneId;
  }
  return null;
}

function firstViewTabIdForEpic(epicId: string): string | null {
  for (const [tabId, tab] of Object.entries(
    useEpicCanvasStore.getState().tabsById,
  )) {
    if (tab !== undefined && tab.epicId === epicId) return tabId;
  }
  return null;
}

/**
 * Split-mode canvas placement: when a pane already hosts a tile of
 * `sessionId`, the new tile becomes a focused tab there (smart grouping);
 * otherwise it splits in right of the active pane. Returns false only when no
 * anchor resolves.
 */
function placeTileGroupedBySession(args: {
  readonly viewTabId: string;
  readonly canvas: EpicCanvasState;
  readonly tile: EpicCanvasTileRef;
  readonly sessionId: string;
}): boolean {
  const store = useEpicCanvasStore.getState();
  const groupedPaneId = findPaneIdHostingSessionTile(
    args.canvas,
    args.sessionId,
  );
  if (groupedPaneId !== null) {
    store.openTileInPane(args.viewTabId, groupedPaneId, args.tile);
    return true;
  }
  const anchorPaneId =
    args.canvas.activePaneId ??
    collectPanes(args.canvas.root).at(0)?.id ??
    null;
  if (
    anchorPaneId === null ||
    findPaneById(args.canvas.root, anchorPaneId) === null
  ) {
    return false;
  }
  store.splitPaneWithNode(args.viewTabId, anchorPaneId, "right", args.tile);
  // Depth cap exceeded or lost race: fill into the anchor pane instead of
  // dropping the tab entirely.
  const nextCanvas =
    useEpicCanvasStore.getState().canvasByTabId[args.viewTabId];
  if (nextCanvas?.tilesByInstanceId[args.tile.instanceId] === undefined) {
    store.openTileInPane(args.viewTabId, anchorPaneId, args.tile);
  }
  return true;
}

/**
 * Split-mode placement for a host-owned Electron tab. The canvas stores only
 * the durable host/session/tab pointer; native incarnation and surfaces remain
 * renderer lifecycle state. Same-session tabs group in one pane.
 */
export function placeAgentTabTile(request: {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): boolean {
  const viewTabId = firstViewTabIdForEpic(request.epicId);
  if (viewTabId === null) return false;
  const store = useEpicCanvasStore.getState();
  const canvas = store.canvasByTabId[viewTabId];
  if (canvas === undefined || canvas.root === null) return false;
  return placeTileGroupedBySession({
    viewTabId,
    canvas,
    tile: makeBrowserSessionTileRef({
      hostId: request.hostId,
      sessionId: request.sessionId,
      tabId: request.tabId,
    }),
    sessionId: request.sessionId,
  });
}

export function surfaceAgentTab(input: {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): void {
  const disposition = decideAgentTabDisposition({
    mode: useSettingsStore.getState().agentTabSurfacingMode,
    epicVisible: isEpicSurfaceVisible(input.epicId),
    manualPipActive: isManualPipActive(input.epicId),
  });
  trackAgentTabSurfaced(disposition);
  if (disposition.action === "suppress") return;
  if (disposition.action === "tile") {
    placeAgentTabTile(input);
    return;
  }
  // Silent on failure by design: a failed auto-PiP leaves the tab reachable
  // via the sidebar instead of toasting about background automation.
  convertBrowserTabToPip({
    ...input,
    origin: "agent",
    onReady: () => {},
    onError: () => {},
  });
}
