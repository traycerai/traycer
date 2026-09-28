import { useMatch } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, type ReactNode } from "react";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { MobileEpicHeaderActionsBinder } from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { remeasureTileSurfaceGeometry } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";
import { StripLiveAgentsPortal } from "@/components/epic-canvas/sidebar/strip-live-agents";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useArrangementValue } from "@/lib/layout-overrides";
import type { EdgeSide } from "@/lib/layout/layout-arrangement";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { useTabSurfaceActivity } from "@/components/layout/tab-surface-activity-hooks";
import { browserGuestCssSheetAnchorName } from "@/lib/browser-view/guest/persistent-browser-guest-host";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/surface-host-opened-tab";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { AgentBrowserPip } from "@/components/epic-canvas/pip/agent-browser-pip";
import { BrowserSessionsProvider } from "@/components/epic-canvas/renderers/browser-sessions-provider";

interface EpicSurfaceProps {
  readonly epicId: string;
  readonly tabId: string;
}

/** One independently retained Epic pane: sidebar and canvas share its session. */
export function EpicSurface(props: EpicSurfaceProps) {
  const activity = useTabSurfaceActivity();
  // Report visibility for the agent-tab-surfacing pipeline: PiP auto-surfacing
  // only arms while this epic is the visible surface. Renderer parking rolls
  // the same per-epic set up with a debounce - see `lib/epics/epic-parking.ts`,
  // which keys its ENTRIES on the open tab rather than on this surface, so a
  // tab past the retention pool (unmounted, therefore never reporting here)
  // still parks. All this owes it is the visibility edge.
  useEffect(() => {
    setEpicSurfaceVisibility(props.epicId, props.tabId, activity.visible);
    return () => {
      setEpicSurfaceVisibility(props.epicId, props.tabId, false);
    };
  }, [activity.visible, props.epicId, props.tabId]);
  const activeRoute = useMatch({
    from: "/epics/$epicId/$tabId",
    shouldThrow: false,
    select: (match) => ({
      epicId: match.params.epicId,
      tabId: match.params.tabId,
      search: match.search,
    }),
    structuralSharing: true,
  });
  const isMobile = useIsMobileViewport();
  const sidebarSide = useArrangementValue("sidebarSide");
  const route = activeRoute ?? null;
  const activeSearch =
    route !== null &&
    route.epicId === props.epicId &&
    route.tabId === props.tabId
      ? route.search
      : null;
  const routeMatches = activeSearch !== null;
  // Phones present one full-screen surface at a time: the epic sidebar
  // (artifact/chat/terminal tree + resize rail) is dropped below md so the
  // pane container spans the full width. Its navigation re-homes into the
  // mobile tile switcher. Desktop (>=768px) is unaffected.
  const sidebarColumn = isMobile ? null : (
    <EpicSidebarColumn
      epicId={props.epicId}
      tabId={props.tabId}
      side={sidebarSide}
    />
  );
  return (
    <PaneSurfaceActivityContext.Provider value={activity}>
      <PaneVisibilityContext.Provider value={activity.visible}>
        <EpicSessionProvider epicId={props.epicId} tabId={props.tabId}>
          <EpicViewTabContext.Provider value={props.tabId}>
            <BrowserSessionsProvider epicId={props.epicId}>
              {/* Registers the mobile header's right actions (the tab switcher
                  trigger) for this epic PANE - focused or merely retained - so a
                  focus switch onto an already-retained tab resolves its trigger
                  in that same commit, with no register-on-focus gap. Which pane's
                  entry the header shows is resolution's call, keyed by the tab
                  layout's focused ref rather than the route - so the trigger also
                  appears on a phone cold restore, where the layout restores the
                  tab but the router boots at `/`, leaving the route-active
                  effects below unmounted. Self-gates on mobile, so desktop
                  registers nothing either way. */}
              <MobileEpicHeaderActionsBinder tabId={props.tabId} />
              {/* The Activity view's live agents, drawn in the strip under
                  this tab's row but owned here, inside this pane's session
                  (D9). */}
              <StripLiveAgentsPortal
                epicId={props.epicId}
                tabId={props.tabId}
              />
              <EpicSurfaceSheets
                tabId={props.tabId}
                sidebarSide={sidebarSide}
                sidebar={sidebarColumn}
              >
                <EpicRouteSessionBody
                  epicId={props.epicId}
                  tabId={props.tabId}
                  active={Boolean(activity.focused && routeMatches)}
                  focusedAt={activeSearch?.focusedAt}
                  focusArtifactId={activeSearch?.focusArtifactId}
                  focusThreadId={activeSearch?.focusThreadId}
                  focusPaneId={activeSearch?.focusPaneId}
                  focusTileInstanceId={activeSearch?.focusTileInstanceId}
                />
              </EpicSurfaceSheets>
              <AgentBrowserPip
                epicId={props.epicId}
                viewTabId={props.tabId}
                surfaceVisible={activity.visible}
              />
            </BrowserSessionsProvider>
          </EpicViewTabContext.Provider>
        </EpicSessionProvider>
      </PaneVisibilityContext.Provider>
    </PaneSurfaceActivityContext.Provider>
  );
}

/**
 * The epic surface, edge to edge with no enclosing box: the sidebar column
 * (the panel pane) on `sidebarSide` and the content pane beside it. Only the
 * epic canvas inside the content pane draws a border.
 */
export function EpicSurfaceSheets(props: {
  readonly tabId: string;
  readonly sidebarSide: EdgeSide;
  readonly sidebar: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { tabId, sidebarSide, sidebar } = props;
  // Hosted chat bodies (`StableTileSurfaceHost`) paint at rects the geometry
  // coordinator reads inside a ResizeObserver callback, and a ResizeObserver
  // reports SIZE changes only. Moving the sidebar to the other side moves the
  // content sheet by the panel's width without resizing it, so without this
  // the chat body stays at its old x, drawn over the panel (Staging F2) - the
  // same position-only move `TopLevelTabHost` handles for "Reverse views".
  // Layout effect: the re-read has to see this commit's order before paint.
  useLayoutEffect(() => {
    remeasureTileSurfaceGeometry();
  }, [sidebarSide]);
  return (
    <div
      data-shell-sheet="task"
      style={{ anchorName: browserGuestCssSheetAnchorName(tabId) }}
      className="flex min-h-0 min-w-0 flex-1 flex-row md:overflow-clip"
      data-epic-surface={tabId}
    >
      {/* DOM order follows `sidebarSide` (S-06), never CSS `order`, so
          focus and reading order track what is on screen. Split panes each
          render an `EpicSurface`, so both follow the one global side. */}
      {sidebarSide === "right" ? null : sidebar}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col md:overflow-clip md:bg-canvas">
        {props.children}
      </div>
      {sidebarSide === "right" ? sidebar : null}
    </div>
  );
}
