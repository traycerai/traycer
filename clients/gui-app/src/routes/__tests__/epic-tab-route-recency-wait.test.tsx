import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { RECENCY_HOME_ANSWER_WAIT_MS } from "@/routes/epic-tab-route-components";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";

/**
 * `7d521991d` - the bounded-wait recency decision inside
 * `epic-tab-route-components.tsx`'s `EpicRouteTabSync`. Gap 3 of the lane 9
 * evidence artifact (§3.3): this pins the SECOND table there, the route's
 * decision over time. The first table (`readEpicLocalHomeReading`'s own
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

vi.mock("@/components/layout/header/windows-menu-bar", () => ({
  WindowsMenuBar: () => null,
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

vi.mock("@/components/layout/bridges/notification-focus-bridge", () => ({
  NotificationFocusBridge: () => null,
}));
vi.mock("@/components/layout/bridges/notification-emission-controller", () => ({
  NotificationEmissionController: () => null,
}));

vi.mock("@/components/layout/dialogs/system-tab-modal-host", () => ({
  SystemTabModalHost: () => null,
}));

vi.mock("@/components/layout/bridges/tray-open-epic-bridge", () => ({
  TrayOpenEpicBridge: () => null,
}));

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({ tasks: [] }),
}));

vi.mock("@/hooks/epic/use-epic-record-viewed-mutation", () => ({
  useEpicRecordViewed: (hostId: string | null) => {
    recordViewedHostIds.push(hostId);
    return { mutate: recordViewed };
  },
}));

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
  const actual = await importOriginal<
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

function renderRoute() {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({
      initialEntries: [`/epics/${EPIC_ID}/${TAB_ID}`],
    }),
    context: {
      queryClient: new QueryClient(),
      getAuthSnapshot: () => useAuthStore.getState(),
      getHostClient: () => null,
    },
  });
  render(<RouterProvider router={router} />);
  return router;
}

describe("EpicRouteTabSync recency bounded wait (7d521991d)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    homeReadingStore.set("unstated");
    sessionHostStore.set(null);
    recordViewedHostIds.length = 0;
    recordViewed.mockReset();
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
    seedOpenEpicTab();
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
  });

  it("fires once with isLocalHome:true when a local-homed session appears before the bound", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute();
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
    // The cold reviewer's A/B. The route carries the session's `isLocalHome`
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
      renderRoute();
      return Promise.resolve();
    });
    act(() => {
      homeReadingStore.set("local");
    });

    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
    });
    // Every render resolved the SESSION host. Asserted over all of them rather
    // than the last: a route that briefly resolved the effective host and
    // settled on the right one would still have dispatched on the wrong one.
    expect(recordViewedHostIds.length).toBeGreaterThan(0);
    expect(new Set(recordViewedHostIds)).toEqual(new Set([SESSION_HOST_ID]));
    expect(recordViewedHostIds).not.toContain(EFFECTIVE_HOST_ID);
  });

  it("falls back to the following client when NO session is open", async () => {
    // The control, and the reason `null` is not a defect: with no session
    // nothing stated a local home, so the write is the ordinary cloud one that
    // any host proxies to the account - which is what the effective host has
    // always correctly served. `null` is how `useEpicRecordViewed` asks for
    // that, so the route passing it through is the shipped behaviour, not a
    // missing host.
    useSelectionAuthorityStore.setState({ effectiveHostId: EFFECTIVE_HOST_ID });
    sessionHostStore.set(null);
    seedSignedInAuth();

    await act(() => {
      renderRoute();
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(new Set(recordViewedHostIds)).toEqual(new Set([null]));
  });

  it("drops a `local` answer that arrives after the bound even if the TIMER never fired", async () => {
    // The cold reviewer's finding. `setTimeout` is the mechanism that wakes the
    // decision, not the bound itself: a backgrounded tab throttles timers to a
    // minute or more and a busy main thread delays them arbitrarily, so wall
    // time can pass the deadline while the callback is still queued. The
    // publish edge is the only edge that sees the late answer, so it has to
    // check the clock too - otherwise an answer arriving arbitrarily late is
    // recorded as though it had been prompt, and the bound means nothing.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute();
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
    // The reviewer's case, and the one my first repair missed. The guard tested
    // `!cloudAuthorized`, so a deadline that passed while unverified stopped
    // being expired the moment the verdict came back: the guard fell through and
    // the cloud branch recorded, stamping the RECOVERY time as the view time.
    // That is the defect the latch was built for, reached through the fix for
    // its sibling. An overdue deadline is expired, never decided.
    seedUnverifiedAuth();

    await act(() => {
      renderRoute();
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
      renderRoute();
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
      renderRoute();
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
    });
  });

  it("records nothing when the reading is still `unstated` past the bound, and does not retry on a later state change", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute();
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
      renderRoute();
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
      renderRoute();
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
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
      renderRoute();
      return Promise.resolve();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
    });

    await act(() => {
      vi.runOnlyPendingTimers();
      return Promise.resolve();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("fires when the verdict returns DURING the wait - the deliberate trade", async () => {
    seedUnverifiedAuth();

    await act(() => {
      renderRoute();
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
      renderRoute();
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
});
