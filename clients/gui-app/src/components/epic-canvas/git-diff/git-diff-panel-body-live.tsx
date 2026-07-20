import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  queryOptions,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import type {
  GitListChangedFilesResponse,
  GitListChangedFilesResponseV11,
  WorktreeBindingSelectorRowV12,
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
import type {
  GitDiffRepoSwitcherRootCounts,
  GitDiffRepoSwitcherRootInput,
} from "@/lib/git/git-diff-repo-switcher";
import { useGitSubmoduleSnapshotRefresh } from "@/hooks/git/use-git-submodule-snapshot-refresh";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
  type GitPanelSelectedRepo,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { isWorkspaceResolvePending } from "@/lib/worktree/worktree-row-resolve-pending";
import { getBasename } from "@/lib/path/cross-platform-path";
import { WorkspacePickerWithOpener } from "@/components/worktree/workspace-picker-with-opener";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { CapabilityGate } from "./capability-gate";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { GitRootsUnavailable } from "./empty-states/git-roots-unavailable";
import { NoGitWorktrees } from "./empty-states/no-git-worktrees";
import { GitDiffRepoSwitcher } from "./git-diff-repo-switcher";
import { SelectedRepoChanges } from "./selected-repo-changes";

const GIT_REFERENCE_REFRESH_TIMEOUT_MS = 10_000;

interface UnavailableRootsState {
  readonly keys: ReadonlySet<string>;
  readonly observedRootKey: string | null;
  readonly observedAvailable: boolean | null;
}

interface UnavailableGitRootKeys {
  readonly keys: ReadonlySet<string>;
  readonly reset: () => ReadonlySet<string>;
}

export interface GitDiffPanelBodyLiveProps {
  readonly epicId: string;
  readonly tabId: string;
}

function createUnavailableRootsState(
  keys: ReadonlySet<string>,
  observedRootKey: string | null,
  observedAvailable: boolean | null,
): UnavailableRootsState {
  return { keys, observedRootKey, observedAvailable };
}

function updateUnavailableKeys(
  current: ReadonlySet<string>,
  rootKey: string,
  shouldBeUnavailable: boolean,
): ReadonlySet<string> {
  const isUnavailable = current.has(rootKey);
  if (isUnavailable === shouldBeUnavailable) return current;
  const next = new Set(current);
  if (shouldBeUnavailable) {
    next.add(rootKey);
  } else {
    next.delete(rootKey);
  }
  return next;
}

function useUnavailableGitRootKeys(
  selectedRootKey: string | null,
  selectedRootAvailable: boolean | null,
): UnavailableGitRootKeys {
  const [unavailableRoots, setUnavailableRoots] =
    useState<UnavailableRootsState>(() =>
      createUnavailableRootsState(new Set(), null, null),
    );
  if (
    selectedRootKey !== null &&
    selectedRootAvailable !== null &&
    (unavailableRoots.observedRootKey !== selectedRootKey ||
      unavailableRoots.observedAvailable !== selectedRootAvailable)
  ) {
    setUnavailableRoots(
      createUnavailableRootsState(
        updateUnavailableKeys(
          unavailableRoots.keys,
          selectedRootKey,
          !selectedRootAvailable,
        ),
        selectedRootKey,
        selectedRootAvailable,
      ),
    );
  }

  const reset = useCallback((): ReadonlySet<string> => {
    const cleared = new Set<string>();
    setUnavailableRoots(createUnavailableRootsState(cleared, null, null));
    return cleared;
  }, []);

  return useMemo(
    () => ({ keys: unavailableRoots.keys, reset }),
    [reset, unavailableRoots.keys],
  );
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
  // Worktrees the host reports as no longer usable git repos (e.g. deleted out
  // from under us). This render-time adjustment follows React's guarded
  // "adjust state from props" pattern so the terminal empty-state check and the
  // default-pick effect see the same unavailable-root set before commit.
  const unavailableGitRootKeys = useUnavailableGitRootKeys(
    selectedRootKey,
    selectedCapabilityData?.available ?? null,
  );

  useEffect(() => {
    gitRows.forEach((row) => {
      void prefetch({
        hostId: row.hostId,
        runningDir: row.runningDir,
        ignoreWhitespace,
      });
    });
  }, [ignoreWhitespace, prefetch, gitRows]);

  useEffect(() => {
    if (bindingsQuery.isPending || bindingsQuery.error !== null) return;

    const selectedRootReady = gitRows.some(
      (row) =>
        selectedRepo !== null &&
        row.hostId === selectedRepo.hostId &&
        row.runningDir === selectedRepo.rootRunningDir &&
        !unavailableGitRootKeys.keys.has(worktreeRowKey(row)),
    );
    if (selectedRootReady) return;

    const next = pickDefaultRow(
      gitRows,
      queryClient,
      unavailableGitRootKeys.keys,
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
    selectedRepo,
    setSelectedRepo,
    unavailableGitRootKeys.keys,
  ]);

  // Clear the probed-unavailable set and re-probe every root's capability, so a
  // fully-degraded panel can recover once a broken worktree is restored. The
  // retry also re-picks a root so the freshly invalidated capability query runs
  // against a candidate again.
  const retryUnavailableRoots = useCallback(() => {
    const cleared = unavailableGitRootKeys.reset();
    void queryClient.invalidateQueries({
      predicate: (query) =>
        gitQueryKeys.matchGitCapabilitiesQuery(query.queryKey),
    });
    const next = pickDefaultRow(
      gitRows,
      queryClient,
      cleared,
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
    gitRows,
    ignoreWhitespace,
    props.epicId,
    queryClient,
    setSelectedRepo,
    unavailableGitRootKeys,
  ]);

  if (bindingsQuery.isPending) return <DiffLoadingSkeleton variant="panel" />;
  if (bindingsQuery.error !== null) return <NoGitWorktrees />;
  if (gitRows.length === 0) {
    // Rows whose git facts are still unverified placeholders (cold-resolve
    // timeout on the host, or a pre-@1.2 host) are pending, not dead: keep
    // the skeleton instead of declaring "no git workspaces" - the host's
    // sweep pushes `worktree.changed` and the refetch settles this either
    // way within a tick.
    if (rows.some(isWorkspaceResolvePending)) {
      return <DiffLoadingSkeleton variant="panel" />;
    }
    return <NoGitWorktrees />;
  }
  if (selectedRepo === null || selectedRootRow === null) {
    if (allRowsKnownUnavailable(gitRows, unavailableGitRootKeys.keys)) {
      // Every bound root probed unavailable: an explicit, recoverable degrade -
      // never the transient skeleton, which with zero available roots would
      // never resolve and read as "still loading" forever.
      return <GitRootsUnavailable onRetry={retryUnavailableRoots} />;
    }
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

function allRowsKnownUnavailable(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
  unavailableKeys: ReadonlySet<string> | null,
): boolean {
  return (
    unavailableKeys !== null &&
    rows.length > 0 &&
    rows.every((row) => unavailableKeys.has(worktreeRowKey(row)))
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
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly selected: GitPanelSelectedRepo;
  readonly selectedRootRow: WorktreeBindingSelectorRowV12;
}

function GitDiffPanelLoaded(props: GitDiffPanelLoadedProps): ReactNode {
  const { selected, selectedRootRow } = props;
  const [repoSwitcherOpen, setRepoSwitcherOpen] = useState(false);
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
  const workspaceSelected = useMemo<GitPanelSelectedRepo>(
    () =>
      selected.repoRoot === selected.rootRunningDir
        ? selected
        : {
            hostId: selected.hostId,
            rootRunningDir: selected.rootRunningDir,
            repoRoot: selected.rootRunningDir,
          },
    [selected],
  );

  // Reactive read of every root's cached v1.0 change count for switcher badges.
  // `combine` keeps the counts array referentially stable across unrelated
  // re-renders, so the memoized `roots` below only rebuilds when a count changes.
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
        return parentStatusCounts(data);
      }),
  });
  const activeRootCounts = activeRootParentCounts(
    snapshot.data,
    subscription.data,
  );
  const roots: ReadonlyArray<GitDiffRepoSwitcherRootInput> = useMemo(
    () =>
      props.rows.map((row, index) => {
        const cachedCounts = rootCounts[index] ?? null;
        const isSelectedRoot =
          row.hostId === selectedRootRow.hostId &&
          row.runningDir === selectedRootRow.runningDir;
        const counts =
          isSelectedRoot && activeRootCounts !== null
            ? activeRootCounts
            : cachedCounts;
        return {
          row,
          fileChangeCount: counts?.fileChangeCount ?? null,
          moduleChangeCount: counts?.moduleChangeCount ?? null,
        };
      }),
    [
      activeRootCounts,
      props.rows,
      rootCounts,
      selectedRootRow.hostId,
      selectedRootRow.runningDir,
    ],
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
  ]);

  // Explicit generation-aware unary fetch (works under stream ownership too,
  // where the passive unary query is disabled) - see
  // `useGitSubmoduleSnapshotRefresh`.
  const handleRefresh = useGitSubmoduleSnapshotRefresh({
    hostId: selectedRootRow.hostId,
    rootRunningDir: selectedRootRow.runningDir,
    ignoreWhitespace,
  });
  const referenceRefresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: snapshot.isPending,
    timeoutMs: GIT_REFERENCE_REFRESH_TIMEOUT_MS,
  });

  const handleSelectRoot = useCallback(
    (row: WorktreeBindingSelectorRowV12) => {
      setSelectedRepo(props.epicId, {
        hostId: row.hostId,
        rootRunningDir: row.runningDir,
        repoRoot: row.runningDir,
      });
    },
    [props.epicId, setSelectedRepo],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 px-2 pt-1.5 pb-1">
        <WorkspacePickerWithOpener
          picker={
            <GitDiffRepoSwitcher
              open={repoSwitcherOpen}
              onOpenChange={setRepoSwitcherOpen}
              roots={roots}
              activeRootSubmodules={submoduleNodes}
              selected={workspaceSelected}
              onSelectRoot={handleSelectRoot}
              hostSection={<WorktreePickerHostSection />}
              autoFocusSearch={repoSwitcherOpen}
              triggerClassName={undefined}
              contentClassName={undefined}
              triggerTestId="git-diff-repo-switcher-trigger"
              contentTestId="git-diff-repo-switcher-popover"
            />
          }
          openTarget={{
            workspacePath: selectedRootRow.runningDir,
            hostId: selectedRootRow.hostId,
          }}
        />
      </div>
      <CapabilityGate
        hostId={selectedRootRow.hostId}
        runningDir={selectedRootRow.runningDir}
      >
        <SelectedRepoChanges
          epicId={props.epicId}
          viewTabId={props.viewTabId}
          selected={workspaceSelected}
          rootLabel={moduleNameForRow(selectedRootRow)}
          subscription={subscription}
          snapshot={snapshot}
          onRefresh={referenceRefresh.trigger}
          isRefreshing={referenceRefresh.refreshing}
        />
      </CapabilityGate>
    </div>
  );
}

function pickDefaultRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
  queryClient: QueryClient,
  excludeKeys: ReadonlySet<string>,
  ignoreWhitespace: boolean,
): WorktreeBindingSelectorRowV12 | null {
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
  row: WorktreeBindingSelectorRowV12,
  queryClient: QueryClient,
  ignoreWhitespace: boolean,
): number {
  const data = queryClient.getQueryData<GitListChangedFilesResponse>(
    gitQueryKeys.listChangedFiles(row.hostId, row.runningDir, ignoreWhitespace),
  );
  return data?.files.length ?? 0;
}

function labelForRow(row: WorktreeBindingSelectorRowV12): string {
  return formatGitWorktreeLabel(row);
}

function moduleNameForRow(row: WorktreeBindingSelectorRowV12): string {
  return row.repoIdentifier?.repo ?? getBasename(row.runningDir);
}

function activeRootParentCounts(
  snapshotData: GitListChangedFilesResponseV11 | null,
  subscriptionData: GitListChangedFilesResponse | null,
): GitDiffRepoSwitcherRootCounts | null {
  return (
    parentStatusCounts(snapshotData) ?? parentStatusCounts(subscriptionData)
  );
}

function parentStatusCounts(
  data: GitListChangedFilesResponse | GitListChangedFilesResponseV11 | null,
): GitDiffRepoSwitcherRootCounts | null {
  if (data === null) return null;
  const seenGitlinkPaths = new Set<string>();
  return data.files.reduce<GitDiffRepoSwitcherRootCounts>(
    (counts, file) => {
      if (!("gitlink" in file) || file.gitlink === null) {
        return {
          fileChangeCount: (counts.fileChangeCount ?? 0) + 1,
          moduleChangeCount: counts.moduleChangeCount,
        };
      }
      if (seenGitlinkPaths.has(file.path)) return counts;
      seenGitlinkPaths.add(file.path);
      return {
        fileChangeCount: counts.fileChangeCount,
        moduleChangeCount: (counts.moduleChangeCount ?? 0) + 1,
      };
    },
    { fileChangeCount: 0, moduleChangeCount: 0 },
  );
}
