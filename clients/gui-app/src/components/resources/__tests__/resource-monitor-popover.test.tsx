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
import { useTitleBarDragStore } from "@/stores/layout/title-bar-drag-store";

type MockEpicIntentInput = Readonly<Record<string, unknown>>;
type MockEpicIntent = MockEpicIntentInput & { readonly kind: "epic" };

const routerMock = vi.hoisted(() => ({
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => routerMock.navigate,
}));

const tabNavigationMock = vi.hoisted(() => ({
  existingEpicTabIntent: vi.fn(
    (input: MockEpicIntentInput): MockEpicIntent => ({
      kind: "epic",
      ...input,
    }),
  ),
  openOrFocusEpicIntent: vi.fn(
    (input: MockEpicIntentInput): MockEpicIntent => ({
      kind: "epic",
      tabId: "tab-1",
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
  const openTileInTab = vi.fn();
  const setActiveTilePane = vi.fn();
  const setActiveTileTab = vi.fn();
  const resolveTargetTabForEpic = vi.fn(() => "tab-1");
  const state = {
    openTabOrder: ["tab-1"],
    tabsById: {
      "tab-1": {
        tabId: "tab-1",
        epicId: "epic-1",
        name: "Resource Task",
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
    },
    artifactTreeByEpicId: {
      "epic-1": [],
    },
    openTileInTab,
    setActiveTilePane,
    setActiveTileTab,
    resolveTargetTabForEpic,
  };
  return {
    state,
    openTileInTab,
    setActiveTilePane,
    setActiveTileTab,
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

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, "runnerHost");
  routerMock.navigate.mockReset();
  tabNavigationMock.existingEpicTabIntent.mockClear();
  tabNavigationMock.openOrFocusEpicIntent.mockClear();
  tabNavigationMock.navigateToTabIntent.mockClear();
  canvasMock.openTileInTab.mockReset();
  canvasMock.setActiveTilePane.mockReset();
  canvasMock.setActiveTileTab.mockReset();
  canvasMock.resolveTargetTabForEpic.mockClear();
  __setResourcesStreamClientFactoryForTests(null);
  resourcesRegistry.disposeAll();
  useTitleBarDragStore.setState({ suppressors: new Set() });
});

describe("ResourceMonitorPopover", () => {
  it("shows global app resources, task process trees, and focuses linked terminal tabs", async () => {
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
          owners: [
            owner({}),
            owner({
              owner: {
                kind: "terminal",
                hostId: "host-1",
                epicId: "epic-2",
                ownerId: "term-closed",
              },
              activeProcessName: "bun",
              cpuPercent: 4,
              rssBytes: 50 * 1024 * 1024,
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
    expect(
      screen.getAllByText("node dev-server.js (2 sub-processes)"),
    ).toHaveLength(2);
    expect(screen.queryByText("/bin/sh")).toBeNull();
    expect(screen.queryByText("make")).toBeNull();
    expect(screen.getByText("2 open terminals")).not.toBeNull();
    expect(screen.queryByText(/terminal processes/)).toBeNull();

    const cappedProcessRow = screen
      .getAllByText("node dev-server.js (2 sub-processes)")[0]
      .closest("button");
    if (cappedProcessRow === null) {
      throw new Error("Expected capped process row to be a focusable button");
    }
    fireEvent.focus(cappedProcessRow);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip.textContent).toContain("/bin/sh");
    expect(tooltip.textContent).toContain("make");
    // The collapsed sub-tree carries the same CPU/memory columns as the tree.
    expect(tooltip.textContent).toContain("2.0 MB");
    expect(tooltip.textContent).toContain("4.0 MB");

    fireEvent.click(screen.getByText("Terminal Alpha"));
    expect(canvasMock.setActiveTilePane).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
    );
    expect(canvasMock.setActiveTileTab).toHaveBeenCalledWith(
      "tab-1",
      "pane-1",
      "tile-term-1",
    );
    expect(tabNavigationMock.navigateToTabIntent).toHaveBeenCalledTimes(1);
    expect(canvasMock.openTileInTab).not.toHaveBeenCalled();
  });

  it("hides terminal rows with no subprocesses while keeping aggregate metrics", () => {
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
              activeProcessName: "idle-shell",
              processCount: 1,
              cpuPercent: 77,
              rssBytes: 900 * 1024 * 1024,
              // A bare shell with nothing running under it: its whole tree is a
              // single process, so the terminal owner row is hidden entirely
              // while its metrics still fold into the aggregate below.
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
    // The whole terminal owner row is hidden - neither its label nor its lone
    // shell process renders.
    expect(screen.queryByText("idle-shell")).toBeNull();
    expect(screen.queryByText("/usr/bin/idle-zsh")).toBeNull();
    expect(screen.getByText("2 open terminals")).not.toBeNull();
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
