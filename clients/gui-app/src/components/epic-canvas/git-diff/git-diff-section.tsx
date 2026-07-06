import { useCallback, useMemo, type ReactNode } from "react";
import type { GitChangedFile } from "@traycer/protocol/host";
import type { GitDiffBundleGroup } from "@/stores/epics/canvas/types";
import { gitBundleGroupLabel } from "@/lib/git/git-diff-tile";
import { sumGitFileStats } from "@/lib/git/file-stats";
import {
  selectGitPanelSectionCollapsed,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { Section } from "./section";
import { BundleOpenButton } from "./bundle-open-button";
import { GitSectionStatsSummary } from "./diff-tab-shell";

export interface GitDiffSectionCollapseController {
  readonly collapsed: (group: GitDiffBundleGroup) => boolean;
  readonly toggle: (group: GitDiffBundleGroup) => void;
}

export interface GitDiffSectionProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly group: GitDiffBundleGroup;
  readonly visibleFiles: ReadonlyArray<GitChangedFile>;
  readonly bundleFileCount: number;
  /**
   * When a filter is active, force the section open regardless of the user's
   * stored collapse flag so matches are always visible. Overridden at render
   * time only - the persisted flag is untouched, so clearing the filter
   * restores the user's collapse state.
   */
  readonly forceExpanded: boolean;
  readonly collapseController: GitDiffSectionCollapseController | null;
  readonly fillAvailable: boolean;
  readonly compactChrome: boolean;
  readonly children: ReactNode;
}

/**
 * Per-stage-group chrome shared by both panel layouts (flat list and
 * Pierre tree): the Section shell, the persisted per-epic collapse flag,
 * the +/- stats summary, and the bundle-open action. `Section` only
 * mounts `children` when expanded and non-empty, so callers pass the
 * section body unconditionally.
 */
export function GitDiffSection(props: GitDiffSectionProps): ReactNode {
  const collapseController = props.collapseController;
  const epicId = props.epicId;
  const group = props.group;
  const persistedCollapsed = useGitPanelStore(
    selectGitPanelSectionCollapsed(epicId, group),
  );
  const collapsed =
    collapseController === null
      ? persistedCollapsed
      : collapseController.collapsed(group);
  const handleToggle = useCallback(() => {
    if (collapseController !== null) {
      collapseController.toggle(group);
      return;
    }
    useGitPanelStore.getState().toggleSection(epicId, group);
  }, [collapseController, epicId, group]);
  const stats = useMemo(
    () => sumGitFileStats(props.visibleFiles),
    [props.visibleFiles],
  );

  return (
    <Section
      title={gitBundleGroupLabel(props.group)}
      count={props.visibleFiles.length}
      summary={
        <GitSectionStatsSummary
          insertions={stats.insertions}
          deletions={stats.deletions}
        />
      }
      collapsed={props.forceExpanded ? false : collapsed}
      onToggle={handleToggle}
      fillAvailable={props.fillAvailable}
      compactChrome={props.compactChrome}
      actions={
        <BundleOpenButton
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          hostId={props.hostId}
          runningDir={props.runningDir}
          group={props.group}
          disabled={props.bundleFileCount === 0}
        />
      }
    >
      {props.children}
    </Section>
  );
}
