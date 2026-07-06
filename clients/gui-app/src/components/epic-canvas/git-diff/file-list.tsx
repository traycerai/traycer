import { useMemo, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import {
  useGitPanelStore,
  selectGitPanelEpicState,
} from "@/stores/epics/git-panel-store";
import {
  createGitChangedFileSearchIndex,
  filterGitChangedFiles,
} from "@/lib/git/git-changed-file-search";
import type { HighlightRanges } from "@/lib/git/path-highlight";
import { FileSections } from "./file-sections";
import { FileTree } from "./file-tree";
import { NoMatchingFiles } from "./empty-states/no-matching-files";
import type { GitDiffSectionCollapseController } from "./git-diff-section";

export interface FileListProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly query: string;
  readonly onClearQuery: () => void;
  readonly hideEmptySections: boolean;
  readonly sectionCollapseController: GitDiffSectionCollapseController | null;
  readonly virtualized: boolean;
}

export function FileList(props: FileListProps): ReactNode {
  const layout = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).listLayout,
  );
  const trimmedQuery = props.query.trim();
  const queryActive = trimmedQuery.length > 0;

  const searchIndex = useMemo(
    () => createGitChangedFileSearchIndex(props.files),
    [props.files],
  );
  const matches = useMemo(
    () => filterGitChangedFiles(props.files, searchIndex, props.query),
    [props.files, props.query, searchIndex],
  );
  const visibleFiles = useMemo(
    () => matches.map((match) => match.file),
    [matches],
  );
  const pathRangesByPath = useMemo(() => {
    const ranges = new Map<string, HighlightRanges>();
    for (const match of matches) {
      if (match.pathRanges.length > 0) {
        ranges.set(match.file.path, match.pathRanges);
      }
    }
    return ranges;
  }, [matches]);

  if (queryActive && visibleFiles.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <NoMatchingFiles query={trimmedQuery} onClear={props.onClearQuery} />
      </div>
    );
  }

  if (layout === "tree") {
    return (
      <FileTree
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={props.runningDir}
        allFiles={props.files}
        visibleFiles={visibleFiles}
        forceExpanded={queryActive}
        hideEmptySections={props.hideEmptySections}
        sectionCollapseController={props.sectionCollapseController}
        virtualized={props.virtualized}
      />
    );
  }

  return (
    <FileSections
      epicId={props.epicId}
      viewTabId={props.viewTabId}
      hostId={props.hostId}
      runningDir={props.runningDir}
      allFiles={props.files}
      visibleFiles={visibleFiles}
      pathRangesByPath={pathRangesByPath}
      forceExpanded={queryActive}
      hideEmptySections={props.hideEmptySections}
      sectionCollapseController={props.sectionCollapseController}
      virtualized={props.virtualized}
    />
  );
}
