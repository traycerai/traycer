import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { paneTabRefs } from "@/stores/epics/canvas/actions";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

// A double-click can fire two handlers before React flushes the state update
// that closes the popover. Row selection must not launch anything; the launch
// latch is what collapses a double-fired Launch action to a single terminal.

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
    data: { rows: [ROW], folderlessCwd: "/Users/tgill" },
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

vi.mock("@/components/ui/button", () => ({
  Button: ({
    variant: _variant,
    size: _size,
    asChild: _asChild,
    className: _className,
    children,
    onClick,
    ...props
  }: ComponentProps<"button"> & {
    readonly variant?: string | undefined;
    readonly size?: string | undefined;
    readonly asChild?: boolean | undefined;
  }) => (
    <button
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (children === "Launch") onClick?.(event);
      }}
    >
      {children}
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

describe("<NewTerminalPicker /> double-launch guard", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
  });

  it("opens a single terminal when Launch fires twice after row selection", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic");
    render(<NewTerminalPicker epicId="epic-1" tabId={tabId} />);
    fireEvent.click(screen.getByTestId("epic-terminals-panel-add"));

    fireEvent.click(screen.getByTestId("double-pick-row"));
    expect(tabTiles(tabId).filter((t) => t.type === "terminal")).toHaveLength(
      0,
    );
    const launchButton = screen.getByRole("button", { name: "Launch" });
    expect(launchButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(launchButton);

    const terminals = tabTiles(tabId).filter((t) => t.type === "terminal");
    expect(terminals).toHaveLength(1);
  });
});
