import { Outlet, useMatch } from "@tanstack/react-router";
import { EpicSidebarColumn } from "@/components/epic-canvas/sidebar/epic-sidebar-column";
import { EpicTabHost } from "@/components/epic-tabs/epic-tab-host";

/**
 * Layout for `/epics` and `/epics/$epicId/$tabId`. Hosts the single hoisted
 * epic sidebar plus the persistent keep-alive epic panes (`EpicTabHost`)
 * above the route `<Outlet/>` so both survive navigation between the epic
 * list and any epic detail.
 *
 * Layout row: [sidebar column | resize handle | pane container]. The sidebar
 * is ONE app-level instance living OUTSIDE the keep-alive panes - it
 * re-projects on active-tab change instead of mounting per pane - and it
 * only renders while an epic detail route is active (the same condition
 * that shows a pane). The pane container keeps its relative positioning
 * context for the panes' `absolute inset-0`.
 *
 * - Epic detail route: the matching pane shows next to the sidebar; the
 *   Outlet renders the thin detail selector (`null`/skeleton).
 * - Epic list route: no pane is active, no sidebar renders, and the
 *   Outlet's list renders in normal flow.
 * - Phase->epic migration: the detail route owns the screen (and the pane is
 *   suppressed), so the sidebar hides with it.
 */
export function EpicsLayoutRoute() {
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
  const sidebarRoute =
    activeRoute !== undefined && activeRoute.search.migrationSource !== "phase"
      ? activeRoute
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-row">
      {sidebarRoute === null ? null : (
        <EpicSidebarColumn
          epicId={sidebarRoute.epicId}
          tabId={sidebarRoute.tabId}
        />
      )}
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <EpicTabHost activeRoute={activeRoute ?? null} />
        <Outlet />
      </div>
    </div>
  );
}
