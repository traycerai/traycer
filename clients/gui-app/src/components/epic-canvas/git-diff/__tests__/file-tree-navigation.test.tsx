import type { MouseEvent, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GitChangedFileV11 } from "@traycer/protocol/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import { FileTree as GitDiffFileTree } from "../file-tree";

const testState = vi.hoisted(() => ({
  treePath: "src/app.ts",
  navigateNested: vi.fn(
    (
      _epicId: string,
      _tabId: string,
      prepare: () => NestedFocusTarget | null,
    ) => prepare(),
  ),
}));

vi.mock("@pierre/trees/react", () => ({
  FileTree: (props: {
    readonly onClick: (event: MouseEvent<HTMLElement>) => void;
    readonly onDoubleClick: (event: MouseEvent<HTMLElement>) => void;
    readonly "data-testid": string;
  }) => (
    <button
      type="button"
      data-testid={props["data-testid"]}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
    >
      Git file tree
    </button>
  ),
}));

vi.mock("../git-diff-section", () => ({
  GitDiffSection: (props: { readonly children: ReactNode }) => (
    <section>{props.children}</section>
  ),
}));

vi.mock("../use-git-panel-active-file", () => ({
  gitPanelActiveFilePathForGroup: () => null,
  useGitPanelActiveFile: () => null,
  useGitPanelRevealSection: () => undefined,
}));

vi.mock("../use-git-pierre-file-tree-model", () => ({
  useGitPierreFileTreeModel: (files: ReadonlyArray<GitChangedFileV11>) => ({
    fileByPath: new Map(files.map((file) => [file.path, file])),
    model: {
      getSelectedPaths: () => [],
      getItem: () => null,
      scrollToPath: () => undefined,
    },
  }),
}));

vi.mock("@/components/epic-canvas/pierre-tree-adapter", () => ({
  extractPierreItemPathFromEvent: () => testState.treePath,
}));

vi.mock("@/components/epic-canvas/dnd/use-pierre-canvas-drag-bridge", () => ({
  usePierreCanvasDragBridge: () => ({ wrapperProps: {} }),
}));

vi.mock("@/hooks/epic/use-epic-nested-focus-navigation", () => ({
  useEpicNestedFocusNavigation: () => testState.navigateNested,
}));

function changedFile(): GitChangedFileV11 {
  return {
    path: testState.treePath,
    previousPath: null,
    status: "modified",
    stage: "staged",
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

function renderTree(tabId: string): void {
  const file = changedFile();
  render(
    <GitDiffFileTree
      epicId="epic-1"
      viewTabId={tabId}
      hostId="host-1"
      runningDir="/repo"
      allFiles={[file]}
      visibleFiles={[file]}
      forceExpanded={false}
      hideEmptySections
      sectionCollapseController={null}
      virtualized={false}
    />,
  );
}

describe("<FileTree /> nested focus navigation", () => {
  beforeEach(() => {
    cleanup();
    resetCanvas();
    testState.navigateNested.mockClear();
  });

  it("routes tree-row preview through nested focus navigation", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderTree(tabId);

    fireEvent.click(screen.getByTestId("git-pierre-file-tree"));

    expect(testState.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
  });

  it("routes tree-row pinned open through nested focus navigation", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderTree(tabId);

    fireEvent.doubleClick(screen.getByTestId("git-pierre-file-tree"));

    expect(testState.navigateNested).toHaveBeenCalledWith(
      "epic-1",
      tabId,
      expect.any(Function),
    );
  });
});
