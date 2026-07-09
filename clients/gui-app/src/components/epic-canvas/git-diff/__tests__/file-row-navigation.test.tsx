import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { GitChangedFileV11 } from "@traycer/protocol/host";
import { FileRow } from "../file-row";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    listeners: undefined,
    attributes: {},
    isDragging: false,
  }),
}));

function changedFile(path: string): GitChangedFileV11 {
  return {
    path,
    previousPath: null,
    status: "modified",
    stage: "unstaged",
    isBinary: false,
    insertions: 3,
    deletions: 1,
    sizeBytes: 100,
    stagedOid: null,
    worktreeOid: null,
    gitlink: null,
  };
}

function resetCanvas(): void {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

function renderRow(tabId: string): void {
  render(
    <TooltipProvider>
      <FileRow
        epicId="epic-1"
        viewTabId={tabId}
        hostId="host-1"
        runningDir="/repo"
        file={changedFile("src/app.ts")}
        active={false}
        pathRanges={[]}
        nested={false}
      />
    </TooltipProvider>,
  );
}

describe("<FileRow /> nested focus navigation", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    nestedFocusBoundaryMock.navigateNested.mockClear();
  });

  it("routes single-click preview through nested focus navigation", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderRow(tabId);

    fireEvent.click(
      screen.getByRole("button", { name: "Modified app.ts in src" }),
    );

    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const activeTileId = canvas.root.activeTabId;
    if (activeTileId === null) throw new Error("expected active tile");
    const tile = canvas.tilesByInstanceId[activeTileId];
    if (tile === undefined) throw new Error("expected tile");
    expect(tile.type).toBe("git-diff");
  });

  it("routes double-click pinned open through nested focus navigation", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderRow(tabId);

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "Modified app.ts in src" }),
    );

    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
  });
});
