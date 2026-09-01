import { useMatch } from "@tanstack/react-router";
import { useEffect } from "react";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { MobileEpicHeaderActionsBinder } from "@/components/epic-canvas/mobile/epic-mobile-header-actions";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { useTabSurfaceActivity } from "@/components/layout/tab-surface-activity-hooks";
import { setEpicSurfaceVisibility } from "@/lib/browser-view/tiles/agent-tab-surfacing";
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
  // only arms while this epic is the visible surface.
  useEffect(() => {
    setEpicSurfaceVisibility(props.epicId, activity.visible);
    return () => {
      setEpicSurfaceVisibility(props.epicId, false);
    };
  }, [props.epicId, activity.visible]);
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
  const route = activeRoute ?? null;
  const activeSearch =
    route !== null &&
    route.epicId === props.epicId &&
    route.tabId === props.tabId
      ? route.search
      : null;
  const routeMatches = activeSearch !== null;
  return (
    <PaneSurfaceActivityContext.Provider value={activity}>
      <PaneVisibilityContext.Provider value={activity.visible}>
        <EpicSessionProvider epicId={props.epicId} tabId={props.tabId}>
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
            <EpicViewTabContext.Provider value={props.tabId}>
              <div
                className="flex min-h-0 min-w-0 flex-1 flex-row"
                data-epic-surface={props.tabId}
              >
                {/* Phones present one full-screen surface at a time: the epic
                    sidebar (artifact/chat/terminal tree + resize rail) is dropped
                    below md so the pane container spans the full width. Its
                    navigation re-homes into the mobile tile switcher. Desktop
                    (>=768px) is unaffected. */}
                {isMobile ? null : (
                  <EpicSidebarColumn
                    epicId={props.epicId}
                    tabId={props.tabId}
                  />
                )}
                <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
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
                </div>
              </div>
            </EpicViewTabContext.Provider>
            <AgentBrowserPip
              epicId={props.epicId}
              viewTabId={props.tabId}
              surfaceVisible={activity.visible}
            />
          </BrowserSessionsProvider>
        </EpicSessionProvider>
      </PaneVisibilityContext.Provider>
    </PaneSurfaceActivityContext.Provider>
  );
}
