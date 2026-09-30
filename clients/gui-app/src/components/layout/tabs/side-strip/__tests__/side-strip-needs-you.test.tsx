/**
 * `SideStripNeedsYou` (D10, D13): the Activity view's Needs you block, pinned
 * under the nav rows. Mounted through the real `SideTabStrip` so the real
 * host-notifications pipeline, `useNeedsYouItems` and the arrangement/strip
 * stores are exactly what production reads. `NeedsYouItem` itself and
 * `useNeedsYouItems`'s selection logic are covered in their own suites
 * (`needs-you-item.test.tsx`, `needs-you-items.test.ts`); this suite is the
 * block's own visibility rule and its wiring to the shared item component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import type { NotificationActivationInput } from "@/hooks/notifications/use-notification-activation";
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
import { SampleSceneContext } from "@/components/sample-workspace/sample-scene-context";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLayoutEditorStore } from "@/stores/layout/layout-editor-store";
import { tabItemId, tabRefKey } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
import { useStripDisclosureStore } from "../strip-disclosure";
import { chatProjection, coolAllEpics, warmEpic } from "./warm-epic-fixture";
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

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

// The activation pipeline itself (routing, markAsRead, the origin-host guard)
// is `useNotificationActivation`'s own suite
// (`use-notification-activation.test.tsx`); this file owns only whether
// `SideStripNeedsYou` wires a click to it for the right row, with the strip
// surface.
const activateSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivation: () => ({ activate: activateSpy }),
}));

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
  const epicRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "epics/$epicId/$tabId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, epicRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(<RouterProvider router={router} />);
}

function resetSharedState(): void {
  __resetTabNavigationControllerForTesting();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useLayoutEditorStore.setState({
    hoveredSetting: null,
    selectedSetting: null,
  });
  coolAllEpics();
  useStripDisclosureStore.setState({ expanded: {} });
  __resetAgentActivityStoreForTests();
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useSideTabStripStore.setState({ collapsed: false });
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
  epicId: string,
  chatId: string,
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
    epicId,
    chatId,
    payload: {
      kind: "approval",
      epicId,
      chatId,
      chatTitle: "Deploy checkout fix",
      taskTitle: "Deploy checkout fix",
      approvalId: id,
    },
  };
}

function seedApprovals(count: number): void {
  seedApprovalsFor(
    Array.from({ length: count }, (_unused, index) => ({
      id: `approval-${index}`,
      epicId: "epic-1",
      chatId: "chat-1",
    })),
  );
}

function seedApprovalsFor(
  approvals: ReadonlyArray<{
    readonly id: string;
    readonly epicId: string;
    readonly chatId: string;
  }>,
): void {
  const count = approvals.length;
  const entries = approvals.map(({ id, epicId, chatId }, index) =>
    approvalEntry(id, 10 + index, epicId, chatId),
  );
  act(() => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries, nextCursor: null },
      recent: { entries, nextCursor: null },
      summary: { unreadCount: count, attentionCount: count },
    });
  });
}

/** Vertical, expanded, Activity: the one arrangement `useLiveAgentsInStrip` admits. */
function activateActivityView(): void {
  act(() => {
    useLayoutStore.setState({
      arrangement: {
        ...DEFAULT_ARRANGEMENT,
        tabStripPlacement: "left",
        sideStripView: "activity",
      },
    });
  });
}

function renderStrip(): void {
  renderHarness(
    <WindowsBridgeContext.Provider value={{ bridge: null, hasHydrated: true }}>
      <SideTabStrip edge="left" ownsTitleBar={false} />
    </WindowsBridgeContext.Provider>,
  );
}

/**
 * The strip as the layout editor's canvas frames it: `SampleSceneContext`
 * true, the way `SampleWorkspaceSurface` provides it for a live session
 * (B1). `false` renders the identical tree the app's own window does -
 * `renderStrip` above is a plain call of this with `false`, kept separate
 * only because most of the file's cases have no reason to name the context
 * at all.
 */
function renderStripInSampleScene(sample: boolean): void {
  renderHarness(
    <SampleSceneContext.Provider value={sample}>
      <WindowsBridgeContext.Provider
        value={{ bridge: null, hasHydrated: true }}
      >
        <SideTabStrip edge="left" ownsTitleBar={false} />
      </WindowsBridgeContext.Provider>
    </SampleSceneContext.Provider>,
  );
}

describe("SideStripNeedsYou", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("stays hidden in the Layered view even with prompts waiting", async () => {
    seedApprovals(1);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("stays hidden with nothing waiting, even in the Activity view", async () => {
    activateActivityView();
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("stays hidden while the strip is collapsed", async () => {
    activateActivityView();
    seedApprovals(1);
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("shows the waiting prompts, with a heading count matching the items", async () => {
    activateActivityView();
    seedApprovals(2);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const block = await screen.findByTestId("side-strip-needs-you");
    expect(block.textContent).toContain("Needs you");
    expect(block.textContent).toContain("2");
    expect(screen.getAllByTestId("needs-you-item")).toHaveLength(2);
  });

  it("appears live as the strip flips into the Activity view, and leaves it again", async () => {
    seedApprovals(1);
    renderStrip();
    await screen.findByTestId("side-tab-strip");
    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();

    activateActivityView();
    expect(await screen.findByTestId("side-strip-needs-you")).toBeTruthy();

    act(() => {
      useLayoutStore.setState((state) => ({
        arrangement: { ...state.arrangement, sideStripView: "layered" },
      }));
    });
    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("wires a click to the shared activation path for that row, on the strip surface (D13)", async () => {
    activateActivityView();
    seedApprovals(1);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const item = await screen.findByTestId("needs-you-item");
    expect(item.dataset.notificationId).toBe("host:approval-0");
    expect(activateSpy).not.toHaveBeenCalled();

    fireEvent.click(item);

    expect(activateSpy).toHaveBeenCalledTimes(1);
    const input = activateSpy.mock.calls[0][0] as NotificationActivationInput;
    expect(input.feedId).toBe("host:approval-0");
    expect(input.payload).toMatchObject({
      kind: "approval",
      epicId: "epic-1",
      chatId: "chat-1",
    });
    // The outcome is reported for the strip surface. A failed outcome keeps
    // the row unread, so reporting it touches no feed state.
    const track = vi.spyOn(Analytics.getInstance(), "track");
    try {
      input.onResult?.("failure");
      expect(track).toHaveBeenCalledWith(
        AnalyticsEvent.NotificationActivationCompleted,
        expect.objectContaining({ surface: "strip", outcome: "failure" }),
      );
    } finally {
      track.mockRestore();
    }
  });
});

/**
 * A prompt is listed in one place: under its task's row when the strip draws
 * that task, else in the pinned block. The task's tab is seeded the way a real
 * window holds it, and a cold task nests its prompt as a needs-you row.
 */
describe("SideStripNeedsYou, tasks with a row in the strip (D10)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  function seedTaskTabs(
    epicIds: ReadonlyArray<string>,
    collapsedGroupOf: string | null,
  ): void {
    const refs: ReadonlyArray<TabRef> = epicIds.map((id) => ({
      kind: "epic",
      id,
    }));
    for (const id of epicIds) {
      useEpicCanvasStore
        .getState()
        .seedEpic(id, { tabId: id, name: `Task ${id}` }, []);
    }
    useTabsStore.setState({
      version: 2,
      items: refs.map((ref) => ({ kind: "tab", id: tabItemId(ref), ref })),
      activeItemId: tabItemId(refs[0]),
      stripOrder: refs,
      systemTabs: { history: null, settings: null },
      groups:
        collapsedGroupOf === null
          ? {}
          : { g1: { name: "Group", color: "#8ab4f8", collapsed: true } },
      customizations:
        collapsedGroupOf === null
          ? {}
          : {
              [tabRefKey({ kind: "epic", id: collapsedGroupOf })]: {
                color: null,
                icon: null,
                groupId: "g1",
              },
            },
    });
  }

  it("lists a prompt only under its task while the strip draws that task", async () => {
    activateActivityView();
    seedTaskTabs(["epic-1"], null);
    seedApprovals(1);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(
      await screen.findByTestId("strip-agent-host:approval-0"),
    ).toBeTruthy();
    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("nests a warm collapsed task's prompt whose chat has no waiting agent, and pins nothing", async () => {
    activateActivityView();
    // epic-2 is in front, so epic-1 is collapsed; its one live agent is busy.
    seedTaskTabs(["epic-2", "epic-1"], null);
    warmEpic("epic-1", [chatProjection("chat-1", { title: "Busy agent" })]);
    __setAgentActivityStateForTests(
      { "epic-1": { working: ["chat-1"], turn: ["chat-1"] } },
      "local",
      "connected",
    );
    seedApprovalsFor([
      { id: "approval-unmatched", epicId: "epic-1", chatId: "chat-9" },
    ]);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    expect(
      await screen.findByTestId("strip-agent-host:approval-unmatched"),
    ).toBeTruthy();
    expect(screen.queryByTestId("strip-agent-chat-1")).toBeNull();
    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
  });

  it("keeps a prompt whose task has no row in the pinned block, beside a task that has one", async () => {
    activateActivityView();
    seedTaskTabs(["epic-1"], null);
    seedApprovalsFor([
      { id: "approval-in-strip", epicId: "epic-1", chatId: "chat-1" },
      { id: "approval-elsewhere", epicId: "epic-2", chatId: "chat-2" },
    ]);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const block = await screen.findByTestId("side-strip-needs-you");
    const items = within(block).getAllByTestId("needs-you-item");
    expect(items.map((item) => item.dataset.notificationId)).toEqual([
      "host:approval-elsewhere",
    ]);
    expect(
      screen.getByTestId("strip-agent-host:approval-in-strip"),
    ).toBeTruthy();
  });

  it("keeps a prompt in the pinned block when its task sits in a collapsed group, which draws no row", async () => {
    activateActivityView();
    seedTaskTabs(["epic-1", "epic-2"], "epic-1");
    seedApprovalsFor([
      { id: "approval-hidden", epicId: "epic-1", chatId: "chat-1" },
    ]);
    renderStrip();
    await screen.findByTestId("side-tab-strip");

    const block = await screen.findByTestId("side-strip-needs-you");
    expect(
      within(block)
        .getAllByTestId("needs-you-item")
        .map((item) => item.dataset.notificationId),
    ).toEqual(["host:approval-hidden"]);
  });
});

/**
 * The layout editor's canvas frames the sample scene, never the person's own
 * (B1): the strip's needs-you read is empty while `useSampleScene()` is true.
 * The sample task's waiting agent already shows under its row, so the pinned
 * block has nothing of the sample's to list either. A real pending prompt is
 * seeded in every case below, so a regression that read the real feed would
 * show it in the block.
 */
describe("SideStripNeedsYou, framing the sample scene (B1)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("shows no block in place of a real prompt waiting", async () => {
    activateActivityView();
    seedApprovals(1);
    renderStripInSampleScene(true);
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-needs-you")).toBeNull();
    expect(
      document.querySelector('[data-notification-id="host:approval-0"]'),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Deploy checkout fix");
  });

  it("shows the real prompt instead, with no sample scene framing it", async () => {
    activateActivityView();
    seedApprovals(1);
    renderStripInSampleScene(false);
    await screen.findByTestId("side-tab-strip");

    const block = await screen.findByTestId("side-strip-needs-you");
    const items = within(block).getAllByTestId("needs-you-item");
    expect(items).toHaveLength(1);
    expect(items[0].dataset.notificationId).toBe("host:approval-0");
  });

  /**
   * The sample tab is the strip's only nested group under the scene: it draws
   * the sample agents, and a real, busy, warm task with a prompt waiting
   * nests nothing, so none of the person's own agents or prompts appear.
   */
  function seedRealTaskBesideSampleTab(): void {
    const realRef: TabRef = { kind: "epic", id: "epic-1" };
    const sampleRef: TabRef = {
      kind: "sample-workspace",
      id: "sample-workspace",
    };
    useEpicCanvasStore
      .getState()
      .seedEpic("epic-1", { tabId: "epic-1", name: "Real task" }, []);
    useTabsStore.setState({
      version: 2,
      items: [realRef, sampleRef].map((ref) => ({
        kind: "tab",
        id: tabItemId(ref),
        ref,
      })),
      activeItemId: tabItemId(sampleRef),
      stripOrder: [realRef, sampleRef],
      systemTabs: { history: null, settings: null },
    });
    warmEpic("epic-1", [chatProjection("chat-1", { title: "Real agent" })]);
    __setAgentActivityStateForTests(
      { "epic-1": { working: ["chat-1"], turn: ["chat-1"] } },
      "local",
      "connected",
    );
    seedApprovals(1);
  }

  it("nests the sample agents under the sample tab and nothing under a real task", async () => {
    activateActivityView();
    seedRealTaskBesideSampleTab();
    renderStripInSampleScene(true);
    await screen.findByTestId("side-tab-strip");

    const group = await screen.findByTestId("strip-agent-group");
    expect(screen.getAllByTestId("strip-agent-group")).toHaveLength(1);
    expect(
      screen
        .getByTestId("tab-sample-workspace-sample-workspace")
        .getAttribute("aria-controls"),
    ).toBeNull();
    expect(group.getAttribute("aria-labelledby")).toBe(
      "side-tab-row-sample-workspace",
    );
    expect(
      within(group)
        .getAllByRole("button")
        .map((row) => row.getAttribute("data-status")),
    ).toEqual(["waiting", "failed", "turn"]);
    expect(group.textContent).not.toContain("Real agent");
    expect(screen.queryByTestId("strip-agent-chat-1")).toBeNull();
    expect(screen.queryByTestId("strip-agent-host:approval-0")).toBeNull();
  });

  it("draws the sample agents ghosted in Tabs only while the editor points at Side tab view", async () => {
    act(() => {
      useLayoutStore.setState({
        arrangement: {
          ...DEFAULT_ARRANGEMENT,
          tabStripPlacement: "left",
          sideStripView: "layered",
        },
      });
      useLayoutEditorStore.getState().setHoveredSetting("sideStripView");
    });
    seedRealTaskBesideSampleTab();
    renderStripInSampleScene(true);
    await screen.findByTestId("side-tab-strip");

    const group = await screen.findByTestId("strip-agent-group");
    expect(group.getAttribute("data-ghost")).toBe("1");

    act(() => {
      useLayoutEditorStore.getState().setHoveredSetting(null);
    });
    expect(screen.queryByTestId("strip-agent-group")).toBeNull();
  });
});
