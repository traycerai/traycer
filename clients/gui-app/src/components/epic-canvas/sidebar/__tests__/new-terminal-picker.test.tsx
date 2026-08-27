import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { RenderResult } from "@testing-library/react";
import type {
  WorktreeBindingSelectorDisabledReason,
  WorktreeBindingSelectorRowV12,
} from "@traycer/protocol/host";
import { NewTerminalPicker } from "../new-terminal-picker";
import { useSurfaceHostSelectionStore } from "@/stores/host/surface-host-selection-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  PaneSurfaceActivityContext,
  PaneVisibilityContext,
} from "@/components/epic-tabs/pane-visibility-context";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { hasTerminalPendingCreate } from "@/lib/terminals/pending-create-identity";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import {
  isHostEpicTerminalRef,
  type EpicCanvasTileRef,
} from "@/stores/epics/canvas/types";
import { usePanelHeaderMenuStore } from "@/stores/epics/panel-header-menu-store";
import { resetEpicTerminalDurableCreatesForTests } from "@/lib/terminals/epic-terminal-durable-create-coordinator";
import { modLabel } from "@/lib/keybindings/platform";

const selectById = vi.fn();
const refreshDirectory = vi.fn(() => Promise.resolve([]));

interface BindingsQueryStub {
  readonly data:
    | {
        readonly rows: WorktreeBindingSelectorRowV12[];
        readonly folderlessCwd: string | null;
      }
    | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

const bindingsQuery = vi.hoisted(() => ({
  current: null as BindingsQueryStub | null,
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => bindingsQuery.current,
  useWorktreeListBindingsForEpicForClient: () => bindingsQuery.current,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({
    status: "reachable",
    hostLabel: "MacBook",
    unavailability: null,
  }),
}));

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [{ hostId: "host-1" }],
    fetchStatus: "idle",
  }),
}));

function stubLoadedBindings(): void {
  bindingsQuery.current = {
    data: {
      rows: [
        makeRow("host-1", "/work/traycer", "main", null),
        makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", null),
      ],
      folderlessCwd: "/Users/tgill",
    },
    isPending: false,
    isError: false,
  };
}

// This suite is about the WORKSPACE / terminal-launch list, not the host
// list, so it mocks `useHostOptions` at the boundary (the same pattern panel
// suites use for `useHostScope`) rather than standing up the six hooks it
// composes. The host section itself is now a collapsed `HostSwitcher`
// trigger (one host here, so its nested popover renders no search box, just
// the one option row).
vi.mock("@/components/settings/host-scope/use-host-options", async () => {
  const { hostOptionsFixture, hostScopeOptionFixture } =
    await import("@/components/settings/host-scope/host-scope-fixture");
  return {
    useHostOptions: () =>
      hostOptionsFixture({
        hosts: [hostScopeOptionFixture({ hostId: "host-1", name: "MacBook" })],
        activeHostId: "host-1",
      }),
  };
});

// `NewTerminalPickerBody` also reads this directly (the folderless-launch
// target's host id), independent of `useHostOptions`.
vi.mock("@/hooks/host/use-addressable-host-id", () => ({
  useAddressableHostId: () => "host-1",
}));

// The surface pin (`useSurfaceHostPin` -> `useEffectiveHostId`, redesign
// P1.2) resolves the picker's own pin row when it has none, so an unmocked
// authority store would read a null effective host here.
vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "host-1",
}));

vi.mock("@/lib/host", () => ({
  useHostBinding: () => ({
    directory: { refresh: refreshDirectory, selectById },
  }),
}));

function makeRow(
  hostId: string,
  runningDir: string,
  branch: string,
  disabledReason: WorktreeBindingSelectorDisabledReason | null,
): WorktreeBindingSelectorRowV12 {
  return {
    hostId,
    runningDir,
    workspacePath: "/work/traycer",
    worktreePath: runningDir,
    mode: "worktree",
    isGitRepo: true,
    repoIdentifier: { owner: "traycer", repo: "traycer" },
    branch,
    isPrimary: runningDir.endsWith("traycer"),
    isImported: false,
    setupState: "not_required",
    disabledReason,
    sources: [],
    isGitResolvePending: false,
  };
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

// The host section now opts the window into the registry liveness poll, and
// that hook stands on TanStack Query - so these boundary-mocked suites need a
// client even though every query in them is disabled (signed-out auth store).
// ONE client for the wrapper's lifetime: constructing it inside the render
// would hand `rerender` a fresh client while existing observers stay attached
// to the old one.
const testQueryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, gcTime: 0 } },
});
function TestProviders(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={testQueryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function renderWithClient(ui: ReactElement): RenderResult {
  return render(ui, { wrapper: TestProviders });
}

function openPicker(): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  renderWithClient(
    <TooltipProvider>
      <NewTerminalPicker
        epicId="epic-1"
        tabId={tabId}
        onBeforeOpen={undefined}
        onLaunched={null}
      />
    </TooltipProvider>,
  );
  fireEvent.click(screen.getByTestId("epic-terminals-panel-add"));
  return tabId;
}

function tabTiles(tabId: string): ReadonlyArray<EpicCanvasTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) => paneTabRefs(canvas, pane));
}

function launchedTerminalCwd(tile: EpicCanvasTileRef): string | undefined {
  if (tile.type !== "terminal" || !isHostEpicTerminalRef(tile)) {
    return undefined;
  }
  return tile.legacyFallback.cwd;
}

describe("<NewTerminalPicker />", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    usePanelHeaderMenuStore.setState({ openBySurfaceKey: {} });
    selectById.mockClear();
    refreshDirectory.mockClear();
    useSurfaceHostSelectionStore.getState().resetForTests();
    stubLoadedBindings();
  });

  afterEach(() => {
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
    resetEpicTerminalDurableCreatesForTests();
  });

  it("opens a popover with the host section and workspace rows", () => {
    openPicker();

    expect(screen.getByTestId("new-terminal-picker-popover")).toBeDefined();
    expect(
      screen.getByTestId("host-workspace-selector-host-section"),
    ).toBeDefined();
    // The host section is now a collapsed switcher trigger, not a flat row
    // list - its rows are one click away, not asserted here.
    const hostTrigger = screen.getByTestId("settings-host-switcher");
    expect(hostTrigger.getAttribute("aria-label")).toBe("Host: MacBook");
    const workspacesHeader = screen.getByText("Workspaces");
    const search = screen.getByRole("combobox");
    expect(screen.getAllByText("Workspaces")).toHaveLength(1);
    expect(
      workspacesHeader.compareDocumentPosition(search) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const primaryOption = screen.getByRole("option", {
      name: /traycer.*main/i,
    });
    expect(primaryOption).toBeDefined();
    expect(primaryOption.className).toContain("cursor-pointer");
    expect(screen.getByRole("option", { name: /feature-x/i })).toBeDefined();
    expect(screen.getByText("/work/traycer-wt/feature-x")).toBeDefined();
    // The primary workspace is auto-selected on open, so Launch is ready.
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(primaryOption.dataset.checked).toBe("true");
    expect(
      screen.getByRole("option", { name: /feature-x/i }).dataset.checked,
    ).toBeUndefined();
  });

  it("preserves the open picker when its panel header remounts", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
    const picker = (key: string) => (
      <TooltipProvider>
        <NewTerminalPicker
          key={key}
          epicId="epic-1"
          tabId={tabId}
          onBeforeOpen={undefined}
          onLaunched={null}
        />
      </TooltipProvider>
    );
    const { rerender } = renderWithClient(picker("collapsed-header"));

    fireEvent.click(screen.getByTestId("epic-terminals-panel-add"));
    rerender(picker("expanded-header"));

    expect(screen.getByTestId("new-terminal-picker-popover")).toBeDefined();
  });

  it("auto-selects the primary workspace even when it is not the first row", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", null),
          makeRow("host-1", "/work/traycer", "main", null),
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    openPicker();

    expect(
      screen.getByRole("option", { name: /traycer.*main/i }).dataset.checked,
    ).toBe("true");
    expect(
      screen.getByRole("option", { name: /feature-x/i }).dataset.checked,
    ).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("falls back to the first selectable row when the primary is disabled", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          makeRow("host-1", "/work/traycer", "main", "missing_worktree_path"),
          makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", null),
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    openPicker();

    // The primary row is disabled ("missing"), so it cannot be selected; the
    // next selectable row is auto-selected as the fallback.
    expect(
      screen.getByRole("option", { name: /feature-x/i }).dataset.checked,
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("launches the fallback row when the primary is missing", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          makeRow("host-1", "/work/traycer", "main", "missing_worktree_path"),
          makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", null),
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].hostId).toBe("host-2");
    expect(launchedTerminalCwd(terminals[0])).toBe(
      "/work/traycer-wt/feature-x",
    );
    expect(isHostEpicTerminalRef(terminals[0])).toBe(true);
    expect(
      hasTerminalPendingCreate(
        useEpicCanvasStore.getState().pendingCreateTerminalIdentities,
        terminals[0].hostId,
        terminals[0].id,
      ),
    ).toBe(true);
  });

  it("launches the selected terminal with Cmd+Enter", () => {
    const tabId = openPicker();

    const launchButton = screen.getByRole("button", { name: "Launch" });
    expect(launchButton.textContent).toContain(modLabel());
    expect(launchButton.textContent).toContain("↵");

    fireEvent.keyDown(window, { key: "Enter", metaKey: true });

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].hostId).toBe("host-1");
    expect(launchedTerminalCwd(terminals[0])).toBe("/work/traycer");
    expect(isHostEpicTerminalRef(terminals[0])).toBe(true);
  });

  it("shows failed setup as a non-blocking warning and launches that worktree", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          {
            ...makeRow(
              "host-1",
              "/work/traycer-wt/feature-x",
              "feature-x",
              null,
            ),
            setupState: "failed",
          },
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    const option = screen.getByRole("option", { name: /feature-x/i });
    const warning = within(option).getByText("setup failed");
    expect(warning.getAttribute("data-status-tone")).toBe("warning");
    expect(warning.getAttribute("aria-label")).toContain(
      "worktree is still usable",
    );
    expect(option.className).toContain("cursor-pointer");
    expect(option.dataset.checked).toBe("true");
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(launchedTerminalCwd(terminals[0])).toBe(
      "/work/traycer-wt/feature-x",
    );
  });

  it("launches immediately after creation while setup is still running", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          {
            ...makeRow(
              "host-1",
              "/work/traycer-wt/feature-x",
              "feature-x",
              // Compatibility with an older host that still projected setup
              // progress as a disabled reason.
              "setup_running",
            ),
            // The legacy disabled reason remains authoritative when a mixed
            // host/client deployment has not converged on setupState yet.
            setupState: "not_required",
          },
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    const option = screen.getByRole("option", { name: /feature-x/i });
    const progress = within(option).getByText("setting up");
    expect(progress.getAttribute("data-status-tone")).toBe("neutral");
    expect(progress.getAttribute("aria-label")).toContain(
      "ready to use while setup continues",
    );
    expect(option.dataset.checked).toBe("true");
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    expect(
      tabTiles(tabId).some(
        (tile) =>
          tile.type === "terminal" &&
          launchedTerminalCwd(tile) === "/work/traycer-wt/feature-x",
      ),
    ).toBe(true);
  });

  it("shows legacy setup-pending status while keeping the row selectable", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          {
            ...makeRow(
              "host-1",
              "/work/traycer-wt/feature-x",
              "feature-x",
              "setup_pending",
            ),
            setupState: "not_required",
          },
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    openPicker();

    const option = screen.getByRole("option", { name: /feature-x/i });
    const pending = within(option).getByText("setup pending");
    expect(pending.getAttribute("data-status-tone")).toBe("neutral");
    expect(option.className).toContain("cursor-pointer");
    expect(option.dataset.checked).toBe("true");
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("selects nothing and keeps Launch disabled when every row is disabled", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          {
            ...makeRow("host-1", "/work/traycer", "main", "setup_pending"),
            setupState: "pending",
            isGitRepo: false,
          },
          {
            ...makeRow(
              "host-2",
              "/work/traycer-wt/feature-x",
              "feature-x",
              "setup_running",
            ),
            setupState: "running",
            isGitRepo: false,
          },
        ],
        folderlessCwd: "/Users/tgill",
      },
      isPending: false,
      isError: false,
    };
    openPicker();

    expect(
      screen
        .getAllByRole("option")
        .every((option) => option.dataset.checked === undefined),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("launches a terminal in the host default cwd when no workspaces are bound", () => {
    bindingsQuery.current = {
      data: { rows: [], folderlessCwd: "/Users/tgill" },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    expect(
      screen.getByText(
        "No directories available. Open a workspace in the epic first.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].hostId).toBe("host-1");
    expect(launchedTerminalCwd(terminals[0])).toBe("/Users/tgill");
    expect(isHostEpicTerminalRef(terminals[0])).toBe(true);
  });

  it("keeps Launch disabled while workspace bindings are loading", () => {
    bindingsQuery.current = {
      data: undefined,
      isPending: true,
      isError: false,
    };
    const tabId = openPicker();

    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(0);
  });

  it("keeps Launch disabled when the host cannot resolve a folderless cwd", () => {
    // A v1.0 host predates folderless workspaces; the bridged response
    // carries `folderlessCwd: null`.
    bindingsQuery.current = {
      data: { rows: [], folderlessCwd: null },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    expect(
      screen.getByTestId("new-terminal-folderless-cwd-error"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(0);

    // Capability-gated off by default.
    expect(screen.queryByRole("button", { name: "Report issue" })).toBeNull();

    act(() => {
      useDesktopDialogStore.setState({ reportIssueAvailable: true });
    });
    fireEvent.click(screen.getByRole("button", { name: "Report issue" }));

    expect(useDesktopDialogStore.getState()).toMatchObject({
      activeDialog: "report-issue",
      reportIssueContext: {
        title: "Couldn't resolve terminal directory",
        message: "The terminal working directory could not be resolved.",
        code: null,
        source: "New terminal",
      },
    });
  });

  it("selects a workspace without creating a terminal on a single click", () => {
    const tabId = openPicker();

    fireEvent.click(screen.getByRole("option", { name: /feature-x/i }));

    const tiles = tabTiles(tabId);
    expect(tiles.filter((tile) => tile.type === "terminal")).toHaveLength(0);
    expect(screen.queryByTestId("new-terminal-picker-popover")).not.toBeNull();
    const worktreeOption = screen.getByRole("option", { name: /feature-x/i });
    const primaryOption = screen.getByRole("option", {
      name: /traycer.*main/i,
    });
    expect(worktreeOption.dataset.checked).toBe("true");
    expect(primaryOption.dataset.checked).toBeUndefined();
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(false);
  });

  it("launches a terminal bound to the selected row's host and cwd", () => {
    const tabId = openPicker();

    fireEvent.click(screen.getByRole("option", { name: /feature-x/i }));
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const tiles = tabTiles(tabId);
    const terminals = tiles.filter((tile) => tile.type === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0].hostId).toBe("host-2");
    expect(launchedTerminalCwd(terminals[0])).toBe(
      "/work/traycer-wt/feature-x",
    );
    expect(terminals[0].name).toBe("New Terminal");
    expect(screen.queryByTestId("new-terminal-picker-popover")).toBeNull();
  });

  it("does not create a terminal when workspaces fail to load", () => {
    bindingsQuery.current = {
      data: undefined,
      isPending: false,
      isError: true,
    };
    const tabId = openPicker();

    expect(screen.getByText("Failed to load workspaces.")).toBeDefined();

    const tiles = tabTiles(tabId);
    expect(tiles.filter((tile) => tile.type === "terminal")).toHaveLength(0);
  });

  it("pins the surface host without creating a tile when a host row is clicked", () => {
    const tabId = openPicker();

    // The host row is one click behind the switcher trigger now.
    fireEvent.click(screen.getByTestId("settings-host-switcher"));
    fireEvent.click(screen.getByTestId("settings-host-switcher-option-host-1"));

    expect(selectById).not.toHaveBeenCalled();
    const surfaceKey = Object.keys(
      useSurfaceHostSelectionStore.getState().selections,
    )[0];
    expect(surfaceKey).toMatch(/^new-terminal/);
    expect(useSurfaceHostSelectionStore.getState().selections[surfaceKey]).toBe(
      "host-1",
    );
    const tiles = tabTiles(tabId);
    expect(tiles.filter((tile) => tile.type === "terminal")).toHaveLength(0);
  });

  it("focuses the workspace search input on open", () => {
    openPicker();

    expect(document.activeElement).toBe(screen.getByRole("combobox"));
  });

  it("navigates and selects rows with arrow keys without leaving the input", () => {
    openPicker();

    const input = screen.getByRole("combobox");
    expect(document.activeElement).toBe(input);

    // Arrow off the auto-selected primary onto the next row, then commit with
    // Enter - all while focus stays in the search input (cmdk owns this).
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(
      screen.getByRole("option", { name: /feature-x/i }).dataset.checked,
    ).toBe("true");
    expect(
      screen.getByRole("option", { name: /traycer.*main/i }).dataset.checked,
    ).toBeUndefined();
    expect(document.activeElement).toBe(input);
  });
});

describe("<NewTerminalPicker /> focus-loss dismissal (MED4)", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    usePanelHeaderMenuStore.setState({ openBySurfaceKey: {} });
    stubLoadedBindings();
  });

  function paneUi(focused: boolean, tabId: string) {
    return (
      <PaneSurfaceActivityContext.Provider value={{ visible: true, focused }}>
        <PaneVisibilityContext.Provider value>
          <TooltipProvider>
            <NewTerminalPicker
              epicId="epic-1"
              tabId={tabId}
              onBeforeOpen={undefined}
              onLaunched={null}
            />
          </TooltipProvider>
        </PaneVisibilityContext.Provider>
      </PaneSurfaceActivityContext.Provider>
    );
  }

  it("dismisses an open picker when its pane loses focus, rather than leaving a logically-open root with reset content", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
    const { rerender } = renderWithClient(paneUi(true, tabId));
    fireEvent.click(screen.getByTestId("epic-terminals-panel-add"));
    expect(screen.queryByTestId("new-terminal-picker-popover")).not.toBeNull();

    // Pane backgrounded (e.g. a native/deep-link activation of the partner).
    act(() => {
      rerender(paneUi(false, tabId));
    });
    expect(screen.queryByTestId("new-terminal-picker-popover")).toBeNull();
  });
});
