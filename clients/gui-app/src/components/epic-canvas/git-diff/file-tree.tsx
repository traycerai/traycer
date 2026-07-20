import type { ReactNode } from "react";
import { useCallback, useEffect, type MouseEvent } from "react";
import {
  FileTree as PierreFileTree,
  useFileTreeSelector,
} from "@pierre/trees/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
} from "@pierre/trees";
import type { GitChangedFile } from "@traycer/protocol/host";
import { buildGitTreeDirectoryPaths } from "@/lib/git/panel-file-rendering";
import { GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE } from "@/components/epic-canvas/pierre-tree-theme";
import { extractPierreItemPathFromEvent } from "@/components/epic-canvas/pierre-tree-adapter";
import { usePierreCanvasDragBridge } from "@/components/epic-canvas/dnd/use-pierre-canvas-drag-bridge";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import type { GitDiffSectionCollapseController } from "./git-diff-section";
import { GitFileSectionStack } from "./git-file-section-stack";
import type { GitFileSectionBodyRenderProps } from "./git-file-section-stack";
import { useGitPierreFileTreeModel } from "./use-git-pierre-file-tree-model";

export interface FileTreeProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly repositoryContext: GitDiffRepositoryContext | null;
  readonly allFiles: ReadonlyArray<GitChangedFile>;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly forceExpanded: boolean;
  readonly hideEmptySections: boolean;
  readonly sectionCollapseController: GitDiffSectionCollapseController | null;
  readonly virtualized: boolean;
}

interface GitTreeSectionBodyProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly repositoryContext: GitDiffRepositoryContext | null;
  readonly group: GitDiffBundleGroup;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly activeFilePath: string | null;
  readonly virtualized: boolean;
}

type GitTreeVisibilityModel = {
  getItem(path: string): FileTreeItemHandle | null;
};

export function FileTree(props: FileTreeProps): ReactNode {
  const renderBody = useCallback(
    (section: GitFileSectionBodyRenderProps) => (
      <GitTreeSectionBody
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={props.runningDir}
        repositoryContext={props.repositoryContext}
        group={section.group}
        files={section.visibleFiles}
        activeFilePath={section.activeFilePath}
        virtualized={props.virtualized}
      />
    ),
    [
      props.epicId,
      props.hostId,
      props.repositoryContext,
      props.runningDir,
      props.viewTabId,
      props.virtualized,
    ],
  );

  return (
    <GitFileSectionStack
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      hostId={props.hostId}
      runningDir={props.runningDir}
      repositoryContext={props.repositoryContext}
      allFiles={props.allFiles}
      visibleFiles={props.visibleFiles}
      forceExpanded={props.forceExpanded}
      hideEmptySections={props.hideEmptySections}
      sectionCollapseController={props.sectionCollapseController}
      virtualized={props.virtualized}
      testId="git-file-tree-sections"
      renderBody={renderBody}
    />
  );
}

/**
 * Pierre's renderer is always virtualized and therefore needs a definite host
 * height. Module-group bodies deliberately use the outer panel as their scroll
 * owner, so size that mode to its currently visible rows instead of inheriting
 * `height: 100%` from an auto-height section body (which resolves to zero).
 */
function gitTreeStyle(
  itemHeight: number,
  visibleRowCount: number,
  virtualized: boolean,
) {
  if (virtualized) return GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE;
  return {
    ...GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE,
    height: visibleRowCount * itemHeight,
  };
}

function gitTreePathIsVisible(
  model: GitTreeVisibilityModel,
  treePath: string,
): boolean {
  return buildGitTreeDirectoryPaths([treePath]).every((directoryPath) => {
    const directory = model.getItem(directoryPath);
    return (
      directory !== null &&
      isDirectoryHandle(directory) &&
      directory.isExpanded()
    );
  });
}

function countVisibleGitTreeRows(
  model: GitTreeVisibilityModel,
  paths: ReadonlyArray<string>,
  rowDirectoryPaths: ReadonlyArray<string>,
): number {
  return (
    rowDirectoryPaths.filter((path) => gitTreePathIsVisible(model, path))
      .length + paths.filter((path) => gitTreePathIsVisible(model, path)).length
  );
}

function isDirectoryHandle(
  handle: FileTreeItemHandle,
): handle is FileTreeDirectoryHandle {
  return handle.isDirectory();
}

function GitTreeSectionBody(props: GitTreeSectionBodyProps): ReactNode {
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTilePreviewInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTilePreviewInTabFocusTarget,
  );
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
  const { model, fileByPath, paths, rowDirectoryPaths } =
    useGitPierreFileTreeModel(props.files);
  const selectVisibleRowCount = useCallback(
    (currentModel: GitTreeVisibilityModel) =>
      props.virtualized
        ? 0
        : countVisibleGitTreeRows(currentModel, paths, rowDirectoryPaths),
    [paths, props.virtualized, rowDirectoryPaths],
  );
  const visibleRowCount = useFileTreeSelector(model, selectVisibleRowCount);

  // Mirror the canvas's focused diff tile into Pierre's selection, expanding
  // ancestor folders and scrolling the row into view. Runs on focus changes
  // and once on mount; `scrollToPath` with "nearest" is a no-op for rows
  // already visible, so self-clicks never shift the tree.
  const activeFilePath = props.activeFilePath;
  useEffect(() => {
    for (const selectedPath of model.getSelectedPaths()) {
      if (selectedPath === activeFilePath) continue;
      model.getItem(selectedPath)?.deselect();
    }
    if (activeFilePath === null) return;
    const item = model.getItem(activeFilePath);
    if (item === null) return;
    if (!item.isSelected()) item.select();
    for (const directoryPath of buildGitTreeDirectoryPaths([activeFilePath])) {
      const directory = model.getItem(directoryPath);
      if (directory === null) continue;
      if (!isDirectoryHandle(directory)) continue;
      if (!directory.isExpanded()) directory.expand();
    }
    model.scrollToPath(activeFilePath, { offset: "nearest" });
  }, [activeFilePath, model]);

  // Single source of truth for "tree row path -> diff tile". Reused by the
  // click/double-click open handlers and the drag bridge so a row absent from
  // the change list (a synthesized directory row) is non-openable everywhere.
  const tileForTreePath = useCallback(
    (treePath: string): GitDiffTileRef | null => {
      const file = fileByPath.get(treePath);
      if (file === undefined) return null;
      return makeGitFileDiffTileForFile({
        hostId: props.hostId,
        runningDir: props.runningDir,
        file,
        repositoryContext: props.repositoryContext,
      });
    },
    [fileByPath, props.hostId, props.repositoryContext, props.runningDir],
  );

  const openFile = useCallback(
    (
      treePath: string,
      open: (tabId: string, tile: GitDiffTileRef) => NestedFocusTarget | null,
    ) => {
      const tile = tileForTreePath(treePath);
      if (tile === null) return;
      navigateNested(props.epicId, props.viewTabId, () =>
        open(props.viewTabId, tile),
      );
    },
    [navigateNested, props.epicId, props.viewTabId, tileForTreePath],
  );

  const previewFileFromTreeRow = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) return;
      openFile(treePath, prepareOpenTilePreviewInTabFocusTarget);
    },
    [openFile, prepareOpenTilePreviewInTabFocusTarget],
  );

  const pinFileFromTreeRow = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) return;
      openFile(treePath, prepareOpenTileInTabFocusTarget);
    },
    [openFile, prepareOpenTileInTabFocusTarget],
  );

  // Bridge Pierre's shadow-DOM rows into the canvas dnd-kit drag flow. The row
  // under the activating pointer is recovered via the same `data-item-path`
  // scrape used for open.
  const epicId = props.epicId;
  const viewTabId = props.viewTabId;
  const resolveDragSourceData = useCallback(
    (event: PointerEvent): EpicCanvasDragSourceData | null => {
      const treePath = extractPierreItemPathFromEvent({ nativeEvent: event });
      if (treePath === null) return null;
      const tile = tileForTreePath(treePath);
      return tile === null
        ? null
        : { kind: GIT_DIFF_TILE_DND_TYPE, epicId, viewTabId, tile };
    },
    [epicId, tileForTreePath, viewTabId],
  );
  const bridge = usePierreCanvasDragBridge({
    id: getGitDiffTileDragId(`tree:${props.viewTabId}:${props.group}`),
    resolveSourceData: resolveDragSourceData,
  });

  return (
    <div {...bridge.wrapperProps} className="flex h-full min-h-0 flex-col">
      <PierreFileTree
        className="h-full min-h-0"
        model={model}
        onClick={previewFileFromTreeRow}
        onDoubleClick={pinFileFromTreeRow}
        style={gitTreeStyle(
          model.getItemHeight(),
          visibleRowCount,
          props.virtualized,
        )}
        data-testid="git-pierre-file-tree"
      />
    </div>
  );
}
