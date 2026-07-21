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
  // The (host client, workspace draft) the folder picker was last wired with,
  // so a test can assert it targets the CAPTURED host/draft, not live focus.
  pickArgs: null as {
    readonly clientHostId: string | null;
    readonly workspaceDraftId: string | null;
  } | null,
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
  buildTransientHostClient: vi.fn<
    (
      client: unknown,
      entry: { readonly hostId: string },
    ) => { getActiveHostId: () => string; onChange: () => () => void } | null
  >((_client, entry) => ({
    getActiveHostId: () => entry.hostId,
    onChange: () => () => undefined,
  })),
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
    usePickAndAddWorkspaceFolders: (
      client: { getActiveHostId?: () => string | null } | null,
      workspaceSource: { draftId: string | null },
    ) => {
      // Record the host client + workspace source the picker was wired with, so
      // a test can assert both address the CAPTURED host/draft (finding 3).
      mocks.pickArgs = {
        clientHostId:
          client === null || client.getActiveHostId === undefined
            ? null
            : client.getActiveHostId(),
        workspaceDraftId: workspaceSource.draftId,
      };
      return mocks.pickAndAddFolders;
    },
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
  useHostDirectory: () => ({
    findById: (hostId: string) => ({ hostId, websocketUrl: "ws://test" }),
  }),
}));
vi.mock("@/hooks/host/use-host-client-for", () => ({
  buildTransientHostClient: mocks.buildTransientHostClient,
}));
vi.mock(
  "@/components/home/host-workspace-selector/use-home-workspace-source",
  () => ({
    useHomeWorkspaceSource: (key: {
      readonly surface: string;
      readonly draftId: string | null;
    }) => ({
      primaryWorkspacePath: mocks.primaryWorkspacePath,
      // Tag the source with the draft it was keyed by so a test can assert the
      // provider keys it to the CAPTURED draft while a gesture pins.
      draftId: key.surface === "landing" ? key.draftId : null,
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
  LandingTerminalTile: () => (
    <div data-testid="landing-terminal-tile">Starting terminal…</div>
  ),
}));

import { LandingTerminalPanel } from "@/components/home/terminal-panel/landing-terminal-panel";
import { LandingTerminalGestureProvider } from "@/components/home/terminal-panel/landing-terminal-gesture-provider";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The app mounts one `TooltipProvider` at the root; the strip's disabled "+"
 * tooltip needs it, so every render goes through this wrapper. The gesture
 * provider (the single live-value reader) wraps the panel exactly as
 * `LandingTerminalHost` does in production; `draftId` models the focused draft
 * the host projects, so a rerender with a new `draftId` models a focus switch.
 */
function panelUi() {
  return panelUiForDraft(null);
}

function panelUiForDraft(draftId: string | null) {
  return (
    <TooltipProvider>
      <LandingTerminalGestureProvider draftId={draftId}>
        <LandingTerminalPanel />
      </LandingTerminalGestureProvider>
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
    mocks.pickArgs = null;
    mocks.folderPickPending = 0;
    mocks.kill.mockReset();
    mocks.killAsync.mockClear();
    // Reset (not just clear): a test may override the return with a fail-closed
    // `null`, and mockClear would leak that override into later tests. Restore
    // the default host-pinned client here.
    mocks.buildTransientHostClient.mockReset();
    mocks.buildTransientHostClient.mockImplementation(
      (_client: unknown, entry: { readonly hostId: string }) => ({
        getActiveHostId: () => entry.hostId,
        onChange: () => () => undefined,
      }),
    );
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

  it("keeps an opening gesture on draft A when focus switches to draft B before terminal.list settles", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // The top-level host projects the focused draft into its one terminal host.
    // Focus moves to B while A's terminal.list generation is pending.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    const [spawned] = useLandingTerminalStore.getState().tabs;
    expect(spawned.cwd).toBe("/workspace/draft-a");
    expect(useLandingTerminalStore.getState().activeInstanceId).toBe(
      spawned.instanceId,
    );
  });

  it("preserves a folderless opening gesture when focus switches to a foldered draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("reconciles through the host client captured at the opening gesture", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.activeHostId = "host-b";
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("disables the create action when the host client cannot be pinned, never falling back to the default client", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    // Directory churn / missing ws url: the transient client cannot be pinned.
    mocks.buildTransientHostClient.mockReturnValue(null);
    render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Opening captures a gesture whose pinned client is null -> fail-closed.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });

    const plus = await screen.findByRole("button", { name: "New terminal" });
    // Fail-closed: disabled, and NOT silently reconciling on the default client
    // (which would auto-spawn a terminal into the empty panel).
    expect(plus.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(plus);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
    expect(mocks.queryClient.fetchQuery).not.toHaveBeenCalled();
  });

  it("creates from the captured host's supported verdict when the live host becomes unavailable before terminal.list settles", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Capture the gesture while host-a is supported...
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // ...then the default host switches to host-b whose probe has not resolved,
    // so the LIVE availability is "unknown". The captured supported verdict must
    // still drive creation on host-a; the live host's verdict must not gate it.
    mocks.activeHostId = "host-b";
    mocks.probeData = undefined;
    view.rerender(panelUiForDraft("draft-b"));
    await drainDeferredListFetches(resolvers);

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("clears a settled opening gesture so the + button follows focus to a folderless draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Open on foldered draft A: the gesture settles and auto-spawns A's terminal.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(
      screen
        .getByRole("button", { name: "New terminal" })
        .getAttribute("aria-disabled"),
    ).toBeNull();

    // Focus moves to a folderless draft B AFTER the gesture settled. A stale A
    // snapshot would keep + enabled from A's pinned folder; the cleared gesture
    // makes + reflect the live folderless B instead.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "New terminal" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    });
    // The A terminal survives; focus-following must not have spawned in B.
    expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    expect(useLandingTerminalStore.getState().tabs[0]?.cwd).toBe(
      "/workspace/draft-a",
    );
  });

  it("creates a + terminal on the captured host and folder even after focus moved to a folderless draft", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Open on draft A (the gesture pins host-a + /workspace/draft-a); the list
    // fetch is deferred, so the gesture is still pending.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // Focus moves to a folderless draft B before the list settles.
    mocks.primaryWorkspacePath = null;
    view.rerender(panelUiForDraft("draft-b"));

    // The + button must create against the pinned A gesture, not the folderless
    // B the panel now happens to be focused on. It must NOT re-capture.
    const plus = await screen.findByRole("button", { name: "New terminal" });
    fireEvent.click(plus);

    await waitFor(() => {
      expect(useLandingTerminalStore.getState().tabs).toHaveLength(1);
    });
    expect(useLandingTerminalStore.getState().tabs[0]).toMatchObject({
      hostId: "host-a",
      cwd: "/workspace/draft-a",
    });
  });

  it("honors fail-closed on the tab.new chord: an unpinnable host creates nothing via the default client", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/project";
    mocks.probeData = { sessions: [] };
    mocks.freshProbeData = mocks.probeData;
    // The transient client cannot be pinned to the host.
    mocks.buildTransientHostClient.mockReturnValue(null);
    render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // tab.new opens the panel (capturing a fail-closed gesture) and creates. It
    // must NOT fall back to the default client to spawn a terminal.
    act(() => {
      dispatchAction("tab.new", router);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(useLandingTerminalStore.getState().tabs).toHaveLength(0);
  });

  it("wires the folder picker to the captured host and draft, not the focused partner", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = null;
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Open on a folderless draft A (the gesture pins host-a + draft-a), then
    // focus moves to draft B on a different host with a folder.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    mocks.activeHostId = "host-b";
    mocks.primaryWorkspacePath = "/workspace/draft-b";
    view.rerender(panelUiForDraft("draft-b"));

    // The empty-state picker must add folders to the CAPTURED host + draft, so a
    // picked folder lands where the gesture opened, not on the focused partner.
    await screen.findByTestId("landing-terminal-select-folder");
    expect(mocks.pickArgs).toEqual({
      clientHostId: "host-a",
      workspaceDraftId: "draft-a",
    });
  });

  it("remembers a captured host's availability downgrade after focus switches away", async () => {
    mocks.activeHostId = "host-a";
    mocks.primaryWorkspacePath = "/workspace/draft-a";
    mocks.probeData = { sessions: [] };
    const resolvers: Array<(value: unknown) => void> = [];
    mocks.queryClient.fetchQuery.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const view = render(panelUiForDraft("draft-a"));
    const router = fakeKeybindingRouter();

    // Capture the gesture while host-a is supported.
    act(() => {
      dispatchAction("app.terminal.toggle", router);
    });
    // host-a's capability then downgrades while host-a is STILL selected.
    mocks.probeData = undefined;
    view.rerender(panelUiForDraft("draft-a"));
    // Focus then moves to draft B on a different host.
    mocks.activeHostId = "host-b";
    view.rerender(panelUiForDraft("draft-b"));

    // The + button must reflect host-a's LAST observed (downgraded) verdict, not
    // the initial captured "supported": a forgotten downgrade would leave it
    // enabled.
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "New terminal" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
    });
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
