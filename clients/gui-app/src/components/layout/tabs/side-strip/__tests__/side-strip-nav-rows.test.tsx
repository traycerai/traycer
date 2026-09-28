/**
 * `SideStripNavRows` (D6): the Notifications row (one unread count, tinted by needs-you,
 * collapsed badge, admission gate) and the All tasks row (shortcut, active
 * state), plus the Tasks label above the rows. Mounted through the real
 * `SideTabStrip` so `ColumnEdgeContext`, the popover store and the real
 * host-notifications pipeline are exactly what production wires.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostNotificationEntryV22 } from "@traycer/protocol/host/notifications/contracts";
import { SideTabStrip } from "@/components/layout/tabs/side-strip/side-tab-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";
import { useSideTabStripStore } from "@/stores/layout/side-tab-strip-store";
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";
import { __resetAppLocalNotificationsStoreForTests } from "@/stores/notifications/app-local-notifications-store";
import {
  __resetHostNotificationsStoreForTests,
  useHostNotificationsStore,
} from "@/stores/notifications/host-notifications-store";
import { __resetNotificationsStoreForTests } from "@/stores/notifications/notifications-store";
import { useNotificationsPopoverStore } from "@/stores/notifications/notifications-popover-store";
import { useKeybindingStore } from "@/stores/settings/keybinding-store";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

function createRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://example.com",
    authnBaseUrl: "https://auth.example.com",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

function makeMessengerFactory(): (args: {
  registry: HostRpcRegistry;
}) => IHostMessenger<HostRpcRegistry> {
  return (args) =>
    new MockHostMessenger<HostRpcRegistry>({
      registry: args.registry,
      requestId: () => "req-1",
      handlers: {
        "host.status": () =>
          Promise.resolve({
            ready: true,
            hostVersion: "1.2.3",
            protocolVersion: { major: 1, minor: 0 },
            busy: false,
            busySessionCount: 0,
            updateProgress: null,
            busyBreakdown: null,
            updateOperation: null,
            updateTransaction: null,
            storeFormats: null,
            install: null,
          }),
      },
    });
}

function renderHarness(tree: ReactNode): void {
  const runnerHost = createRunnerHost();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <RunnerHostProvider runnerHost={runnerHost}>
          <HostRuntimeProvider
            registry={hostRpcRegistry}
            messengerFactory={makeMessengerFactory()}
            invalidator={null}
            requestId={null}
            remoteFetcher={() =>
              Promise.resolve({ kind: "hosts", entries: [] })
            }
            fallback={<div data-testid="runtime-fallback">…</div>}
          >
            <TooltipProvider>{tree}</TooltipProvider>
          </HostRuntimeProvider>
        </RunnerHostProvider>
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

function resetSharedState(): void {
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useSideTabStripStore.setState({ widthPx: 240, collapsed: false });
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
  useLayoutStore.getState().setRegionValues("homeTab", { shown: "hidden" });
  useTitleBarDragStore.setState({ suppressors: new Set() });
  useNotificationsPopoverStore.getState().setOpen(false);
  __resetNotificationsStoreForTests();
  __resetHostNotificationsStoreForTests();
  __resetAppLocalNotificationsStoreForTests();
  useKeybindingStore.getState().resetAll();
  window.localStorage.clear();
}

function signIn(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "test-user",
      userName: "Ada Lovelace",
      email: "ada@example.com",
    },
    { userId: "test-user", username: "Ada Lovelace" },
    [],
  );
}

function approvalEntry(
  id: string,
  updatedAt: number,
): HostNotificationEntryV22 {
  return {
    id,
    updatedAt,
    readAt: null,
    kind: "approval.requested",
    sourceRef: id,
    severity: "needs_action",
    outcome: null,
    resolvedAt: null,
    epicId: "epic-1",
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Deploy checkout fix",
      approvalId: id,
    },
  };
}

/** Seeds the host feed with `count` unresolved approvals, driving both the
 * unread and the needs-you counts at once (a fresh prompt is unread by
 * construction). */
function seedApprovals(count: number): void {
  const entries = Array.from({ length: count }, (_unused, index) =>
    approvalEntry(`approval-${index}`, 10 + index),
  );
  act(() => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries, nextCursor: null },
      recent: { entries, nextCursor: null },
      summary: { unreadCount: count, attentionCount: count },
    });
  });
}

function openEpicTabs(names: ReadonlyArray<string>): void {
  const refs = names.map((name): TabRef => {
    const id = `e-${name.toLowerCase().replaceAll(" ", "-")}`;
    useEpicCanvasStore.getState().seedEpic(id, { tabId: id, name }, []);
    return { kind: "epic", id };
  });
  const firstRef = refs.at(0);
  useTabsStore.setState({
    version: 2,
    items: refs.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
    activeItemId: firstRef === undefined ? null : tabItemId(firstRef),
    stripOrder: refs,
    systemTabs: { history: null, settings: null },
  });
}

function renderStrip(edge: "left" | "right"): void {
  renderHarness(
    <WindowsBridgeContext.Provider value={{ bridge: null, hasHydrated: true }}>
      <SideTabStrip edge={edge} ownsTitleBar={false} />
    </WindowsBridgeContext.Provider>,
  );
}

describe("SideStripNavRows", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("hides the Inbox row when auth does not admit the local plane, keeping All tasks", async () => {
    useAuthStore.getState().setSignedOut();
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-inbox")).toBeNull();
    expect(screen.getByTestId("side-strip-all-tasks")).toBeTruthy();
  });

  it("keeps the drawer anchor after the Inbox trigger in DOM order (regression pin)", async () => {
    // Radix reports a PopoverAnchor only when it changes; placed before the
    // trigger, the anchor measured the trigger's own detached remount
    // instead of the strip's box (see side-strip-nav-rows.tsx).
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const trigger = screen.getByTestId("side-strip-inbox");
    const anchor = screen.getByTestId("inbox-drawer-anchor");
    expect(
      trigger.compareDocumentPosition(anchor) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("shows one unread count, tinted while an ask needs you, hidden at 0", async () => {
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-inbox-count")).toBeNull();

    seedApprovals(2);

    const badge = screen.getByTestId("side-strip-inbox-count");
    expect(badge.textContent).toBe("2");
    expect(badge.dataset.needsYou).toBe("true");
  });

  it("collapsed: shows one amber corner badge sized by the needs-you count", async () => {
    useSideTabStripStore.setState({ collapsed: true });
    seedApprovals(3);
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(
      screen.getByTestId("side-strip-inbox-needs-you-badge").textContent,
    ).toBe("3");
    expect(screen.queryByTestId("side-strip-inbox-count")).toBeNull();
  });

  it("collapsed: shows no badge with nothing waiting", async () => {
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-inbox-needs-you-badge")).toBeNull();
  });

  it.each([
    { collapsed: false, label: "expanded" },
    { collapsed: true, label: "collapsed" },
  ])(
    "$label: shows the unavailable indicator while the bell state is unknown",
    async ({ collapsed }) => {
      useSideTabStripStore.setState({ collapsed });
      renderStrip("left");
      await screen.findByTestId("side-tab-strip");

      expect(
        screen.getByTestId("side-strip-inbox-unknown-indicator"),
      ).toBeTruthy();
      expect(
        screen.getByTestId("side-strip-inbox").getAttribute("aria-label"),
      ).toBe("Notifications, status unavailable");
    },
  );

  it("hides the unavailable indicator once the host summary is known and clear", async () => {
    seedApprovals(0);
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(
      screen.queryByTestId("side-strip-inbox-unknown-indicator"),
    ).toBeNull();
    expect(
      screen.getByTestId("side-strip-inbox").getAttribute("aria-label"),
    ).toBe("Notifications");
  });

  it("shows the All tasks shortcut only when a binding exists", async () => {
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const chord = useKeybindingStore.getState().bindings["app.history.open"];
    if (chord === null) throw new Error("expected a default binding");
    expect(screen.getByTestId("side-strip-all-tasks").textContent).toBe(
      `All tasks${formatChordForDisplay(chord)}`,
    );
  });

  it("hides the All tasks shortcut text once its binding is cleared", async () => {
    useKeybindingStore.getState().clearBinding("app.history.open");
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const row = screen.getByTestId("side-strip-all-tasks");
    expect(row.textContent).toBe("All tasks");
  });

  it("shows the Tasks label with the open task count only when expanded", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(screen.getByTestId("side-strip-tasks-label").textContent).toBe(
      "Tasks2",
    );

    fireEvent.click(screen.getByTestId("side-tab-strip-collapse"));
    expect(screen.queryByTestId("side-strip-tasks-label")).toBeNull();
  });
});
