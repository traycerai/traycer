import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import { useLandingTerminalStore } from "@/stores/home/landing-terminal-store";
import {
  dispatchAction,
  matchDigitAction,
  type KeybindingRouter,
} from "@/lib/keybindings/dispatch";
import { setSystemTabModalApi } from "@/stores/tabs/system-tab-modal-bridge";
import type { SystemTabModalApi } from "@/stores/tabs/use-system-tab-modal";

const mocks = vi.hoisted(() => ({
  activeHostId: null as string | null,
  probeData: undefined as
    | { readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo> }
    | undefined,
  freshProbeData: undefined as
    | { readonly sessions: ReadonlyArray<CanonicalTerminalSessionInfo> }
    | undefined,
  probeError: null,
  dataUpdatedAt: 1,
  primaryWorkspacePath: null as string | null,
  pickAndAddFolders: vi.fn(() => Promise.resolve(true)),
  folderPickPending: 0,
  kill: vi.fn(),
  killAsync: vi.fn(() => Promise.resolve({ killed: true })),
  queryClient: {
    cancelQueries: vi.fn(() => Promise.resolve()),
    fetchQuery: vi.fn(),
  },
  defaultClient: {
    getActiveHostId: () => mocks.activeHostId,
    onChange: () => () => undefined,
  },
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQueryClient: () => mocks.queryClient,
    useIsMutating: () => mocks.folderPickPending,
  };
});
vi.mock(
  "@/components/home/host-workspace-selector/use-pick-and-add-folders",
  () => ({
    usePickAndAddWorkspaceFolders: () => mocks.pickAndAddFolders,
  }),
);

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => mocks.activeHostId,
}));
vi.mock("@/hooks/terminal/use-terminal-list-for-query", () => ({
  useTerminalListFor: () => ({
    data: mocks.probeData,
    error: mocks.probeError,
    dataUpdatedAt: mocks.dataUpdatedAt,
  }),
}));
vi.mock("@/lib/host", () => ({
  useHostClient: () => mocks.defaultClient,
}));
vi.mock(
  "@/components/home/host-workspace-selector/use-home-workspace-source",
  () => ({
    useHomeWorkspaceSource: () => ({
      primaryWorkspacePath: mocks.primaryWorkspacePath,
    }),
  }),
);
vi.mock("@/components/epic-canvas/canvas/use-pointer-drag-commit", () => ({
  pointerDragHandleAxisClassName: () => "",
  usePointerDragCommit: () => ({
    role: "slider",
    tabIndex: 0,
    "aria-orientation": "vertical",
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerCancel: () => undefined,
    onDoubleClick: () => undefined,
    onKeyDown: () => undefined,
  }),
}));
vi.mock(
  "@/components/home/terminal-panel/use-landing-terminal-kill-mutation",
  () => ({
    useLandingTerminalKill: () => ({
      mutate: mocks.kill,
      mutateAsync: mocks.killAsync,
    }),
  }),
);
vi.mock("@/components/home/terminal-panel/landing-terminal-tile", () => ({
  LandingTerminalTile: () => <div data-testid="landing-terminal-tile" />,
}));

import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The app mounts one `TooltipProvider` at the root; the strip's disabled "+"
 * tooltip needs it, so every render goes through this wrapper.
 */
function panelUi() {
  return (
    <TooltipProvider>
      <LandingTerminalPanel draftId={null} />
    </TooltipProvider>
  );
}

function runningSession(sessionId: string): CanonicalTerminalSessionInfo {
  return {
    sessionId,
    scope: { kind: "independent" },
    sessionKind: "terminal",
    cwd: "/workspace/project",
    shellCommand: "zsh",
    shellArgs: [],
    cols: 80,
    rows: 24,
    status: "running",
    exitCode: null,
    exitReason: null,
    createdAt: 1,
    title: null,
    activeProcessName: null,
  };
}

function fakeKeybindingRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

const openOverlayApi: SystemTabModalApi = {
  active: null,
  openSettings: () => undefined,
  openHistory: () => undefined,
  close: () => undefined,
  setSection: () => undefined,
  promoteToTab: () => undefined,
  isOverlayActive: () => true,
};

/** ⌘1-style event: `metaKey` counts as `mod` on every platform. */
function leaderDigitEvent(code: string): KeyboardEvent {
  return new KeyboardEvent("keydown", { code, metaKey: true });
}

describe("<LandingTerminalPanel />", () => {
  beforeEach(() => {
    mocks.activeHostId = null;
    mocks.probeData = undefined;
    mocks.freshProbeData = undefined;
    mocks.probeError = null;
    mocks.dataUpdatedAt = 1;
    mocks.primaryWorkspacePath = null;
    mocks.pickAndAddFolders.mockClear();
    mocks.folderPickPending = 0;
    mocks.kill.mockReset();
    mocks.killAsync.mockClear();
    mocks.queryClient.cancelQueries.mockClear();
    mocks.queryClient.fetchQuery.mockReset();
    mocks.queryClient.fetchQuery.mockImplementation(() =>
      Promise.resolve(mocks.freshProbeData ?? mocks.probeData),
    );
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    useLandingTerminalStore.getState().resetForTests();
    setSystemTabModalApi(null);
  });

  it("hides while no host is selected, preserving an open panel until selection", async () => {
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(panelUi());
    expect(screen.queryByTestId("landing-terminal-panel")).toBeNull();
    expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();
    expect(useLandingTerminalStore.getState().panelOpen).toBe(true);

    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.dataUpdatedAt += 1;
    view.rerender(panelUi());

    await waitFor(() => {
      expect(screen.getByTestId("landing-terminal-panel")).toBeTruthy();
      expect(useLandingTerminalStore.getState().panelOpen).toBe(true);
    });
  });

  it("shows exactly one collapse affordance while open, and the reveal one while closed", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    // Open: the header owns collapse; the floating reveal button must be gone
    // or the two stack in the same corner.
    const collapse = await screen.findByTestId("landing-terminal-collapse");
    expect(screen.queryByTestId("landing-terminal-toggle")).toBeNull();

    fireEvent.click(collapse);

    // Collapsed: the panel keeps its (hidden) header mounted, so the reveal
    // button coming back is what proves the two never coexist on screen.
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().panelOpen).toBe(false);
      expect(screen.getByTestId("landing-terminal-toggle")).toBeTruthy();
      expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
        "false",
      );
    });
  });

  it("offers the folder picker instead of a dead-end when nothing is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    const pick = await screen.findByTestId("landing-terminal-select-folder");
    // No cwd means nothing to spawn in - the panel must not auto-spawn here.
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);

    fireEvent.click(pick);
    expect(mocks.pickAndAddFolders).toHaveBeenCalledTimes(1);
  });

  it("opens a terminal when the empty tab-strip space is double-clicked", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    // Opening an empty panel auto-spawns exactly one terminal.
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    fireEvent.doubleClick(screen.getByTestId("landing-terminal-tab-strip"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });

    // A double-click that lands on a tab activates it; it must not spawn.
    fireEvent.doubleClick(screen.getAllByRole("tab")[0]);
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("scrolls a newly created tab into view when it overflows the strip", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    const scrollIntoView = vi.spyOn(
      window.HTMLElement.prototype,
      "scrollIntoView",
    );
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });

    const created = useLandingTerminalStore.getState().tabs[1];
    const createdEl = screen.getByTestId(
      `landing-terminal-tab-${created.instanceId}`,
    );
    // The tab that got scrolled must be the new (now active) one, not whatever
    // happened to be active before.
    expect(scrollIntoView.mock.instances).toContain(createdEl);
    scrollIntoView.mockRestore();
  });

  it("focuses the rename input as soon as the context menu commits", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const tab = useLandingTerminalStore.getState().tabs[0];

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${tab.instanceId}`),
    );
    fireEvent.click(await screen.findByText("Rename"));

    // The input must be live AND focused without a second click - focusing
    // naively races the closing menu's focus-restore.
    const input = await screen.findByTestId(
      `landing-terminal-tab-input-${tab.instanceId}`,
    );
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    fireEvent.change(input, { target: { value: "build" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs[0]?.name).toBe("build");
    });
  });

  it("closes every terminal from the context menu, tombstoning before killing", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const before = useLandingTerminalStore.getState().tabs;

    fireEvent.contextMenu(
      screen.getByTestId(`landing-terminal-tab-${before[0].instanceId}`),
    );
    fireEvent.click(await screen.findByText("Close All"));

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    });
    expect(useLandingTerminalStore.getState().panelOpen).toBe(false);
    // Every closed shell gets its own kill. (The tombstones they were written
    // with are drained by the reconciliation that follows, once the host list
    // confirms the sessions are gone - the durable write itself is pinned in
    // the store test.)
    before.forEach((tab) => {
      expect(mocks.kill).toHaveBeenCalledWith({
        hostId: tab.hostId,
        sessionId: tab.sessionId,
      });
    });
  });

  it("adopts the probe result before considering an auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [runningSession("orphan")] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "orphan",
      );
    });
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
  });

  it("uses the fresh list to adopt an orphan before auto-spawn", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = { sessions: [runningSession("fresh-orphan")] };
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
      expect(useLandingTerminalStore.getState().tabs[0]?.sessionId).toBe(
        "fresh-orphan",
      );
    });
  });

  it("does not clear a close tombstone from a stale empty list", async () => {
    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = {
      sessions: [runningSession("still-running")],
    };
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "still-running",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().closeTab("tab-1");
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(mocks.killAsync).toHaveBeenCalledWith({
        hostId: "host-a",
        sessionId: "still-running",
      });
    });
    expect(useLandingTerminalStore.getState().pendingKills).toEqual([
      { hostId: "host-a", sessionId: "still-running" },
    ]);
  });

  it("reruns an empty reconciliation after a workspace becomes available", async () => {
    mocks.activeHostId = "host-a";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(panelUi());

    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });
    expect(useLandingTerminalStore.getState().tabs).toEqual([]);

    mocks.primaryWorkspacePath = "/workspace/project";
    view.rerender(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
  });

  it("answers the epic tab chords: new, prev/next, and close", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    act(() => {
      dispatchAction("tab.new", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first, second] = useLandingTerminalStore.getState().tabs;
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.prev", router);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );
    act(() => {
      dispatchAction("tab.next", router);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    act(() => {
      dispatchAction("tab.close", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0].instanceId).toBe(
      first.instanceId,
    );
    expect(mocks.kill).toHaveBeenCalledWith({
      hostId: second.hostId,
      sessionId: second.sessionId,
    });
  });

  it("switches terminal tabs with the leader digit chord", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first, second] = useLandingTerminalStore.getState().tabs;
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second.instanceId,
    );

    const match = matchDigitAction(leaderDigitEvent("Digit1"));
    expect(match?.actionId).toBe("tab.switch.byDigit");
    act(() => {
      expect(match?.run()).toBe(true);
    });
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );

    // A digit past the last tab falls through instead of claiming the chord.
    const outOfRange = matchDigitAction(leaderDigitEvent("Digit9"));
    expect(outOfRange?.run()).toBe(false);
  });

  it("maximizes and restores via app.terminal.maximize, revealing when collapsed", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).not.toBeNull();

    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).toBeNull();

    // Collapsed panel: the chord reveals and maximizes in one stroke.
    fireEvent.click(
      screen.getByRole("button", { name: "Collapse terminal panel" }),
    );
    expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
      "false",
    );
    act(() => {
      dispatchAction("app.terminal.maximize", router);
    });
    expect(screen.getByTestId("landing-terminal-panel").dataset.open).toBe(
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Restore terminal panel" }),
    ).not.toBeNull();
  });

  it("explains the disabled + button with a tooltip while no folder is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    const plus = await screen.findByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    // aria-disabled instead of the native attr keeps it inert but reachable.
    fireEvent.click(plus);
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);

    fireEvent.focus(plus);
    const hints = await screen.findAllByText(
      "Pick a folder to open a terminal in.",
    );
    // At least the tooltip copy beyond the empty-state paragraph.
    expect(hints.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the + button live with no tooltip once a folder is pinned", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const plus = screen.getByRole("button", { name: "New terminal" });
    expect(plus.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(plus);
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
  });

  it("holds the tab chords while the system-tab modal occludes the page", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });

    setSystemTabModalApi(openOverlayApi);
    act(() => {
      dispatchAction("tab.new", router);
      dispatchAction("tab.close", router);
      dispatchAction("tab.close-all", router);
    });
    expect(matchDigitAction(leaderDigitEvent("Digit1"))).toBeNull();
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(mocks.kill).not.toHaveBeenCalled();
  });
});
