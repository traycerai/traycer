import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { create } from "zustand";
import type { TerminalSessionExitReason } from "@traycer/protocol/host/terminal/unary-schemas";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

// A terminal-agent tile auto-closes when the harness TUI exits (e.g. the user
// presses Ctrl+C and the process terminates). The close must target the pane
// tab *instance* id - `closeCanvasTab` resolves the tile via
// `pane.tabInstanceIds`, so passing the content/session id silently no-ops and
// the dead tab lingers. This test pins that contract.

const testState = vi.hoisted(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  navigateResults: [] as Array<NestedFocusTarget | null>,
  navigateNested: vi.fn(),
}));

const exitedHandle = {
  epicId: "epic-test",
  sessionId: "agent-1",
  dispose: () => undefined,
  store: create(() => ({
    status: "exited" as const,
    connectionStatus: "open" as const,
    exitCode: 0,
    exitReason: null as TerminalSessionExitReason | null,
    effectiveCols: 80,
    effectiveRows: 24,
    lastOutputPreview: null,
    writeInput: () => null,
    requestResize: () => null,
    setWriter: () => undefined,
  })),
};

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
}));

vi.mock("@/hooks/agent/use-terminal-tile-bootstrap", () => ({
  TerminalXtermHost: () => null,
  useTerminalTileBootstrap: () => ({
    handle: exitedHandle,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
  }),
}));

vi.mock(
  "@/components/home/host-workspace-selector/host-workspace-selector",
  () => ({
    HostWorkspaceSelector: () => null,
    // The fork dialog stays mounted under the tile and imports this control.
    ActiveHostWorkspaceControls: () => null,
  }),
);

vi.mock("@/lib/host", () => {
  const entry = {
    hostId: "test-host",
    label: "Test host",
    kind: "local",
    websocketUrl: "ws://127.0.0.1:1/rpc",
    version: null,
    status: "available",
  };
  return {
    useHostBinding: () => null,
    useHostClient: () => ({
      request: () => new Promise(() => {}),
      getActiveHostId: () => "host-test",
      getRequestContextUserId: () => "user-test",
      onChange: () => () => undefined,
    }),
    useHostDirectory: () => ({
      findById: () => entry,
      onChange: () => ({ dispose: () => undefined }),
    }),
  };
});

vi.mock("@/hooks/host/use-host-client-for", () => ({
  useHostClientFor: () => ({
    request: () => new Promise(() => {}),
    getActiveHostId: () => "host-test",
    getRequestContextUserId: () => "user-test",
    onChange: () => () => undefined,
  }),
}));

vi.mock("@/lib/host-error-toast", () => ({
  toastFromHostError: vi.fn(),
}));

vi.mock("@/hooks/agent/use-agent-stop-controls", () => ({
  useAgentStopControls: () => ({ self: null, descendants: [] }),
}));

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-test",
  useEpicTerminalAgent: () => ({
    id: "agent-1",
    harnessId: "claude" as const,
    title: "Claude agent",
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    hostId: "host-test",
    harnessSessionId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    workspaceFolders: [],
    model: null,
    reasoningEffort: null,
    agentMode: "regular" as const,
  }),
}));

vi.mock("@/hooks/agent/use-prepare-tui-launch-mutation", () => ({
  useAgentStartTerminalSession: () => ({
    isError: false,
    isPending: false,
    isIdle: true,
    error: null,
    reset: () => undefined,
    mutateAsync: () => new Promise(() => {}),
  }),
}));

vi.mock("@/hooks/worktree/use-worktree-get-binding-query", () => ({
  useWorktreeGetBinding: () => ({ data: { binding: null } }),
}));

import { TuiAgentTile } from "../tui-agent-tile";
import { TabHostProvider } from "../../tab-host-provider";

const EPIC_ID = "epic-1";
const HOST_ID = "test-host";

function withQueryClient(node: ReactNode): ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TabHostProvider hostId="test-host">{node}</TabHostProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function resetNavigationSpy(): void {
  testState.navigateResults = [];
  testState.navigateNested.mockReset();
  testState.navigateNested.mockImplementation(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => {
      const target = prepare();
      testState.navigateResults.push(target);
      return target;
    },
  );
}

function agentNode(id: string, instanceId: string): EpicNodeRef {
  return {
    id,
    instanceId,
    type: "terminal-agent",
    name: "claude",
    hostId: HOST_ID,
  };
}

function openAgentFixture(inactiveClose: boolean): {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly closingNode: EpicNodeRef;
  readonly activeNode: EpicNodeRef;
} {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const closingNode = agentNode("agent-1", "inst-agent-1");
  store.openTileInTab(viewTabId, closingNode);
  const activeNode = inactiveClose
    ? agentNode("agent-2", "inst-agent-2")
    : closingNode;
  if (inactiveClose) store.openTileInTab(viewTabId, activeNode);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const pane = collectPanes(canvas.root)[0];
  return { viewTabId, paneId: pane.id, closingNode, activeNode };
}

function expectTileClosed(viewTabId: string, closedInstanceId: string): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  expect(canvas.tilesByInstanceId[closedInstanceId]).toBeUndefined();
}

describe("<TuiAgentTile /> exit close", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    __resetAppLocalNotificationsStoreForTests();
    exitedHandle.store.setState({ exitCode: 0, exitReason: null });
    testState.reachability = { status: "reachable", hostLabel: "Host A" };
    resetNavigationSpy();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes unreachable-banner close for an active tile through the nested-focus boundary", () => {
    testState.reachability = { status: "unreachable", hostLabel: "Host A" };
    const fixture = openAgentFixture(false);

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Close tab" }));

    // A revert to raw `closeCanvasTab` would still close the tab but would not
    // invoke this boundary spy, so this assertion catches the regression.
    expect(testState.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      fixture.viewTabId,
      expect.any(Function),
    );
    expect(testState.navigateResults[0]).not.toBeNull();
    expect(testState.navigateResults[0]?.tileInstanceId).toBeUndefined();
    expectTileClosed(fixture.viewTabId, fixture.closingNode.instanceId);
  });

  it("routes harness-exit close for an active tile through the nested-focus boundary", async () => {
    const fixture = openAgentFixture(false);

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(testState.navigateNested).toHaveBeenCalledWith(
        EPIC_ID,
        fixture.viewTabId,
        expect.any(Function),
      );
    });
    expect(testState.navigateResults[0]).not.toBeNull();
    expect(testState.navigateResults[0]?.tileInstanceId).toBeUndefined();
    expectTileClosed(fixture.viewTabId, fixture.closingNode.instanceId);
  });

  it("keeps an abnormal harness exit mounted and emits its terminal failure", async () => {
    exitedHandle.store.setState({
      exitCode: 1,
      exitReason: "process-exit",
    });
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
    const fixture = openAgentFixture(false);

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive
        />,
      ),
    );

    await waitFor(() => {
      expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(
        1,
      );
    });
    const notificationId =
      useAppLocalNotificationsStore.getState().orderedIds[0];
    expect(
      useAppLocalNotificationsStore.getState().byId[notificationId].kind,
    ).toBe("terminal.crashed");
    expectTileOpen(fixture.viewTabId, fixture.closingNode.instanceId);
    expect(testState.navigateNested).not.toHaveBeenCalled();
  });

  it("closes an inactive exited tile without producing a route-write target", async () => {
    const fixture = openAgentFixture(true);

    render(
      withQueryClient(
        <TuiAgentTile
          viewTabId={fixture.viewTabId}
          node={fixture.closingNode}
          tileId={fixture.paneId}
          isActive={false}
        />,
      ),
    );

    await waitFor(() => {
      expect(testState.navigateNested).toHaveBeenCalled();
    });
    expect(testState.navigateResults[0]).toBeNull();
    expectTileClosed(fixture.viewTabId, fixture.closingNode.instanceId);

    const canvas =
      useEpicCanvasStore.getState().canvasByTabId[fixture.viewTabId];
    if (canvas === undefined) throw new Error("expected view tab canvas");
    const pane = collectPanes(canvas.root)[0];
    expect(pane.activeTabId).toBe(fixture.activeNode.instanceId);
  });
});

function expectTileOpen(viewTabId: string, instanceId: string): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  expect(canvas.tilesByInstanceId[instanceId]).toBeDefined();
}
