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
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  classifyBindingsFailure,
  type BindingsFailure,
} from "@/lib/worktree/bindings-failure";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import {
  useGitDiffPanelSurfaceKey,
  useSurfaceHostClient,
  useSurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useSurfaceHostStreamBinding } from "@/hooks/host/use-surface-host-stream-binding";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { StreamRuntimeContext } from "@/lib/host/stream-runtime-context";
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
import { withoutResolvedMissingRows } from "@/lib/worktree/worktree-row-resolved-missing";
import { getBasename } from "@/lib/path/cross-platform-path";
import { WorkspacePickerWithOpener } from "@/components/worktree/workspace-picker-with-opener";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { CapabilityGate } from "./capability-gate";
import { GitDiffPanelInlineActions } from "./git-diff-panel-actions";
import { DiffLoadingSkeleton } from "./diff-loading-skeleton";
import { GitBindingsUnreadable } from "./empty-states/git-bindings-unreadable";
import { GitHostUnreachable } from "./empty-states/git-host-unreachable";
import { GitRootsUnavailable } from "./empty-states/git-roots-unavailable";
import { NoGitWorktrees } from "./empty-states/no-git-worktrees";
import { GitDiffRepoSwitcher } from "./git-diff-repo-switcher";
import { GitWatcherStatusNotice } from "./git-watcher-status-notice";
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
  const surfaceKey = useGitDiffPanelSurfaceKey(props.tabId);
  const pin = useSurfaceHostPin(surfaceKey);
  const { latchOnFirstUse } = pin;
  const client = useSurfaceHostClient(pin.resolvedHostId);
  // The value to PROVIDE: ambient while following, the pin's own binding once
  // built, null while pending - never the ambient socket for a pinned host.
  const pinnedStreamBinding = useSurfaceHostStreamBinding(pin.resolvedHostId);
  // No dead arm: a pinned host that dies resolves to `effective`, so the panel
  // re-points instead of blanking. The selected repo is (hostId, path), so the
  // default-pick effect below finds it absent from the new host's rows and
  // re-picks - the panel can never render the dead host's repo against a live
  // one's diffs.
  const bindingsQuery = useWorktreeListBindingsForEpicForClient({
    client,
    epicId: props.epicId,
    enabled: pin.resolvedHostId !== null,
  });
  const selectedRepo = useGitPanelStore(
    (s) => selectGitPanelEpicState(props.epicId)(s).selectedRepo,
  );
  // Host-proven-missing rows are hidden (no git surface can use them); the
  // current selection is exempt so a just-deleted selected root routes through
  // the existing unavailable-roots machinery instead of vanishing.
  const rows = useMemo(
    () =>
      withoutResolvedMissingRows(
        bindingsQuery.data?.rows ?? [],
        selectedRepo === null
          ? null
          : {
              hostId: selectedRepo.hostId,
              runningDir: selectedRepo.rootRunningDir,
            },
      ),
    [bindingsQuery.data?.rows, selectedRepo],
  );
  const gitRows = useMemo(() => rows.filter(isGitSelectable), [rows]);
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
    if (selectedRootReady) {
      latchOnFirstUse();
      return;
    }

    const next = pickDefaultRow(
      gitRows,
      queryClient,
      unavailableGitRootKeys.keys,
      ignoreWhitespace,
    );
    if (next !== null) {
      latchOnFirstUse();
    }
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
    latchOnFirstUse,
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
    if (next !== null) {
      latchOnFirstUse();
    }
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
    latchOnFirstUse,
  ]);

  // The pin moves the STREAM too, not just the unary reads above.
  // `git.subscribeStatus` is opened by `GitDiffPanelLoaded` below out of
  // `StreamRuntimeContext`, so before this the panel sent the pinned host's
  // name as a subscribe PARAM over the APP-WIDE host's socket - watching the
  // wrong machine's working tree while every unary read beside it was
  // correctly pinned. One swap here re-targets the whole subtree.
  //
  // Re-dial the host this panel resolves to. Host-scoped queries deliberately
  // disable every automatic recovery route (no retry, no polling, no
  // focus/reconnect refetch - see `lib/host/availability-recovery.ts`), so an
  // errored bindings read stays errored until something asks again. This is
  // the only thing in the panel that can ask.
  // Returns the query's own promise rather than firing and forgetting: the
  // retry affordance keeps its pending state for exactly as long as the read
  // is in flight, which is only true if the caller can await it.
  const { refetch: refetchBindings } = bindingsQuery;
  const retryBindings = useCallback(async (): Promise<void> => {
    await refetchBindings();
  }, [refetchBindings]);

  // Returning the surface to following by clearing the pin - the recovery the
  // panel can perform on its own, rather than waiting on the authority to
  // reach a death verdict it may never reach. Offered only when it would
  // actually MOVE the panel.
  //
  // The comparison is against `resolvedHostId`, NOT the raw `selection`. A pin
  // whose host the authority HAS declared dead is already deposed, so the
  // panel is on `followingHostId` and reads through to it - and if that host's
  // own bindings read then fails, comparing the raw preference would offer
  // "Use active host" while the active host is precisely what already failed.
  // Clicking would drop the sticky pin, move nothing and change no error,
  // which is the no-op-that-reads-like-a-fix this guard exists to prevent.
  const { setSelection } = pin;
  const canUseActiveHost =
    pin.selection !== null &&
    pin.followingHostId !== null &&
    pin.resolvedHostId !== pin.followingHostId;
  const handleUseActiveHost = useCallback(() => {
    setSelection(null);
  }, [setSelection]);

  const resolvedHostEntry = useHostDirectoryEntryForHostId(pin.resolvedHostId);

  // Rendered UNCONDITIONALLY, as `ResourceMonitorPopover` is and for the same
  // reason: mounting the provider only when a pinned binding exists changes
  // the element type at this position the instant a pick resolves, and React
  // would unmount the subtree - discarding the panel's selection and scroll
  // the moment a host is chosen. `null` means "following", where the ambient
  // binding is already this host's.
  return (
    <StreamRuntimeContext.Provider value={pinnedStreamBinding}>
      {renderGitDiffPanelBody({
        surfaceKey,
        client,
        latchOnFirstUse: pin.latchOnFirstUse,
        bindingsPending: bindingsQuery.isPending,
        bindingsFailure: classifyBindingsFailure(bindingsQuery.error),
        gitRows,
        rows,
        selectedRepo,
        selectedRootRow,
        epicId: props.epicId,
        tabId: props.tabId,
        retryUnavailableRoots,
        unavailableGitRootKeys: unavailableGitRootKeys.keys,
        retryBindings,
        useActiveHost: canUseActiveHost ? handleUseActiveHost : null,
        resolvedHostName: resolvedHostEntry?.label ?? null,
      })}
    </StreamRuntimeContext.Provider>
  );
}

function renderGitDiffPanelBody(input: {
  readonly surfaceKey: string;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly latchOnFirstUse: () => void;
  readonly bindingsPending: boolean;
  readonly bindingsFailure: BindingsFailure | null;
  readonly gitRows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly selectedRepo: GitPanelSelectedRepo | null;
  readonly selectedRootRow: WorktreeBindingSelectorRowV12 | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly retryUnavailableRoots: () => void;
  readonly unavailableGitRootKeys: ReadonlySet<string>;
  readonly retryBindings: () => Promise<void>;
  readonly useActiveHost: (() => void) | null;
  readonly resolvedHostName: string | null;
}): ReactNode {
  if (
    input.selectedRepo !== null &&
    input.selectedRootRow !== null &&
    input.gitRows.length > 0 &&
    !input.bindingsPending &&
    input.bindingsFailure === null
  ) {
    return (
      <GitDiffPanelLoaded
        epicId={input.epicId}
        viewTabId={input.tabId}
        rows={input.rows}
        selected={input.selectedRepo}
        selectedRootRow={input.selectedRootRow}
        surfaceKey={input.surfaceKey}
        onLatchHost={input.latchOnFirstUse}
        client={input.client}
      />
    );
  }

  // EVERY degraded branch keeps the header, and that is the whole point of
  // this shape rather than a tidier early-return chain.
  //
  // The host picker lives in the repo switcher's `hostSection`, which used to
  // render only inside `GitDiffPanelLoaded`. So each of the states below -
  // reached BY choosing a host - removed the one control that could choose a
  // different one. Pinning to a host that could not answer produced "No git
  // workspaces available" with no picker, no auto-follow (the pin is deposed
  // only on a lease death that needs a refusal streak nothing here re-dials to
  // produce) and no refetch (host queries disable every automatic recovery
  // route), so the panel stayed there across reloads: the pin is persisted.
  //
  // The shared host-option model keeps an indeterminate route selectable: a
  // dial that fails is recoverable where an un-pickable row is not. That only
  // helps while the picker outlives the failure.
  return (
    <GitDiffPanelDegraded
      surfaceKey={input.surfaceKey}
      epicId={input.epicId}
      rows={input.rows}
      client={input.client}
      onLatchHost={input.latchOnFirstUse}
    >
      {degradedGitDiffBody(input)}
    </GitDiffPanelDegraded>
  );
}

function degradedGitDiffBody(input: {
  readonly bindingsPending: boolean;
  readonly bindingsFailure: BindingsFailure | null;
  readonly gitRows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly retryUnavailableRoots: () => void;
  readonly unavailableGitRootKeys: ReadonlySet<string>;
  readonly retryBindings: () => Promise<void>;
  readonly useActiveHost: (() => void) | null;
  readonly resolvedHostName: string | null;
}): ReactNode {
  if (input.bindingsPending) return <DiffLoadingSkeleton variant="panel" />;
  // Both arms are distinct from `NoGitWorktrees`, which tells the user to add
  // workspaces - the wrong remedy, on the wrong machine, and indistinguishable
  // from a host that answered with nothing. They are also distinct from EACH
  // OTHER, which is the finer point: "did not answer" and "answered with a
  // refusal" have different fixes, and only the first is about reachability.
  if (input.bindingsFailure !== null) {
    if (input.bindingsFailure.kind === "answered") {
      return (
        <GitBindingsUnreadable
          message={input.bindingsFailure.message}
          onRetry={input.retryBindings}
        />
      );
    }
    return (
      <GitHostUnreachable
        hostName={input.resolvedHostName}
        onRetry={input.retryBindings}
        onUseActiveHost={input.useActiveHost}
      />
    );
  }
  if (input.gitRows.length === 0) {
    // Rows whose git facts are still unverified placeholders (cold-resolve
    // timeout on the host, or a pre-@1.2 host) are pending, not dead: keep
    // the skeleton instead of declaring "no git workspaces" - the host's
    // sweep pushes `worktree.changed` and the refetch settles this either
    // way within a tick.
    if (input.rows.some(isWorkspaceResolvePending)) {
      return <DiffLoadingSkeleton variant="panel" />;
    }
    return <NoGitWorktrees />;
  }
  if (allRowsKnownUnavailable(input.gitRows, input.unavailableGitRootKeys)) {
    // Every bound root probed unavailable: an explicit, recoverable degrade -
    // never the transient skeleton, which with zero available roots would
    // never resolve and read as "still loading" forever.
    return <GitRootsUnavailable onRetry={input.retryUnavailableRoots} />;
  }
  // Default-pick is resolving the initial selection (one commit).
  return <DiffLoadingSkeleton variant="panel" />;
}

interface GitDiffPanelDegradedProps {
  readonly surfaceKey: string;
  readonly epicId: string;
  readonly rows: ReadonlyArray<WorktreeBindingSelectorRowV12>;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly onLatchHost: () => void;
  readonly children: ReactNode;
}

/**
 * The panel's chrome for every state that is not fully loaded: the same
 * workspace/host picker the loaded header carries, above whatever the degraded
 * body is.
 *
 * It is a REDUCED header rather than the loaded one because the facts the
 * loaded header renders do not exist here - there is no selected root, so no
 * change counts, no submodule tree and no watcher status to qualify. The
 * switcher already models exactly this: `selected: null` renders "Select
 * workspace", and an empty `roots` renders "No workspaces found." in its list.
 * What survives is the part that matters - the host section, and any rows the
 * host DID return, so a pick can move the panel out of this state.
 *
 * `openTarget` is null throughout: with no selected workspace there is no path
 * to open in an editor, and the opener renders inert rather than aiming at a
 * host that just failed to answer.
 */
function GitDiffPanelDegraded(props: GitDiffPanelDegradedProps): ReactNode {
  const [repoSwitcherOpen, setRepoSwitcherOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  const setSelectedRepo = useGitPanelStore((s) => s.setSelectedRepo);
  const { epicId, onLatchHost } = props;
  const isMobileViewport = useIsMobileViewport();

  const roots: ReadonlyArray<GitDiffRepoSwitcherRootInput> = useMemo(
    () =>
      props.rows.map((row) => ({
        row,
        fileChangeCount: null,
        moduleChangeCount: null,
      })),
    [props.rows],
  );

  const handleSelectRoot = useCallback(
    (row: WorktreeBindingSelectorRowV12) => {
      onLatchHost();
      setSelectedRepo(epicId, {
        hostId: row.hostId,
        rootRunningDir: row.runningDir,
        repoRoot: row.runningDir,
      });
    },
    [epicId, onLatchHost, setSelectedRepo],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 pt-1.5 pb-1">
        <div className="min-w-0 flex-1">
          <WorkspacePickerWithOpener
            picker={
              <GitDiffRepoSwitcher
                open={repoSwitcherOpen}
                onOpenChange={setRepoSwitcherOpen}
                roots={roots}
                activeRootSubmodules={[]}
                selected={null}
                onSelectRoot={handleSelectRoot}
                hostSection={
                  <WorktreePickerHostSection surfaceKey={props.surfaceKey} />
                }
                // Opening the switcher is a tap to pick a workspace, not to
                // type. A touch pointer would pay for the search's focus with
                // a software keyboard over the list; a fine one gets
                // type-to-filter for free. Focus stays on the still-mounted
                // trigger either way.
                autoFocusSearch={coarsePointer ? false : repoSwitcherOpen}
                triggerClassName={undefined}
                contentClassName={undefined}
                triggerTestId="git-diff-repo-switcher-trigger"
                contentTestId="git-diff-repo-switcher-popover"
              />
            }
            openTarget={null}
            hostClient={props.client}
          />
        </div>
        {/* Degraded keeps the overflow menu for the same reason it keeps the
            picker: desktop's panel header carries it in every state, and the
            phone has no other home for it. */}
        {isMobileViewport ? (
          <GitDiffPanelInlineActions epicId={epicId} />
        ) : null}
      </div>
      {/* The bodies below are written as `h-full` blocks (they used to be the
          panel's ONLY child). A percentage height needs a definite parent, so
          they get a flex slot of their own rather than being dropped straight
          into the column beside the header, where `h-full` would resolve to
          the full panel and overflow it. */}
      <div className="flex min-h-0 flex-1 flex-col">{props.children}</div>
    </div>
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
  readonly surfaceKey: string;
  readonly onLatchHost: () => void;
  /** This panel's own pinned client, forwarded to the "open in editor" opener. */
  readonly client: HostClient<HostRpcRegistry> | null;
}

function GitDiffPanelLoaded(props: GitDiffPanelLoadedProps): ReactNode {
  const { selected, selectedRootRow, epicId, onLatchHost, surfaceKey, client } =
    props;
  const [repoSwitcherOpen, setRepoSwitcherOpen] = useState(false);
  const coarsePointer = useCoarsePointer();
  const ignoreWhitespace = useSettingsStore(
    (s) => s.diffViewerPreferences.ignoreWhitespace,
  );
  const setSelectedRepo = useGitPanelStore((s) => s.setSelectedRepo);
  // Below md the epic sidebar - and with it this panel's header Actions slot -
  // is never mounted; the tab switcher shows the body alone. The overflow menu
  // moves into the body header there so the layout toggle and the manual
  // refresh stay reachable, and stays out of it wherever the header exists.
  const isMobileViewport = useIsMobileViewport();

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
    setSelectedRepo(epicId, {
      hostId: selected.hostId,
      rootRunningDir: selected.rootRunningDir,
      repoRoot: selected.rootRunningDir,
    });
  }, [
    epicId,
    selected.hostId,
    selected.repoRoot,
    selected.rootRunningDir,
    setSelectedRepo,
  ]);

  // Explicit generation-aware unary fetch (works under stream ownership too,
  // where the passive unary query is disabled) - see
  // `useGitSubmoduleSnapshotRefresh`.
  const { refresh: handleRefresh, isRefreshing } =
    useGitSubmoduleSnapshotRefresh({
      hostId: selectedRootRow.hostId,
      rootRunningDir: selectedRootRow.runningDir,
      ignoreWhitespace,
    });
  const referenceRefresh = useRefreshSpinner({
    onRefresh: handleRefresh,
    externalRefreshing: snapshot.isPending || isRefreshing,
    timeoutMs: GIT_REFERENCE_REFRESH_TIMEOUT_MS,
  });

  const handleSelectRoot = useCallback(
    (row: WorktreeBindingSelectorRowV12) => {
      onLatchHost();
      setSelectedRepo(epicId, {
        hostId: row.hostId,
        rootRunningDir: row.runningDir,
        repoRoot: row.runningDir,
      });
    },
    [epicId, onLatchHost, setSelectedRepo],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 pt-1.5 pb-1">
        {/* `min-w-0 flex-1` on the WRAPPER, not the picker: the picker's own
            `flex-1` governs its inner layout only, so as a bare flex item it
            would shrink to its content and leave the header half empty -
            most visibly when the watcher is healthy and renders nothing. */}
        <div className="min-w-0 flex-1">
          <WorkspacePickerWithOpener
            picker={
              <GitDiffRepoSwitcher
                open={repoSwitcherOpen}
                onOpenChange={setRepoSwitcherOpen}
                roots={roots}
                activeRootSubmodules={submoduleNodes}
                selected={workspaceSelected}
                onSelectRoot={handleSelectRoot}
                hostSection={
                  <WorktreePickerHostSection surfaceKey={surfaceKey} />
                }
                // Opening the switcher is a tap to pick a workspace, not to
                // type. A touch pointer would pay for the search's focus with
                // a software keyboard over the list; a fine one gets
                // type-to-filter for free. Focus stays on the still-mounted
                // trigger either way.
                autoFocusSearch={coarsePointer ? false : repoSwitcherOpen}
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
            hostClient={client}
          />
        </div>
        {/* Sits beside the repo switcher because it qualifies THIS repo's
            freshness - watcher health is per-repo, not per-host. */}
        <GitWatcherStatusNotice
          status={subscription.watcherStatus}
          className={undefined}
          compact={false}
        />
        {isMobileViewport ? (
          <GitDiffPanelInlineActions epicId={epicId} />
        ) : null}
      </div>
      <CapabilityGate
        hostId={selectedRootRow.hostId}
        runningDir={selectedRootRow.runningDir}
      >
        <SelectedRepoChanges
          epicId={epicId}
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
