import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  useGitPanelActiveFile,
  useGitPanelRevealSection,
  type GitPanelActiveFile,
} from "@/components/epic-canvas/git-diff/use-git-panel-active-file";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { openTile } from "@/stores/epics/canvas/actions";
import { createEmptyCanvas } from "@/stores/epics/canvas/canvas-state";
import type { EpicCanvasState } from "@/stores/epics/canvas/types";
import { makeGitFileDiffTile } from "@/lib/git/git-diff-tile";
import {
  defaultEpicState,
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";

const TAB_ID = "view-tab-1";
const EPIC_ID = "epic-1";
const HOST_ID = "host-1";
const RUNNING_DIR = "/repo";

function seedViewTab(canvas: EpicCanvasState): void {
  useEpicCanvasStore.setState((s) => ({
    tabsById: {
      ...s.tabsById,
      [TAB_ID]: {
        tabId: TAB_ID,
        epicId: EPIC_ID,
        name: "Epic",
      },
    },
    canvasByTabId: {
      ...s.canvasByTabId,
      [TAB_ID]: canvas,
    },
  }));
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useGitPanelStore.setState({ stateByEpicId: {} });
});

afterEach(() => {
  cleanup();
});

describe("useGitPanelActiveFile", () => {
  it("returns the focused file diff tile scoped to the panel worktree", () => {
    const tile = makeGitFileDiffTile({
      hostId: HOST_ID,
      runningDir: RUNNING_DIR,
      filePath: "src/a.ts",
      stage: "staged",
      repositoryContext: null,
    });
    seedViewTab(openTile(createEmptyCanvas(), tile, false));

    const { result } = renderHook(() =>
      useGitPanelActiveFile({
        viewTabId: TAB_ID,
        hostId: HOST_ID,
        runningDir: RUNNING_DIR,
      }),
    );

    expect(result.current).toEqual({
      tileId: tile.id,
      filePath: "src/a.ts",
      group: "staged",
    });
  });

  it("returns null when the focused tile belongs to another worktree", () => {
    const tile = makeGitFileDiffTile({
      hostId: HOST_ID,
      runningDir: "/other-worktree",
      filePath: "src/a.ts",
      stage: "unstaged",
      repositoryContext: null,
    });
    seedViewTab(openTile(createEmptyCanvas(), tile, false));

    const { result } = renderHook(() =>
      useGitPanelActiveFile({
        viewTabId: TAB_ID,
        hostId: HOST_ID,
        runningDir: RUNNING_DIR,
      }),
    );

    expect(result.current).toBeNull();
  });

  it("returns null when the view tab has no canvas", () => {
    const { result } = renderHook(() =>
      useGitPanelActiveFile({
        viewTabId: "missing-tab",
        hostId: HOST_ID,
        runningDir: RUNNING_DIR,
      }),
    );

    expect(result.current).toBeNull();
  });
});

describe("useGitPanelRevealSection", () => {
  function stagedCollapsed(): boolean {
    return selectGitPanelEpicState(EPIC_ID)(useGitPanelStore.getState())
      .stagedSectionCollapsed;
  }

  function makeActiveFile(tileId: string): GitPanelActiveFile {
    return { tileId, filePath: "src/a.ts", group: "staged" };
  }

  it("expands the collapsed section holding the focused file", () => {
    useGitPanelStore.setState({
      stateByEpicId: {
        [EPIC_ID]: { ...defaultEpicState, stagedSectionCollapsed: true },
      },
    });

    renderHook(() =>
      useGitPanelRevealSection({
        epicId: EPIC_ID,
        activeFile: makeActiveFile("tile-1"),
      }),
    );

    expect(stagedCollapsed()).toBe(false);
  });

  it("respects a manual re-collapse until focus moves to another tile", () => {
    useGitPanelStore.setState({
      stateByEpicId: {
        [EPIC_ID]: { ...defaultEpicState, stagedSectionCollapsed: true },
      },
    });

    const { rerender } = renderHook(
      (props: { readonly activeFile: GitPanelActiveFile }) =>
        useGitPanelRevealSection({
          epicId: EPIC_ID,
          activeFile: props.activeFile,
        }),
      { initialProps: { activeFile: makeActiveFile("tile-1") } },
    );
    expect(stagedCollapsed()).toBe(false);

    act(() => {
      useGitPanelStore.getState().toggleSection(EPIC_ID, "staged");
    });
    rerender({ activeFile: makeActiveFile("tile-1") });
    expect(stagedCollapsed()).toBe(true);

    rerender({ activeFile: makeActiveFile("tile-2") });
    expect(stagedCollapsed()).toBe(false);
  });

  it("does nothing without an active file", () => {
    useGitPanelStore.setState({
      stateByEpicId: {
        [EPIC_ID]: { ...defaultEpicState, stagedSectionCollapsed: true },
      },
    });

    renderHook(() =>
      useGitPanelRevealSection({ epicId: EPIC_ID, activeFile: null }),
    );

    expect(stagedCollapsed()).toBe(true);
  });

  it("reveals the same tile again after focus leaves git diffs", () => {
    useGitPanelStore.setState({
      stateByEpicId: {
        [EPIC_ID]: { ...defaultEpicState, stagedSectionCollapsed: true },
      },
    });

    const initialProps: { readonly activeFile: GitPanelActiveFile | null } = {
      activeFile: makeActiveFile("tile-1"),
    };

    const { rerender } = renderHook(
      (props: { readonly activeFile: GitPanelActiveFile | null }) =>
        useGitPanelRevealSection({
          epicId: EPIC_ID,
          activeFile: props.activeFile,
        }),
      { initialProps },
    );
    expect(stagedCollapsed()).toBe(false);

    act(() => {
      useGitPanelStore.getState().toggleSection(EPIC_ID, "staged");
    });
    rerender({ activeFile: null });
    expect(stagedCollapsed()).toBe(true);

    rerender({ activeFile: makeActiveFile("tile-1") });
    expect(stagedCollapsed()).toBe(false);
  });
});
