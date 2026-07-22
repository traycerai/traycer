import { useEffect, useSyncExternalStore } from "react";
import {
  useNavigate,
  useParams,
  useRouterState,
  useSearch,
} from "@tanstack/react-router";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { RootLandingPage } from "@/components/layout/root-landing-page";
import {
  activateTabIntent,
  existingEpicTabIntent,
  openPhaseMigrationIntent,
  subscribeTabNavigationResolutionFailure,
  tabNavigationResolutionFailed,
} from "@/lib/tab-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicFocusSearch } from "./epic-route-search";

export function EpicRoute() {
  const { epicId, tabId } = useParams({ from: "/epics/$epicId/$tabId" });
  const search = useSearch({ from: "/epics/$epicId/$tabId" });

  if (search.migrationSource === "phase") {
    return (
      <PhaseToEpicMigrationGate
        phaseId={epicId}
        tabId={tabId}
        search={search}
      />
    );
  }

  return <EpicRouteTabSync epicId={epicId} tabId={tabId} />;
}

/** The root bridge owns every route -> store transition. This adapter renders. */
function EpicRouteTabSync(props: {
  readonly epicId: string;
  readonly tabId: string;
}) {
  const { epicId, tabId } = props;
  const routeTab = useEpicCanvasStore((s) => s.tabsById[tabId] ?? null);
  const routeTabIsOpen = useEpicCanvasStore((s) =>
    s.openTabOrder.includes(tabId),
  );
  const locationState = useRouterState({ select: (s) => s.location.state });
  const resolutionFailed = useSyncExternalStore(
    subscribeTabNavigationResolutionFailure,
    () => tabNavigationResolutionFailed(locationState),
    () => false,
  );

  if (resolutionFailed) return <RootLandingPage />;

  // Until the tab record exists the host has no pane to show; render a themed
  // skeleton (never a blank/black frame). Once it exists the host's pane paints
  // over this and the route contributes nothing.
  if (routeTab?.epicId !== epicId || !routeTabIsOpen) {
    return <EpicShell epicId={epicId} tabId={tabId} active />;
  }
  return null;
}

/** Deep links only ensure the persisted migration ref; the slot owns its UI. */
export function PhaseToEpicMigrationGate(props: {
  readonly phaseId: string;
  readonly tabId: string;
  readonly search: EpicFocusSearch;
}) {
  const navigate = useNavigate();
  const routeTab = useEpicCanvasStore(
    (state) => state.tabsById[props.tabId] ?? null,
  );
  useEffect(() => {
    if (
      routeTab?.surfaceMode?.kind === "phase-migration" &&
      routeTab.surfaceMode.phaseId === props.phaseId
    ) {
      return;
    }
    if (routeTab !== null && routeTab.surfaceMode?.kind !== "phase-migration") {
      activateTabIntent(
        navigate,
        existingEpicTabIntent({
          epicId: routeTab.epicId,
          tabId: routeTab.tabId,
          focus: { ...props.search, migrationSource: undefined },
        }),
        { replace: true },
      );
      return;
    }
    activateTabIntent(
      navigate,
      openPhaseMigrationIntent({
        phaseId: props.phaseId,
        name: undefined,
        focus: props.search,
      }),
      { replace: true },
    );
  }, [navigate, props.phaseId, props.search, routeTab]);

  return <EpicShell epicId={props.phaseId} tabId={props.tabId} active />;
}
