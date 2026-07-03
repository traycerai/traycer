import { useMemo, type ReactNode } from "react";
import type {
  GitChangedFile,
  GitListChangedFilesResponseV11,
  RepoMode,
  RepoState,
} from "@traycer/protocol/host";
import type { GitListChangedFilesSubscriptionResult } from "@/hooks/git/use-git-list-changed-files-subscription";
import type { GitListChangedFilesWithSubmodulesResult } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import type { GitPanelSelectedRepo } from "@/stores/epics/git-panel-store";
import {
  buildSubmoduleReferenceRows,
  findSubmoduleChangeset,
  splitParentFiles,
  type SubmoduleReferenceRowView,
} from "@/lib/git/git-repo-tree";
import { GitChangedFilesView } from "./git-changed-files-view";
import { RepoStateBanner } from "./repo-state-banner";
import { SubmoduleReferenceRow } from "./submodule-reference-row";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { NoChangesInWorktree } from "./empty-states/no-changes-in-worktree";
import { SubscriptionErrorState } from "./empty-states/subscription-error-state";
import { SubmoduleUnavailable } from "./empty-states/submodule-unavailable";

export interface SelectedRepoChangesProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly selected: GitPanelSelectedRepo;
  readonly subscription: GitListChangedFilesSubscriptionResult;
  readonly snapshot: GitListChangedFilesWithSubmodulesResult;
  readonly onSelectSubmoduleRepoRoot: (repoRoot: string) => void;
  readonly onRefresh: () => void;
  readonly isRefreshing: boolean;
}

/**
 * The single full-featured changes view scoped to the selected repo node. Both
 * the root repo and each submodule render through the SAME parent components
 * (`GitChangedFilesView` -> `FileList` -> flat list / Pierre tree), so a
 * submodule's changes get identical rows, actions, search, and virtualization
 * (the parity fix). Diffs route by `runningDir = selected.repoRoot`, so a
 * submodule's own working-tree files diff stage-based inside the submodule.
 */
export function SelectedRepoChanges(
  props: SelectedRepoChangesProps,
): ReactNode {
  const isRoot = props.selected.repoRoot === props.selected.rootRunningDir;
  return isRoot ? (
    <RootRepoChanges {...props} />
  ) : (
    <SubmoduleChanges {...props} />
  );
}

interface RootSource {
  readonly files: ReadonlyArray<GitChangedFile>;
  readonly referenceRows: ReadonlyArray<SubmoduleReferenceRowView>;
  readonly repoState: RepoState | null;
  readonly repoMode: RepoMode | null;
  readonly hasLanded: boolean;
}

/**
 * Pick the root's changes source: the nested snapshot once it lands (it demotes
 * gitlink rows to reference rows), else the live v1.0 subscription so the
 * parent's ordinary files show immediately with no flicker.
 */
function resolveRootSource(
  subscriptionData: ReadonlyArray<GitChangedFile> | null,
  subscriptionRepoState: RepoState | null,
  subscriptionRepoMode: RepoMode | null,
  snapshotData: GitListChangedFilesResponseV11 | null,
): RootSource {
  if (snapshotData !== null) {
    const split = splitParentFiles(snapshotData.files);
    return {
      files: split.ordinaryFiles,
      referenceRows: buildSubmoduleReferenceRows(
        split.gitlinkFiles,
        snapshotData.submodules,
      ),
      repoState: snapshotData.repoState,
      repoMode: snapshotData.repoMode,
      hasLanded: true,
    };
  }
  return {
    files: subscriptionData ?? [],
    referenceRows: [],
    repoState: subscriptionRepoState,
    repoMode: subscriptionRepoMode,
    hasLanded: subscriptionData !== null,
  };
}

function RootRepoChanges(props: SelectedRepoChangesProps): ReactNode {
  const { subscription, snapshot } = props;
  const source = useMemo(
    () =>
      resolveRootSource(
        subscription.data?.files ?? null,
        subscription.repoState,
        subscription.repoMode,
        snapshot.data,
      ),
    [
      subscription.data,
      subscription.repoState,
      subscription.repoMode,
      snapshot.data,
    ],
  );

  if (subscription.error !== null && snapshot.data === null) {
    return <SubscriptionErrorState event={subscription.error} />;
  }
  if (!source.hasLanded) {
    return <DiffLoadingSkeleton variant="panel" />;
  }

  const conflictCount = source.files.filter(
    (file) => file.stage === "conflicted",
  ).length;

  // The banner renders even with zero changes: a clean tree can still be in a
  // non-clean repo state (detached HEAD, paused rebase/cherry-pick) the user
  // must see - mirrors SubmoduleChanges below.
  const banner =
    source.repoState !== null && source.repoState.kind !== "clean" ? (
      <RepoStateBanner
        state={source.repoState}
        repoMode={source.repoMode}
        conflictCount={conflictCount}
      />
    ) : null;

  if (source.files.length === 0 && source.referenceRows.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {banner}
        <NoChangesInWorktree lastUpdatedAtMs={subscription.pollStartedAtMs} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {banner}
      {source.files.length > 0 ? (
        <GitChangedFilesView
          key={props.selected.repoRoot}
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          hostId={props.selected.hostId}
          runningDir={props.selected.repoRoot}
          files={source.files}
        />
      ) : null}
      {source.referenceRows.length > 0 ? (
        <div
          className="shrink-0 border-t border-border/60 py-1"
          data-testid="git-submodule-reference-rows"
        >
          {source.referenceRows.map((row) => (
            <SubmoduleReferenceRow
              key={row.parentPath}
              view={row}
              onSelect={props.onSelectSubmoduleRepoRoot}
              onRefresh={props.onRefresh}
              isRefreshing={props.isRefreshing}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function SubmoduleChanges(props: SelectedRepoChangesProps): ReactNode {
  const { snapshot } = props;

  if (snapshot.error !== null) {
    return (
      <SubmoduleUnavailable
        onRefresh={props.onRefresh}
        isRefreshing={props.isRefreshing}
      />
    );
  }
  if (snapshot.data === null) {
    return <DiffLoadingSkeleton variant="panel" />;
  }

  const changeset = findSubmoduleChangeset(
    snapshot.data.submodules,
    props.selected.repoRoot,
  );
  // The submodule dropped out of the snapshot (it went clean): show the ordinary
  // empty state rather than a stale view.
  if (changeset === null) {
    return <NoChangesInWorktree lastUpdatedAtMs={null} />;
  }
  if (changeset.availability.state === "unavailable") {
    return (
      <SubmoduleUnavailable
        onRefresh={props.onRefresh}
        isRefreshing={props.isRefreshing}
      />
    );
  }

  const files = changeset.files;
  const conflictCount = files.filter(
    (file) => file.stage === "conflicted",
  ).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {changeset.repoState.kind !== "clean" ? (
        <RepoStateBanner
          state={changeset.repoState}
          repoMode={null}
          conflictCount={conflictCount}
        />
      ) : null}
      {files.length > 0 ? (
        <GitChangedFilesView
          key={props.selected.repoRoot}
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          hostId={props.selected.hostId}
          runningDir={props.selected.repoRoot}
          files={files}
        />
      ) : (
        <NoChangesInWorktree lastUpdatedAtMs={null} />
      )}
    </div>
  );
}
