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
  within,
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
import { DEFAULT_ARRANGEMENT } from "@/lib/layout/layout-arrangement";
import { __resetTabNavigationControllerForTesting } from "@/lib/tab-navigation";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import { WindowsBridgeContext } from "@/providers/windows-bridge-context";
import {
  __resetAgentActivityStoreForTests,
  __setAgentActivityStateForTests,
} from "@/stores/agent-activity-store";
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
    epicId: `epic-${id}`,
    chatId: "chat-1",
    payload: {
      kind: "approval",
      epicId: `epic-${id}`,
      chatId: "chat-1",
      chatTitle: "Deploy checkout fix",
      taskTitle: "Deploy checkout fix",
      approvalId: id,
    },
  };
}

/** Seeds the host feed with `count` unresolved approvals, each in a task of
 * its own, driving both the unread and the needs-you counts at once (a fresh
 * prompt is unread by construction). */
function seedApprovals(count: number): void {
  seedFeed(count, count);
}

/** Seeds `needsYou` unresolved approvals, a task each, under a summary of `unread` unread. */
function seedFeed(needsYou: number, unread: number): void {
  const entries = Array.from({ length: needsYou }, (_unused, index) =>
    approvalEntry(`approval-${index}`, 10 + index),
  );
  act(() => {
    useHostNotificationsStore.getState().applySnapshot({
      attention: { entries, nextCursor: null },
      recent: { entries, nextCursor: null },
      summary: { unreadCount: unread, attentionCount: needsYou },
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

  it("Layered view: the amber pill is the Needs you task count, the muted one the unread total while no task needs you, hidden at 0", async () => {
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(screen.queryByTestId("side-strip-inbox-count")).toBeNull();

    seedFeed(0, 3);
    const unread = screen.getByTestId("side-strip-inbox-count");
    expect(unread.textContent).toBe("3");
    expect(unread.dataset.needsYou).toBe("false");

    // Amber says Needs you, so it never carries the unread total.
    seedFeed(2, 5);
    const needsYou = screen.getByTestId("side-strip-inbox-count");
    expect(needsYou.textContent).toBe("2");
    expect(needsYou.dataset.needsYou).toBe("true");
  });

  it("Activity view: the pill is the Needs you task count, not the unread total, and is absent at 0", async () => {
    activateActivityView();
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    // Unread with nothing waiting: the Layered view would show a muted "3".
    seedFeed(0, 3);
    expect(screen.queryByTestId("side-strip-inbox-count")).toBeNull();

    seedFeed(2, 5);
    const badge = screen.getByTestId("side-strip-inbox-count");
    expect(badge.textContent).toBe("2");
    expect(badge.dataset.needsYou).toBe("true");
  });

  it("collapsed: shows one amber corner badge sized by the Needs you task count", async () => {
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

  it("expanded: draws no unavailable indicator beside a count, and still names the state", async () => {
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");
    seedApprovals(2);
    // The summary goes stale; the waiting prompts it filed stay.
    act(() => {
      useHostNotificationsStore.getState().markSummaryUnknown();
    });

    expect(screen.getByTestId("side-strip-inbox-count").textContent).toBe("2");
    expect(
      screen.queryByTestId("side-strip-inbox-unknown-indicator"),
    ).toBeNull();
    expect(
      screen.getByTestId("side-strip-inbox").getAttribute("aria-label"),
    ).toBe("Notifications, 2 need you, status unavailable");
  });

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

/**
 * The background utilities that set no colour: attachment, clip, origin,
 * repeat, size, position, image (gradients included) and blend mode, and an
 * arbitrary value typed as one of those.
 */
const NON_COLOUR_BACKGROUND =
  /^bg-(?:fixed|local|scroll|clip-|origin-|repeat|no-repeat|auto|cover|contain|size-|position-|top|bottom|center|left|right|none|linear-|radial-|conic-|gradient-|blend-|[[(](?:url\(|image:|length:|size:|position:))/;

/**
 * The resting colour fills a class list paints: its unmodified `bg-*` colour
 * utilities. A token with a `hover:` / `dark:` / `aria-*:` modifier is a
 * state's fill, not the button's, and starts with its modifier, never with
 * `bg-`; the `bg-*` utilities that paint no colour are dropped by name. jsdom
 * resolves no cascade, so the class list is the contract a stylesheet is
 * handed.
 */
function restingFillClasses(element: HTMLElement): ReadonlyArray<string> {
  return [...element.classList].filter(
    (token) => token.startsWith("bg-") && !NON_COLOUR_BACKGROUND.test(token),
  );
}

describe("SideStripNewTask (F7)", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it.each([
    { collapsed: false, label: "expanded" },
    { collapsed: true, label: "collapsed" },
  ])(
    "$label: New Task is filled with the primary colour and with no other resting fill",
    async ({ collapsed }) => {
      useSideTabStripStore.setState({ collapsed });
      renderStrip("left");
      await screen.findByTestId("side-tab-strip");

      const newTask = screen.getByTestId("side-strip-new-task");
      // Exactly the primary: a second fill class would mean two answers to
      // the one question, and the cascade would pick between them.
      expect(restingFillClasses(newTask)).toEqual(["bg-primary"]);
      expect(newTask.classList.contains("text-primary-foreground")).toBe(true);

      // The control: All tasks is a plain nav row beside it and is not
      // primary. Without it `bg-primary` could be what every nav row wears.
      const allTasks = screen.getByTestId("side-strip-all-tasks");
      expect(restingFillClasses(allTasks)).not.toContain("bg-primary");
      expect(allTasks.classList.contains("text-primary-foreground")).toBe(
        false,
      );
    },
  );
});

describe("SideStripNewTask in the Activity view", () => {
  beforeEach(() => {
    resetSharedState();
    signIn();
    activateActivityView();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
  });

  it("is a quiet nav row: no primary fill, the same label and its shortcut", async () => {
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const newTask = screen.getByTestId("side-strip-new-task");
    expect(restingFillClasses(newTask)).not.toContain("bg-primary");
    expect(newTask.classList.contains("text-primary-foreground")).toBe(false);
    expect(screen.getByTestId("side-strip-new-task-label").textContent).toBe(
      "New Task",
    );
    const chord = useKeybindingStore.getState().bindings["epic.new"];
    if (chord === null) throw new Error("expected a default binding");
    expect(newTask.textContent).toContain(formatChordForDisplay(chord));
  });

  it("collapsed: the rail keeps the primary tile", async () => {
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    expect(
      restingFillClasses(screen.getByTestId("side-strip-new-task")),
    ).toEqual(["bg-primary"]);
  });
});

/**
 * `AgentSpinningDots`' default ("dots") frames: the ten braille cells a
 * running agent shows everywhere. Written out, not imported, because the claim
 * is that the strip draws THESE and not some other preset.
 */
const RUNNING_DOTS_FRAMES: ReadonlyArray<string> = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

/**
 * Running work on the strip's own rows (F3, D5), read off the real
 * `SideTabStrip` with the host's activity plane seeded rather than the row's
 * props written by hand: the expanded row draws a running turn as the shared
 * spinning dots, and the collapsed tile draws it as the meter's turn pips and
 * carries no spinner. The dots' own motion and reduced-motion behaviour are
 * `tab-leading-icon.test.tsx`'s.
 */
describe("SideTabStrip rows: running work (F3, D5)", () => {
  beforeEach(() => {
    resetSharedState();
    __resetAgentActivityStoreForTests();
    signIn();
  });

  afterEach(() => {
    cleanup();
    useAuthStore.getState().setSignedOut();
    resetSharedState();
    __resetAgentActivityStoreForTests();
  });

  /**
   * Alpha has one agent mid-turn (a row shows the spinner for one, and the
   * meter from two); nothing is seeded for any other task.
   */
  function seedRunningAlpha(): void {
    __setAgentActivityStateForTests(
      {
        "e-alpha": {
          working: ["agent-1"],
          turn: ["agent-1"],
        },
      },
      "local",
      "connected",
    );
  }

  it("expanded: a running task's row draws AgentSpinningDots' default dots inside a named status, and an idle task's row draws none", async () => {
    openEpicTabs(["Alpha", "Beta"]);
    seedRunningAlpha();
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const alpha = within(screen.getByTestId("tab-epic-e-alpha"));
    const glyph = alpha
      .getByTestId("side-tab-trailing")
      .querySelector('[data-status-glyph="running"]');
    if (!(glyph instanceof HTMLElement))
      throw new Error("expected the running task's row to draw a glyph");

    expect(glyph.querySelector("svg")).toBeNull();
    expect(RUNNING_DOTS_FRAMES).toContain(glyph.textContent);
    expect(glyph.closest('[role="status"]')?.getAttribute("aria-label")).toBe(
      "Task activity in progress",
    );
    // The control: Beta has nothing running and draws no spinner, so the glyph
    // above follows its own task's activity rather than every row's.
    expect(
      screen
        .getByTestId("tab-epic-e-beta")
        .querySelector('[data-status-glyph="running"]'),
    ).toBeNull();
  });

  it("collapsed: a running task's tile shows its running agents as turn pips and draws no spinner, where the expanded row draws one", async () => {
    openEpicTabs(["Alpha"]);
    seedRunningAlpha();
    useSideTabStripStore.setState({ collapsed: true });
    renderStrip("left");
    await screen.findByTestId("side-tab-strip");

    const tile = screen.getByTestId("tab-epic-e-alpha");
    expect(tile.getAttribute("data-side-tab")).toBe("collapsed");
    // One turn pip per agent mid-turn: the tile says WHAT is running by
    // counting it, in the meter's own mark.
    expect(
      tile.querySelectorAll('[data-testid="side-tab-meter"] [data-pip="turn"]'),
    ).toHaveLength(1);
    expect(
      tile.querySelector('[data-status-glyph="running"], .font-mono'),
    ).toBe(null);

    // The control: the same seeded work on the same task DOES draw a spinner
    // once the strip is expanded, so its absence on the tile is the rail's
    // doing and not a task that was never running.
    act(() => {
      useSideTabStripStore.setState({ collapsed: false });
    });
    const row = screen.getByTestId("tab-epic-e-alpha");
    expect(row.getAttribute("data-side-tab")).toBe("expanded");
    expect(row.querySelector('[data-status-glyph="running"]')).not.toBeNull();
  });
});
