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
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  __resetAppLocalNotificationsStoreForTests,
  useAppLocalNotificationsStore,
} from "@/stores/notifications/app-local-notifications-store";

const testState = vi.hoisted(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  navigateResults: [] as Array<NestedFocusTarget | null>,
  navigateNested: vi.fn(),
  // The bootstrap's verdict for the tile under test. `attached` means it got a
  // live session handle; `hostSessionExited` is the host still listing this PTY
  // inside its ~60s post-exit grace window. The two are independent: a tile can
  // attach and then have its session exit, or open onto one that already has.
  bootstrap: {
    attached: true,
    hostSessionExited: false,
  },
}));

const exitedHandle = {
  scope: { kind: "epic" as const, epicId: "epic-test" },
  sessionId: "terminal-1",
  dispose: () => undefined,
  store: create(() => ({
    status: "exited" as const,
    connectionStatus: "open" as const,
    exitCode: 0,
    exitReason: null as TerminalSessionExitReason | null,
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

vi.mock("@/lib/epic-selectors", () => ({
  useOpenEpicId: () => "epic-1",
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
    handle: testState.bootstrap.attached ? exitedHandle : null,
    createIsError: false,
    createError: null,
    retry: () => undefined,
    hostHasSession: false,
    hostSessionExited: testState.bootstrap.hostSessionExited,
  }),
}));

vi.mock("@/lib/perf/terminal-load-perf", () => ({
  beginTerminalLoad: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  AnalyticsEvent: {
    TerminalOpened: "TerminalOpened",
    TabClosed: "TabClosed",
  },
  Analytics: {
    getInstance: () => ({ track: vi.fn() }),
  },
  analyticsTargetForCanvasTileType: () => null,
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
    __resetAppLocalNotificationsStoreForTests();
    exitedHandle.store.setState({ exitCode: 0, exitReason: null });
    testState.reachability = { status: "reachable", hostLabel: "Host A" };
    testState.bootstrap = { attached: true, hostSessionExited: false };
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

  it("keeps an abnormal exit mounted and emits its terminal failure", async () => {
    exitedHandle.store.setState({
      exitCode: 1,
      exitReason: "process-exit",
    });
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
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

  it("closes a tile that opens onto an already-exited session instead of hanging on startup", async () => {
    // Reopening a terminal whose PTY died inside the host's grace window: the
    // bootstrap refuses to respawn under that id, so no handle ever arrives.
    // Without the close, the tile sits on "Starting terminal session…" until the
    // grace lapses and then silently spawns a fresh shell in its place.
    testState.bootstrap = { attached: false, hostSessionExited: true };
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
      expectTileClosed(fixture.viewTabId, fixture.closingNode.instanceId);
    });
    expect(testState.navigateNested).toHaveBeenCalledWith(
      EPIC_ID,
      fixture.viewTabId,
      expect.any(Function),
    );
  });

  it("keeps a crashed tile mounted even while the host still lists its exited session", async () => {
    // The close above is gated on never having attached. Once a tile HAS a
    // handle, its exit belongs to the live-stream path, which deliberately keeps
    // a crash on screen so the failure indicator has a tab to hang on - and the
    // host reports that same session as `exited` for 60s, so an ungated close
    // would rip the crashed terminal away.
    testState.bootstrap = { attached: true, hostSessionExited: true };
    exitedHandle.store.setState({ exitCode: 1, exitReason: "process-exit" });
    useAppLocalNotificationsStore.getState().activateIdentity("user-a");
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
      expect(useAppLocalNotificationsStore.getState().orderedIds).toHaveLength(
        1,
      );
    });
    expectTileOpen(fixture.viewTabId, fixture.closingNode.instanceId);
    expect(testState.navigateNested).not.toHaveBeenCalled();
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

function expectTileOpen(viewTabId: string, instanceId: string): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  expect(canvas.tilesByInstanceId[instanceId]).toBeDefined();
}
