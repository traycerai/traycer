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
import { registerComposerFocus } from "@/lib/composer/composer-focus-registry";
import {
  registerTerminalFocus,
  resetTerminalFocusRegistryForTests,
} from "@/lib/terminals/terminal-focus-registry";
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
  reconcileXtermHostAfterLayoutTransition: vi.fn(),
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
  LandingTerminalTile: () => (
    <div data-testid="landing-terminal-tile">Starting terminal…</div>
  ),
}));
vi.mock("@/components/epic-canvas/renderers/xterm-host-registry", () => ({
  reconcileXtermHostAfterLayoutTransition:
    mocks.reconcileXtermHostAfterLayoutTransition,
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

/**
 * Resolves every deferred `fetchQuery` a reconciliation generation issues,
 * repeatedly: a generation only calls `fetchQuery` after an internal await, so
 * a single splice would race it and leave the live generation hanging. Each
 * pass yields a macrotask so continuations (including newly started
 * generations) run before the next drain.
 */
async function drainDeferredListFetches(
  resolvers: Array<(value: unknown) => void>,
): Promise<void> {
  await act(async () => {
    for (let pass = 0; pass < 10; pass += 1) {
      resolvers.splice(0).forEach((resolve) => {
        resolve({ sessions: [] });
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

async function flushAnimationFrame(): Promise<void> {
  await act(
    () =>
      new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => resolve());
      }),
  );
}

function testRect(width: number, height: number, left: number): DOMRect {
  return {
    x: left,
    y: 0,
    width,
    height,
    top: 0,
    right: left + width,
    bottom: height,
    left,
    toJSON: () => ({}),
  };
}

describe("<LandingTerminalPanel />", () => {
  const focusCleanups: Array<() => void> = [];

  beforeEach(() => {
    resetTerminalFocusRegistryForTests();
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
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();
    mocks.queryClient.cancelQueries.mockClear();
    mocks.queryClient.fetchQuery.mockReset();
    mocks.queryClient.fetchQuery.mockImplementation(() =>
      Promise.resolve(mocks.freshProbeData ?? mocks.probeData),
    );
    useLandingTerminalStore.getState().resetForTests();
  });

  afterEach(() => {
    cleanup();
    focusCleanups.forEach((unregister) => unregister());
    focusCleanups.length = 0;
    resetTerminalFocusRegistryForTests();
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

  it("shows only the host connection state while an existing terminal waits for the probe", () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelOpen(true);

    render(panelUi());

    expect(screen.getByRole("status").textContent).toBe(
      "Connecting to the selected host…",
    );
    expect(screen.queryByText("Starting terminal…")).toBeNull();
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

  it("moves focus into the active terminal on expand and back to the composer on collapse", async () => {
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
    const tab = useLandingTerminalStore.getState().tabs[0];
    const terminalFocus = vi.fn();
    const composerFocus = vi.fn();
    focusCleanups.push(registerTerminalFocus(tab.instanceId, terminalFocus));
    focusCleanups.push(registerComposerFocus(composerFocus, true));

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    expect(useLandingTerminalStore.getState().panelOpen).toBe(false);
    await waitFor(() => {
      expect(composerFocus).toHaveBeenCalled();
    });
    expect(terminalFocus).not.toHaveBeenCalled();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(terminalFocus).toHaveBeenCalled();
    });
  });

  it("refits the active terminal after reopening from zero width to the stored panel width", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [runningSession("session-1")] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelWidthFraction(0.42);
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    const panel = screen.getByTestId("landing-terminal-panel");
    expect(panel.style.width).toBe("42%");
    await flushAnimationFrame();
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    fireEvent.click(screen.getByTestId("landing-terminal-collapse"));
    await waitFor(() => {
      expect(panel.style.width).toBe("0%");
    });
    fireEvent.transitionEnd(panel, { propertyName: "width" });
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    await waitFor(() => {
      expect(panel.style.width).toBe("42%");
    });
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.transitionEnd(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).toHaveBeenCalledOnce();
    expect(mocks.reconcileXtermHostAfterLayoutTransition).toHaveBeenCalledWith(
      "tab-1",
    );
  });

  it("refits a terminal activated by delayed reconciliation after the reveal transition", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/other";
    mocks.probeData = undefined;
    const sessions = [
      runningSession("session-1"),
      { ...runningSession("session-2"), cwd: "/workspace/other" },
    ];
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-2",
      sessionId: "session-2",
      hostId: "host-a",
      cwd: "/workspace/other",
      name: "other",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().activateTab("tab-1");
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUi());

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    const panel = screen.getByTestId("landing-terminal-panel");
    fireEvent.transitionEnd(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(mocks.reconcileXtermHostAfterLayoutTransition).toHaveBeenCalledWith(
      "tab-1",
    );
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    mocks.probeData = { sessions };
    mocks.dataUpdatedAt += 1;
    view.rerender(panelUi());
    await waitFor(() => {
      expect(resolvers).toHaveLength(1);
    });
    const resolveFreshList = resolvers.shift();
    if (resolveFreshList === undefined) {
      throw new Error("Expected a deferred terminal list fetch");
    }
    await act(async () => {
      resolveFreshList({ sessions });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().activeInstanceId).toBe("tab-2");
    });
    await waitFor(() => {
      expect(
        mocks.reconcileXtermHostAfterLayoutTransition,
      ).toHaveBeenCalledWith("tab-2");
    });
  });

  it("waits for an interrupted reveal drag to commit before refitting", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [runningSession("session-1")] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelWidthFraction(0.42);
    render(panelUi());

    fireEvent.click(screen.getByTestId("landing-terminal-toggle"));
    const panel = screen.getByTestId("landing-terminal-panel");
    const resizeHandle = screen.getByTestId("landing-terminal-resize-handle");
    const container = resizeHandle.parentElement;
    if (container === null) throw new Error("Expected the panel container");
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue(
      testRect(1_000, 800, 0),
    );
    vi.spyOn(panel, "getBoundingClientRect").mockReturnValue(
      testRect(420, 800, 580),
    );
    mocks.reconcileXtermHostAfterLayoutTransition.mockClear();

    fireEvent.pointerDown(resizeHandle, {
      button: 0,
      pointerId: 7,
      clientX: 580,
    });
    fireEvent.transitionCancel(panel, { propertyName: "width" });
    await flushAnimationFrame();
    expect(
      mocks.reconcileXtermHostAfterLayoutTransition,
    ).not.toHaveBeenCalled();

    fireEvent.pointerMove(resizeHandle, { pointerId: 7, clientX: 530 });
    fireEvent.pointerUp(resizeHandle, { pointerId: 7, clientX: 530 });
    expect(panel.style.width).toBe("47%");
    await waitFor(() => {
      expect(
        mocks.reconcileXtermHostAfterLayoutTransition,
      ).toHaveBeenCalledWith("tab-1");
    });
  });

  it("does not steal focus from the composer when mounting with the panel already open", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    useLandingTerminalStore.getState().setPanelOpen(true);
    const terminalFocus = vi.fn();
    focusCleanups.push(registerTerminalFocus("tab-1", terminalFocus));

    render(panelUi());

    // Let the mount-time reconciliation generation settle fully, including
    // any deferred focus fulfilment the registry might have scheduled.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(1);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(terminalFocus).not.toHaveBeenCalled();
  });

  it("parks the focus request for a terminal spawned by expanding an empty panel", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const created = useLandingTerminalStore.getState().tabs[0];

    // The auto-spawned tile's engine registers after the create - the parked
    // request must fire exactly then, not get lost.
    const terminalFocus = vi.fn();
    focusCleanups.push(
      registerTerminalFocus(created.instanceId, terminalFocus),
    );
    await waitFor(() => {
      expect(terminalFocus).toHaveBeenCalledTimes(1);
    });
  });

  it("fulfils tab-activation focus only after the commit, never synchronously", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    fireEvent.click(screen.getByTestId("landing-terminal-new-tab"));
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const [first] = useLandingTerminalStore.getState().tabs;
    const firstFocus = vi.fn();
    focusCleanups.push(registerTerminalFocus(first.instanceId, firstFocus));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    firstFocus.mockClear();

    // At click time the target tile's wrapper is still `invisible` (React has
    // not committed the active flip), and a browser rejects focus on hidden
    // elements without retrying - so the registry must defer fulfilment past
    // the commit instead of invoking the callback inside the click handler.
    fireEvent.click(
      screen.getByTestId(`landing-terminal-tab-${first.instanceId}`),
    );
    expect(firstFocus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(firstFocus).toHaveBeenCalledTimes(1);
    });
  });

  it("an unfulfilled open intent lands on the folder pinned at settle time", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    // Expand while the list fetch is still in flight, then repoint the pinned
    // folder before anything settles. The open gesture was never fulfilled,
    // so the surviving generation honors it against the folder pinned NOW -
    // nothing had landed yet, so nothing is disrupted.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());
    await drainDeferredListFetches(resolvers);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const spawned = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.instanceId !== "tab-1");
    expect(spawned?.cwd).toBe("/workspace/other");
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      spawned?.instanceId,
    );
  });

  it("cancels the open intent once the user interacts with the panel", async () => {
    mocks.activeHostId = "host-a";
    // Pinned folder has no matching terminal, so an uncancelled intent would
    // spawn there on settle.
    mocks.primaryWorkspacePath = "/workspace/other";
    mocks.probeData = { sessions: [] };
    useLandingTerminalStore.getState().addTab({
      instanceId: "tab-1",
      sessionId: "session-1",
      hostId: "host-a",
      cwd: "/workspace/project",
      name: "project",
      titleSource: "default",
    });
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    render(panelUi());
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // The user picks a tab themselves while the list fetch is still pending -
    // a late-settling pass must not yank them off that choice or spawn.
    fireEvent.click(screen.getByTestId("landing-terminal-tab-tab-1"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe("tab-1");
  });

  it("hands focus to the composer when closing the last tab collapses the panel", async () => {
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
    const composerFocus = vi.fn();
    focusCleanups.push(registerComposerFocus(composerFocus, true));

    act(() => {
      dispatchAction("tab.close", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().panelOpen).toBe(false);
      expect(composerFocus).toHaveBeenCalled();
    });
  });

  it("reopens onto the pinned folder: spawns there when no terminal matches, reuses one that does", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(panelUi());
    const router = fakeKeybindingRouter();

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const first = useLandingTerminalStore.getState().tabs[0];
    expect(first.cwd).toBe("/workspace/project");

    // Collapse, repoint the composer's pinned folder, re-expand: the panel
    // must land on a terminal running in the new folder - here by spawning
    // one, since none matches - while the old terminal stays as a tab.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
    });
    const second = useLandingTerminalStore
      .getState()
      .tabs.find((tab) => tab.instanceId !== first.instanceId);
    expect(second?.cwd).toBe("/workspace/other");
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      second?.instanceId,
    );

    // Collapse, repoint back to the original folder, re-expand: the still-
    // running matching terminal is reused instead of spawning a third.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/project";
    view.rerender(panelUi());
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
        first.instanceId,
      );
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(2);
  });

  it("leaves the open panel alone when the pinned folder changes without a reopen", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    useLandingTerminalStore.getState().setPanelOpen(true);
    const view = render(panelUi());

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const first = useLandingTerminalStore.getState().tabs[0];

    mocks.primaryWorkspacePath = "/workspace/other";
    view.rerender(panelUi());

    // The folder change re-runs reconciliation; it must not spawn or switch
    // while the panel stays open - only a reopen re-targets the pinned folder.
    await waitFor(() => {
      expect(mocks.queryClient.fetchQuery).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      first.instanceId,
    );
  });
});
