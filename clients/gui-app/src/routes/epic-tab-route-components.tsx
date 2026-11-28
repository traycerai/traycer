import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { useEpicRecordViewed } from "@/hooks/epic/use-epic-record-viewed-mutation";
import { useRequesterHostId } from "@/hooks/host/use-requester-host-id";
import {
  getEpicSessionHandleHostId,
  readSessionLocalHome,
  type EpicLocalHomeReading,
} from "@/lib/registries/epic-session-registry";
import {
  getEpicSessionController,
  type EpicSessionTabSnapshot,
} from "@/lib/registries/epic-session-controller";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
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

/**
 * How long the recency decision waits for the epic stream to state where the
 * epic is durable, before deciding with what it has.
 *
 * Sized for the stream's FIRST FRAMES over the slowest link this client
 * supports - a relay hop to a phone - not for the whole open: the durability
 * legs ride the subscription's opening frames, so a statement that has not
 * arrived by now is one that is not coming (a peer that never negotiated the
 * `@1.6` legs is indistinguishable from a slow one, from here).
 *
 * The cost of over-waiting is bounded and invisible: recency is stamped by the
 * host when the write lands, so the wait moves a "last opened" time by at most
 * this much. The cost of under-waiting is a dropped record on a first open,
 * which is the defect this bound exists to close - so when in doubt this is the
 * direction to be generous in.
 *
 * Exported for the bounded-wait suite, which has to tell "the answer arrived
 * inside the bound" from "after it" - two cases no test can name without the
 * number. A copy of the literal in the test would keep passing its INSIDE case
 * while production's bound moved out from under it.
 */
export const RECENCY_HOME_ANSWER_WAIT_MS = 2_000;

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
  const controller = getEpicSessionController();
  const subscribeSession = useCallback(
    (listener: () => void) => controller.subscribe(listener),
    [controller],
  );
  const readSession = useCallback(
    () => controller.readTabSnapshot(epicId, tabId),
    [controller, epicId, tabId],
  );
  const session = useSyncExternalStore(subscribeSession, readSession);
  const { handle } = session;
  const readHome = useCallback(() => {
    const state = handle?.store.getState();
    if (state !== undefined && (state.accessLost || state.epicDeleted !== null))
      return "unavailable";
    return readSessionLocalHome(handle);
  }, [handle]);
  const home = useSyncExternalStore(
    useCallback(
      (listener) => handle?.store.subscribe(listener) ?? (() => undefined),
      [handle],
    ),
    readHome,
  );
  const requesterHostId = useRequesterHostId(session.sessionHostClient);
  const hostId = readReadyRecencyHost(session, requesterHostId);
  const { mutate: recordViewed } = useEpicRecordViewed(hostId);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const matchingOpen = routeTab?.epicId === epicId && routeTabIsOpen;
  const recency = useRef<{
    readonly epicId: string;
    readonly tabId: string;
    decided: boolean;
    deadline: number | null;
  } | null>(null);

  useEffect(() => {
    if (recency.current?.epicId !== epicId || recency.current.tabId !== tabId) {
      recency.current = { epicId, tabId, decided: false, deadline: null };
    }
    const open = recency.current;
    if (open.decided) return;

    const current = readSession();
    if (resolutionFailed || current.presentation.kind === "failed") {
      open.decided = true;
      return;
    }
    if (!matchingOpen || !isEpicRouteTabOpen(epicId, tabId)) return;

    const now = Date.now();
    if (open.deadline !== null && now >= open.deadline) {
      open.decided = true;
      return;
    }
    const authorizedNow = authorizesCloudCapability(
      useAuthStore.getState().status,
    );

    // The controller can retain the outgoing handle during a repoint.
    // Revalidate the accepted tuple before using its host and durability.
    const decision =
      current === session
        ? decideRecency(
            revalidateRecencyHost(current, hostId),
            readHome(),
            authorizedNow,
          )
        : "wait";
    if (decision !== "wait") {
      open.decided = true;
      if (decision !== "skip") {
        recordViewed({
          epicId,
          isLocalHome: decision === "local",
          refreshAccountHistory: confirmsAccountRecency(current),
        });
      }
      return;
    }

    // Verified opens wait for the controller. A bound already armed under
    // unverified auth still applies even when verification returns.
    if (open.deadline === null) {
      if (authorizedNow) return;
      open.deadline = now + RECENCY_HOME_ANSWER_WAIT_MS;
    }
    const timer = window.setTimeout(
      () => {
        if (recency.current === open) open.decided = true;
      },
      Math.max(0, open.deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [
    cloudAuthorized,
    epicId,
    home,
    hostId,
    matchingOpen,
    readHome,
    readSession,
    recordViewed,
    resolutionFailed,
    session,
    tabId,
  ]);

  if (resolutionFailed) return <RootLandingPage />;

  // Until the tab record exists the host has no pane to show; render a themed
  // skeleton (never a blank/black frame). Once it exists the host's pane paints
  // over this and the route contributes nothing.
  if (routeTab?.epicId !== epicId || !routeTabIsOpen) {
    return <EpicShell epicId={epicId} tabId={tabId} active />;
  }
  return null;
}

function isEpicRouteTabOpen(epicId: string, tabId: string): boolean {
  const canvas = useEpicCanvasStore.getState();
  return (
    canvas.tabsById[tabId]?.epicId === epicId &&
    canvas.openTabOrder.includes(tabId)
  );
}

function confirmsAccountRecency(session: EpicSessionTabSnapshot): boolean {
  return (
    session.sessionHostId === POOL_HOST_ID ||
    session.handle?.store.getState().durabilityStatus === "cloud"
  );
}

function decideRecency(
  hostId: string | null,
  home: EpicLocalHomeReading | "unavailable",
  authorized: boolean,
): "local" | "cloud" | "skip" | "wait" {
  if (hostId === null) return "wait";
  if (home === "unavailable") return "skip";
  if (hostId !== POOL_HOST_ID && home === "local") return "local";
  if (authorized) return "cloud";
  return hostId === POOL_HOST_ID || home === "no-local-claim" ? "skip" : "wait";
}

function revalidateRecencyHost(
  session: EpicSessionTabSnapshot,
  renderedHostId: string | null,
): string | null {
  const liveHostId = readReadyRecencyHost(
    session,
    session.sessionHostClient?.getActiveHostId() ?? null,
  );
  return liveHostId === renderedHostId ? liveHostId : null;
}

function readReadyRecencyHost(
  session: EpicSessionTabSnapshot,
  requesterHostId: string | null,
): string | null {
  const { handle, presentation, sessionHostClient, sessionHostId } = session;
  if (
    presentation.kind !== "ready" ||
    handle === null ||
    sessionHostId === null ||
    presentation.targetHostId !== sessionHostId ||
    getEpicSessionHandleHostId(handle) !== sessionHostId ||
    (sessionHostClient !== null && requesterHostId !== sessionHostId)
  ) {
    return null;
  }
  return sessionHostId;
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
