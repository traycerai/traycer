import { useCallback, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import type { HighlightRanges } from "@/lib/git/path-highlight";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitFlatFileList } from "./git-flat-file-list";
import { GitFileSectionStack } from "./git-file-section-stack";
import type { GitFileSectionBodyRenderProps } from "./git-file-section-stack";
import type { GitDiffSectionCollapseController } from "./git-diff-section";
import type { GitDiffRepositoryContext } from "@/stores/epics/canvas/types";

// Deliberate hover dwell for the per-row path tooltips: long enough that
// sweeping the cursor across the list never pops them, and skipDelay 0 so
// every row requires the same full dwell (no instant chain-popping).
const FILE_ROW_TOOLTIP_DELAY_MS = 700;

export interface FileSectionsProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly repositoryContext: GitDiffRepositoryContext | null;
  readonly allFiles: ReadonlyArray<GitChangedFile>;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly pathRangesByPath: ReadonlyMap<string, HighlightRanges>;
  readonly forceExpanded: boolean;
  readonly hideEmptySections: boolean;
  readonly sectionCollapseController: GitDiffSectionCollapseController | null;
  readonly virtualized: boolean;
}

export function FileSections(props: FileSectionsProps): ReactNode {
  const renderBody = useCallback(
    (section: GitFileSectionBodyRenderProps) => (
      <GitFlatFileList
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={props.runningDir}
        repositoryContext={props.repositoryContext}
        files={section.visibleFiles}
        pathRangesByPath={props.pathRangesByPath}
        activeFilePath={section.activeFilePath}
        virtualized={props.virtualized}
        nestedRows={!props.virtualized}
      />
    ),
    [
      props.epicId,
      props.hostId,
      props.pathRangesByPath,
      props.repositoryContext,
      props.runningDir,
      props.viewTabId,
      props.virtualized,
    ],
  );

  return (
    <TooltipProvider
      delayDuration={FILE_ROW_TOOLTIP_DELAY_MS}
      skipDelayDuration={0}
    >
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
        testId="git-file-sections"
        renderBody={renderBody}
      />
    </TooltipProvider>
  );
}
