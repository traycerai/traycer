import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useEpicRecordViewed } from "@/hooks/epic/use-epic-record-viewed-mutation";
import { useLocalHomedOpenEpicIds } from "@/lib/registries/epic-session-registry";
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
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
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
  const recordViewedMutation = useEpicRecordViewed();
  const recordViewed = recordViewedMutation.mutate;
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // The epic's own live session is the only source for this under
  // `unverified`: `epic.getTaskContexts`, which carries `localHomedTaskIds`
  // for the History surfaces, is itself gated on the cloud verdict and so
  // answers nothing in exactly the state this exemption is for.
  const recencyEpicIds = useMemo(() => [epicId], [epicId]);
  const isLocalHome = useLocalHomedOpenEpicIds(recencyEpicIds).has(epicId);
  // The epic this route has already made its one recency decision for. The
  // effect below re-runs when the verdict changes, and without this marker a
  // route that mounted unverified would fire `recordViewed` the moment the
  // verdict returned - stamping the recovery time as the view time.
  const recencyDecidedForEpicId = useRef<string | null>(null);

  useEffect(() => {
    // `epic.recordViewed` writes personal cloud recency, so it is a CAPABILITY
    // spend, not part of rendering the epic. The route itself is admitted under
    // `unverified` on purpose - the epic is on disk and must stay openable - but
    // merely restoring a tab while authn is unreachable, or after the credential
    // was rejected, would otherwise fire a cloud mutation on a bearer the cloud
    // has stopped vouching for.
    //
    // A LOCAL-HOMED epic is the exception, and it is not a cloud write at all:
    // the host's resolver admits it on the local `epicHomeVerdict` and returns
    // before building any cloud header, so recency for an epic living on the
    // connected device's disk is recorded with no verdict at all. Without this
    // an offline or free-tier user's own machine forgets what they just opened.
    // The exemption only reaches epics whose live session has already answered
    // - see `isLocalHome` above - so a first open whose durability statement is
    // still in flight keeps today's drop.
    //
    // A background effect rather than a click, which is why no UI gate covers
    // it: nothing in this tree is disabled, so the spend happens on mount with
    // no gesture behind it at all.
    //
    // Deliberately dropped rather than deferred. Recency is a "last time you
    // looked at this" datum whose whole value is being current; replaying it
    // when the verdict returns would record the wrong moment, and the effect
    // re-runs on the next open anyway. So the decision is made ONCE per epic,
    // whichever way it goes: the marker is set before the verdict is
    // consulted, and a later verdict change finds it already set.
    //
    // This gate is the render-time one. React can flush a committed effect
    // before rendering the store update that withdrew the verdict, so the
    // mutation re-reads the live verdict at dispatch
    // (`EPIC_RECORD_VIEWED_UNAUTHORIZED_MESSAGE`) and refuses what this
    // captured `true` would otherwise let through. The local-home exemption is
    // carried at BOTH layers for the same reason it is on the pin: a gate here
    // that the mutation does not honour is a write that fires and throws.
    // `isLocalHome` travels in the variables so the two read one fact, not two.
    if (recencyDecidedForEpicId.current === epicId) return;
    recencyDecidedForEpicId.current = epicId;
    if (!cloudAuthorized && !isLocalHome) return;
    recordViewed({ epicId, isLocalHome });
  }, [cloudAuthorized, epicId, isLocalHome, recordViewed]);

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
