import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { nestedFocusBoundaryMock } from "@/__tests__/nested-focus-boundary-mock";
import { BundleOpenButton } from "../bundle-open-button";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    setNodeRef: vi.fn(),
    listeners: undefined,
    attributes: {},
    isDragging: false,
  }),
}));

function resetCanvas(): void {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
}

describe("<BundleOpenButton />", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    nestedFocusBoundaryMock.navigateNested.mockClear();
  });

  it("opens a pinned bundle diff tile in the current Epic canvas", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <BundleOpenButton
        epicId="epic-1"
        viewTabId={tabId}
        hostId="host-1"
        runningDir="/repo"
        group="changes"
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Changes" }));

    expect(nestedFocusBoundaryMock.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    expect(canvas.root.tabInstanceIds).toHaveLength(1);
    const tile = canvas.tilesByInstanceId[canvas.root.tabInstanceIds[0]];
    if (tile === undefined) throw new Error("expected a resolvable tile");
    expect(tile.type).toBe("git-diff");
    if (tile.type !== "git-diff") throw new Error("expected git diff");
    expect(tile.diff).toEqual({
      kind: "bundle",
      runningDir: "/repo",
      bundleGroup: "changes",
    });
    expect(tile.hostId).toBe("host-1");
  });

  it("opens a pinned merge bundle diff tile", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <BundleOpenButton
        epicId="epic-1"
        viewTabId={tabId}
        hostId="host-1"
        runningDir="/repo"
        group="merge"
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Merge Changes" }));

    const canvas = useEpicCanvasStore.getState().canvasByTabId[tabId];
    if (canvas?.root?.kind !== "pane") throw new Error("expected pane");
    const tile = canvas.tilesByInstanceId[canvas.root.tabInstanceIds[0]];
    if (tile === undefined) throw new Error("expected a resolvable tile");
    expect(tile.type).toBe("git-diff");
    if (tile.type !== "git-diff") throw new Error("expected git diff");
    expect(tile.diff).toEqual({
      kind: "bundle",
      runningDir: "/repo",
      bundleGroup: "merge",
    });
  });

  it("does not open a bundle tile when the group action is disabled", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");

    render(
      <BundleOpenButton
        epicId="epic-1"
        viewTabId={tabId}
        hostId="host-1"
        runningDir="/repo"
        group="staged"
        disabled
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Staged" }));

    expect(useEpicCanvasStore.getState().canvasByTabId[tabId]?.root).toBeNull();
  });
});
