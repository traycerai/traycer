import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  GitListChangedFilesResponse,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useGitPrefetchWorktreeStatus } from "@/hooks/git/use-git-prefetch-worktree-status";
import { useGitCapabilitiesQuery } from "@/hooks/git/use-git-capabilities-query";
import {
  useGitListChangedFilesSubscription,
  type GitListChangedFilesSubscriptionResult,
} from "@/hooks/git/use-git-list-changed-files-subscription";
import { useGitListChangedFilesWithSubmodules } from "@/hooks/git/use-git-list-changed-files-with-submodules";
import { useGitRefreshSubmoduleStatus } from "@/hooks/git/use-git-refresh-submodule-status";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { composeGitRepos } from "@/lib/git/git-repo-composition";
import { getBasename } from "@/lib/path/cross-platform-path";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { CapabilityGate } from "./capability-gate";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { GitChangedFilesView } from "./git-changed-files-view";
import { GitReposPanel } from "./git-repos-panel";
import { NoGitWorktrees } from "./empty-states/no-git-worktrees";
import { NoChangesInWorktree } from "./empty-states/no-changes-in-worktree";
import { SubscriptionErrorState } from "./empty-states/subscription-error-state";
import { PanelToolbar } from "./panel-toolbar";
import { RepoStateBanner } from "./repo-state-banner";

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
  const selectedWorktree = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedWorktree,
  );
  const setSelectedWorktree = useGitPanelStore((s) => s.setSelectedWorktree);
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const queryClient = useQueryClient();
  const prefetch = useGitPrefetchWorktreeStatus();

  // Worktrees the host reports as no longer usable git repos (e.g. their
  // directory was deleted out from under us). Tracked in a ref - not React
  // state - so recording one never triggers a setState-in-effect cascade;
  // keys are removed when the same worktree probes healthy again. Lazily
  // initialized in the effect (null seed avoids rebuilding a Set every render).
  // Resets on remount.
  const unavailableKeysRef = useRef<Set<string> | null>(null);

  const selectedRow =
    rows.find(
      (row) =>
        selectedWorktree !== null &&
        worktreeRowKey(row) === worktreeRowKey(selectedWorktree) &&
        isGitSelectable(row),
    ) ?? null;

  // Probe the selected worktree's git capability here (the CapabilityGate
  // fetches the same query, deduped by key). This feeds disk-truth health back
  // into selection: a deleted worktree resolves `available: false` and gets
  // routed around, instead of leaving the user stuck behind the gate with no
  // picker to escape to.
  const selectedCapabilityQuery = useGitCapabilitiesQuery({
    hostId: selectedRow === null ? null : selectedRow.hostId,
    runningDir: selectedRow === null ? "" : selectedRow.runningDir,
    enabled: selectedRow !== null,
  });
  const selectedRunningKey =
    selectedRow === null ? null : worktreeRowKey(selectedRow);
  const selectedCapabilityData =
    selectedRow === null ? null : (selectedCapabilityQuery.data ?? null);

  useEffect(() => {
    for (const row of rows) {
      if (!isGitSelectable(row)) continue;
      void prefetch({
        hostId: row.hostId,
        runningDir: row.runningDir,
        ignoreWhitespace,
      });
    }
  }, [ignoreWhitespace, prefetch, rows]);

  useEffect(() => {
    if (bindingsQuery.isPending || bindingsQuery.error !== null) return;

    // Record a selected worktree the host reports as gone (capability
    // `available: false`), then treat membership like a `disabledReason` so a
    // dead worktree is never considered "still ready" and is excluded from the
    // default pick. Only `available: false` (not a pending/absent probe) marks
    // it, so selection never churns on an unsettled probe.
    const unavailable = (unavailableKeysRef.current ??= new Set<string>());
    if (selectedRunningKey !== null && selectedCapabilityData !== null) {
      if (selectedCapabilityData.available) {
        unavailable.delete(selectedRunningKey);
      } else {
        unavailable.add(selectedRunningKey);
      }
    }

    const selectedStillReady = rows.some(
      (row) =>
        selectedWorktree !== null &&
        worktreeRowKey(row) === worktreeRowKey(selectedWorktree) &&
        isGitSelectable(row) &&
        !unavailable.has(worktreeRowKey(row)),
    );
    if (selectedStillReady) return;
    const next = pickDefaultRow(
      rows,
      queryClient,
      unavailable,
      ignoreWhitespace,
    );
    setSelectedWorktree(
      props.epicId,
      next === null
        ? null
        : { hostId: next.hostId, runningDir: next.runningDir },
    );
  }, [
    bindingsQuery.error,
    bindingsQuery.isPending,
    props.epicId,
    ignoreWhitespace,
    queryClient,
    rows,
    selectedCapabilityData,
    selectedRunningKey,
    selectedWorktree,
    setSelectedWorktree,
  ]);

  if (bindingsQuery.isPending) return <DiffLoadingSkeleton variant="panel" />;
  if (bindingsQuery.error !== null) return <NoGitWorktrees />;
  if (rows.length === 0) return <NoGitWorktrees />;

  // The worktree picker (PanelToolbar) renders unconditionally above the gated
  // body, so a selected worktree whose capability check fails never unmounts
  // the only affordance for switching to a healthy worktree.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelToolbar
        epicId={props.epicId}
        rows={rows}
        selectedRow={selectedRow}
      />
      {selectedRow === null ? (
        <NoGitWorktrees />
      ) : (
        <CapabilityGate
          hostId={selectedRow.hostId}
          runningDir={selectedRow.runningDir}
        >
          <PanelContent
            epicId={props.epicId}
            viewTabId={props.tabId}
            selectedRow={selectedRow}
          />
        </CapabilityGate>
      )}
    </div>
  );
}

interface PanelContentProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly selectedRow: WorktreeBindingSelectorRow;
}

function PanelContent(props: PanelContentProps): ReactNode {
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const subscription = useGitListChangedFilesSubscription({
    hostId: props.selectedRow.hostId,
    runningDir: props.selectedRow.runningDir,
    ignoreWhitespace,
    enabled: true,
  });

  // The submodule-aware nested snapshot (single epoch). The parent subscription
  // fingerprint is the change-trigger; a bounded timer covers inner-only edits
  // (both inside the hook). Manual refresh flows through the toolbar mutation.
  const submoduleSnapshot = useGitListChangedFilesWithSubmodules({
    hostId: props.selectedRow.hostId,
    runningDir: props.selectedRow.runningDir,
    ignoreWhitespace,
    enabled: true,
    changeToken: subscription.data?.fingerprint ?? null,
  });

  const composition = useMemo(() => {
    const snapshot = submoduleSnapshot.data;
    if (snapshot === null) return null;
    return composeGitRepos({
      runningDir: snapshot.runningDir,
      label: getBasename(props.selectedRow.runningDir),
      branch: snapshot.branch,
      headSha: snapshot.headSha,
      repoState: snapshot.repoState,
      files: snapshot.files,
      submodules: snapshot.submodules,
    });
  }, [submoduleSnapshot.data, props.selectedRow.runningDir]);

  const refresh = useGitRefreshSubmoduleStatus(props.selectedRow.hostId);
  const handleRefresh = useCallback(() => {
    void refresh.mutateAsync({
      hostId: props.selectedRow.hostId,
      runningDir: props.selectedRow.runningDir,
      ignoreWhitespace,
    });
  }, [ignoreWhitespace, props.selectedRow, refresh]);

  // Group-by-repo engages only once the nested snapshot confirms submodule
  // content. Otherwise the panel renders exactly as the single-repo case does
  // today, off the live subscription (no flicker while the unary call lands).
  if (composition !== null && composition.hasSubmoduleContent) {
    return (
      <GitReposPanel
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.selectedRow.hostId}
        runningDir={props.selectedRow.runningDir}
        composition={composition}
        repoMode={submoduleSnapshot.data?.repoMode ?? null}
        onRefresh={handleRefresh}
        isRefreshing={refresh.isPending}
      />
    );
  }

  const conflictCount =
    subscription.data?.files.filter((file) => file.stage === "conflicted")
      .length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {subscription.repoState !== null &&
      subscription.repoState.kind !== "clean" ? (
        <RepoStateBanner
          state={subscription.repoState}
          repoMode={subscription.repoMode}
          conflictCount={conflictCount}
        />
      ) : null}
      <PanelBody panel={props} subscription={subscription} />
    </div>
  );
}

interface PanelBodyProps {
  readonly panel: PanelContentProps;
  readonly subscription: GitListChangedFilesSubscriptionResult;
}

function PanelBody(props: PanelBodyProps): ReactNode {
  const { panel, subscription } = props;
  if (subscription.isPending) return <DiffLoadingSkeleton variant="panel" />;
  if (subscription.error !== null) {
    return <SubscriptionErrorState event={subscription.error} />;
  }
  if ((subscription.data?.files.length ?? 0) === 0) {
    return (
      <NoChangesInWorktree lastUpdatedAtMs={subscription.pollStartedAtMs} />
    );
  }
  if (subscription.data !== null) {
    return (
      // Keyed by worktree so the ephemeral filter query resets when the user
      // switches worktrees (it otherwise persists across the list/tree toggle
      // and live status updates).
      <GitChangedFilesView
        key={worktreeRowKey(panel.selectedRow)}
        epicId={panel.epicId}
        viewTabId={panel.viewTabId}
        hostId={panel.selectedRow.hostId}
        runningDir={panel.selectedRow.runningDir}
        files={subscription.data.files}
      />
    );
  }
  return null;
}

function pickDefaultRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
  queryClient: QueryClient,
  excludeKeys: ReadonlySet<string>,
  ignoreWhitespace: boolean,
): WorktreeBindingSelectorRow | null {
  const ready = rows.filter(
    (row) => isGitSelectable(row) && !excludeKeys.has(worktreeRowKey(row)),
  );
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
