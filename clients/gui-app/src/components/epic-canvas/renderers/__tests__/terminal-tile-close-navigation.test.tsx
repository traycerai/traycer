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
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";

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
  sessionId: "terminal-1",
  dispose: () => undefined,
  store: create(() => ({
    status: "exited" as const,
    connectionStatus: "open" as const,
    exitCode: 0,
    exitReason: null,
    effectiveCols: 80,
    effectiveRows: 24,
    lastOutputPreview: null,
    writeInput: () => undefined,
    requestResize: () => undefined,
    setWriter: () => undefined,
  })),
};

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => testState.reachability,
}));

vi.mock("@/hooks/terminal/use-terminal-session-recovery", () => ({
  useTerminalSessionRecovery: () => ({
    recoverNonce: 0,
    recoveryExhausted: false,
    onManualReconnect: () => undefined,
    onSessionHealthy: () => undefined,
    onSessionLost: () => undefined,
  }),
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

vi.mock("@/lib/perf/terminal-load-perf", () => ({
  beginTerminalLoad: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: { TerminalOpened: "TerminalOpened" },
  Analytics: {
    getInstance: () => ({ track: vi.fn() }),
  },
}));

import { TerminalTile } from "../terminal-tile";

const EPIC_ID = "epic-1";
const HOST_ID = "host-1";

function withTabHost(node: ReactNode): ReactNode {
  return <TabHostProvider hostId={HOST_ID}>{node}</TabHostProvider>;
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

function terminalNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "shell",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "/work/repo",
  };
}

function openTerminalFixture(inactiveClose: boolean): {
  readonly viewTabId: string;
  readonly paneId: string;
  readonly closingNode: EpicTerminalRef;
  readonly activeNode: EpicTerminalRef;
} {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const closingNode = terminalNode("terminal-1", "inst-terminal-1");
  store.openTileInTab(viewTabId, closingNode);
  const activeNode = inactiveClose
    ? terminalNode("terminal-2", "inst-terminal-2")
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

describe("<TerminalTile /> close navigation", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    testState.reachability = { status: "reachable", hostLabel: "Host A" };
    resetNavigationSpy();
  });

  afterEach(() => {
    cleanup();
  });

  it("routes unreachable-banner close for an active tile through the nested-focus boundary", () => {
    testState.reachability = { status: "unreachable", hostLabel: "Host A" };
    const fixture = openTerminalFixture(false);

    render(
      withTabHost(
        <TerminalTile
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

  it("routes PTY-exit close for an active tile through the nested-focus boundary", async () => {
    const fixture = openTerminalFixture(false);

    render(
      withTabHost(
        <TerminalTile
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

  it("closes an inactive exited tile without producing a route-write target", async () => {
    const fixture = openTerminalFixture(true);

    render(
      withTabHost(
        <TerminalTile
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
