import { useMemo, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import { buildGitPanelFileSections } from "@/lib/git/panel-file-rendering";
import type { HighlightRanges } from "@/lib/git/path-highlight";
import { TooltipProvider } from "@/components/ui/tooltip";
import { GitDiffSection } from "./git-diff-section";
import { GitFlatFileList } from "./git-flat-file-list";
import {
  gitPanelActiveFilePathForGroup,
  useGitPanelActiveFile,
  useGitPanelRevealSection,
} from "./use-git-panel-active-file";

// Deliberate hover dwell for the per-row path tooltips: long enough that
// sweeping the cursor across the list never pops them, and skipDelay 0 so
// every row requires the same full dwell (no instant chain-popping).
const FILE_ROW_TOOLTIP_DELAY_MS = 700;

export interface FileSectionsProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly allFiles: ReadonlyArray<GitChangedFile>;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly pathRangesByPath: ReadonlyMap<string, HighlightRanges>;
  readonly forceExpanded: boolean;
}

export function FileSections(props: FileSectionsProps): ReactNode {
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
    <TooltipProvider
      delayDuration={FILE_ROW_TOOLTIP_DELAY_MS}
      skipDelayDuration={0}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden"
        data-testid="git-file-sections"
      >
        {sections.map(({ group, visibleFiles, bundleFileCount }) =>
          // While filtering, hide any empty section so only matches show;
          // otherwise keep the existing "hide the merge section when empty"
          // behavior and let staged/changes render their empty state.
          visibleFiles.length === 0 &&
          (props.forceExpanded || group === "merge") ? null : (
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
            >
              <GitFlatFileList
                epicId={props.epicId}
                viewTabId={props.viewTabId}
                hostId={props.hostId}
                runningDir={props.runningDir}
                files={visibleFiles}
                pathRangesByPath={props.pathRangesByPath}
                activeFilePath={gitPanelActiveFilePathForGroup(
                  activeFile,
                  group,
                )}
              />
            </GitDiffSection>
          ),
        )}
      </div>
    </TooltipProvider>
  );
}
