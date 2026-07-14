import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";

interface TestBootstrapState {
  reachability: { status: string; hostLabel: string };
  createIsError: boolean;
  createError: { readonly message: string } | null;
}

const testState = vi.hoisted<TestBootstrapState>(() => ({
  reachability: {
    status: "reachable",
    hostLabel: "Host A",
  },
  createIsError: true,
  createError: {
    message: "secret-token-should-never-render /Users/hostile/path",
  },
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
    handle: null,
    createIsError: testState.createIsError,
    createError: testState.createError,
    retry: () => undefined,
    hostHasSession: false,
    hostSessionExited: false,
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

function renderErroredTile(): void {
  const store = useEpicCanvasStore.getState();
  const viewTabId = store.openEpicTab(EPIC_ID, "Epic");
  const node = terminalNode("terminal-1", "inst-terminal-1");
  store.openTileInTab(viewTabId, node);
  const canvas = useEpicCanvasStore.getState().canvasByTabId[viewTabId];
  if (canvas === undefined) throw new Error("expected view tab canvas");
  const paneId = collectPanes(canvas.root)[0].id;
  render(
    withTabHost(
      <TerminalTile
        viewTabId={viewTabId}
        node={node}
        tileId={paneId}
        isActive
      />,
    ),
  );
}

describe("<TerminalTile /> bootstrap error report action", () => {
  beforeEach(() => {
    cleanup();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    testState.reachability = { status: "reachable", hostLabel: "Host A" };
    testState.createIsError = true;
    testState.createError = {
      message: "secret-token-should-never-render /Users/hostile/path",
    };
  });

  afterEach(() => {
    cleanup();
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("hides the report action when the support capability is unavailable", () => {
    renderErroredTile();

    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();
  });

  it("reports only fixed generic context, never the raw bootstrap error", () => {
    renderErroredTile();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Failed to start terminal",
        message: "The terminal session could not be started.",
        code: null,
        source: "Terminal",
      },
    });
    const context = useDesktopDialogStore.getState().reportIssueContext;
    expect(JSON.stringify(context)).not.toContain("secret-token");
    expect(JSON.stringify(context)).not.toContain("/Users/hostile/path");
  });
});
