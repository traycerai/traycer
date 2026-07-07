import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type {
  WorktreeBindingSelectorDisabledReason,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import { NewTerminalPicker } from "../new-terminal-picker";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

const selectById = vi.fn();

interface BindingsQueryStub {
  readonly data: { readonly rows: WorktreeBindingSelectorRow[] } | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

interface DefaultCwdQueryStub {
  readonly data: { readonly cwd: string } | undefined;
  readonly isPending: boolean;
  readonly isError: boolean;
}

const bindingsQuery = vi.hoisted(() => ({
  current: null as BindingsQueryStub | null,
}));

const defaultCwdQuery: { current: DefaultCwdQueryStub } = vi.hoisted(() => ({
  current: {
    data: { cwd: "/Users/tgill" },
    isPending: false,
    isError: false,
  },
}));

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => bindingsQuery.current,
}));

vi.mock("@/hooks/terminal/use-terminal-default-cwd-query", () => ({
  useTerminalDefaultCwd: () => defaultCwdQuery.current,
}));

function stubLoadedBindings(): void {
  bindingsQuery.current = {
    data: {
      rows: [
        makeRow("host-1", "/work/traycer", "main", null),
        makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x", null),
      ],
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
  useHostBinding: () => ({ directory: { selectById } }),
}));

function makeRow(
  hostId: string,
  runningDir: string,
  branch: string,
  disabledReason: WorktreeBindingSelectorDisabledReason | null,
): WorktreeBindingSelectorRow {
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
  };
}

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function openPicker(): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
  render(<NewTerminalPicker epicId="epic-1" tabId={tabId} />);
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
    stubLoadedBindings();
    defaultCwdQuery.current = {
      data: { cwd: "/Users/tgill" },
      isPending: false,
      isError: false,
    };
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
      data: { rows: [] },
      isPending: false,
      isError: false,
    };
    const tabId = openPicker();

    expect(screen.getByText("No worktrees found.")).toBeDefined();
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

  it("keeps Launch disabled while folderless default cwd is loading", () => {
    bindingsQuery.current = {
      data: { rows: [] },
      isPending: false,
      isError: false,
    };
    defaultCwdQuery.current = {
      data: undefined,
      isPending: true,
      isError: false,
    };
    const tabId = openPicker();

    expect(
      screen.getByTestId("new-terminal-folderless-cwd-pending"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Launch" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));

    const terminals = tabTiles(tabId).filter(
      (tile) => tile.type === "terminal",
    );
    expect(terminals).toHaveLength(0);
  });

  it("keeps Launch disabled when folderless default cwd fails", () => {
    bindingsQuery.current = {
      data: { rows: [] },
      isPending: false,
      isError: false,
    };
    defaultCwdQuery.current = {
      data: undefined,
      isPending: false,
      isError: true,
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
