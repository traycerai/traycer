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
    expect(screen.getByText("node dev-server.js")).not.toBeNull();
    expect(screen.getByText("1 open terminal")).not.toBeNull();
    expect(screen.queryByText(/terminal processes/)).toBeNull();

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
});
