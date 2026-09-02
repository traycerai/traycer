/**
 * Surfacing for a tab the HOST opened - the agent driving a session, or a page
 * inside one spawning a popup (decisions A4, B5, B6, C9, C10; plan §5.3).
 *
 * The `tabOpened` frame arrives on the browser-sessions coordinator, which is
 * module-global and outside React, so this file opens through the non-React
 * `openTileWithNavigation` seam. Everything about WHERE the tile lands is the
 * resolver's; what stays here is the part the resolver cannot see: the
 * `agentTabSurfacing` gate and the PiP suppression rules (C9).
 */
import type { BrowserTabOpenedSource } from "@traycer/protocol/host/browser/contracts";
import { isMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import {
  commitWithoutNavigation,
  openTileWithNavigation,
} from "@/lib/canvas/tile-open/open-tile";
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
import { getPipSnapshot } from "../pip/pip-store";

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
 *
 * `browserPlacement` is the EFFECTIVE placement, not the raw setting (R4) -
 * see {@link effectiveBrowserPlacement}.
 */
export function hostOpenedTabSuppressReason(input: {
  readonly source: BrowserTabOpenedSource;
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
 * What the resolver will DO with this push, as far as the pip gate cares. Only
 * a float can be suppressed, and two things upstream of the setting turn a
 * `pip` setting into a plain tab: an explicit grouped pane (C7) and the
 * single-tile viewport (C10). Gating on the raw setting instead dropped those
 * tabs entirely (R4).
 */
function effectiveBrowserPlacement(input: {
  readonly configured: BrowserTilePlacement;
  readonly grouped: boolean;
}): BrowserTilePlacement {
  if (input.configured !== "pip") return input.configured;
  if (input.grouped) return "tab";
  return isMobileViewport() ? "tab" : "pip";
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
  for (const pane of collectPanes(canvas.root)) {
    for (const instanceId of pane.tabInstanceIds) {
      const tile = canvas.tilesByInstanceId[instanceId];
      if (tile === undefined || !isBrowserSessionTileRef(tile)) continue;
      if (tile.sessionId === sessionId) return pane.id;
    }
  }
  return null;
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
  readonly source: BrowserTabOpenedSource;
}

export function surfaceHostOpenedTab(input: HostOpenedTabSurfacing): void {
  const settings = useSettingsStore.getState();
  const store = useEpicCanvasStore.getState();
  // Deliberately the NON-creating lookup: a host push must not mint (and
  // activate) a header tab for an epic the user never opened.
  const viewTabId = store.resolveTabIdForEpic(input.epicId);
  const canvas =
    viewTabId === null ? undefined : store.canvasByTabId[viewTabId];
  const groupedPaneId =
    canvas === undefined
      ? null
      : findPaneIdHostingSessionTile(canvas, input.sessionId);

  const browserPlacement = effectiveBrowserPlacement({
    configured: tilePlacementForCategory(settings.tilePlacement, "browser"),
    grouped: groupedPaneId !== null,
  });
  const reason = hostOpenedTabSuppressReason({
    source: input.source,
    surfacing: settings.agentTabSurfacing,
    browserPlacement,
    epicVisible: isEpicSurfaceVisible(input.epicId),
    manualPipActive: isManualPipActive(input.epicId),
  });
  if (input.source === "agent") trackAgentTabSurfaced(browserPlacement, reason);
  if (reason !== null) return;

  openTileWithNavigation(
    {
      node: makeBrowserSessionTileRef({
        hostId: input.hostId,
        sessionId: input.sessionId,
        tabId: input.tabId,
      }),
      target: { epicId: input.epicId },
      // Always `explicit`: the wire carries no disposition (a headless runtime
      // cannot detect one, and Electron's real in-page disposition travels on
      // `browserViewOpenTileRequest` instead - A5/B6), so a host push is a
      // deliberate open, not a background one.
      gesture: "explicit",
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
    },
    // The route is deliberately not written: the live router is created inside
    // `<TraycerApp>` and exported nowhere, so a module-global caller has none.
    // That matches what the agent path already did (mutate the store and stop);
    // every surface that DOES have a router keeps committing through
    // `navigateNested`.
    commitWithoutNavigation,
    { createTab: false, pipOrigin: "agent" },
  );
}
