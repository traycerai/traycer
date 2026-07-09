import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { EpicRouteSessionBody } from "@/components/epic-canvas/epic-route-session-body";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicFocusSearch } from "@/routes/epic-route-search";

export const MAX_RETAINED_EPIC_TAB_PANES = 5;

export interface ActiveEpicTabRoute {
  readonly epicId: string;
  readonly tabId: string;
  readonly search: EpicFocusSearch;
}

export interface EpicTabHostProps {
  readonly activeRoute: ActiveEpicTabRoute | null;
}

/**
 * Renders one keep-alive pane per open epic tab the user has visited, capped
 * by the view-layer pane policy. This is deliberately separate from the
 * open-epic data registry: the registry is per-epic and has a dirty-session
 * soft cap, while panes are per tab and retain DOM/editor/terminal view state.
 * Only the pane whose `(epicId, tabId)` matches the typed active route is
 * shown; the rest stay mounted but hidden with `display:none`. Switching tabs
 * is then a visibility toggle - no unmount/remount, no blank frame, and
 * per-tab scroll / terminal / editor state survives.
 *
 * Mounted as a sibling of the `/epics` layout `<Outlet/>`: its panes are
 * `absolute inset-0` over the layout's relative container, so when no pane is
 * active (the epic list, or a phase->epic migration) they collapse out of the
 * way and the Outlet content shows through.
 */
export function EpicTabHost(props: EpicTabHostProps) {
  const { activeRoute } = props;
  const activeTabId = activeRoute?.tabId ?? null;
  // During a phase->epic migration the detail route owns the screen via its
  // own session render (`PhaseToEpicMigrationGate`); suppress the host pane so
  // the two don't double-mount the same epic.
  const migrating = activeRoute?.search.migrationSource === "phase";

  const openTabOrder = useEpicCanvasStore((s) => s.openTabOrder);
  const tabsById = useEpicCanvasStore(useShallow((s) => s.tabsById));

  const mountedTabIds = useMountedTabIds(openTabOrder, activeTabId);

  return (
    <>
      {mountedTabIds.map((tabId) => {
        const tab = tabsById[tabId];
        if (tab === undefined) return null;
        const routeMatchesTab =
          activeRoute !== null &&
          tabId === activeRoute.tabId &&
          tab.epicId === activeRoute.epicId;
        if (migrating && routeMatchesTab) return null;
        const isActive = routeMatchesTab;
        const activeSearch = isActive ? activeRoute.search : null;
        return (
          <div
            key={tabId}
            className={cn(
              "absolute inset-0 isolate flex min-h-0 flex-col [contain:layout_paint_style]",
              !isActive && "hidden",
            )}
            data-testid={`epic-pane-${tabId}`}
            data-epic-id={tab.epicId}
            data-active={isActive ? "true" : "false"}
          >
            <PaneVisibilityContext.Provider value={isActive}>
              <EpicSessionProvider epicId={tab.epicId} tabId={tabId}>
                <EpicRouteSessionBody
                  epicId={tab.epicId}
                  tabId={tabId}
                  active={isActive}
                  focusedAt={activeSearch?.focusedAt}
                  focusArtifactId={activeSearch?.focusArtifactId}
                  focusThreadId={activeSearch?.focusThreadId}
                  focusPaneId={activeSearch?.focusPaneId}
                  focusTileInstanceId={activeSearch?.focusTileInstanceId}
                />
              </EpicSessionProvider>
            </PaneVisibilityContext.Provider>
          </div>
        );
      })}
    </>
  );
}

/**
 * Tracks the most-recently-active tabs (visit order) and returns the bounded
 * set to keep mounted, rendered in stable `openTabOrder` so DOM positions don't
 * shuffle on activation. The active tab is always included - even on the render
 * it first becomes active - so a freshly opened tab never flashes empty. Closed
 * tabs drop out automatically: they leave `openTabOrder` and are filtered here.
 *
 * Recency is recorded with React's "adjust state during render" pattern (a
 * guarded `setState` while rendering, NOT in an effect) so the new order is
 * available in the same commit, with no cascading-render effect.
 */
function useMountedTabIds(
  openTabOrder: ReadonlyArray<string>,
  activeTabId: string | null,
): ReadonlyArray<string> {
  const [recency, setRecency] = useState<ReadonlyArray<string>>(() =>
    activeTabId === null ? [] : [activeTabId],
  );
  const [seenActiveTabId, setSeenActiveTabId] = useState(activeTabId);

  if (activeTabId !== seenActiveTabId) {
    setSeenActiveTabId(activeTabId);
    setRecency((prev) =>
      activeTabId === null
        ? prev
        : [activeTabId, ...prev.filter((id) => id !== activeTabId)],
    );
  }

  return useMemo(() => {
    const open = new Set(openTabOrder);
    const ordered =
      activeTabId !== null && open.has(activeTabId)
        ? [activeTabId, ...recency.filter((id) => id !== activeTabId)]
        : recency.filter((id) => open.has(id));
    const capped = new Set(ordered.slice(0, MAX_RETAINED_EPIC_TAB_PANES));
    return openTabOrder.filter((id) => capped.has(id));
  }, [recency, openTabOrder, activeTabId]);
}
