import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
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

// The tab's host client is reached twice here: an exited sign-in tile renders
// the restart button (which instantiates the terminal-login mutation), and the
// live tile resolves its terminal title through `terminal.list`. Neither is
// under test, so a stub answering the identity reads and readiness
// subscription every host query makes is enough - the full host runtime is not
// what these cases exercise.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({
    getActiveHostId: () => HOST_ID,
    getRequestContextUserId: () => null,
    onChange: () => () => undefined,
    request: vi.fn(),
  }),
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
  // A sign-in tile that has exited renders the restart button, and that button
  // instantiates the terminal-login mutation hook - so this wrapper needs a
  // QueryClient even though the ordinary-terminal cases never reach one.
  return (
    <QueryClientProvider client={new QueryClient()}>
      <TabHostProvider hostId={HOST_ID}>{node}</TabHostProvider>
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

function signInTerminalNode(id: string, instanceId: string): EpicTerminalRef {
  return {
    id,
    instanceId,
    type: "terminal",
    name: "Copilot sign-in",
    titleSource: "manual",
    hostId: HOST_ID,
    cwd: "~",
    origin: "provider-login",
    originProviderId: "copilot",
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

  // A sign-in terminal is exempt from the clean-exit auto-close every
  // ordinary terminal gets (the "routes PTY-exit close" case above): it is
  // the only surface that can restart the sign-in, and closing it on a clean
  // exit (the user typing `exit` after signing in) would retract that
  // restart affordance and the CLI's last words with no explanation.
  // Probed: dropping `isSignInTerminal` from `TerminalLive`'s exit effect
  // dependency guard makes this tile close identically to the ordinary one -
  // confirmed and reverted.
  it("keeps a sign-in terminal tile open after a clean exit, unlike an ordinary terminal", async () => {
    const store = useEpicCanvasStore.getState();
    const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
    const signInNode = signInTerminalNode("term-signin", "inst-term-signin");
    store.openTileInTab(viewTabId, signInNode);
    const canvasBefore = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
    if (canvasBefore === undefined) throw new Error("expected view tab canvas");
    const paneId = collectPanes(canvasBefore.root)[0].id;

    render(
      withTabHost(
        <TerminalTile
          viewTabId={viewTabId}
          node={signInNode}
          tileId={paneId}
          isActive
        />,
      ),
    );

    // Give the exit effect a couple of ticks - the same window the ordinary
    // "routes PTY-exit close" case awaits its close through.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expectTileOpen(viewTabId, signInNode.instanceId);
    expect(testState.navigateNested).not.toHaveBeenCalled();

    // Staying open is only half the contract: the tile has to SAY the shell
    // ended and offer the restart. `signInSessionGone` in the parent cannot
    // cover this - it reads `terminal.list`, which has a 60s staleTime and
    // never polls, so on the ATTACHED path it still believes the session is
    // live long after the store's stream-driven status says otherwise. Before
    // `TerminalLive` learned to render the panel itself, this assertion failed
    // while the one above passed: an open tile holding a dead, torn-down xterm
    // with no explanation and no way back.
    expect(await screen.findByText("Sign-in terminal ended.")).toBeDefined();
    expect(screen.getByRole("button", { name: /Start again/ })).toBeDefined();
  });
});

function expectTileOpen(viewTabId: string, instanceId: string): void {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  expect(canvas.tilesByInstanceId[instanceId]).toBeDefined();
}
