import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { GitChangedFile } from "@traycer/protocol/host";
import { sortGitPanelFlatFiles } from "@/lib/git/panel-file-rendering";
import { NO_HIGHLIGHT, type HighlightRanges } from "@/lib/git/path-highlight";
import { FileRow } from "./file-row";

export interface GitFlatFileListProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly files: ReadonlyArray<GitChangedFile>;
  /** Filter match ranges keyed by file path; empty map when no filter active. */
  readonly pathRangesByPath: ReadonlyMap<string, HighlightRanges>;
  /** Path of the canvas's focused diff file when it lives in this section. */
  readonly activeFilePath: string | null;
}

export function GitFlatFileList(props: GitFlatFileListProps): ReactNode {
  const {
    activeFilePath,
    hostId,
    epicId,
    files: unsortedFiles,
    pathRangesByPath,
    runningDir,
    viewTabId,
  } = props;
  const files = useMemo(
    () => sortGitPanelFlatFiles(unsortedFiles),
    [unsortedFiles],
  );

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const activeIndex = useMemo(
    () =>
      activeFilePath === null
        ? -1
        : files.findIndex((file) => file.path === activeFilePath),
    [activeFilePath, files],
  );

  // Reveal once per focused file (and once on mount): scrollIntoView is a
  // no-op when the row is already visible, so clicking a visible row never
  // shifts the list under the cursor.
  const lastRevealedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (activeFilePath === null) return;
    if (activeIndex === -1) return;
    if (lastRevealedPathRef.current === activeFilePath) return;
    lastRevealedPathRef.current = activeFilePath;
    virtuosoRef.current?.scrollIntoView({
      index: activeIndex,
      behavior: "auto",
    });
  }, [activeFilePath, activeIndex]);

  const renderItem = useCallback(
    (_index: number, file: GitChangedFile) => (
      <FileRow
        epicId={epicId}
        viewTabId={viewTabId}
        hostId={hostId}
        runningDir={runningDir}
        file={file}
        active={file.path === activeFilePath}
        pathRanges={pathRangesByPath.get(file.path) ?? NO_HIGHLIGHT}
      />
    ),
    [activeFilePath, hostId, epicId, pathRangesByPath, runningDir, viewTabId],
  );

  const itemKey = useCallback(
    (_index: number, file: GitChangedFile) => file.path,
    [],
  );

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={files}
      computeItemKey={itemKey}
      itemContent={renderItem}
      className="h-full"
      overscan={8}
      data-testid="git-flat-file-list"
    />
  );
}
