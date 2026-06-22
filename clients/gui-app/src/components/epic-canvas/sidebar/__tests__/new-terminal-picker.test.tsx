import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
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
        makeRow("host-1", "/work/traycer", "main"),
        makeRow("host-2", "/work/traycer-wt/feature-x", "feature-x"),
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
    disabledReason: null,
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
    // Create-new flow has no persistent selection to check-mark.
    expect(
      screen
        .getAllByRole("option")
        .every((option) => option.dataset.checked === undefined),
    ).toBe(true);
  });

  it("creates a terminal bound to the row's host and cwd on a single click", () => {
    const tabId = openPicker();

    fireEvent.click(screen.getByRole("option", { name: /feature-x/i }));

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
});
