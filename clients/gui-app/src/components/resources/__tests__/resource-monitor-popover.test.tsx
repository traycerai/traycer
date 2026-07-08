/**
 * Proves that the resource-monitor popover's owner-open flow commits through
 * the nested-focus opener boundary instead of raw canvas store mutations
 * paired with a stale-search `navigateToTabIntent` call. See the decision
 * artifact "Nested Focus Opener Boundary".
 *
 * The resource monitor is a global surface: the owner it opens can live in
 * the currently active tab, a DIFFERENT open tab, or not be open at all -
 * unlike same-route openers (chat markdown links, sidebar rows), it must
 * decide whether to reuse `useEpicNestedFocusNavigation` in place or perform
 * a cross-route top-level navigation carrying a store-prepared focus target.
 * `useEpicNestedFocusNavigation` is mocked with a spy that still invokes the
 * `prepare` callback (mirrors `epic-sidebar-nested-focus-boundary.test.tsx`),
 * so each assertion checks both that the right boundary path was taken AND
 * that the underlying `prepare*FocusTarget` store action ran with the right
 * arguments. The canvas store mock deliberately omits the raw
 * `openTileInTab` / `setActiveTilePane` / `setActiveTileTab` actions, so a
 * regression back to calling them directly throws instead of silently
 * passing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  AppResourceSnapshotWire,
  OwnerResourceSnapshotWire,
  ResourceProcessSnapshotWire,
} from "@traycer/protocol/host/resources/subscribe";
import type {
  ResourcesProjectionPayload,
  ResourcesStreamCallbacks,
} from "@traycer-clients/shared/host-transport/resources-stream-client";
import { ResourceMonitorPopover } from "@/components/resources/resource-monitor-popover";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ResourcesStreamMount } from "@/providers/resources-stream-mount";
import { __setResourcesStreamClientFactoryForTests } from "@/providers/resources-stream-factory-override";
import { resourcesRegistry } from "@/stores/resources/resources-registry";

type MockEpicIntentInput = Readonly<Record<string, unknown>>;
type MockEpicIntent = MockEpicIntentInput & { readonly kind: "epic" };

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
  pathname: "/epics/epic-1/tab-1",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMock.navigate,
  useRouterState: (opts: {
    readonly select: (state: {
      readonly location: { readonly pathname: string };
    }) => unknown;
  }) => opts.select({ location: { pathname: routerMock.pathname } }),
}));

const navigateNestedMock = vi.hoisted(() =>
  vi.fn((_epicId: string, _tabId: string, prepare: () => unknown) => prepare()),
);

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => navigateNestedMock,
}));

const historyNavAvailableMock = vi.hoisted(() => ({ enabled: true }));

vi.mock("@/lib/history-navigation/use-history-nav-available", () => ({
  useHistoryNavAvailable: () => historyNavAvailableMock.enabled,
}));

const tabNavigationMock = vi.hoisted(() => ({
  existingEpicTabIntentWithNestedFocus: vi.fn(
    (input: MockEpicIntentInput): MockEpicIntent => ({
      kind: "epic",
      ...input,
    }),
  ),
  navigateToTabIntent: vi.fn(),
}));

vi.mock("@/lib/tab-navigation", () => tabNavigationMock);

const canvasMock = vi.hoisted(() => {
  const prepareOpenTileInTabFocusTarget = vi.fn();
  const prepareSetActiveTileTabFocusTarget = vi.fn();
  const resolveTargetTabForEpic = vi.fn(() => "tab-2");
  const state = {
    openTabOrder: ["tab-1", "tab-2"],
    tabsById: {
      "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Resource Task" },
      "tab-2": { tabId: "tab-2", epicId: "epic-1", name: "Resource Task" },
    },
    canvasByTabId: {
      "tab-1": {
        root: {
          kind: "pane",
          id: "pane-1",
          tabInstanceIds: ["tile-term-1"],
          activeTabId: "tile-term-1",
          previewTabId: null,
          activationHistory: ["tile-term-1"],
        },
        activePaneId: "pane-1",
        tilesByInstanceId: {
          "tile-term-1": {
            id: "term-1",
            instanceId: "tile-term-1",
            type: "terminal",
            name: "Terminal Alpha",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work",
          },
        },
        sizesByGroupId: {},
      },
      "tab-2": {
        root: {
          kind: "pane",
          id: "pane-2",
          tabInstanceIds: ["tile-term-2"],
          activeTabId: "tile-term-2",
          previewTabId: null,
          activationHistory: ["tile-term-2"],
        },
        activePaneId: "pane-2",
        tilesByInstanceId: {
          "tile-term-2": {
            id: "term-2",
            instanceId: "tile-term-2",
            type: "terminal",
            name: "Terminal Beta",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work",
          },
        },
        sizesByGroupId: {},
      },
    },
    artifactTreeByEpicId: {
      "epic-1": [
        {
          id: "chat-1",
          parentId: null,
          name: "Agent Chat",
          type: "chat",
          hostId: "host-1",
        },
      ],
    },
    prepareOpenTileInTabFocusTarget,
    prepareSetActiveTileTabFocusTarget,
    resolveTargetTabForEpic,
  };
  return {
    state,
    prepareOpenTileInTabFocusTarget,
    prepareSetActiveTileTabFocusTarget,
    resolveTargetTabForEpic,
  };
});

vi.mock("@/stores/epics/canvas/store", () => {
  const useEpicCanvasStore = Object.assign(
    (selector: (state: typeof canvasMock.state) => unknown) =>
      selector(canvasMock.state),
    {
      getState: () => canvasMock.state,
    },
  );
  return { useEpicCanvasStore };
});

function resourceProcess(
  over: Partial<ResourceProcessSnapshotWire>,
): ResourceProcessSnapshotWire {
  return {
    pid: 10,
    parentPid: null,
    rootPid: 10,
    name: "traycer-host",
    command: "traycer-host",
    cpuPercent: 1,
    rssBytes: 20 * 1024 * 1024,
    ...over,
  };
}

function app(): AppResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    hostTotalMemoryBytes: 2 * 1024 * 1024 * 1024,
    process: resourceProcess({}),
    processCount: 1,
    cpuPercent: 1,
    rssBytes: 20 * 1024 * 1024,
  };
}

function owner(
  over: Partial<OwnerResourceSnapshotWire>,
): OwnerResourceSnapshotWire {
  return {
    owner: {
      kind: "terminal",
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "term-1",
    },
    sampledAt: 1_000,
    rootPids: [100],
    activeProcessName: "node",
    processCount: 2,
    cpuPercent: 12,
    rssBytes: 100 * 1024 * 1024,
    processes: [
      resourceProcess({
        pid: 100,
        rootPid: 100,
        name: "zsh",
        command: "/bin/zsh",
        cpuPercent: 2,
        rssBytes: 40 * 1024 * 1024,
      }),
    ],
    ...over,
  };
}

function projection(
  over: Partial<ResourcesProjectionPayload>,
): ResourcesProjectionPayload {
  return {
    epicId: "epic-1",
    sampledAt: 1_000,
    app: null,
    owners: [],
    epic: null,
    ...over,
  };
}

function installStubFactory(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_epicId, callbacks) => {
    captured = callbacks;
    return { close: () => undefined };
  });
  return {
    emit: () => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    },
  };
}

function renderPopover(): void {
  render(
    <TooltipProvider>
      <ResourcesStreamMount epicId="epic-1" />
      <ResourceMonitorPopover className={undefined} />
    </TooltipProvider>,
  );
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "runnerHost");
  routerMock.navigate.mockReset();
  routerMock.pathname = "/epics/epic-1/tab-1";
  navigateNestedMock.mockClear();
  historyNavAvailableMock.enabled = true;
  tabNavigationMock.existingEpicTabIntentWithNestedFocus.mockClear();
  tabNavigationMock.navigateToTabIntent.mockClear();
  canvasMock.prepareOpenTileInTabFocusTarget.mockReset();
  canvasMock.prepareSetActiveTileTabFocusTarget.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReturnValue("tab-2");
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
});

describe("ResourceMonitorPopover", () => {
  it("shows global app resources and task process trees", async () => {
    const stub = installStubFactory();
    const getDesktopMetrics = vi.fn().mockResolvedValue({
      appMetrics: [
        {
          pid: 10,
          type: "Browser",
          cpu: { percentCPUUsage: 0.5 },
          memory: { workingSetSize: 100 * 1024 },
        },
        {
          pid: 11,
          type: "Tab",
          cpu: { percentCPUUsage: 0.25 },
          memory: { workingSetSize: 200 * 1024 },
        },
      ],
    });
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: getDesktopMetrics,
        },
      },
    });

    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Resources")).not.toBeNull();
    expect(await screen.findByText("Traycer Desktop")).not.toBeNull();
    expect(screen.getByText("Renderer")).not.toBeNull();
    expect(getDesktopMetrics).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Traycer Host")).not.toBeNull();
    expect(screen.getByText("Resource Task")).not.toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.getByText("1 open terminal")).not.toBeNull();
  });

  it("commits an already-open owner in the CURRENT tab through the same-route boundary", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Alpha"));

    // Same-route: must reuse the boundary hook, not a top-level navigation.
    expect(navigateNestedMock).toHaveBeenCalledWith(
      "epic-1",
      "tab-1",
      expect.any(Function),
    );
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      "tile-term-1",
    );
    expect(
      tabNavigationMock.existingEpicTabIntentWithNestedFocus,
    ).not.toHaveBeenCalled();
    expect(tabNavigationMock.navigateToTabIntent).not.toHaveBeenCalled();
  });

  it("commits an already-open owner in ANOTHER tab through a single cross-route navigation", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "tile-term-2",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-2",
              },
              activeProcessName: "vim",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Beta"));

    // Cross-route: the current-route boundary must NOT be used - the owner's
    // tab (tab-2) differs from the active route (tab-1).
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-2",
      "pane-2",
      "tile-term-2",
    );
    expect(
      tabNavigationMock.existingEpicTabIntentWithNestedFocus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-2",
        nestedFocus: { paneId: "pane-2", tileInstanceId: "tile-term-2" },
      }),
    );
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      expect.objectContaining({ tabId: "tab-2" }),
    );
  });

  it("commits a not-yet-open owner through prepareOpenTileInTabFocusTarget + cross-route navigation", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.resolveTargetTabForEpic.mockReturnValue("tab-2");
    canvasMock.prepareOpenTileInTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "instance-new",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "chat",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "chat-1",
              },
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Agent Chat"));

    expect(canvasMock.resolveTargetTabForEpic).toHaveBeenCalledWith(
      "epic-1",
      expect.any(String),
    );
    expect(canvasMock.prepareOpenTileInTabFocusTarget).toHaveBeenCalledWith(
      "tab-2",
      expect.objectContaining({
        id: "chat-1",
        type: "chat",
        hostId: "host-1",
      }),
    );
    expect(navigateNestedMock).not.toHaveBeenCalled();
    expect(
      tabNavigationMock.existingEpicTabIntentWithNestedFocus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-2",
        nestedFocus: { paneId: "pane-2", tileInstanceId: "instance-new" },
      }),
    );
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
  });

  it("does not carry a prepared nested focus target on browser builds (no persistent history)", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    historyNavAvailableMock.enabled = false;
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-2",
      tileInstanceId: "tile-term-2",
    });
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-2",
              },
              activeProcessName: "vim",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Terminal Beta"));

    // The canvas mutation still happens (owner still gets focused), but no
    // nested search params are written to the URL - matches every other
    // desktop-only-gated opener's browser-build behavior.
    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-2",
      "pane-2",
      "tile-term-2",
    );
    expect(
      tabNavigationMock.existingEpicTabIntentWithNestedFocus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "tab-2", nestedFocus: null }),
    );
  });
});
