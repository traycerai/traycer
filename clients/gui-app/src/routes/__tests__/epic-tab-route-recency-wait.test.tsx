import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useSyncExternalStore, type ReactNode } from "react";
import {
  RouterProvider,
  createMemoryHistory,
  createRouter,
} from "@tanstack/react-router";
import { QueryClient } from "@tanstack/react-query";
import { routeTree } from "@/routeTree.gen";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useOnboardingStore } from "@/stores/onboarding/onboarding-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
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
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const recordViewed = vi.hoisted(() => vi.fn());

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
  useEpicRecordViewed: () => ({ mutate: recordViewed }),
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
  };
});

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
    recordViewed.mockReset();
    useOnboardingStore.setState({ completedAt: 1_700_000_000_000 });
    seedOpenEpicTab();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    useAuthStore.getState().setSignedOut();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    useOnboardingStore.setState({ completedAt: null });
  });

  it("fires once with isLocalHome:true when a local-homed session appears before the bound", async () => {
    seedUnverifiedAuth();

    await act(async () => {
      renderRoute();
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
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the reading is still `unstated` past the bound, and does not retry on a later state change", async () => {
    seedUnverifiedAuth();

    await act(async () => {
      renderRoute();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
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

    await act(async () => {
      renderRoute();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    act(() => {
      homeReadingStore.set("local");
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).not.toHaveBeenCalled();
  });

  it("fires immediately when the reading is `local` at mount - no wait is armed", async () => {
    seedUnverifiedAuth();
    homeReadingStore.set("local");

    await act(async () => {
      renderRoute();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: true,
    });

    // No wait was armed for this decision: running whatever else is pending
    // must not add a second call.
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("fires immediately once the verdict is already held, whatever the reading is - first-open behaviour unchanged", async () => {
    seedSignedInAuth();
    homeReadingStore.set("unstated");

    await act(async () => {
      renderRoute();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("fires when the verdict returns DURING the wait - the deliberate trade", async () => {
    seedUnverifiedAuth();

    await act(async () => {
      renderRoute();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(async () => {
      seedSignedInAuth();
    });

    expect(recordViewed).toHaveBeenCalledTimes(1);
    expect(recordViewed).toHaveBeenCalledWith({
      epicId: EPIC_ID,
      isLocalHome: false,
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).toHaveBeenCalledTimes(1);
  });

  it("records nothing when the verdict returns AFTER the bound - the marker is already set", async () => {
    seedUnverifiedAuth();

    await act(async () => {
      renderRoute();
    });

    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(recordViewed).not.toHaveBeenCalled();

    await act(async () => {
      seedSignedInAuth();
    });

    expect(recordViewed).not.toHaveBeenCalled();
  });
});
