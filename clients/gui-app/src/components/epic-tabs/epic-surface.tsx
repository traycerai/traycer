import { useMatch } from "@tanstack/react-router";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { EpicViewTabContext } from "@/components/epic-canvas/view-tab-context";
import { useTabSurfaceActivity } from "@/components/layout/tab-surface-activity-hooks";
import { EpicSessionProvider } from "@/providers/epic-session-provider";

export interface EpicSurfaceProps {
  readonly epicId: string;
  readonly tabId: string;
}

/** One independently retained Epic pane: sidebar and canvas share its session. */
export function EpicSurface(props: EpicSurfaceProps) {
  const activity = useTabSurfaceActivity();
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
  const route = activeRoute ?? null;
  const activeSearch =
    route !== null &&
    route.epicId === props.epicId &&
    route.tabId === props.tabId
      ? route.search
      : null;
  const routeMatches = activeSearch !== null;
  const migrating = activeSearch?.migrationSource === "phase";

  if (migrating) return null;

  return (
    <PaneVisibilityContext.Provider value={activity.visible}>
      <EpicSessionProvider epicId={props.epicId} tabId={props.tabId}>
        <EpicViewTabContext.Provider value={props.tabId}>
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-row"
            data-epic-surface={props.tabId}
          >
            <EpicSidebarColumn epicId={props.epicId} tabId={props.tabId} />
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
      </EpicSessionProvider>
    </PaneVisibilityContext.Provider>
  );
}
