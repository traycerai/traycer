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
  HostTreeResourceSnapshotWire,
  OtherResourceSnapshotWire,
  OwnerResourceSnapshotWireV13,
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
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

const streamVersionMock = vi.hoisted(() => ({
  version: null as { readonly major: number; readonly minor: number } | null,
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => null,
  useStreamMethodSupport: () => null,
  useStreamMethodSchemaVersion: () => streamVersionMock.version,
}));

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

const liveArtifactTitleMock = vi.hoisted(() => ({
  title: null as string | null,
}));

vi.mock("@/lib/epic-selectors", () => ({
  useRegisteredEpicLiveArtifactTitle: (
    _epicId: string,
    artifactId: string | null,
  ) => (artifactId === "chat-1" ? liveArtifactTitleMock.title : null),
}));

vi.mock("@/lib/history-navigation/use-history-nav-available", () => ({
  useHistoryNavAvailable: () => historyNavAvailableMock.enabled,
}));

// The kill mutation reaches into the host-runtime + query providers, which this
// pure-render harness does not mount. Stub it so the popover renders the kill
// affordances without that wiring; `resourcesKillMock.mutate` captures calls.
const resourcesKillMock = vi.hoisted(() => ({ mutate: vi.fn() }));
vi.mock("@/hooks/resources/use-resources-kill-mutation", () => ({
  useResourcesKill: () => ({
    mutate: resourcesKillMock.mutate,
    isPending: false,
  }),
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

vi.mock("@/hooks/epics/use-cloud-epic-tasks-query", () => ({
  useCloudEpicTasksQuery: () => ({
    tasks: [
      {
        epic: {
          light: {
            id: "epic-2",
            title: "Background Task",
          },
        },
      },
    ],
  }),
}));

const canvasMock = vi.hoisted(() => {
  const prepareOpenTileInTabFocusTarget = vi.fn();
  const prepareSetActiveTileTabFocusTarget = vi.fn();
  const resolveTargetTabForEpic = vi.fn(() => "tab-2");
  const state = {
    openTabOrder: ["tab-1", "tab-2"],
    tabsById: {
      "tab-1": { tabId: "tab-1", epicId: "epic-1", name: "Resource Task" },
      "tab-2": { tabId: "tab-2", epicId: "epic-1", name: "Resource Task" },
      "tab-closed": {
        tabId: "tab-closed",
        epicId: "epic-2",
        name: "Background Task",
      },
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
      "tab-closed": {
        root: {
          kind: "pane",
          id: "pane-closed",
          tabInstanceIds: ["tile-term-closed"],
          activeTabId: "tile-term-closed",
          previewTabId: null,
          activationHistory: ["tile-term-closed"],
        },
        activePaneId: "pane-closed",
        tilesByInstanceId: {
          "tile-term-closed": {
            id: "term-closed",
            instanceId: "tile-term-closed",
            type: "terminal",
            name: "Background Terminal",
            titleSource: "manual",
            hostId: "host-1",
            cwd: "/work/background",
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
  over: Partial<OwnerResourceSnapshotWireV13>,
): OwnerResourceSnapshotWireV13 {
  return {
    owner: {
      kind: "terminal",
      hostId: "host-1",
      epicId: "epic-1",
      ownerId: "term-1",
    },
    sampledAt: 1_000,
    rootPids: [100],
    harnessId: null,
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
      resourceProcess({
        pid: 101,
        parentPid: 100,
        rootPid: 100,
        name: "node",
        command: "node dev-server.js",
        cpuPercent: 10,
        rssBytes: 60 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 102,
        parentPid: 101,
        rootPid: 100,
        name: "sh",
        command: "/bin/sh",
        cpuPercent: 0,
        rssBytes: 2 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 103,
        parentPid: 102,
        rootPid: 100,
        name: "make",
        command: "make",
        cpuPercent: 1,
        rssBytes: 4 * 1024 * 1024,
      }),
    ],
    ...over,
  };
}

function hostTree(
  over: Partial<HostTreeResourceSnapshotWire>,
): HostTreeResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    processCount: 4,
    cpuPercent: 10,
    rssBytes: 400 * 1024 * 1024,
    ...over,
  };
}

function other(
  over: Partial<OtherResourceSnapshotWire>,
): OtherResourceSnapshotWire {
  return {
    sampledAt: 1_000,
    rootPids: [500],
    processCount: 2,
    cpuPercent: 5,
    rssBytes: 50 * 1024 * 1024,
    processes: [
      resourceProcess({
        pid: 500,
        rootPid: 500,
        name: "worker",
        command: "worker",
        cpuPercent: 1,
        rssBytes: 10 * 1024 * 1024,
      }),
      resourceProcess({
        pid: 501,
        parentPid: 500,
        rootPid: 500,
        name: "child",
        command: "child",
        cpuPercent: 4,
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
    epics: [],
    hostTree: undefined,
    other: undefined,
    ...over,
  };
}

function installStubFactory(): { emit: () => ResourcesStreamCallbacks } {
  let captured: ResourcesStreamCallbacks | null = null;
  __setResourcesStreamClientFactoryForTests((_scope, callbacks) => {
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
  liveArtifactTitleMock.title = null;
  canvasMock.state.canvasByTabId["tab-1"].tilesByInstanceId["tile-term-1"] = {
    id: "term-1",
    instanceId: "tile-term-1",
    type: "terminal",
    name: "Terminal Alpha",
    titleSource: "manual",
    hostId: "host-1",
    cwd: "/work",
  };
  canvasMock.state.artifactTreeByEpicId["epic-1"][0] = {
    ...canvasMock.state.artifactTreeByEpicId["epic-1"][0],
    name: "Agent Chat",
  };
  tabNavigationMock.existingEpicTabIntentWithNestedFocus.mockClear();
  tabNavigationMock.navigateToTabIntent.mockClear();
  canvasMock.prepareOpenTileInTabFocusTarget.mockReset();
  canvasMock.prepareSetActiveTileTabFocusTarget.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReset();
  canvasMock.resolveTargetTabForEpic.mockReturnValue("tab-2");
  __setResourcesStreamClientFactoryForTests(null);
  streamVersionMock.version = null;
  resourcesRegistry.disposeAll();
  useTitleBarDragStore.setState({ suppressors: new Set() });
});

describe("ResourceMonitorPopover", () => {
  it("defaults to tab order when the popover opens", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const sortTrigger = screen.getByRole("button", {
      name: "Sort resource rows",
    });
    expect(sortTrigger.textContent).toContain("Tab order");

    fireEvent.pointerDown(sortTrigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(
      screen
        .getByRole("menuitemradio", { name: "Tab order" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("uses the live chat title when the persisted owner name is untitled", async () => {
    liveArtifactTitleMock.title = "Generated chat title";
    canvasMock.state.artifactTreeByEpicId["epic-1"][0] = {
      ...canvasMock.state.artifactTreeByEpicId["epic-1"][0],
      name: "Untitled chat",
    };
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
              harnessId: null,
              activeProcessName: null,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(await screen.findByText("Generated chat title")).not.toBeNull();
    expect(screen.queryByText("Untitled chat")).toBeNull();
  });

  it("offers a kill affordance on an owner row", () => {
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
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    // The per-row "Kill" text button is present (revealed on hover) and arms an
    // inline Confirm/Cancel pair rather than opening a modal.
    resourcesKillMock.mutate.mockClear();
    const killButton = screen.getByRole("button", { name: /^Kill / });
    fireEvent.click(killButton);
    expect(
      screen.getByRole("button", { name: /^Keep .* running$/ }),
    ).not.toBeNull();

    // Confirming fires the kill mutation with the owner's host + root pids.
    fireEvent.click(screen.getByRole("button", { name: /^Confirm kill / }));
    expect(resourcesKillMock.mutate).toHaveBeenCalledTimes(1);
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [100],
    });
  });

  it("enters multi-select mode and reveals row checkboxes", () => {
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
              harnessId: "claude",
              activeProcessName: null,
            }),
          ],
        }),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes.length).toBeGreaterThan(0);

    // Selecting the owner and confirming the bulk action fires one grouped
    // kill for its host + root pids.
    resourcesKillMock.mutate.mockClear();
    fireEvent.click(checkboxes[0]);
    fireEvent.click(screen.getByRole("button", { name: "Kill 1 selected" }));
    expect(resourcesKillMock.mutate).toHaveBeenCalledTimes(1);
    expect(resourcesKillMock.mutate).toHaveBeenCalledWith({
      hostId: "host-1",
      pids: [100],
    });
  });

  it("prunes the selection count when a selected process exits on its own", () => {
    const stub = installStubFactory();
    renderPopover();
    const chatOwner = owner({
      owner: {
        kind: "chat" as const,
        hostId: "host-1",
        epicId: "epic-1",
        ownerId: "chat-1",
      },
      harnessId: "claude",
      activeProcessName: null,
    });
    act(() => {
      stub.emit().onSnapshot(projection({ owners: [chatOwner] }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Select processes to kill" }),
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]);
    const killOne = screen.getByRole("button", { name: "Kill 1 selected" });
    expect(killOne.hasAttribute("disabled")).toBe(false);

    // The selected owner's tree exits on its own -> it drops out of the next
    // frame, and the armed count must fall back to zero (button disabled).
    act(() => {
      stub.emit().onUpdate(projection({ owners: [] }));
    });
    const killZero = screen.getByRole("button", { name: "Kill 0 selected" });
    expect(killZero.hasAttribute("disabled")).toBe(true);
  });

  it("counts a nested tracked root once in owner tree totals", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              processes: [
                // PTY root: parent (the host) is outside this list.
                resourceProcess({
                  pid: 100,
                  parentPid: 1,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                  cpuPercent: 3,
                  rssBytes: 10 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "node",
                  command: "node agent.js",
                  cpuPercent: 5,
                  rssBytes: 20 * 1024 * 1024,
                }),
                // Second tracked root that is an OS descendant of the first
                // tree: must be counted exactly once (as a child), never as
                // an additional root.
                resourceProcess({
                  pid: 102,
                  parentPid: 101,
                  rootPid: 102,
                  name: "claude",
                  command: "claude --chat",
                  cpuPercent: 9,
                  rssBytes: 30 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // 3 + 5 + 9 single-counted, shown by exactly two elements: the task
    // header and the owner row. A double-count regression in either
    // projection drops the count below 2 and surfaces 26% instead.
    expect(screen.getAllByText("17%")).toHaveLength(2);
    expect(screen.queryByText("26%")).toBeNull();
  });

  it("updates an auto-titled terminal owner from each resource frame", () => {
    canvasMock.state.canvasByTabId["tab-1"].tilesByInstanceId["tile-term-1"] = {
      ...canvasMock.state.canvasByTabId["tab-1"].tilesByInstanceId[
        "tile-term-1"
      ],
      titleSource: "default",
    };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "first-command" })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("first-command")).not.toBeNull();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [owner({ activeProcessName: "second-command" })],
        }),
      );
    });

    expect(screen.queryByText("Terminal Alpha")).toBeNull();
    expect(screen.getByText("second-command")).not.toBeNull();
  });

  it("uses the host-tree aggregate plus desktop usage for the headline", async () => {
    const stub = installStubFactory();
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: vi.fn().mockResolvedValue({
            appMetrics: [
              {
                pid: 10,
                type: "Browser",
                cpu: { percentCPUUsage: 1.5 },
                memory: { workingSetSize: 100 * 1024 },
              },
            ],
          }),
        },
      },
    });
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({}),
          owners: [owner({ cpuPercent: 99, rssBytes: 900 * 1024 * 1024 })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("12%")).not.toBeNull();
    expect(screen.getByText("500 MB")).not.toBeNull();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "24",
    );
  });

  it("renders Other as a non-navigable, expandable process-root section", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub
        .emit()
        .onSnapshot(
          projection({ app: app(), hostTree: hostTree({}), other: other({}) }),
        );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    // Collapsed by default: only the section header with aggregate totals.
    expect(screen.getByText("Other")).not.toBeNull();
    expect(screen.queryByText("worker (1 sub-process)")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand other processes" }),
    );
    expect(screen.getByText("worker (1 sub-process)")).not.toBeNull();
    expect(screen.queryByText("child")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand sub-processes of worker" }),
    );
    expect(screen.getByText("child")).not.toBeNull();
  });

  it("shows compact basename labels for Other roots until expanded", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({}),
          other: other({
            processes: [
              resourceProcess({
                pid: 500,
                rootPid: 500,
                name: "/Users/dev/.traycer/host/dev/providers/opencode/opencode",
                command:
                  "/Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
                cpuPercent: 1,
                rssBytes: 10 * 1024 * 1024,
              }),
              resourceProcess({
                pid: 501,
                parentPid: 500,
                rootPid: 500,
                name: "node",
                command: "node worker.js",
                cpuPercent: 4,
                rssBytes: 40 * 1024 * 1024,
              }),
            ],
          }),
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand other processes" }),
    );
    // Collapsed root shows the executable basename, not the install path.
    expect(screen.getByText("opencode (1 sub-process)")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of /Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
      }),
    );
    // Expanded root reveals the full command for inspection.
    expect(
      screen.getByText(
        "/Users/dev/.traycer/host/dev/providers/opencode/opencode serve",
      ),
    ).not.toBeNull();
  });

  it("keeps the legacy headline and hides Other on resources.subscribe@1.1", () => {
    streamVersionMock.version = { major: 1, minor: 1 };
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          hostTree: hostTree({ cpuPercent: 50 }),
          other: other({}),
          owners: [owner({ cpuPercent: 2, rssBytes: 100 * 1024 * 1024 })],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(screen.getByText("3.0%")).not.toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
  });

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
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              harnessId: null,
              activeProcessName: "bun",
              cpuPercent: 4,
              rssBytes: 50 * 1024 * 1024,
              // Distinct pids from the first owner: a host never reuses a pid
              // across owners, so per-node expansion must not collide.
              rootPids: [200],
              processes: [
                resourceProcess({
                  pid: 200,
                  rootPid: 200,
                  name: "zsh",
                  command: "/bin/zsh",
                  rssBytes: 40 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 201,
                  parentPid: 200,
                  rootPid: 200,
                  name: "node",
                  command: "node dev-server.js",
                  rssBytes: 60 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 202,
                  parentPid: 201,
                  rootPid: 200,
                  name: "sh",
                  command: "/bin/sh",
                  rssBytes: 2 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 203,
                  parentPid: 202,
                  rootPid: 200,
                  name: "make",
                  command: "make",
                  rssBytes: 4 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Resources")).not.toBeNull();
    expect(await screen.findByText("Traycer Desktop")).not.toBeNull();
    expect(screen.getByText("Renderer")).not.toBeNull();
    expect(getDesktopMetrics).toHaveBeenCalled();
    expect(screen.getByText("Traycer Host")).not.toBeNull();
    expect(screen.getByText("Resource Task")).not.toBeNull();
    expect(screen.getByText("Background Task")).not.toBeNull();
    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    // Owner trees start collapsed, so their inclusive values are visible on the
    // owner rows while no individual process is rendered yet.
    expect(
      screen.queryByText("node dev-server.js (2 sub-processes)"),
    ).toBeNull();
    expect(screen.queryByText("/bin/sh")).toBeNull();
    expect(screen.queryByText("make")).toBeNull();
    expect(screen.queryByText(/terminal processes/)).toBeNull();

    fireEvent.click(
      screen.getAllByRole("button", { name: "Expand process tree" })[0],
    );
    expect(
      screen.getByText("node dev-server.js (2 sub-processes)"),
    ).not.toBeNull();
    expect(screen.queryByText("/bin/sh")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of node dev-server.js",
      }),
    );
    expect(screen.getByText("/bin/sh (1 sub-process)")).not.toBeNull();
    expect(screen.queryByText("make")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Expand sub-processes of /bin/sh",
      }),
    );
    expect(screen.getByText("make")).not.toBeNull();
  });

  it("swaps tree values for self values without double-counting visible rows", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider delayDuration={0}>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              cpuPercent: 13,
              rssBytes: 106 * 1024 * 1024,
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    const ownerRow = screen.getByText("Terminal Alpha").closest("button");
    if (ownerRow === null) throw new Error("Expected owner row button");
    expect(ownerRow.textContent).toContain("13%");
    expect(ownerRow.textContent).toContain("106 MB");
    expect(
      screen.queryByText("node dev-server.js (2 sub-processes)"),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );
    expect(ownerRow.textContent).toContain("2.0%");
    expect(ownerRow.textContent).toContain("40.0 MB");
    const nodeRow = screen
      .getByText("node dev-server.js (2 sub-processes)")
      .closest("button");
    if (nodeRow === null) throw new Error("Expected node row button");
    expect(nodeRow.textContent).toContain("11%");
    expect(nodeRow.textContent).toContain("66.0 MB");

    const metrics = ownerRow.querySelector('[data-slot="tooltip-trigger"]');
    if (metrics === null)
      throw new Error("Expected owner metric tooltip trigger");
    fireEvent.pointerMove(metrics);
    expect(
      await screen.findAllByText(/Self: 2\.0% CPU · 40\.0 MB memory/),
    ).not.toHaveLength(0);
    expect(
      await screen.findAllByText(/Tree: 13% CPU · 106 MB memory/),
    ).not.toHaveLength(0);

    fireEvent.click(nodeRow);
    expect(nodeRow.textContent).toContain("10%");
    expect(nodeRow.textContent).toContain("60.0 MB");
    const shellRow = screen
      .getByText("/bin/sh (1 sub-process)")
      .closest("button");
    if (shellRow === null) throw new Error("Expected shell row button");
    expect(shellRow.textContent).toContain("1.0%");
    expect(shellRow.textContent).toContain("6.0 MB");
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
              harnessId: null,
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

  it("reopens a closed task and focuses its preserved terminal", async () => {
    routerMock.pathname = "/epics/epic-1/tab-1";
    canvasMock.prepareSetActiveTileTabFocusTarget.mockReturnValue({
      paneId: "pane-closed",
      tileInstanceId: "tile-term-closed",
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
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              harnessId: null,
              activeProcessName: "make",
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(await screen.findByText("Background Terminal"));

    expect(canvasMock.prepareSetActiveTileTabFocusTarget).toHaveBeenCalledWith(
      "tab-closed",
      "pane-closed",
      "tile-term-closed",
    );
    expect(
      tabNavigationMock.existingEpicTabIntentWithNestedFocus,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-2",
        tabId: "tab-closed",
        nestedFocus: {
          paneId: "pane-closed",
          tileInstanceId: "tile-term-closed",
        },
      }),
    );
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledWith(
      routerMock.navigate,
      expect.objectContaining({ tabId: "tab-closed" }),
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
              harnessId: null,
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
              harnessId: null,
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

  it("sorts sibling process rows by aggregated subtree usage", () => {
    const stub = installStubFactory();
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({
              processes: [
                resourceProcess({
                  pid: 100,
                  rootPid: 100,
                  name: "zsh",
                  command: "/bin/zsh",
                  cpuPercent: 0,
                  rssBytes: 1 * 1024 * 1024,
                }),
                // Wire order puts the light sibling first; the heavy-subtree
                // sibling must still bubble above it under the memory sort.
                resourceProcess({
                  pid: 101,
                  parentPid: 100,
                  rootPid: 100,
                  name: "alpha",
                  command: "alpha",
                  cpuPercent: 8,
                  rssBytes: 10 * 1024 * 1024,
                }),
                // Small on its own, but carries a heavy grandchild: subtree
                // totals (21% / 205 MB) dominate alpha's (8% / 10 MB).
                resourceProcess({
                  pid: 102,
                  parentPid: 100,
                  rootPid: 100,
                  name: "beta",
                  command: "beta",
                  cpuPercent: 1,
                  rssBytes: 5 * 1024 * 1024,
                }),
                resourceProcess({
                  pid: 103,
                  parentPid: 102,
                  rootPid: 100,
                  name: "gamma",
                  command: "gamma",
                  cpuPercent: 20,
                  rssBytes: 200 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Memory" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    const expectBefore = (firstText: string, secondText: string) => {
      const first = screen.getByText(firstText);
      const second = screen.getByText(secondText);
      expect(
        first.compareDocumentPosition(second) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).not.toBe(0);
    };

    // Memory sort: beta's 205 MB subtree outranks alpha's 10 MB.
    expectBefore("beta (1 sub-process)", "alpha");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expectBefore("alpha", "beta (1 sub-process)");

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Tab order" }));
    // Tab order has no process meaning: fall back to the host's wire order.
    expectBefore("alpha", "beta (1 sub-process)");
  });

  it("sorts the desktop process groups by the selected option", async () => {
    const stub = installStubFactory();
    Reflect.set(globalThis, "runnerHost", {
      platform: {
        diagnostics: {
          getMetrics: vi.fn().mockResolvedValue({
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
                cpu: { percentCPUUsage: 2 },
                memory: { workingSetSize: 300 * 1024 },
              },
            ],
          }),
        },
      },
    });
    renderPopover();

    act(() => {
      stub.emit().onSnapshot(projection({ app: app(), owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    const renderer = await screen.findByText("Renderer");
    const main = screen.getByText("Main");

    // Tab order has no process-group meaning, so the fixed Main-first order is
    // kept when the popover opens.
    expect(
      main.compareDocumentPosition(renderer) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Memory" }));
    expect(
      screen
        .getByText("Renderer")
        .compareDocumentPosition(screen.getByText("Main")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(
      screen
        .getByText("Main")
        .compareDocumentPosition(screen.getByText("Renderer")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("pins an expanded owner row beneath its sticky section header", () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(projection({ app: app(), owners: [owner({})] }));
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Expand process tree" }),
    );

    // Layout engines, not jsdom, validate scroll positioning; this verifies the
    // structural sticky container and its measured section-header offset.
    const ownerRow = screen.getByText("Terminal Alpha").closest(".sticky");
    expect(ownerRow).not.toBeNull();
    expect(ownerRow?.className).toContain("bg-popover");
    expect(ownerRow?.getAttribute("style")).toContain("top: 0px");
  });

  it("shows idle terminals even when they have no subprocesses", () => {
    const stub = installStubFactory();

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-1",
                ownerId: "term-idle",
              },
              rootPids: [900],
              harnessId: null,
              activeProcessName: "idle-shell",
              processCount: 1,
              cpuPercent: 77,
              rssBytes: 900 * 1024 * 1024,
              // A bare shell with nothing running under it is still a terminal
              // session and must remain visible in the compact default view.
              processes: [
                resourceProcess({
                  pid: 900,
                  parentPid: null,
                  rootPid: 900,
                  name: "zsh",
                  command: "/usr/bin/idle-zsh",
                  cpuPercent: 0,
                  rssBytes: 4 * 1024 * 1024,
                }),
              ],
            }),
          ],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));

    expect(screen.getByText("Terminal Alpha")).not.toBeNull();
    expect(screen.getByText("idle-shell")).not.toBeNull();
    expect(screen.queryByText("/usr/bin/idle-zsh")).toBeNull();
    expect(screen.getAllByText("89%").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1000 MB").length).toBeGreaterThan(0);
  });

  it("suppresses title-bar dragging only while the panel is open", () => {
    const stub = installStubFactory();

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(projection({ owners: [owner({})] }));
    });

    const isSuppressed = () =>
      useTitleBarDragStore.getState().suppressors.has("resource-monitor");

    expect(isSuppressed()).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(isSuppressed()).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(isSuppressed()).toBe(false);
  });

  it("keeps the resources panel open when clicking inside it to dismiss the sort menu", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    expect(screen.getByRole("menuitemradio", { name: "CPU" })).not.toBeNull();

    fireEvent.pointerDown(screen.getByText("Traycer Host"), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.mouseDown(screen.getByText("Traycer Host"), { button: 0 });
    fireEvent.pointerUp(screen.getByText("Traycer Host"), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByText("Traycer Host"));

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      {
        button: 0,
        ctrlKey: false,
        pointerType: "mouse",
      },
    );
    expect(screen.getByRole("menuitemradio", { name: "CPU" })).not.toBeNull();

    fireEvent.pointerDown(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.mouseDown(document.body, { button: 0 });
    fireEvent.pointerUp(document.body, {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(document.body);

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Resources" })).toBeNull();
  });

  it("keeps the resources panel open when selecting a sort option", async () => {
    const stub = installStubFactory();
    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Sort resource rows" }),
      { button: 0, ctrlKey: false, pointerType: "mouse" },
    );
    const cpuItem = screen.getByRole("menuitemradio", { name: "CPU" });

    // Choosing a sort option closes the menu but must leave the Resources
    // dialog (and its tray content) intact, and apply the selected sort.
    fireEvent.click(cpuItem);

    expect(screen.queryByRole("menuitemradio", { name: "CPU" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Sort resource rows" }).textContent,
    ).toContain("CPU");
  });

  it("stays open when focus moves to newly loaded content outside the panel", async () => {
    const stub = installStubFactory();
    const outside = document.createElement("input");
    document.body.appendChild(outside);

    render(
      <TooltipProvider>
        <ResourcesStreamMount epicId="epic-1" />
        <ResourceMonitorPopover className={undefined} />
      </TooltipProvider>,
    );

    act(() => {
      stub.emit().onSnapshot(
        projection({
          app: app(),
          owners: [owner({})],
        }),
      );
    });

    fireEvent.click(screen.getByRole("button", { name: "Resources" }));
    expect(await screen.findByText("Traycer Host")).not.toBeNull();

    // A task finishing load autofocuses its content: focus lands on an element
    // outside the popover, which Radix reports as a focus-outside dismissal.
    act(() => {
      outside.focus();
      fireEvent.focusIn(outside);
    });

    expect(screen.getByRole("dialog", { name: "Resources" })).not.toBeNull();
    expect(screen.getByText("Traycer Host")).not.toBeNull();

    outside.remove();
  });
});
