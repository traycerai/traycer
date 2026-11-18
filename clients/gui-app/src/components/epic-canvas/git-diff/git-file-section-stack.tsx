import { useMemo, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
} from "@/stores/epics/canvas/types";
import { buildGitPanelFileSections } from "@/lib/git/panel-file-rendering";
import { cn } from "@/lib/utils";
import { GitDiffSection } from "./git-diff-section";
import type { GitDiffSectionCollapseController } from "./git-diff-section";
import {
  gitPanelActiveFilePathForGroup,
  useGitPanelActiveFile,
  useGitPanelRevealSection,
} from "./use-git-panel-active-file";

export interface GitFileSectionBodyRenderProps {
  readonly group: GitDiffBundleGroup;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly activeFilePath: string | null;
}

export interface GitFileSectionStackProps {
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
  readonly testId: string;
  readonly renderBody: (props: GitFileSectionBodyRenderProps) => ReactNode;
}

/**
 * Shared stage-section hierarchy for the flat and tree layouts. In the live
 * module composition, the outer module list owns scrolling so both the module
 * header and its nested stage headers participate in the same sticky context.
 */
export function GitFileSectionStack(
  props: GitFileSectionStackProps,
): ReactNode {
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
      className={cn(
        props.virtualized
          ? "flex min-h-0 flex-1 flex-col overflow-hidden"
          : "flex flex-col overflow-visible",
      )}
      data-testid={props.testId}
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
            repositoryContext={props.repositoryContext}
            visibleFiles={visibleFiles}
            bundleFileCount={bundleFileCount}
            forceExpanded={props.forceExpanded}
            collapseController={props.sectionCollapseController}
            fillAvailable={props.virtualized}
            compactChrome={!props.virtualized}
          >
            {props.renderBody({
              group,
              visibleFiles,
              activeFilePath: gitPanelActiveFilePathForGroup(activeFile, group),
            })}
          </GitDiffSection>
        ),
      )}
    </div>
  );
}
