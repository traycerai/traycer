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
  useFileTreeSelector: (
    model: object,
    selector: (currentModel: object) => number,
  ) => selector(model),
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
      getItemHeight: () => 24,
      scrollToPath: () => undefined,
    },
    paths: files.map((file) => file.path),
    rowDirectoryPaths: ["src"],
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
      repositoryContext={null}
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

  /**
   * Inside the mobile switcher sheet this tree is a vaul drawer descendant, and
   * vaul decides scroll-vs-dismiss by climbing `parentElement` from the touch
   * target. Pierre's scroller is in a shadow root and a touch inside one
   * retargets to the host, so that climb finds nothing scrollable and claims
   * the gesture - which is what left the tree unscrollable on device.
   *
   * This pins the attribute, NOT the scrolling: whether a finger scrolls is a
   * touch-arbitration question that jsdom cannot answer, and the earlier
   * attempt to settle it with `scrollTop` is precisely what missed the bug.
   */
  it("marks the tree wrapper as not a drawer-drag surface", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderTree(tabId);

    const tree = screen.getByTestId("git-pierre-file-tree");
    expect(tree.closest("[data-vaul-no-drag]")).not.toBeNull();
  });

  /**
   * The tree's light-DOM wrapper carries `useShadowScrollerTouchShield`'s ref
   * (see `use-shadow-scroller-touch-shield.ts`), which stops a `touchmove`
   * bubbling out of Pierre's shadow-rooted scroller before it reaches a
   * document BUBBLE listener - the modal scroll lock a vaul drawer registers
   * while open. jsdom has no `TouchEvent`, so a plain bubbling `Event` stands
   * in; the hook only calls `stopPropagation()`, which does not care about
   * the event's concrete type. `touchstart` is the control: it is untouched
   * by this hook, so it must still reach the document. Deleting
   * `ref={touchShieldRef}` from the wrapper must fail this test.
   */
  it("shields a bubbling touchmove from the pierre tree so it never reaches the document", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-1", "Epic 1");
    renderTree(tabId);

    const documentTouchMove = vi.fn();
    const documentTouchStart = vi.fn();
    document.addEventListener("touchmove", documentTouchMove);
    document.addEventListener("touchstart", documentTouchStart);
    try {
      const tree = screen.getByTestId("git-pierre-file-tree");
      tree.dispatchEvent(new Event("touchmove", { bubbles: true }));
      tree.dispatchEvent(new Event("touchstart", { bubbles: true }));

      expect(documentTouchMove).not.toHaveBeenCalled();
      expect(documentTouchStart).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("touchmove", documentTouchMove);
      document.removeEventListener("touchstart", documentTouchStart);
    }
  });
});
