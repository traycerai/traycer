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
  readonly virtualized: boolean;
  readonly nestedRows: boolean;
}

interface GitFlatFileListItemProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly activeFilePath: string | null;
  readonly pathRangesByPath: ReadonlyMap<string, HighlightRanges>;
  readonly nestedRows: boolean;
}

function GitFlatFileListItem(props: GitFlatFileListItemProps): ReactNode {
  return (
    <FileRow
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      hostId={props.hostId}
      runningDir={props.runningDir}
      file={props.file}
      active={props.file.path === props.activeFilePath}
      pathRanges={props.pathRangesByPath.get(props.file.path) ?? NO_HIGHLIGHT}
      nested={props.nestedRows}
    />
  );
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
      <GitFlatFileListItem
        epicId={epicId}
        viewTabId={viewTabId}
        hostId={hostId}
        runningDir={runningDir}
        file={file}
        activeFilePath={activeFilePath}
        pathRangesByPath={pathRangesByPath}
        nestedRows={props.nestedRows}
      />
    ),
    [
      activeFilePath,
      hostId,
      epicId,
      pathRangesByPath,
      props.nestedRows,
      runningDir,
      viewTabId,
    ],
  );

  const itemKey = useCallback(
    (_index: number, file: GitChangedFile) => file.path,
    [],
  );

  if (!props.virtualized) {
    return (
      <div data-testid="git-flat-file-list">
        {files.map((file) => (
          <GitFlatFileListItem
            key={file.path}
            epicId={epicId}
            viewTabId={viewTabId}
            hostId={hostId}
            runningDir={runningDir}
            file={file}
            activeFilePath={activeFilePath}
            pathRangesByPath={pathRangesByPath}
            nestedRows={props.nestedRows}
          />
        ))}
      </div>
    );
  }

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
