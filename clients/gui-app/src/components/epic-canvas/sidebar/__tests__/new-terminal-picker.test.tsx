import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type {
  WorktreeBindingSelectorDisabledReason,
  WorktreeBindingSelectorRowV12,
} from "@traycer/protocol/host";
import { NewTerminalPicker } from "../new-terminal-picker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useDesktopDialogStore } from "@/stores/dialogs/desktop-dialog-store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

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

vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({
    data: [
      {
        hostId: "host-1",
        label: "MacBook",
        kind: "local",
        websocketUrl: null,
        version: null,
        status: "available",
      },
    ],
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
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

function openPicker(): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  render(
    <TooltipProvider>
      <NewTerminalPicker epicId="epic-1" tabId={tabId} />
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

describe("<NewTerminalPicker />", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    selectById.mockClear();
    refreshDirectory.mockClear();
    stubLoadedBindings();
  });

  afterEach(() => {
    useDesktopDialogStore.setState({
      activeDialog: null,
      reportIssueAvailable: false,
      reportIssueContext: null,
    });
  });

  it("opens a popover with the host section and workspace rows", () => {
    openPicker();

    expect(screen.getByTestId("new-terminal-picker-popover")).toBeDefined();
    expect(
      screen.getByTestId("host-workspace-selector-host-section"),
    ).toBeDefined();
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
    expect(terminals[0].cwd).toBe("/work/traycer-wt/feature-x");
  });

  it("selects nothing and keeps Launch disabled when every row is disabled", () => {
    bindingsQuery.current = {
      data: {
        rows: [
          makeRow("host-1", "/work/traycer", "main", "missing_worktree_path"),
          makeRow(
            "host-2",
            "/work/traycer-wt/feature-x",
            "feature-x",
            "setup_failed",
          ),
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
    expect(terminals[0].cwd).toBe("/Users/tgill");
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
    expect(terminals[0].cwd).toBe("/work/traycer-wt/feature-x");
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

  it("swaps the bound host without creating a tile when a host row is clicked", () => {
    const tabId = openPicker();

    fireEvent.click(
      screen.getByTestId("host-workspace-selector-host-row-host-1"),
    );

    expect(selectById).toHaveBeenCalledWith("host-1");
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
