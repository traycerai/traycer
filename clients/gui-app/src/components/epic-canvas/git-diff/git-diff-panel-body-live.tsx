import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  GitListChangedFilesResponse,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useGitPrefetchWorktreeStatus } from "@/hooks/git/use-git-prefetch-worktree-status";
import { useGitCapabilitiesQuery } from "@/hooks/git/use-git-capabilities-query";
import { useGitListChangedFilesSubscription } from "@/hooks/git/use-git-list-changed-files-subscription";
import { useGitListChangedFilesWithSubmodules } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { buildSubmoduleNodes } from "@/lib/git/git-repo-tree";
import { invalidateGitSubmoduleSnapshot } from "@/lib/git/invalidate-git-submodule-snapshot";
import { formatWorktreeFolderDisabledReason } from "@/lib/worktree/worktree-folder-disabled-reason";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
  type GitPanelSelectedRepo,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { OpenInEditorButton } from "@/components/worktree/open-in-editor-button";
import { CapabilityGate } from "./capability-gate";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { NoGitWorktrees } from "./empty-states/no-git-worktrees";
import { RepoTree, type RepoTreeRootRow } from "./repo-tree";
import { SelectedRepoChanges } from "./selected-repo-changes";

const GIT_REFERENCE_REFRESH_TIMEOUT_MS = 10_000;

export interface GitDiffPanelBodyLiveProps {
  readonly epicId: string;
  readonly tabId: string;
}

export function GitDiffPanelBodyLive(
  props: GitDiffPanelBodyLiveProps,
): ReactNode {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: props.epicId,
    enabled: true,
  });
  const rows = useMemo(
    () => bindingsQuery.data?.rows ?? [],
    [bindingsQuery.data?.rows],
  );
  const gitRows = useMemo(() => rows.filter(isGitSelectable), [rows]);

  const selectedRepo = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedRepo,
  );
  const setSelectedRepo = useGitPanelStore((s) => s.setSelectedRepo);
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const queryClient = useQueryClient();
  const prefetch = useGitPrefetchWorktreeStatus();

  // Worktrees the host reports as no longer usable git repos (e.g. deleted out
  // from under us). Tracked in a ref so recording one never triggers a
  // setState-in-effect cascade; keys are removed when the same worktree probes
  // healthy again. Resets on remount.
  const unavailableKeysRef = useRef<Set<string> | null>(null);

  // The root repo owning the current selection (the only root whose nested @1.1
  // snapshot is fetched - bounded lazy fan-out).
  const selectedRootRow = useMemo(
    () =>
      gitRows.find(
        (row) =>
          selectedRepo !== null &&
          row.hostId === selectedRepo.hostId &&
          row.runningDir === selectedRepo.rootRunningDir,
      ) ?? null,
    [gitRows, selectedRepo],
  );

  // Probe the selected root's git capability (deduped with the CapabilityGate).
  // A deleted worktree resolves `available: false` and gets routed around.
  const selectedCapabilityQuery = useGitCapabilitiesQuery({
    hostId: selectedRootRow === null ? null : selectedRootRow.hostId,
    runningDir: selectedRootRow === null ? "" : selectedRootRow.runningDir,
    enabled: selectedRootRow !== null,
  });
  const selectedRootKey =
    selectedRootRow === null ? null : worktreeRowKey(selectedRootRow);
  const selectedCapabilityData =
    selectedRootRow === null ? null : (selectedCapabilityQuery.data ?? null);

  useEffect(() => {
    for (const row of gitRows) {
      void prefetch({
        hostId: row.hostId,
        runningDir: row.runningDir,
        ignoreWhitespace,
      });
    }
  }, [ignoreWhitespace, prefetch, gitRows]);

  useEffect(() => {
    if (bindingsQuery.isPending || bindingsQuery.error !== null) return;

    const unavailable = (unavailableKeysRef.current ??= new Set<string>());
    if (selectedRootKey !== null && selectedCapabilityData !== null) {
      if (selectedCapabilityData.available) {
        unavailable.delete(selectedRootKey);
      } else {
        unavailable.add(selectedRootKey);
      }
    }

    const selectedRootReady = gitRows.some(
      (row) =>
        selectedRepo !== null &&
        row.hostId === selectedRepo.hostId &&
        row.runningDir === selectedRepo.rootRunningDir &&
        !unavailable.has(worktreeRowKey(row)),
    );
    if (selectedRootReady) return;

    const next = pickDefaultRow(
      gitRows,
      queryClient,
      unavailable,
      ignoreWhitespace,
    );
    setSelectedRepo(
      props.epicId,
      next === null
        ? null
        : {
            hostId: next.hostId,
            rootRunningDir: next.runningDir,
            repoRoot: next.runningDir,
          },
    );
  }, [
    bindingsQuery.error,
    bindingsQuery.isPending,
    props.epicId,
    ignoreWhitespace,
    queryClient,
    gitRows,
    selectedCapabilityData,
    selectedRootKey,
    selectedRepo,
    setSelectedRepo,
  ]);

  if (bindingsQuery.isPending) return <DiffLoadingSkeleton variant="panel" />;
  if (bindingsQuery.error !== null) return <NoGitWorktrees />;
  if (gitRows.length === 0) return <NoGitWorktrees />;
  if (selectedRepo === null || selectedRootRow === null) {
    // Default-pick is resolving the initial selection (one commit).
    return <DiffLoadingSkeleton variant="panel" />;
  }

  return (
    <GitDiffPanelLoaded
      epicId={props.epicId}
      viewTabId={props.tabId}
      rows={rows}
      selected={selectedRepo}
      selectedRootRow={selectedRootRow}
    />
  );
}

interface GitDiffPanelLoadedProps {
  readonly epicId: string;
  readonly viewTabId: string;
  /**
   * Every binding for the epic, selectable or not - disabled rows (non-git
   * folders, setup states) render greyed with their reason instead of
   * silently vanishing from the panel.
   */
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRow>;
  readonly selected: GitPanelSelectedRepo;
  readonly selectedRootRow: WorktreeBindingSelectorRow;
}

function gitDiffDisabledLabel(row: WorktreeBindingSelectorRow): string | null {
  if (!row.isGitRepo) return "not git";
  return formatWorktreeFolderDisabledReason(row);
}

function GitDiffPanelLoaded(props: GitDiffPanelLoadedProps): ReactNode {
  const { selected, selectedRootRow } = props;
  const queryClient = useQueryClient();
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const setSelectedRepo = useGitPanelStore((s) => s.setSelectedRepo);

  // Live parent status for the active root: drives the nested-snapshot refetch
  // (its fingerprint is the change token) and the immediate pre-snapshot render.
  const subscription = useGitListChangedFilesSubscription({
    hostId: selectedRootRow.hostId,
    runningDir: selectedRootRow.runningDir,
    ignoreWhitespace,
    enabled: true,
  });
  const snapshot = useGitListChangedFilesWithSubmodules({
    hostId: selectedRootRow.hostId,
    runningDir: selectedRootRow.runningDir,
    ignoreWhitespace,
    enabled: true,
    changeToken: subscription.data?.fingerprint ?? null,
  });

  // Reactive read of every root's cached v1.0 change count for the tree
  // badges. `combine` keeps the counts array referentially stable across
  // unrelated re-renders, so the memoized `roots` below only rebuilds (and
  // RepoTree's visibleRows memo only busts) when a count actually changes.
  const rootCounts = useQueries({
    queries: props.rows.map((row) =>
      queryOptions({
        queryKey: gitQueryKeys.listChangedFiles(
          row.hostId,
          row.runningDir,
          ignoreWhitespace,
        ),
        queryFn: (): Promise<GitListChangedFilesResponse | null> =>
          Promise.resolve(null),
        enabled: false,
        staleTime: Infinity,
      }),
    ),
    combine: (results) =>
      results.map((result) => {
        const data = result.data ?? null;
        return data === null ? null : data.files.length;
      }),
  });
  const roots: ReadonlyArray<RepoTreeRootRow> = useMemo(
    () =>
      props.rows.map((row, index) => ({
        row,
        changeCount: rootCounts[index] ?? null,
        disabledLabel: gitDiffDisabledLabel(row),
      })),
    [props.rows, rootCounts],
  );

  const submoduleNodes = useMemo(
    () =>
      snapshot.data === null
        ? []
        : buildSubmoduleNodes(snapshot.data.submodules),
    [snapshot.data],
  );

  useEffect(() => {
    if (selected.repoRoot === selected.rootRunningDir) return;
    if (snapshot.data === null) return;
    const selectedSubmoduleStillExists = snapshot.data.submodules.some(
      (submodule) => submodule.repoRoot === selected.repoRoot,
    );
    if (selectedSubmoduleStillExists) return;
    setSelectedRepo(props.epicId, {
      hostId: selected.hostId,
      rootRunningDir: selected.rootRunningDir,
      repoRoot: selected.rootRunningDir,
    });
  }, [
    props.epicId,
    selected.hostId,
    selected.repoRoot,
    selected.rootRunningDir,
    setSelectedRepo,
    snapshot.data,
  ]);

  const handleRefresh = useCallback(
    (): Promise<void> =>
      invalidateGitSubmoduleSnapshot(queryClient, {
        hostId: selectedRootRow.hostId,
        rootRunningDir: selectedRootRow.runningDir,
        ignoreWhitespace,
      }),
    [ignoreWhitespace, queryClient, selectedRootRow],
  );
  const referenceRefresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: snapshot.isPending,
    timeoutMs: GIT_REFERENCE_REFRESH_TIMEOUT_MS,
  });

  const handleSelectRoot = useCallback(
    (row: WorktreeBindingSelectorRow) => {
      setSelectedRepo(props.epicId, {
        hostId: row.hostId,
        rootRunningDir: row.runningDir,
        repoRoot: row.runningDir,
      });
    },
    [props.epicId, setSelectedRepo],
  );

  const handleSelectSubmoduleRepoRoot = useCallback(
    (repoRoot: string) => {
      setSelectedRepo(props.epicId, {
        hostId: selected.hostId,
        rootRunningDir: selected.rootRunningDir,
        repoRoot,
      });
    },
    [props.epicId, selected.hostId, selected.rootRunningDir, setSelectedRepo],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-end px-2 pt-1.5 pb-1">
        <OpenInEditorButton
          openTarget={{
            workspacePath: selected.repoRoot,
            hostId: selected.hostId,
          }}
        />
      </div>
      <RepoTree
        roots={roots}
        selected={selected}
        activeRootSubmodules={submoduleNodes}
        onSelectRoot={handleSelectRoot}
        onSelectSubmodule={(node) =>
          handleSelectSubmoduleRepoRoot(node.repoRoot)
        }
      />
      <CapabilityGate
        hostId={selectedRootRow.hostId}
        runningDir={selectedRootRow.runningDir}
      >
        <SelectedRepoChanges
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          selected={selected}
          subscription={subscription}
          snapshot={snapshot}
          onSelectSubmoduleRepoRoot={handleSelectSubmoduleRepoRoot}
          onRefresh={referenceRefresh.trigger}
          isRefreshing={referenceRefresh.refreshing}
        />
      </CapabilityGate>
    </div>
  );
}

function pickDefaultRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
  queryClient: QueryClient,
  excludeKeys: ReadonlySet<string>,
  ignoreWhitespace: boolean,
): WorktreeBindingSelectorRow | null {
  const ready = rows.filter((row) => !excludeKeys.has(worktreeRowKey(row)));
  if (ready.length === 0) return null;
  return ready.toSorted((left, right) => {
    const leftCount = readCachedCount(left, queryClient, ignoreWhitespace);
    const rightCount = readCachedCount(right, queryClient, ignoreWhitespace);
    if (leftCount !== rightCount) return rightCount - leftCount;
    if (left.isPrimary !== right.isPrimary) return left.isPrimary ? -1 : 1;
    return labelForRow(left).localeCompare(labelForRow(right));
  })[0];
}

function readCachedCount(
  row: WorktreeBindingSelectorRow,
  queryClient: QueryClient,
  ignoreWhitespace: boolean,
): number {
  const data = queryClient.getQueryData<GitListChangedFilesResponse>(
    gitQueryKeys.listChangedFiles(row.hostId, row.runningDir, ignoreWhitespace),
  );
  return data?.files.length ?? 0;
}

function labelForRow(row: WorktreeBindingSelectorRow): string {
  return formatGitWorktreeLabel(row);
}
