import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import type {
  GitChangedFile,
  GitListChangedFilesResponse,
  WorktreeBindingSelectorRow,
} from "@traycer/protocol/host";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useGitPrefetchWorktreeStatus } from "@/hooks/git/use-git-prefetch-worktree-status";
import { useGitCapabilitiesQuery } from "@/hooks/git/use-git-capabilities-query";
import {
  useGitListChangedFilesSubscription,
  type GitListChangedFilesSubscriptionResult,
} from "@/hooks/git/use-git-list-changed-files-subscription";
import { gitQueryKeys } from "@/lib/query-keys/git-query-keys";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import {
  selectGitPanelEpicState,
  useGitPanelStore,
} from "@/stores/epics/git-panel-store";
import { useSettingsStore } from "@/stores/settings/settings-store";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isGitSelectable } from "@/lib/worktree/worktree-git-selectable";
import { CapabilityGate } from "./capability-gate";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { FileList } from "./file-list";
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

// Mirrors the file-tree explorer panel: the controlled input updates
// immediately while the applied query (which drives filtering) is debounced.
const GIT_PANEL_SEARCH_DEBOUNCE_MS = 150;

interface GitChangedFilesViewProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly files: ReadonlyArray<GitChangedFile>;
}

function GitChangedFilesView(props: GitChangedFilesViewProps): ReactNode {
  const [searchQuery, setSearchQuery] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");
  const debounceTimerRef = useRef<number | null>(null);

  const clearPendingDebounce = useCallback(() => {
    if (debounceTimerRef.current === null) return;
    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = null;
  }, []);

  const handleSearchChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const next = event.target.value;
      setSearchQuery(next);
      clearPendingDebounce();
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        setAppliedQuery(next);
      }, GIT_PANEL_SEARCH_DEBOUNCE_MS);
    },
    [clearPendingDebounce],
  );

  const handleClear = useCallback(() => {
    clearPendingDebounce();
    setSearchQuery("");
    setAppliedQuery("");
  }, [clearPendingDebounce]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      handleClear();
      event.currentTarget.blur();
    },
    [handleClear],
  );

  useEffect(() => clearPendingDebounce, [clearPendingDebounce]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 bg-background/50 px-2 py-1.5">
        <InputGroup className="h-7 border-transparent bg-muted/25 shadow-none focus-within:bg-muted/35">
          <InputGroupAddon align="inline-start">
            <Search className="size-3.5" aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="text"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            placeholder="Filter changed files…"
            aria-label="Filter changed files"
            className="text-ui-sm"
          />
          {searchQuery.length > 0 ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                onClick={handleClear}
                aria-label="Clear filter"
              >
                <X className="size-3.5" aria-hidden />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>
      <FileList
        epicId={props.epicId}
        viewTabId={props.viewTabId}
        hostId={props.hostId}
        runningDir={props.runningDir}
        files={props.files}
        query={appliedQuery}
        onClearQuery={handleClear}
      />
    </div>
  );
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
