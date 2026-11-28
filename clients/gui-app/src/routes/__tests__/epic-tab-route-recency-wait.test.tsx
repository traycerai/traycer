import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import {
  createRootRoute,
  createRoute,
  RouterProvider,
  createMemoryHistory,
  createRouter,
  Outlet,
} from "@tanstack/react-router";
import {
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { RECENCY_HOME_ANSWER_WAIT_MS } from "@/routes/epic-tab-route-components";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { handleHostIds } from "@/lib/registries/epic-session-registry";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { hostRpcRegistry } from "@traycer/protocol/host/registry";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import { EpicRoute } from "@/routes/epic-tab-route-components";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksQueryKey,
} from "@/lib/cloud-epic-tasks-query";
import { historyPageMethod } from "@/lib/cloud-epic-tasks-query/query";
import {
  cloudEpicTasksPageGeneration,
  cloudEpicTasksPageIdentity,
  useCloudEpicTasksPagesStore,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

const routeMutationState = vi.hoisted(() => ({
  useRealMutation: false,
  client: null as HostClient<HostRpcRegistry> | null,
}));

const sessionSnapshotStore = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let readCount = 0;
  let snapshot: {
    handle: OpenEpicStoreHandle | null;
    sessionHostId: string | null;
    sessionHostClient: { getActiveHostId: () => string | null } | null;
    presentation:
      | { readonly kind: "ready"; readonly targetHostId: string }
      | { readonly kind: "establishing"; readonly targetHostId: string | null }
      | { readonly kind: "failed"; readonly targetHostId: string | null };
  } = {
    handle: null,
    sessionHostId: null,
    sessionHostClient: null,
    presentation: { kind: "establishing", targetHostId: null },
  };
  return {
    get: () => snapshot,
    read: () => {
      readCount += 1;
      return snapshot;
    },
    readCount: () => readCount,
    set(next: typeof snapshot): void {
      snapshot = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/lib/registries/epic-session-controller", () => ({
  getEpicSessionController: () => ({
    readTabSnapshot: () => sessionSnapshotStore.read(),
    subscribe: sessionSnapshotStore.subscribe,
  }),
}));

/**
 * `7d521991d` - the bounded-wait recency decision inside
 * `epic-tab-route-components.tsx`'s `EpicRouteTabSync`: this pins
 * the route's
 * decision over time. The local-home reading (`readEpicLocalHomeReading`'s own
 * classification) is pinned separately in
 * `src/lib/registries/__tests__/use-epic-local-home-reading.test.ts`.
 *
 * `useEpicLocalHomeReading` is mocked to a controllable external store so
 * each scenario can drive the reading across renders without a real Epic
 * session/Y.Doc. Fake timers stand in for `RECENCY_HOME_ANSWER_WAIT_MS`;
 * `vi.runOnlyPendingTimers()` fires whatever is scheduled without asserting
 * on the literal 2000ms bound, so a tuning change does not redden this file.
 */

type HomeReading = "local" | "no-local-claim" | "unstated";

const homeReadingStore = vi.hoisted(() => {
  let reading: "local" | "no-local-claim" | "unstated" = "unstated";
  const listeners = new Set<() => void>();
  return {
    get: () => reading,
    set(next: typeof reading): void {
      reading = next;
      for (const listener of listeners) listener();
    },
    // An arrow PROPERTY, like `get` beside it, and not a method shorthand: this
    // one is passed BY REFERENCE to `useSyncExternalStore`, which a shorthand
    // makes an unbound method (`unbound-method`). Fixed here rather than wrapped
    // at the call site on purpose - a wrapper would be a new function identity on
    // every render, so React would re-subscribe on every commit, and this suite's
    // whole subject is what happens across commits and timers. `set` stays a
    // method because it is only ever called, never referenced.
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const recordViewed = vi.hoisted(() => vi.fn());

// The host the route resolves the recency write on. Captured as the hook's
// ARGUMENT rather than observed on a requester: the defect was the route
// choosing the wrong host, and the argument is exactly where that choice lands.
const recordViewedHostIds = vi.hoisted(() => new Array<string | null>());

// The session's host, mocked beside the home reading because production reads
// them through one mechanism for one reason - a local-home fact and the machine
// that stated it are the same fact.
const sessionHostStore = vi.hoisted(() => {
  let hostId: string | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => hostId,
    set(next: string | null): void {
      hostId = next;
      for (const listener of listeners) listener();
    },
    // An arrow property for the same reason as `homeReadingStore.subscribe`.
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("@/components/layout/app-shell", () => ({
  AppShell: (props: { readonly children: ReactNode }) => (
    <div data-testid="app-shell">{props.children}</div>
  ),
}));

// Route recency is the subject here. The root route now mounts the real
// organization projection beside route content, and that projection needs a
// host runtime which this route-only harness intentionally does not build.
vi.mock("@/hooks/organization/organization-provider", () => ({
  OrganizationProvider: (props: { readonly children: ReactNode }) =>
    props.children,
}));

vi.mock("@/components/layout/header/desktop-menu-bar", () => ({
  DesktopMenuBar: () => null,
}));

vi.mock("@/components/layout/dialogs/desktop-dialog-host", () => ({
  DesktopDialogHost: () => null,
}));

vi.mock("@/components/layout/bridges/menu-command-listener", () => ({
  MenuCommandListener: () => null,
}));

vi.mock("@/components/layout/host-ready-gate", () => ({
  HostReadyGate: (props: { readonly children: ReactNode }) => props.children,
}));

vi.mock("@/components/layout/bridges/host-tray-command-listener", () => ({
  HostTrayCommandListener: () => null,
}));
vi.mock("@/components/layout/bridges/host-unresponsive-prompt", () => ({
  HostUnresponsivePrompt: () => null,
}));

vi.mock("@/components/layout/bridges/notification-focus-bridge", () => ({
  NotificationFocusBridge: () => null,
}));
vi.mock("@/components/layout/bridges/notification-emission-controller", () => ({
  NotificationEmissionController: () => null,
}));
vi.mock("@/hooks/notifications/use-app-icon-badge", () => ({
  useAppIconBadge: () => undefined,
}));
vi.mock(
  "@/hooks/notifications/use-delivered-notifications-feed-trigger",
  () => ({
    useDeliveredNotificationsFeedTrigger: () => undefined,
  }),
);

vi.mock("@/components/layout/dialogs/system-tab-modal-host", () => ({
  SystemTabModalHost: () => null,
}));
// The retrospective and move sheets RootComponent mounts app-wide read this
// computer's host through a <HostRuntimeProvider> this harness does not build.
vi.mock("@/components/settings/move/environment-sheets-host", () => ({
  EnvironmentSheetsHost: () => null,
}));

vi.mock("@/components/layout/bridges/tray-open-epic-bridge", () => ({
  TrayOpenEpicBridge: () => null,
}));

// Always mounted by RootComponent, and it reads the QueryClient to report a
// lifecycle mode change. This harness supplies only a router queryClient (no
// QueryClientProvider), so stub it like the other shell bridges above.
vi.mock("@/components/layout/bridges/host-lifecycle-analytics-bridge", () => ({
  HostLifecycleAnalyticsBridge: () => null,
}));
// The team-removal tile closer reads the host registry query; this harness
// has no QueryClientProvider, so stub it like the shell bridges above.
vi.mock("@/providers/team-removal-tile-closer", () => ({
  TeamRemovalTileCloser: () => null,
}));
vi.mock("@/providers/claimed-computer-notifier", () => ({
  ClaimedComputerNotifier: () => null,
}));
// This harness has no QueryClientProvider, so the cover is stubbed.
vi.mock("@/components/layout/dialogs/window-host-modal-host", () => ({
  WindowHostModalHost: () => null,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => routeMutationState.client,
}));

vi.mock(
  "@/hooks/epic/use-epic-record-viewed-mutation",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/epic/use-epic-record-viewed-mutation")
      >();
    return {
      ...actual,
      useEpicRecordViewed: (hostId: string | null) => {
        if (routeMutationState.useRealMutation) {
          return actual.useEpicRecordViewed(hostId);
        }
        recordViewedHostIds.push(hostId);
        return { mutate: recordViewed };
      },
    };
  },
);

vi.mock("@/hooks/migration/use-phase-migrate-to-epic-mutation", () => ({
  usePhaseMigrateToEpic: () => ({
    data: undefined,
    error: null,
    isError: false,
    isPending: true,
    mutate: () => undefined,
  }),
}));

vi.mock("@/components/onboarding/onboarding-page", () => ({
  OnboardingPage: () => <div data-testid="onboarding-page-stub" />,
}));

vi.mock("@/providers/epic-session-provider", () => ({
  EpicSessionProvider: (props: {
    readonly children: ReactNode;
    readonly epicId: string;
  }) => (
    <div data-epic-id={props.epicId} data-testid="epic-session-provider">
      {props.children}
    </div>
  ),
}));

vi.mock("@/components/epic-canvas/epic-route-session-body", () => ({
  EpicRouteSessionBody: (props: {
    readonly epicId: string;
    readonly tabId: string;
  }) => (
    <div
      data-epic-id={props.epicId}
      data-tab-id={props.tabId}
      data-testid="epic-route-session-body"
    />
  ),
}));

vi.mock("@/lib/registries/epic-session-registry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/registries/epic-session-registry")
    >();
  return {
    ...actual,
    useEpicLocalHomeReading: (): HomeReading =>
      useSyncExternalStore(homeReadingStore.subscribe, homeReadingStore.get),
    useEpicSessionHostIdForEpic: (): string | null =>
      useSyncExternalStore(sessionHostStore.subscribe, sessionHostStore.get),
  };
});

const SESSION_HOST_ID = "host-session";
const EFFECTIVE_HOST_ID = "host-effective";
const EPIC_ID = "epic-recency-wait";
const TAB_ID = "tab-recency-wait";

function seedUnverifiedAuth(): void {
  useAuthStore
    .getState()
    .setUnverifiedSession(
      { userId: "user-1", userName: "User One", email: "user@example.com" },
      { userId: "user-1", username: "User One" },
    );
}

function seedSignedInAuth(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-1",
      userName: "User One",
      email: "user@example.com",
    },
    { userId: "user-1", username: "User One" },
    [],
  );
}

function seedOpenEpicTab(): void {
  const canvas: EpicCanvasState = createEmptyCanvas();
  useEpicCanvasStore.setState({
    tabsById: {
      [TAB_ID]: {
        tabId: TAB_ID,
        epicId: EPIC_ID,
        name: "Recency Wait Epic",
      },
    },
    canvasByTabId: { [TAB_ID]: canvas },
    openTabOrder: [TAB_ID],
    activeTabId: TAB_ID,
    mostRecentTabIdByEpicId: { [EPIC_ID]: TAB_ID },
    artifactTreeByEpicId: { [EPIC_ID]: [] },
  });
}

function publishReadySession(
  hostId: string,
  sessionHostClient: { getActiveHostId: () => string | null } | null,
  handleHostId: string,
): void {
  const handle = Object.assign(Object.create(null), {
    store: {
      getState: () => ({
        accessLost: false,
        epicDeleted: null,
        durabilityStatus: readTestDurabilityStatus(),
        retainedDurabilityStatus: null,
        snapshotFetchError: null,
      }),
      subscribe: homeReadingStore.subscribe,
    },
  }) as OpenEpicStoreHandle;
  handleHostIds.set(handle, handleHostId);
  sessionSnapshotStore.set({
    handle,
    sessionHostId: hostId,
    sessionHostClient,
    presentation: { kind: "ready", targetHostId: hostId },
  });
}

function readTestDurabilityStatus(): "local" | "cloud" | null {
  const reading = homeReadingStore.get();
  if (reading === "local") return "local";
  if (reading === "unstated") return null;
  return "cloud";
}

function renderRoute(queryClient: QueryClient | undefined) {
  const client = queryClient ?? new QueryClient();
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/epics/${EPIC_ID}/${TAB_ID}`],
    }),
    context: {
      queryClient: client,
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient: client };
}

function renderBareEpicRoute(queryClient: QueryClient) {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/epics/$epicId/$tabId",
    component: EpicRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([epicRoute]),
    history: createMemoryHistory({
      initialEntries: [`/epics/${EPIC_ID}/${TAB_ID}`],
    }),
    context: {},
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { router, queryClient };
}

describe("EpicRouteTabSync recency bounded wait (7d521991d)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    homeReadingStore.set("unstated");
    sessionHostStore.set(null);
    sessionSnapshotStore.set({
      handle: null,
      sessionHostId: null,
      sessionHostClient: null,
      presentation: { kind: "establishing", targetHostId: null },
    });
    recordViewedHostIds.length = 0;
    recordViewed.mockReset();
    routeMutationState.useRealMutation = false;
    routeMutationState.client = null;
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
    seedOpenEpicTab();
    publishReadySession(SESSION_HOST_ID, null, SESSION_HOST_ID);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useSelectionAuthorityStore.setState(
      useSelectionAuthorityStore.getInitialState(),
      true,
    );
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useOnboardingStore.setState({ completedAt: null });
    routeMutationState.useRealMutation = false;
    routeMutationState.client = null;
    resetHostConnectionRegistryForTest();
  });

  it("fires once with isLocalHome:true when a local-homed session appears before the bound", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
      refreshAccountHistory: false,
    });

    // The wait's own timer is cleared once the effect re-runs and decides;
    // running whatever remains scheduled must not add a second call.
    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("records on the SESSION's host, not the window's effective host", async () => {
    // The A/B. The route carries the session's `isLocalHome`
    // and used to resolve `useHostClient()` - the window's effective host - so a
    // local session on one machine sent `epic.recordViewed` to another. The
    // host's local-home arm is served out of its OWN store, so that write
    // reached a process that does not have the epic, and it succeeded in the
    // only sense that matters to a toast.
    //
    // The two hosts are the same value on a single-host install and on an
    // unpinned window, which is why this needs both set and set DIFFERENTLY.
    useSelectionAuthorityStore.setState({ effectiveHostId: EFFECTIVE_HOST_ID });
    sessionHostStore.set(SESSION_HOST_ID);
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
      refreshAccountHistory: false,
    });
    // Every render resolved the SESSION host. Asserted over all of them rather
    // than the last: a route that briefly resolved the effective host and
    // settled on the right one would still have dispatched on the wrong one.
    expect(recordViewedHostIds.length).toBeGreaterThan(0);
    expect(new Set(recordViewedHostIds)).toEqual(new Set([SESSION_HOST_ID]));
    expect(recordViewedHostIds).not.toContain(EFFECTIVE_HOST_ID);
  });

  it("does not fall back to an ambient client when no session is open", async () => {
    useSelectionAuthorityStore.setState({ effectiveHostId: EFFECTIVE_HOST_ID });
    sessionHostStore.set(null);
    sessionSnapshotStore.set({
      handle: null,
      sessionHostId: null,
      sessionHostClient: null,
      presentation: { kind: "establishing", targetHostId: null },
    });
    seedSignedInAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("drops a `local` answer that arrives after the bound even if the TIMER never fired", async () => {
    // `setTimeout` is the mechanism that wakes the
    // decision, not the bound itself: a backgrounded tab throttles timers to a
    // minute or more and a busy main thread delays them arbitrarily, so wall
    // time can pass the deadline while the callback is still queued. The
    // publish edge is the only edge that sees the late answer, so it has to
    // check the clock too - otherwise an answer arriving arbitrarily late is
    // recorded as though it had been prompt, and the bound means nothing.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    // `setSystemTime` moves the clock WITHOUT running timers, which is exactly
    // the state being reproduced - `advanceTimersByTime` would fire the wait's
    // own callback and close the decision through the path that already works.
    act(() => {
      vi.setSystemTime(Date.now() + RECENCY_HOME_ANSWER_WAIT_MS + 1_000);
    });
    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).not.toHaveBeenCalled();

    // And the latch closed, so the timer firing later cannot revive it.
    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("expires an overdue deadline even when the VERDICT recovers", async () => {
    // The case the first repair missed. The guard tested
    // `!cloudAuthorized`, so a deadline that passed while unverified stopped
    // being expired the moment the verdict came back: the guard fell through and
    // the cloud branch recorded, stamping the RECOVERY time as the view time.
    // That is the defect the latch was built for, reached through the fix for
    // its sibling. An overdue deadline is expired, never decided.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    act(() => {
      vi.setSystemTime(Date.now() + RECENCY_HOME_ANSWER_WAIT_MS + 60_000);
    });
    act(() => {
      seedSignedInAuth();
    });

    expect(recordViewed).not.toHaveBeenCalled();
    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("expires an overdue deadline when the verdict recovers WITH a local answer", async () => {
    // The second arrangement, because the two arrive through different
    // branches: a recovered verdict alone lands on `cloudAuthorized`, while a
    // verdict plus a local home also satisfies `homeReading === "local"`. Either
    // would have recorded past the bound, and `isLocalHome: true` would have
    // made it look like the legitimate carve-out rather than a late write.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    act(() => {
      vi.setSystemTime(Date.now() + RECENCY_HOME_ANSWER_WAIT_MS + 60_000);
    });
    act(() => {
      homeReadingStore.set("local");
      seedSignedInAuth();
    });

    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("still records a `local` answer that arrives INSIDE the bound with the clock moved", async () => {
    // The control for the row above, and it is doing real work: if the publish
    // edge compared the clock wrongly - a flipped inequality, or a bound of
    // zero - every late answer would drop AND every prompt one would too, and
    // the row above would still pass. Same moved clock, just not past the
    // deadline.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    act(() => {
      vi.setSystemTime(Date.now() + RECENCY_HOME_ANSWER_WAIT_MS - 500);
    });
    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
      refreshAccountHistory: false,
    });
  });

  it("records nothing when the reading is still `unstated` past the bound, and does not retry on a later state change", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    // "No second attempt" must survive a state change an unlatched
    // implementation WOULD have fired on: the session appears and states
    // `local` after the bound already gave up.
    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("decides at mount without burning the bound when the reading is `no-local-claim` at mount", async () => {
    // Unverified + `no-local-claim` decides immediately with `isLocalHome:
    // false` - which the mutation-gate refuses to spend on an unauthorized
    // bearer (`!cloudAuthorized && !isLocalHome`), so nothing is recorded.
    // The claim under test is "decided AT MOUNT, not after a wait": proven by
    // showing the bound never gets a chance to fire the record it would
    // otherwise burn towards - a later local-homed state change stays silent
    // because the one decision was already made.
    seedUnverifiedAuth();
    homeReadingStore.set("no-local-claim");

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    act(() => {
      homeReadingStore.set("local");
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("fires immediately when the reading is `local` at mount - no wait is armed", async () => {
    seedUnverifiedAuth();
    homeReadingStore.set("local");

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
      refreshAccountHistory: false,
    });

    // No wait was armed for this decision: running whatever else is pending
    // must not add a second call.
    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("fires immediately once the verdict is already held, whatever the reading is - first-open behaviour unchanged", async () => {
    seedSignedInAuth();
    homeReadingStore.set("unstated");

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
      refreshAccountHistory: false,
    });

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("allows a distinct History reader refresh only when the computer stated cloud durability", async () => {
    seedSignedInAuth();
    homeReadingStore.set("no-local-claim");

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
      refreshAccountHistory: true,
    });
  });

  it("fires when the verdict returns DURING the wait - the deliberate trade", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(() => {
      seedSignedInAuth();
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
      refreshAccountHistory: false,
    });

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the verdict returns AFTER the bound - the marker is already set", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute(undefined);
      return Promise.resolve();
    });

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(() => {
      seedSignedInAuth();
      return Promise.resolve();
    });

    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("waits for the explicit computer row and sends one addressed unary through teardown", async () => {
    vi.useRealTimers();
    const viewerId = "user-fixture-1";
    useAuthStore.getState().setSignedIn(
      {
        userId: viewerId,
        userName: "User One",
        email: "user@example.com",
      },
      { userId: viewerId, username: "User One" },
      [],
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const writerRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    const readerHostId = "history-answering-computer";
    const readerRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    const writerKey = cloudEpicTasksQueryKey(
      SESSION_HOST_ID,
      viewerId,
      writerRequest,
    );
    const readerKey = cloudEpicTasksQueryKey(
      readerHostId,
      viewerId,
      readerRequest,
    );
    const page = { tasks: [], hasMore: false };
    queryClient.setQueryData(writerKey, page);
    queryClient.setQueryData(readerKey, page);
    const writerIdentity = cloudEpicTasksPageIdentity(
      SESSION_HOST_ID,
      viewerId,
      writerRequest,
    );
    const readerIdentity = cloudEpicTasksPageIdentity(
      readerHostId,
      viewerId,
      readerRequest,
    );
    for (const identity of [writerIdentity, readerIdentity]) {
      useCloudEpicTasksPagesStore.getState().appendPage(identity, 0, page);
    }
    let writerReads = 0;
    let readerReads = 0;
    const writerObserver = new QueryObserver(queryClient, {
      queryKey: writerKey,
      queryFn: () => {
        writerReads += 1;
        return Promise.resolve(page);
      },
      staleTime: Infinity,
    });
    const readerObserver = new QueryObserver(queryClient, {
      queryKey: readerKey,
      queryFn: () => {
        readerReads += 1;
        return Promise.resolve(page);
      },
      staleTime: Infinity,
    });
    const unsubscribeWriter = writerObserver.subscribe(() => undefined);
    const unsubscribeReader = readerObserver.subscribe(() => undefined);
    const requestContext = createRequestContextFixture({
      origin: "renderer",
      bearerToken: "test",
    });
    let directoryReady = false;
    const directoryListeners = new Set<() => void>();
    const hostEntry = { ...mockLocalHostEntry, hostId: SESSION_HOST_ID };
    const findById = (hostId: string) =>
      hostId === SESSION_HOST_ID && directoryReady ? hostEntry : null;
    let reply!: (response: { readonly viewedAt: number }) => void;
    const pendingReply = new Promise<{ readonly viewedAt: number }>(
      (resolve) => {
        reply = resolve;
      },
    );
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "route-record-viewed",
      handlers: {
        "epic.recordViewed": () => pendingReply,
      },
    });
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      messenger,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: findById,
    });
    client.setRequestContext(requestContext);
    const requester = client.createRequesterForHostId(SESSION_HOST_ID);
    routeMutationState.client = requester;
    routeMutationState.useRealMutation = true;
    installHostConnectionRegistrySource({
      directory: {
        findById,
        onDirectoryChanged: (listener) => {
          directoryListeners.add(listener);
          return { dispose: () => directoryListeners.delete(listener) };
        },
      },
      leases: null,
    });
    sessionSnapshotStore.set({
      handle: null,
      sessionHostId: null,
      sessionHostClient: null,
      presentation: { kind: "establishing", targetHostId: SESSION_HOST_ID },
    });
    renderBareEpicRoute(queryClient);
    expect(messenger.calls).toHaveLength(0);

    act(() =>
      publishReadySession(SESSION_HOST_ID, requester, "different-host"),
    );
    expect(messenger.calls).toHaveLength(0);
    const mismatched = sessionSnapshotStore.get();
    expect(mismatched.presentation).toEqual({
      kind: "ready",
      targetHostId: SESSION_HOST_ID,
    });
    expect(mismatched.sessionHostId).toBe(SESSION_HOST_ID);
    expect(requester.getActiveHostId()).toBeNull();

    const outgoingHandle = mismatched.handle;
    if (outgoingHandle === null) {
      throw new Error("expected the retained computer handle");
    }
    handleHostIds.set(outgoingHandle, SESSION_HOST_ID);
    act(() => {
      sessionSnapshotStore.set({
        ...mismatched,
        presentation: { kind: "establishing", targetHostId: POOL_HOST_ID },
      });
    });
    expect(messenger.calls).toHaveLength(0);
    expect(sessionSnapshotStore.get().handle).toBe(outgoingHandle);

    act(() => publishReadySession(SESSION_HOST_ID, requester, SESSION_HOST_ID));
    const acceptedSnapshot = sessionSnapshotStore.get();
    expect(acceptedSnapshot.presentation).toEqual({
      kind: "ready",
      targetHostId: SESSION_HOST_ID,
    });
    expect(acceptedSnapshot.sessionHostClient).toBe(requester);
    expect(requester.getActiveHostId()).toBeNull();
    expect(messenger.calls).toHaveLength(0);
    const controllerReadsBeforeRow = sessionSnapshotStore.readCount();

    act(() => {
      directoryReady = true;
      for (const listener of directoryListeners) listener();
    });
    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(sessionSnapshotStore.readCount()).toBeGreaterThan(
      controllerReadsBeforeRow,
    );
    expect(sessionSnapshotStore.get()).toBe(acceptedSnapshot);
    expect(acceptedSnapshot.sessionHostClient).toBe(requester);
    expect(requester.getActiveHostId()).toBe(SESSION_HOST_ID);
    expect(messenger.calls[0]).toMatchObject({
      method: "epic.recordViewed",
      params: { epicId: EPIC_ID },
    });

    cleanup();
    reply({ viewedAt: 1_800_000_000_000 });
    await pendingReply;
    await waitFor(() => expect(writerReads).toBe(1));
    expect(readerReads).toBe(0);
    expect(cloudEpicTasksPageGeneration(writerIdentity)).toBe(1);
    expect(cloudEpicTasksPageGeneration(readerIdentity)).toBe(0);
    expect(messenger.calls).toHaveLength(1);
    unsubscribeWriter();
    unsubscribeReader();
    queryClient.clear();
    client.dispose();
  });

  it("sends the optional unary to the accepted pool peer and does not replay after teardown", async () => {
    vi.useRealTimers();
    const viewerId = "user-fixture-1";
    useAuthStore.getState().setSignedIn(
      {
        userId: viewerId,
        userName: "User One",
        email: "user@example.com",
      },
      { userId: viewerId, username: "User One" },
      [],
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const readerHostId = "history-answering-computer";
    const organizationLastViewedRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
      filters: { labelNames: ["ops"] },
    };
    const samePeerRequest = {
      ...LIST_CLOUD_TASKS_REQUEST,
      sort: "last-viewed" as const,
    };
    expect(historyPageMethod(organizationLastViewedRequest)).toBe(
      "organization.history",
    );
    let organizationReads = 0;
    let samePeerReads = 0;
    let recentReads = 0;
    const organizationKey = cloudEpicTasksQueryKey(
      readerHostId,
      viewerId,
      organizationLastViewedRequest,
    );
    const samePeerKey = cloudEpicTasksQueryKey(
      readerHostId,
      viewerId,
      samePeerRequest,
    );
    const recentKey = cloudEpicTasksQueryKey(
      readerHostId,
      viewerId,
      LIST_CLOUD_TASKS_REQUEST,
    );
    const otherViewerKey = cloudEpicTasksQueryKey(
      readerHostId,
      "other-viewer",
      samePeerRequest,
    );
    const readerIdentities = [
      cloudEpicTasksPageIdentity(
        readerHostId,
        viewerId,
        organizationLastViewedRequest,
      ),
      cloudEpicTasksPageIdentity(readerHostId, viewerId, samePeerRequest),
    ];
    for (const identity of readerIdentities) {
      useCloudEpicTasksPagesStore
        .getState()
        .appendPage(identity, 0, { tasks: [], hasMore: false });
    }
    const readerPage = { tasks: [], hasMore: false };
    for (const queryKey of [
      organizationKey,
      samePeerKey,
      recentKey,
      otherViewerKey,
    ]) {
      queryClient.setQueryData(queryKey, readerPage);
    }
    const organizationObserver = new QueryObserver(queryClient, {
      queryKey: organizationKey,
      queryFn: () => {
        organizationReads += 1;
        return Promise.resolve(readerPage);
      },
      staleTime: Infinity,
    });
    const samePeerObserver = new QueryObserver(queryClient, {
      queryKey: samePeerKey,
      queryFn: () => {
        samePeerReads += 1;
        return Promise.resolve(readerPage);
      },
      staleTime: Infinity,
    });
    const recentObserver = new QueryObserver(queryClient, {
      queryKey: recentKey,
      queryFn: () => {
        recentReads += 1;
        return Promise.resolve(readerPage);
      },
      staleTime: Infinity,
    });
    const unsubscribeOrganization = organizationObserver.subscribe(
      () => undefined,
    );
    const unsubscribeSamePeer = samePeerObserver.subscribe(() => undefined);
    const unsubscribeRecent = recentObserver.subscribe(() => undefined);
    const poolEntry = { ...mockLocalHostEntry, hostId: POOL_HOST_ID };
    let reply!: (response: { readonly viewedAt: number }) => void;
    const pendingReply = new Promise<{ readonly viewedAt: number }>(
      (resolve) => {
        reply = resolve;
      },
    );
    const messenger = new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "pool-record-viewed",
      handlers: {
        "epic.recordViewed": () => pendingReply,
      },
    });
    const client = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      messenger,
      invalidator: { invalidateHostScope: () => undefined },
      findHostById: (hostId) => (hostId === POOL_HOST_ID ? poolEntry : null),
    });
    client.setRequestContext(
      createRequestContextFixture({ origin: "renderer", bearerToken: "test" }),
    );
    const requester = client.createRequesterForHostId(POOL_HOST_ID);
    routeMutationState.client = requester;
    routeMutationState.useRealMutation = true;
    publishReadySession(POOL_HOST_ID, requester, POOL_HOST_ID);

    renderRoute(queryClient);
    await waitFor(() => expect(messenger.calls).toHaveLength(1));
    expect(messenger.calls[0]).toMatchObject({
      method: "epic.recordViewed",
      params: { epicId: EPIC_ID },
    });
    expect(requester.getActiveHostId()).toBe(POOL_HOST_ID);
    expect(organizationReads).toBe(0);
    expect(samePeerReads).toBe(0);

    cleanup();
    reply({ viewedAt: 1_800_000_000_001 });
    await pendingReply;
    await waitFor(() => {
      expect(organizationReads).toBe(1);
      expect(samePeerReads).toBe(1);
    });
    expect(recentReads).toBe(0);
    expect(queryClient.getQueryData(otherViewerKey)).toBeDefined();
    for (const identity of readerIdentities) {
      expect(cloudEpicTasksPageGeneration(identity)).toBe(1);
    }
    await Promise.resolve();
    expect(messenger.calls).toHaveLength(1);
    unsubscribeOrganization();
    unsubscribeSamePeer();
    unsubscribeRecent();
    queryClient.clear();
    client.dispose();
  });
});
