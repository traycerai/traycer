import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFileTree } from "@pierre/trees/react";
import type {
  FileTree as PierreFileTreeModel,
  FileTreeDirectoryHandle,
  FileTreeItemHandle,
  FileTreeRowDecorationRenderer,
  GitStatusEntry,
} from "@pierre/trees";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  buildGitFileRowMetadata,
  buildGitTreeDirectoryPaths,
  buildGitTreeRowDirectoryPaths,
  gitChangedFileToPierreStatusEntry,
  mergeGitTreeExpandedDirectoryPaths,
} from "@/lib/git/panel-file-rendering";
import { GIT_PANEL_PIERRE_FILE_TREE_UNSAFE_CSS } from "@/components/epic-canvas/pierre-tree-theme";

interface GitPierreFileTreeModel {
  readonly model: PierreFileTreeModel;
  readonly fileByPath: ReadonlyMap<string, GitChangedFile>;
  readonly paths: ReadonlyArray<string>;
  readonly rowDirectoryPaths: ReadonlyArray<string>;
}

export function useGitPierreFileTreeModel(
  files: ReadonlyArray<GitChangedFile>,
): GitPierreFileTreeModel {
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const directoryPaths = useMemo(
    () => buildGitTreeDirectoryPaths(paths),
    [paths],
  );
  const rowDirectoryPaths = useMemo(
    () => buildGitTreeRowDirectoryPaths(paths),
    [paths],
  );
  const fileByPath = useMemo(
    () => new Map(files.map((file) => [file.path, file])),
    [files],
  );
  const gitStatus = useMemo<ReadonlyArray<GitStatusEntry>>(
    () => files.map(gitChangedFileToPierreStatusEntry),
    [files],
  );

  const fileByPathRef = useRef(fileByPath);
  const pathsRef = useRef(paths);

  const renderRowDecoration = useCallback<FileTreeRowDecorationRenderer>(
    (context) => {
      const file = fileByPathRef.current.get(context.item.path);
      if (file === undefined) return null;
      const metadata = buildGitFileRowMetadata(file);
      return {
        text: metadata.countText,
        title: metadata.countTitle,
      };
    },
    [],
  );

  const { model } = useFileTree({
    paths,
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    initialExpandedPaths: directoryPaths,
    density: "compact",
    itemHeight: 24,
    icons: { set: "complete", colored: true },
    stickyFolders: true,
    gitStatus,
    renderRowDecoration,
    unsafeCSS: GIT_PANEL_PIERRE_FILE_TREE_UNSAFE_CSS,
  });

  useEffect(() => {
    fileByPathRef.current = fileByPath;
  }, [fileByPath]);

  useEffect(() => {
    if (areStringArraysEqual(pathsRef.current, paths)) return;
    const expandedPaths = mergeGitTreeExpandedDirectoryPaths(
      directoryPaths,
      collectExpandedDirectoryPaths(model, directoryPaths),
    );
    model.resetPaths(paths, { initialExpandedPaths: expandedPaths });
    pathsRef.current = paths;
  }, [directoryPaths, model, paths]);

  useEffect(() => {
    model.setGitStatus(gitStatus);
  }, [model, gitStatus]);

  return { model, fileByPath, paths, rowDirectoryPaths };
}

function collectExpandedDirectoryPaths(
  model: PierreFileTreeModel,
  directoryPaths: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return directoryPaths.filter((path) => {
    const item = model.getItem(path);
    return item !== null && isDirectoryHandle(item) && item.isExpanded();
  });
}

function isDirectoryHandle(
  item: FileTreeItemHandle,
): item is FileTreeDirectoryHandle {
  return item.isDirectory();
}

function areStringArraysEqual(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
