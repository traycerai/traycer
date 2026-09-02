/**
 * Surfacing for a tab the HOST opened - the agent driving a session, or a page
 * inside one spawning a popup (decisions A4, B5, B6, C9, C10; plan §5.3).
 *
 * The `tabOpened` frame arrives on the browser-sessions coordinator, which is
 * module-global and outside React, so this file owns the store-level `openTile`
 * the coordinator hands in. Everything about WHERE the tile lands is the
 * resolver's; what stays here is the part the resolver cannot see: the
 * `agentTabSurfacing` gate and the PiP suppression rules (C9).
 */
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { executeTileOpen } from "@/lib/canvas/tile-open/execute-tile-open";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import { commitWithoutNavigation } from "@/lib/canvas/tile-open/open-tile";
import { resolveTileOpen } from "@/lib/canvas/tile-open/resolve-tile-open";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import { makeBrowserSessionTileRef } from "@/stores/epics/canvas/tile-schema/browser-tile";
import {
  isBrowserSessionTileRef,
  type EpicCanvasState,
} from "@/stores/epics/canvas/types";
import {
  tilePlacementForCategory,
  useSettingsStore,
  type AgentTabSurfacing,
  type BrowserTilePlacement,
} from "@/stores/settings/settings-store";
import { convertBrowserTabToPip, getPipSnapshot } from "../pip/pip-store";

export type HostOpenedTabSource = "agent" | "page";
export type HostOpenedTabDisposition = "foreground" | "background";

export type HostTabSuppressReason =
  | "mode-off"
  | "manual-pip-active"
  | "pip-epic-hidden";

/**
 * Pure gate. Contract:
 * - `off` suppresses agent presentation only; page popups are browser
 *   semantics and are never gated by a setting (A4). Host-side tab creation is
 *   unaffected either way - it is the host's lifecycle transaction.
 * - a `pip` browser placement is skipped when the user converted a PiP
 *   manually (never stomp explicit user intent) or the epic surface is hidden
 *   (a floating overlay nobody can see arms nothing).
 * - every other placement always lands a tile, even in a hidden epic: layout
 *   mutations are fine where an overlay would be invisible.
 */
export function hostOpenedTabSuppressReason(input: {
  readonly source: HostOpenedTabSource;
  readonly surfacing: AgentTabSurfacing;
  readonly browserPlacement: BrowserTilePlacement;
  readonly epicVisible: boolean;
  readonly manualPipActive: boolean;
}): HostTabSuppressReason | null {
  if (input.source === "agent" && input.surfacing === "off") return "mode-off";
  if (input.browserPlacement !== "pip") return null;
  if (input.manualPipActive) return "manual-pip-active";
  if (!input.epicVisible) return "pip-epic-hidden";
  return null;
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

/**
 * The pane already hosting a canvas tile of `sessionId`. The resolver's own
 * affinity groups by CATEGORY, which would drop a popup into whichever browser
 * pane was last active; a tab of this session belongs beside its siblings, so
 * the lookup stays here and travels as an explicit placement (§5.3).
 */
function findPaneIdHostingSessionTile(
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

/**
 * The `openTile` a host push runs through, for callers with no React context
 * (the browser-sessions coordinator).
 *
 * ponytail: `openTileWithNavigation` almost covers this, and two differences
 * keep it from being a straight call.
 * (1) The header tab is resolved with the NON-creating lookup, so a background
 * host push cannot mint (and activate) a tab for an epic nobody opened.
 * (2) A `pip` plan is an AGENT-origin conversion here, where `executeTileOpen`
 * hard-codes `manual` - and a `manual` PiP is exactly what
 * `isManualPipActive` refuses to replace, so getting it wrong wedges every
 * later agent float. Thread a pip origin through the plan and this collapses
 * into `openTileWithNavigation(intent, commitWithoutNavigation)`.
 *
 * The route is deliberately not written: the live router is created inside
 * `<TraycerApp>` and exported nowhere, so a module-global caller has none.
 * That matches what the agent path already did (mutate the store and stop);
 * every surface that DOES have a router keeps committing through
 * `navigateNested`.
 */
export function openHostPushedTile(intent: TileOpenIntent): void {
  const store = useEpicCanvasStore.getState();
  // Deliberately the NON-creating lookup: a background host push must not mint
  // (and activate) a header tab for an epic the user never opened.
  const tabId =
    "tabId" in intent.target
      ? intent.target.tabId
      : store.resolveTabIdForEpic(intent.target.epicId);
  if (tabId === null) return;
  const plan = resolveTileOpen({
    intent,
    settings: useSettingsStore.getState().tilePlacement,
    canvas: store.canvasByTabId[tabId] ?? createEmptyCanvas(),
    resolveTargetTabForEpic: () => tabId,
    singleTileViewport: isMobileViewport(),
  });
  const epicId = store.tabsById[tabId]?.epicId ?? null;

  if (plan.kind === "pip") {
    if (epicId === null || !isBrowserSessionTileRef(intent.node)) return;
    // Silent on failure by design: a failed auto-PiP leaves the tab reachable
    // via the sidebar instead of toasting about background automation.
    convertBrowserTabToPip({
      epicId,
      hostId: intent.node.hostId,
      sessionId: intent.node.sessionId,
      tabId: intent.node.tabId,
      origin: "agent",
      onReady: () => {},
      onError: () => {},
    });
    return;
  }

  executeTileOpen({
    plan,
    node: intent.node,
    source: intent.source,
    store,
    navigateNested: commitWithoutNavigation,
    epicId,
  });
}

function trackAgentTabSurfaced(
  browserPlacement: BrowserTilePlacement,
  reason: HostTabSuppressReason | null,
): void {
  const placedAs = browserPlacement === "pip" ? "float" : "tile";
  Analytics.getInstance().track(AnalyticsEvent.AgentTabSurfaced, {
    disposition: reason !== null ? "suppress" : placedAs,
    disposition_reason: reason,
  });
}

export interface HostOpenedTabSurfacing {
  readonly epicId: string;
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly source: HostOpenedTabSource;
  readonly disposition: HostOpenedTabDisposition;
  readonly openTile: (intent: TileOpenIntent) => void;
}

export function surfaceHostOpenedTab(input: HostOpenedTabSurfacing): void {
  const settings = useSettingsStore.getState();
  const browserPlacement = tilePlacementForCategory(
    settings.tilePlacement,
    "browser",
  );
  const reason = hostOpenedTabSuppressReason({
    source: input.source,
    surfacing: settings.agentTabSurfacing,
    browserPlacement,
    epicVisible: isEpicSurfaceVisible(input.epicId),
    manualPipActive: isManualPipActive(input.epicId),
  });
  if (input.source === "agent") trackAgentTabSurfaced(browserPlacement, reason);
  if (reason !== null) return;

  const store = useEpicCanvasStore.getState();
  const viewTabId = store.resolveTabIdForEpic(input.epicId);
  const canvas =
    viewTabId === null ? undefined : store.canvasByTabId[viewTabId];
  const groupedPaneId =
    canvas === undefined
      ? null
      : findPaneIdHostingSessionTile(canvas, input.sessionId);

  input.openTile({
    node: makeBrowserSessionTileRef({
      hostId: input.hostId,
      sessionId: input.sessionId,
      tabId: input.tabId,
    }),
    target: { epicId: input.epicId },
    // A background open is `host`: no focus steal, no new geometry (C4).
    gesture: input.disposition === "background" ? "host" : "explicit",
    modifiers: null,
    placement:
      groupedPaneId === null
        ? null
        : { kind: "tab", paneId: groupedPaneId, index: null },
    dedupe: true,
    // ponytail: `AnalyticsSource` has no host-push member and `analytics.ts` is
    // out of this ticket's blast radius; `trackOpenedCanvasTile` emits nothing
    // for `browser-session` tiles anyway, so this value is inert today. Add a
    // real source when the analytics schema is next opened.
    source: "direct_ui",
  });
}
