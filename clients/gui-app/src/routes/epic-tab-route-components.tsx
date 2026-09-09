import { useEffect, useRef, useSyncExternalStore } from "react";
import { useEpicRecordViewed } from "@/hooks/epic/use-epic-record-viewed-mutation";
import { useEpicLocalHomeReading } from "@/lib/registries/epic-session-registry";
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
 */
const RECENCY_HOME_ANSWER_WAIT_MS = 2_000;

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
  // answers nothing in exactly the state this exemption is for. Three-state,
  // not the boolean the render surfaces use: this effect DECIDES ONCE, and
  // `false` would conflate "cloud-homed" with "nobody has answered yet".
  const homeReading = useEpicLocalHomeReading(epicId);
  // The epic this route has already made its one recency decision for. The
  // effect below re-runs when the verdict or the home reading changes, and
  // without this marker a route that mounted unverified would fire
  // `recordViewed` the moment the verdict returned - stamping the recovery
  // time as the view time.
  const recencyDecidedForEpicId = useRef<string | null>(null);
  // When the wait below gives up, anchored at the FIRST evaluation for this
  // epic. Re-deriving it per run would let a dep that churns during the wait
  // (a verdict flapping, a session rebinding) extend the bound indefinitely -
  // which is the unbounded wait this bound exists to rule out.
  const recencyWaitDeadline = useRef<{
    readonly epicId: string;
    readonly at: number;
  } | null>(null);

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
    // an offline or free-tier user's own machine forgets what they just opened
    // - and that user is exactly who this is for.
    //
    // A background effect rather than a click, which is why no UI gate covers
    // it: nothing in this tree is disabled, so the spend happens on mount with
    // no gesture behind it at all.
    //
    // WHY THE DECISION CAN WAIT, AND ONLY FOR THIS. The decision is still made
    // ONCE per epic, but the marker no longer closes on silence. Under
    // `unverified` the exemption turns on where the epic is durable, and the
    // durability statement arrives on the epic stream's first frames - AFTER
    // this effect commits. Latching immediately would have made the exemption
    // fire only on a return visit, with the first open silently dropped: a
    // half-truth of exactly the kind this lane removes.
    //
    // So the wait is for the DURABILITY STATEMENT, never for the verdict. That
    // distinction is the whole safety argument. A verdict can be withheld for
    // minutes, and recording when it returns would stamp the recovery time as
    // the view time; a durability statement either arrives with the stream's
    // first frames or is never coming, and `RECENCY_HOME_ANSWER_WAIT_MS` bounds
    // the difference to something no reader of a "last opened" column can see.
    // A peer that never negotiated the durability legs looks identical, from
    // here, to one whose frames are merely slow - which is why the bound is not
    // optional, and why giving up records NOTHING and never tries again.
    //
    // The wait does re-open the old hole for as long as it lasts, and only that
    // long: a verdict landing DURING it decides the epic and records. That is
    // the trade taken deliberately - the drift is at most
    // `RECENCY_HOME_ANSWER_WAIT_MS`, where the unlatched version's was however
    // long authn stayed unreachable. Past the bound the marker is set and a
    // returning verdict finds it, exactly as before.
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

    const decideRecency = (isLocalHome: boolean): void => {
      recencyDecidedForEpicId.current = epicId;
      if (!cloudAuthorized && !isLocalHome) return;
      recordViewed({ epicId, isLocalHome });
    };

    // Nothing an answer could add. A held verdict admits the write whatever
    // the home turns out to be, and a stated local home admits it without one.
    if (cloudAuthorized || homeReading === "local") {
      decideRecency(homeReading === "local");
      return;
    }
    // Unverified, and the host has said the epic is not local-homed - or that
    // it cannot say. Either way no further answer is coming, so decide now
    // rather than burning the bound to reach the same drop.
    if (homeReading === "no-local-claim") {
      decideRecency(false);
      return;
    }

    // Not `useDeadlineReached`: that hook exists to RENDER a wait, so its
    // anchor has to be a render-time value, and anchoring this one per epic
    // during render means writing state from the render path. Nothing here is
    // rendered - the wait's only output is which branch decides - so an
    // effect-local timer keeps the whole thing on the effect side.
    const deadline =
      recencyWaitDeadline.current?.epicId === epicId
        ? recencyWaitDeadline.current.at
        : Date.now() + RECENCY_HOME_ANSWER_WAIT_MS;
    recencyWaitDeadline.current = { epicId, at: deadline };
    const timer = window.setTimeout(
      () => decideRecency(false),
      // Clamped: a re-run after the deadline has already passed must fire
      // immediately rather than arm a negative interval.
      Math.max(0, deadline - Date.now()),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [cloudAuthorized, epicId, homeReading, recordViewed]);

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
