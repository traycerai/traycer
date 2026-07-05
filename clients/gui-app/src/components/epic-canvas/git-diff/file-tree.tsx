import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, type MouseEvent } from "react";
import { FileTree as PierreFileTree } from "@pierre/trees/react";
import type {
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
} from "@pierre/trees";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  buildGitTreeDirectoryPaths,
  buildGitPanelFileSections,
} from "@/lib/git/panel-file-rendering";
import { GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE } from "@/components/epic-canvas/pierre-tree-theme";
import { extractPierreItemPathFromEvent } from "@/components/epic-canvas/pierre-tree-adapter";
import { usePierreCanvasDragBridge } from "@/components/epic-canvas/dnd/use-pierre-canvas-drag-bridge";
import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  type EpicCanvasDragSourceData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import type {
  GitDiffBundleGroup,
  GitDiffTileRef,
} from "@/stores/epics/canvas/types";
import { GitDiffSection } from "./git-diff-section";
import type { GitDiffSectionCollapseController } from "./git-diff-section";
import { useGitPierreFileTreeModel } from "./use-git-pierre-file-tree-model";
import {
  gitPanelActiveFilePathForGroup,
  useGitPanelActiveFile,
  useGitPanelRevealSection,
} from "./use-git-panel-active-file";

export interface FileTreeProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
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
  readonly group: GitDiffBundleGroup;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly activeFilePath: string | null;
}

export function FileTree(props: FileTreeProps): ReactNode {
  const activeFile = useGitPanelActiveFile({
    viewTabId: props.viewTabId,
    hostId: props.hostId,
    runningDir: props.runningDir,
  });
  useGitPanelRevealSection({ epicId: props.epicId, activeFile });

  const sections = useMemo(
    () => buildGitPanelFileSections(props.allFiles, props.visibleFiles),
    [props.allFiles, props.visibleFiles],
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="git-file-tree-sections"
    >
      {sections.map(({ group, visibleFiles, bundleFileCount }) =>
        visibleFiles.length === 0 &&
        (props.forceExpanded ||
          props.hideEmptySections ||
          group === "merge") ? null : (
          <GitDiffSection
            key={group}
            epicId={props.epicId}
            viewTabId={props.viewTabId}
            hostId={props.hostId}
            runningDir={props.runningDir}
            group={group}
            visibleFiles={visibleFiles}
            bundleFileCount={bundleFileCount}
            forceExpanded={props.forceExpanded}
            collapseController={props.sectionCollapseController}
            fillAvailable={props.virtualized}
            compactChrome={!props.virtualized}
          >
            <GitTreeSectionBody
              epicId={props.epicId}
              viewTabId={props.viewTabId}
              hostId={props.hostId}
              runningDir={props.runningDir}
              group={group}
              files={visibleFiles}
              activeFilePath={gitPanelActiveFilePathForGroup(activeFile, group)}
            />
          </GitDiffSection>
        ),
      )}
    </div>
  );
}

function isDirectoryHandle(
  handle: FileTreeItemHandle,
): handle is FileTreeDirectoryHandle {
  return handle.isDirectory();
}

function GitTreeSectionBody(props: GitTreeSectionBodyProps): ReactNode {
  const openPreview = useEpicCanvasStore((s) => s.openTilePreviewInTab);
  const openPinned = useEpicCanvasStore((s) => s.openTileInTab);
  const { model, fileByPath } = useGitPierreFileTreeModel(props.files);

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
      });
    },
    [fileByPath, props.hostId, props.runningDir],
  );

  const openFile = useCallback(
    (treePath: string, open: (tabId: string, tile: GitDiffTileRef) => void) => {
      const tile = tileForTreePath(treePath);
      if (tile === null) return;
      open(props.viewTabId, tile);
    },
    [tileForTreePath, props.viewTabId],
  );

  const previewFileFromTreeRow = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) return;
      openFile(treePath, openPreview);
    },
    [openFile, openPreview],
  );

  const pinFileFromTreeRow = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      const treePath = extractPierreItemPathFromEvent(event);
      if (treePath === null) return;
      openFile(treePath, openPinned);
    },
    [openFile, openPinned],
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
        style={GIT_PANEL_PIERRE_FILE_TREE_THEME_STYLE}
        data-testid="git-pierre-file-tree"
      />
    </div>
  );
}
