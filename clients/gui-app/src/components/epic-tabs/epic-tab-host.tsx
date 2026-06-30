import { useLayoutEffect, useMemo, useRef, useState } from "react";
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
        return (
          <EpicTabPane
            key={tabId}
            tabId={tabId}
            epicId={tab.epicId}
            isActive={isActive}
            activeSearch={isActive ? activeRoute.search : null}
          />
        );
      })}
    </>
  );
}

interface EpicTabPaneProps {
  readonly tabId: string;
  readonly epicId: string;
  readonly isActive: boolean;
  readonly activeSearch: EpicFocusSearch | null;
}

/**
 * One keep-alive epic pane. Inactive panes stay mounted but hidden with
 * `display:none`; switching tabs is a visibility toggle.
 *
 * `useRevealReflow` repairs a layout-engine reveal race: on the
 * `display:none` -> visible reveal, the canvas's split layout (a `flex-row` of
 * `h-full` children) resolves its children's cross-axis height inconsistently
 * against the not-yet-settled ancestor chain, so one split pane can collapse to
 * its content height (the terminal sticks at its default 80x24 grid) and stay
 * collapsed until a manual relayout. Re-toggling THIS element's `display` -
 * exactly what a manual navigate-away-and-back does, and at the same level - is
 * the known recovery. The descendant-level nudge (TileCanvas) was too low to
 * re-resolve the whole chain; toggling the actual hidden element re-lays-out the
 * full subtree. It is a forced reflow only, so it can never change the final
 * layout (never regresses); the rAF pass covers the case where the subtree
 * hadn't finished mounting on the synchronous pass.
 */
function EpicTabPane(props: EpicTabPaneProps) {
  const { tabId, epicId, isActive, activeSearch } = props;
  const ref = useRevealReflow(isActive);
  return (
    <div
      ref={ref}
      className={cn(
        "absolute inset-0 isolate flex min-h-0 flex-col [contain:layout_paint_style]",
        !isActive && "hidden",
      )}
      data-testid={`epic-pane-${tabId}`}
      data-epic-id={epicId}
      data-active={isActive ? "true" : "false"}
    >
      <PaneVisibilityContext.Provider value={isActive}>
        <EpicSessionProvider epicId={epicId} tabId={tabId}>
          <EpicRouteSessionBody
            epicId={epicId}
            tabId={tabId}
            active={isActive}
            focusedAt={activeSearch?.focusedAt}
            focusArtifactId={activeSearch?.focusArtifactId}
            focusThreadId={activeSearch?.focusThreadId}
          />
        </EpicSessionProvider>
      </PaneVisibilityContext.Provider>
    </div>
  );
}

function useRevealReflow(isActive: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!isActive) return;
    const el = ref.current;
    if (el === null) return;
    forceRevealReflow(el);
    const raf = requestAnimationFrame(() => forceRevealReflow(el));
    return () => cancelAnimationFrame(raf);
  }, [isActive]);
  return ref;
}

function forceRevealReflow(el: HTMLElement): void {
  const previousDisplay = el.style.display;
  // Detach from layout, flush, then re-attach and flush again: this discards the
  // stale (collapsed) layout and re-resolves the subtree from scratch, the same
  // way a `display:none` -> visible navigate-away-and-back does. `getBoundingClientRect`
  // forces the synchronous layout flush each way.
  el.style.display = "none";
  el.getBoundingClientRect();
  el.style.display = previousDisplay;
  el.getBoundingClientRect();
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
