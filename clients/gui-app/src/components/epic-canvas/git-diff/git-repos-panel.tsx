import { useMemo, type ReactNode } from "react";
import type { RepoMode } from "@traycer/protocol/host";
import type { GitReposComposition } from "@/lib/git/git-repo-composition";
import { cn } from "@/lib/utils";
import { GitChangedFilesView } from "./git-changed-files-view";
import { RepoStateBanner } from "./repo-state-banner";
import { SubmoduleReferenceRow } from "./submodule-reference-row";
import { SubmoduleRepoSection } from "./submodule-repo-section";

export interface GitReposPanelProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly composition: GitReposComposition;
  readonly repoMode: RepoMode | null;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}

/**
 * The group-by-repo layout: the parent repo card (header + counts + its ordinary
 * files + demoted submodule-reference rows) followed by one card per dirty
 * submodule. Engaged only when the snapshot has submodule content; the
 * single-repo case never reaches here.
 *
 * Layout keeps the parent's virtualized `FileList` in a bounded flex region so
 * it still virtualizes, with the submodule cards in a separately-scrollable
 * region so neither collapses the other.
 */
export function GitReposPanel(props: GitReposPanelProps): ReactNode {
  const { parent, submodules } = props.composition;
  const hasParentFiles = parent.fileCount > 0;

  const conflictCount = useMemo(
    () => parent.files.filter((file) => file.stage === "conflicted").length,
    [parent.files],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/20 px-3 py-1.5">
        <span className="min-w-0 truncate text-ui-sm font-semibold">
          {parent.label}
        </span>
        <span className="shrink-0 rounded bg-muted/40 px-1.5 py-0.5 text-ui-xs text-muted-foreground">
          {parent.headLabel}
        </span>
        <span
          className="ml-auto shrink-0 text-ui-xs tabular-nums text-muted-foreground"
          data-testid="git-parent-counts"
        >
          {parent.countsLabel}
        </span>
      </header>

      {parent.repoState.kind !== "clean" ? (
        <RepoStateBanner
          state={parent.repoState}
          repoMode={props.repoMode}
          conflictCount={conflictCount}
        />
      ) : null}

      {hasParentFiles ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <GitChangedFilesView
            epicId={props.epicId}
            viewTabId={props.viewTabId}
            hostId={props.hostId}
            runningDir={props.runningDir}
            files={parent.files}
          />
        </div>
      ) : null}

      {parent.referenceRows.length > 0 ? (
        <div
          className="shrink-0 border-t border-border/60 py-1"
          data-testid="git-submodule-reference-rows"
        >
          {parent.referenceRows.map((row) => (
            <SubmoduleReferenceRow
              key={row.parentPath}
              view={row}
              onRefresh={props.onRefresh}
              isRefreshing={props.isRefreshing}
            />
          ))}
        </div>
      ) : null}

      {submodules.length > 0 ? (
        <div
          className={cn(
            "overflow-y-auto border-t border-border/60",
            hasParentFiles ? "max-h-[45%] shrink-0" : "min-h-0 flex-1",
          )}
          data-testid="git-submodule-sections"
        >
          {submodules.map((view) => (
            <SubmoduleRepoSection
              key={view.repoRoot}
              view={view}
              hostId={props.hostId}
              viewTabId={props.viewTabId}
              parentRunningDir={props.runningDir}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
