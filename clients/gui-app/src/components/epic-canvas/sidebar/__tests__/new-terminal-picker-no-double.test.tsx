import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

// A double-click on a folder row fires the row's `onSelect` twice before the
// popover's `setIsOpen(false)` (a state update) can unmount the list. Each call
// mints a fresh `term-${uuidv4()}` id, so without a guard two terminals open.
// The folder list is mocked to a button that fires onSelect twice in one click
// handler - the exact synchronous double-fire - so the latch is what collapses
// it to a single terminal.

const ROW: WorktreeBindingSelectorRow = {
  hostId: "host-1",
  runningDir: "/work/traycer",
  workspacePath: "/work/traycer",
  worktreePath: "/work/traycer",
  mode: "worktree",
  isGitRepo: true,
  repoIdentifier: { owner: "traycer", repo: "traycer" },
  branch: "main",
  isPrimary: true,
  isImported: false,
  setupState: "not_required",
  disabledReason: null,
  sources: [],
};

vi.mock("@/hooks/worktree/use-worktree-list-bindings-for-epic-query", () => ({
  useWorktreeListBindingsForEpic: () => ({
    data: { rows: [ROW] },
    isPending: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/host/use-reactive-active-host-id", () => ({
  useReactiveActiveHostId: () => "host-1",
}));

// Strip the host section - its hooks are irrelevant to the double-pick guard.
vi.mock("@/components/worktree/worktree-picker-host-section", () => ({
  WorktreePickerHostSection: () => null,
}));

// The list body fires `onSelect` twice on a single click, reproducing the
// rapid double-fire that a real double-click produces before unmount.
vi.mock("@/components/worktree/worktree-folder-list-body", () => ({
  WorktreeFolderListBody: (props: {
    readonly rows: ReadonlyArray<WorktreeBindingSelectorRow>;
    readonly onSelect: (row: WorktreeBindingSelectorRow) => void;
  }) => (
    <button
      type="button"
      data-testid="double-pick-row"
      onClick={() => {
        props.onSelect(props.rows[0]);
        props.onSelect(props.rows[0]);
      }}
    >
      row
    </button>
  ),
}));

import { NewTerminalPicker } from "../new-terminal-picker";

function resetCanvas(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function tabTiles(tabId: string): ReadonlyArray<EpicCanvasTileRef> {
  const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
  if (canvas === undefined) return [];
  return collectPanes(canvas.root).flatMap((pane) => paneTabRefs(canvas, pane));
}

describe("<NewTerminalPicker /> double-pick guard", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
  });

  it("opens a single terminal when a folder row is picked twice in one burst", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
    render(<NewTerminalPicker epicId="epic-1" tabId={tabId} />);
    fireEvent.click(screen.getByTestId("epic-terminals-panel-add"));

    fireEvent.click(screen.getByTestId("double-pick-row"));

    const terminals = tabTiles(tabId).filter((t) => t.type === "terminal");
    expect(terminals).toHaveLength(1);
  });
});
