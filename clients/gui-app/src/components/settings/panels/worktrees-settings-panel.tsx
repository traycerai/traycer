import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  Check,
  ChevronRight,
  CopyMinus,
  CopyPlus,
  FileSliders,
  FolderGit2,
  ListChecks,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { WorktreeHostEntry } from "@traycer/protocol/host/index";
import type { WorktreeEntryScripts } from "@traycer/protocol/host/worktree-schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { cn } from "@/lib/utils";
import {
  withMemberAdded,
  withMemberRemoved,
  withMemberToggled,
} from "@/lib/immutable-set";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import { Dialog } from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";
import { type RepoScriptsSeed } from "@/components/workspaces/repo-scripts-form";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";
import {
  backgroundForegroundWorktreeDeleteForHost,
  clearSettledWorktreeDeleteSuccessesForHostIfQuiescent,
  summarizeWorktreeDeleteRuns,
  useWorktreeDeleteRun,
  worktreeDeleteProgressDetail,
  type WorktreeDeleteRunState,
  type WorktreeDeleteProgressSummary,
} from "@/components/settings/panels/use-worktree-delete-run";
import { WorktreeDeleteProgressModal } from "@/components/settings/panels/worktree-delete-progress-modal";

type WorktreeRowDeleteStatus = "deleting";
const WORKTREES_REFRESH_TIMEOUT_MS = 10_000;
const EMPTY_REPO_KEY_SET: ReadonlySet<string> = new Set();

/**
 * Host-wide worktree management. Lists every git worktree under the selected
 * host's `~/.traycer/worktrees/` creation path (disk-truth, so orphans whose
 * owning chat/agent was deleted still appear) and lets the user delete ones
 * they no longer need.
 *
 * The selected host is reached through transient per-host clients
 * (`useHostClientFor` for listing, `useHostStreamClientFor` for the
 * streamed delete), so picking a host here never swaps the app-wide active
 * host or reloads the Epic list. The host picker + a refresh control sit
 * in a toolbar directly above the worktree cards.
 */
export function WorktreesSettingsPanel(): ReactNode {
  const activeHostId = useReactiveActiveHostId();
  const hostsQuery = useHostDirectoryList();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // Default to the active host until the user picks another.
  const effectiveId = selectedId ?? activeHostId;
  // Resolve the entry from the (referentially stable) directory data so the
  // transient clients memoize per host rather than rebuilding each render.
  const selectedEntry = useMemo(
    () => hosts.find((entry) => entry.hostId === effectiveId) ?? null,
    [hosts, effectiveId],
  );
  const client = useHostClientFor(selectedEntry);
  // One-shot `worktree.deleteByPath` stream transport: it survives the panel
  // unmounting (a backgrounded delete keeps its socket) but wires no proactive
  // reconnect and no auth revalidation, so an OS wake / host respawn does not
  // silently re-subscribe and re-run the delete pipeline. A dropped socket
  // surfaces the failure instead.
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();

  return (
    <SettingsPanelShell
      title="Worktrees"
      description="Git worktrees Traycer created under ~/.traycer/worktrees on the selected host. Remove ones you no longer need - including orphans whose chat or agent was deleted."
      bodyClassName="relative"
    >
      <WorktreesBody
        client={client}
        openStreamTransport={openStreamTransport}
        hostId={effectiveId}
        hosts={hosts}
        value={effectiveId}
        onChange={setSelectedId}
      />
    </SettingsPanelShell>
  );
}

function WorktreesToolbar(props: {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
  readonly onRefresh: () => Promise<unknown>;
  readonly refreshing: boolean;
  readonly canRefresh: boolean;
  readonly selectionControls: ReactNode | null;
}): ReactNode {
  const {
    canRefresh,
    hosts,
    onChange,
    onRefresh,
    refreshing,
    selectionControls,
    value,
  } = props;
  const refreshWorktrees = useCallback(async () => {
    await onRefresh();
  }, [onRefresh]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshWorktrees,
    externalRefreshing: refreshing,
    timeoutMs: WORKTREES_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex items-center justify-between gap-2 border-b border-border/40 bg-muted/20 px-5 py-3">
      <HostSelect hosts={hosts} value={value} onChange={onChange} />
      <div
        className="flex shrink-0 items-center gap-1"
        data-testid="worktrees-toolbar-actions"
      >
        {selectionControls}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!canRefresh || refresh.refreshing}
          onClick={refresh.trigger}
          aria-label="Refresh worktrees"
        >
          <RefreshCw
            className={cn("size-4", refresh.refreshing && "animate-spin")}
          />
          <span>Refresh</span>
        </Button>
      </div>
    </div>
  );
}

function HostSelect(props: {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
}): ReactNode {
  return (
    <Select value={props.value ?? undefined} onValueChange={props.onChange}>
      <SelectTrigger size="sm" className="w-[min(60vw,15rem)]">
        <SelectValue placeholder="Select a host" />
      </SelectTrigger>
      <SelectContent>
        {props.hosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {hostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function WorktreesBody(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string | null;
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
}): ReactNode {
  const { client, openStreamTransport, hostId, hosts, value, onChange } = props;
  const reachability = useHostReachability(hostId ?? "");
  const reachable = hostId !== null && reachability.status === "reachable";
  const listQuery = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "worktree.listAllForHost",
    params: {},
    options: { enabled: reachable },
  });
  const canRefresh = reachable && client !== null;
  const toolbarProps = {
    hosts,
    value,
    onChange,
    onRefresh: () => listQuery.refetch(),
    refreshing: listQuery.isFetching,
    canRefresh,
  };

  let content: ReactNode;
  let listOwnsToolbar = false;
  if (hostId === null) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        Select a host to manage its worktrees.
      </WorktreesStateMessage>
    );
  } else if (reachability.status === "checking") {
    content = (
      <WorktreesStateMessage tone="muted" spinner>
        Checking {reachability.hostLabel}…
      </WorktreesStateMessage>
    );
  } else if (!reachable) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        {reachability.hostLabel} is offline. Worktrees can only be managed on a
        reachable host.
      </WorktreesStateMessage>
    );
  } else if (client === null) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        Sign in to manage worktrees on this host.
      </WorktreesStateMessage>
    );
  } else if (listQuery.isPending) {
    content = (
      <WorktreesStateMessage tone="muted" spinner>
        Loading worktrees…
      </WorktreesStateMessage>
    );
  } else if (listQuery.isError) {
    content = (
      <WorktreesStateMessage tone="error" spinner={false}>
        {listQuery.error.message}
      </WorktreesStateMessage>
    );
  } else if (listQuery.data.worktrees.length === 0) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        No worktrees created on this host.
      </WorktreesStateMessage>
    );
  } else {
    listOwnsToolbar = true;
    content = (
      <WorktreesList
        openStreamTransport={openStreamTransport}
        hostId={hostId}
        worktrees={listQuery.data.worktrees}
        toolbarProps={toolbarProps}
      />
    );
  }

  const showStandaloneToolbar = hosts.length > 0 && !listOwnsToolbar;

  return (
    <div className="flex flex-col">
      {showStandaloneToolbar ? (
        <WorktreesToolbar {...toolbarProps} selectionControls={null} />
      ) : null}
      {content}
    </div>
  );
}

// List renders many per-worktree states (loading / empty / error / per-row
// actions); branches are independent, not reducible nesting.
// eslint-disable-next-line complexity
export function WorktreesList(props: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  readonly worktrees: readonly WorktreeHostEntry[];
  readonly toolbarProps: {
    readonly hosts: readonly HostDirectoryEntry[];
    readonly value: string | null;
    readonly onChange: (hostId: string) => void;
    readonly onRefresh: () => Promise<unknown>;
    readonly refreshing: boolean;
    readonly canRefresh: boolean;
  };
}): ReactNode {
  const { hostId, worktrees, openStreamTransport } = props;
  const queryClient = useQueryClient();

  // Refresh the host-wide list plus the shared worktree/binding caches the
  // file-tree / home / create-worktree surfaces read, captured against the
  // host the delete ran on.
  const invalidate = useCallback(() => {
    invalidateWorktreeDeleteCaches(queryClient, hostId);
  }, [queryClient, hostId]);

  const {
    target: confirmed,
    run,
    backgrounded,
    runs,
    start,
    startBatchBackgrounded,
    clearCompletedDeletedMissingFromList,
    background,
    close,
    dismissTerminalBackgrounded,
  } = useWorktreeDeleteRun(hostId, openStreamTransport, invalidate);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [pendingDeleteTargets, setPendingDeleteTargets] =
    useState<ReadonlyArray<WorktreeHostEntry> | null>(null);
  const [pendingScriptReview, setPendingScriptReview] =
    useState<WorktreeScriptReviewDraft | null>(null);
  const reviewedScriptsByPathRef = useRef<ReadonlyMap<
    string,
    WorktreeEntryScripts
  > | null>(null);
  if (reviewedScriptsByPathRef.current === null) {
    reviewedScriptsByPathRef.current = new Map();
  }
  const reviewedScriptsByPath = reviewedScriptsByPathRef.current;

  const groups = useMemo(() => groupByRepo(worktrees), [worktrees]);
  const repoKeys = useMemo(() => groups.map((group) => group.key), [groups]);
  const [collapsedRepoKeys, dispatchCollapsedRepoKeys] = useReducer(
    collapsedRepoKeysReducer,
    EMPTY_REPO_KEY_SET,
  );
  const allReposCollapsed =
    groups.length > 0 &&
    groups.every((group) => collapsedRepoKeys.has(group.key));
  const visibleWorktrees = useMemo(
    () =>
      groups.flatMap((group) =>
        collapsedRepoKeys.has(group.key) ? [] : group.items,
      ),
    [collapsedRepoKeys, groups],
  );
  const visibleWorktreePathSet = useMemo(
    () => new Set(worktrees.map((entry) => entry.worktreePath)),
    [worktrees],
  );
  useEffect(() => {
    clearCompletedDeletedMissingFromList(visibleWorktreePathSet);
  }, [
    backgrounded,
    clearCompletedDeletedMissingFromList,
    visibleWorktreePathSet,
  ]);
  const backgroundedDeleteStatusByPath = useMemo(
    () =>
      new Map(
        runs.flatMap((record) => {
          const status = worktreeRowDeleteStatus(record.run);
          return record.backgrounded && status !== null
            ? [[record.target.worktreePath, status] as const]
            : [];
        }),
      ),
    [runs],
  );
  const selectableWorktreePaths = useMemo(
    () =>
      visibleWorktrees
        .filter((entry) =>
          worktreeCanBeSelected(entry, backgroundedDeleteStatusByPath),
        )
        .map((entry) => entry.worktreePath),
    [backgroundedDeleteStatusByPath, visibleWorktrees],
  );
  const selectablePathSet = useMemo(
    () => new Set(selectableWorktreePaths),
    [selectableWorktreePaths],
  );
  const selectedTargets = useMemo(
    () =>
      visibleWorktrees.filter(
        (entry) =>
          selectedPaths.has(entry.worktreePath) &&
          selectablePathSet.has(entry.worktreePath),
      ),
    [selectablePathSet, selectedPaths, visibleWorktrees],
  );
  const selectedCount = selectedTargets.length;
  const dialogCopy =
    pendingDeleteTargets === null
      ? null
      : deleteDialogCopyForTargets(pendingDeleteTargets);
  const progressSummary = useMemo(
    () => summarizeWorktreeDeleteRuns(runs),
    [runs],
  );
  useEffect(
    () => () => {
      // The Worktrees view is going away (Settings closed, section switched, or
      // host swapped). Keep an in-progress foreground delete alive in the
      // background (the store no-ops if it is already terminal), and drop this
      // host's settled successes the now-unmounted list can no longer prune -
      // otherwise they linger in the app-wide progress toast.
      backgroundForegroundWorktreeDeleteForHost(hostId);
      clearSettledWorktreeDeleteSuccessesForHostIfQuiescent(hostId);
    },
    [hostId],
  );

  const toggleSelection = useCallback(
    (worktreePath: string) => {
      if (!selectablePathSet.has(worktreePath)) return;
      setSelectedPaths((prev) => withMemberToggled(prev, worktreePath));
      setSelectionMode(true);
    },
    [selectablePathSet],
  );
  const enterSelectionMode = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionMode(true);
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelectedPaths(new Set(selectableWorktreePaths));
  }, [selectableWorktreePaths]);
  const cancelSelection = useCallback(() => {
    setSelectedPaths(new Set());
    setSelectionMode(false);
  }, []);
  const toggleRepoCollapsed = useCallback(
    (group: WorktreeRepoGroup, collapsed: boolean) => {
      if (collapsed) {
        dispatchCollapsedRepoKeys({ type: "expand", key: group.key });
      } else {
        dispatchCollapsedRepoKeys({ type: "collapse", key: group.key });
        setSelectedPaths((prev) => removeSelectedWorktrees(prev, group.items));
      }
    },
    [],
  );
  const toggleAllReposCollapsed = useCallback(() => {
    if (allReposCollapsed) {
      dispatchCollapsedRepoKeys({ type: "expand-all" });
      return;
    }
    dispatchCollapsedRepoKeys({ type: "collapse-all", keys: repoKeys });
    setSelectedPaths(new Set());
  }, [allReposCollapsed, repoKeys]);
  const requestDeleteTargets = useCallback(
    (targets: ReadonlyArray<WorktreeHostEntry>) => {
      const deletableTargets = targets.filter((entry) =>
        selectablePathSet.has(entry.worktreePath),
      );
      if (deletableTargets.length === 0) return;
      setPendingDeleteTargets(deletableTargets);
    },
    [selectablePathSet],
  );

  const handleConfirm = (): void => {
    if (pendingDeleteTargets === null) return;
    const targets = pendingDeleteTargets;
    if (targets.length === 1) {
      start(
        targets[0],
        reviewedScriptsByPath.get(targets[0].worktreePath) ?? null,
      );
    } else {
      startBatchBackgrounded(targets, reviewedScriptsByPath);
    }
    setSelectedPaths((prev) => removeSelectedWorktrees(prev, targets));
    setSelectionMode(false);
    setPendingDeleteTargets(null);
  };

  const handleCloseModal = (): void => {
    // While the delete is still running, "Run in background" keeps the stream
    // alive and lets the row carry progress. Once terminal - success OR failure
    // - "Close" tears it down for good. Gate on the live run status, NOT
    // `worktreeRowDeleteStatus` (which reports a just-deleted complete run as
    // still "deleting"): otherwise clicking "Close" on a finished delete would
    // background it and fire a spurious progress toast instead of dismissing.
    if (run !== null && (run.status === "queued" || run.status === "running")) {
      background();
      return;
    }
    close();
    // A delete that was cancelled mid-flight may have partially landed on the
    // host, so refresh on close too - not only on a terminal frame.
    invalidate();
  };
  const handleScriptReviewSave = (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts,
  ): void => {
    const next = new Map(reviewedScriptsByPath);
    next.set(target.worktreePath, scripts);
    reviewedScriptsByPathRef.current = next;
  };

  return (
    <div className="flex flex-col">
      {confirmed !== null && run !== null ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            aria-hidden
            className="absolute inset-0 bg-background/80 backdrop-blur-sm"
          />
          <div className="relative z-10 max-h-[min(80vh,40rem)] w-[min(92vw,32rem)] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-lg">
            <WorktreeDeleteProgressModal
              target={confirmed}
              run={run}
              onClose={handleCloseModal}
            />
          </div>
        </div>
      ) : null}

      <WorktreesToolbar
        {...props.toolbarProps}
        selectionControls={
          <>
            <WorktreesRepoExpansionControl
              allCollapsed={allReposCollapsed}
              onToggle={toggleAllReposCollapsed}
            />
            <WorktreesSelectionControls
              selectionMode={selectionMode}
              canSelect={selectableWorktreePaths.length > 0}
              selectedCount={selectedCount}
              onStart={enterSelectionMode}
              onSelectAll={selectAllVisible}
              onCancel={cancelSelection}
              onDeleteSelected={() => {
                requestDeleteTargets(selectedTargets);
              }}
            />
          </>
        }
      />
      <WorktreeDeleteProgressStrip
        summary={progressSummary}
        onDismiss={dismissTerminalBackgrounded}
      />

      {groups.map((group) => {
        const collapsed = collapsedRepoKeys.has(group.key);
        return (
          <div
            key={group.key}
            className="border-b border-border/40 last:border-b-0"
          >
            <WorktreeRepoHeader
              label={group.label}
              count={group.items.length}
              collapsed={collapsed}
              onToggle={() => toggleRepoCollapsed(group, collapsed)}
            />
            {collapsed ? null : (
              <div className="flex flex-col divide-y divide-border/30">
                {group.items.map((entry) => {
                  // The row carries the in-progress treatment only once the delete
                  // is sent to the background; while the foreground modal is up
                  // the modal alone shows progress - no duplication.
                  const deleteStatus =
                    backgroundedDeleteStatusByPath.get(entry.worktreePath) ??
                    null;
                  return (
                    <WorktreeRow
                      key={entry.worktreePath}
                      entry={entry}
                      deleteStatus={deleteStatus}
                      selectionMode={selectionMode}
                      selected={selectedPaths.has(entry.worktreePath)}
                      canSelect={selectablePathSet.has(entry.worktreePath)}
                      onToggleSelection={() =>
                        toggleSelection(entry.worktreePath)
                      }
                      onManageScripts={() =>
                        setPendingScriptReview({
                          target: entry,
                          scripts:
                            reviewedScriptsByPath.get(entry.worktreePath) ??
                            entry.scripts,
                        })
                      }
                      onDelete={() => requestDeleteTargets([entry])}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <ConfirmDestructiveDialog
        open={pendingDeleteTargets !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTargets(null);
        }}
        title={dialogCopy?.title ?? ""}
        description={dialogCopy?.description ?? ""}
        cascadeSummary={null}
        actionLabel={dialogCopy?.actionLabel ?? "Delete"}
        isPending={false}
        onConfirm={handleConfirm}
      />
      <WorktreeScriptReviewDialog
        target={pendingScriptReview?.target ?? null}
        scriptSeed={pendingScriptReview?.scripts ?? null}
        onOpenChange={(open) => {
          if (!open) setPendingScriptReview(null);
        }}
        onSave={handleScriptReviewSave}
      />
    </div>
  );
}

function WorktreeDeleteProgressStrip(props: {
  readonly summary: WorktreeDeleteProgressSummary;
  readonly onDismiss: () => void;
}): ReactNode {
  if (props.summary.total === 0) return null;
  // Once nothing is in flight, a batch that ended with failures stays put so the
  // user notices; offer an explicit Dismiss to clear it (and the app-wide toast)
  // rather than leaving it stuck forever.
  const showDismiss = props.summary.active === 0 && props.summary.failed > 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 bg-muted/20 px-5 py-2">
      <span className="text-ui-sm font-medium text-foreground">
        {worktreeDeleteProgressTitle(props.summary)}
      </span>
      <div className="flex items-center gap-3">
        <span className="text-ui-xs text-muted-foreground">
          {worktreeDeleteProgressDetail(props.summary)}
        </span>
        {showDismiss ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onDismiss}
            data-testid="worktree-delete-progress-dismiss"
          >
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function worktreeDeleteProgressTitle(
  summary: WorktreeDeleteProgressSummary,
): string {
  if (summary.active > 0) return "Deleting worktrees";
  if (summary.failed === 0) return "Worktrees deleted";
  if (summary.deleted === 0) return "Couldn't delete worktrees";
  return "Some worktrees couldn't be deleted";
}

type WorktreeScriptReviewDraft = {
  readonly target: WorktreeHostEntry;
  readonly scripts: RepoScriptsSeed | null;
};

function WorktreeRepoHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const action = props.collapsed ? "Expand" : "Collapse";
  return (
    <button
      type="button"
      aria-expanded={!props.collapsed}
      aria-label={`${action} ${props.label}`}
      className="flex w-full min-w-0 items-center gap-2 bg-muted/30 px-5 py-2 text-left transition-colors hover:bg-accent/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      onClick={props.onToggle}
    >
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !props.collapsed && "rotate-90",
        )}
        aria-hidden
      />
      <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
        {props.label}
      </span>
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {props.count}
      </span>
    </button>
  );
}

function WorktreeRow(props: {
  readonly entry: WorktreeHostEntry;
  readonly deleteStatus: WorktreeRowDeleteStatus | null;
  readonly selectionMode: boolean;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly onToggleSelection: () => void;
  readonly onManageScripts: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const {
    entry,
    deleteStatus,
    selectionMode,
    selected,
    canSelect,
    onToggleSelection,
    onManageScripts,
    onDelete,
  } = props;
  const deleting = deleteStatus !== null;
  const selectedForDelete = selectionMode && selected && canSelect;
  const selectionDisabled = selectionMode && !canSelect;
  return (
    <div
      aria-busy={deleting}
      data-testid="worktree-row"
      className={cn(
        "group/worktree-row relative flex items-center gap-3 px-5 py-3 transition-colors",
        deleting ? "pointer-events-none opacity-50" : "hover:bg-accent/30",
        selectedForDelete && "bg-accent/40 ring-1 ring-inset ring-primary/40",
        selectionDisabled && "opacity-50",
      )}
    >
      <div className="flex w-5 shrink-0 items-center justify-center">
        <WorktreeSelectionControl
          entry={entry}
          selectionMode={selectionMode}
          selected={selected}
          canSelect={canSelect}
          deleting={deleting}
          onToggleSelection={onToggleSelection}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1 pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {branchLabel(entry)}
          </span>
          {entry.inUse ? (
            <Badge variant="secondary" className="font-normal">
              In use
            </Badge>
          ) : null}
          {!entry.gitRemovable ? (
            <Badge
              variant="outline"
              className="font-normal text-muted-foreground"
            >
              Orphaned
            </Badge>
          ) : null}
          {entry.uncommittedCount > 0 ? (
            <span className="text-ui-xs text-muted-foreground">
              {entry.uncommittedCount} uncommitted
            </span>
          ) : null}
        </div>
        <StartTruncatedText className="block max-w-full text-ui-xs text-muted-foreground">
          {entry.worktreePath}
        </StartTruncatedText>
      </div>
      {deleting ? (
        <span className="inline-flex shrink-0 items-center gap-2 text-ui-xs text-muted-foreground">
          <AgentSpinningDots
            className={undefined}
            testId="worktree-row-deleting-spinner"
            variant={undefined}
          />
          Deleting…
        </span>
      ) : null}
      {!deleting && !selectionMode ? (
        <WorktreeRowActions
          inUse={entry.inUse}
          onManageScripts={onManageScripts}
          onDelete={onDelete}
          label={`Delete worktree ${branchLabel(entry)}`}
          scriptsLabel={`Manage scripts for worktree ${branchLabel(entry)}`}
        />
      ) : null}
    </div>
  );
}

function WorktreesRepoExpansionControl(props: {
  readonly allCollapsed: boolean;
  readonly onToggle: () => void;
}): ReactNode {
  const label = props.allCollapsed ? "Expand all" : "Collapse all";
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={label}
      title={label}
      data-testid="worktrees-toggle-all-repos"
      className="text-muted-foreground hover:text-foreground"
      onClick={props.onToggle}
    >
      {props.allCollapsed ? (
        <CopyPlus className="size-4" />
      ) : (
        <CopyMinus className="size-4" />
      )}
    </Button>
  );
}

function WorktreesSelectionControls(props: {
  readonly selectionMode: boolean;
  readonly canSelect: boolean;
  readonly selectedCount: number;
  readonly onStart: () => void;
  readonly onSelectAll: () => void;
  readonly onCancel: () => void;
  readonly onDeleteSelected: () => void;
}): ReactNode {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {props.selectionMode ? (
        <>
          <span className="px-1 text-ui-xs text-muted-foreground">
            {props.selectedCount} selected
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!props.canSelect}
            onClick={props.onSelectAll}
          >
            Select all
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={props.onCancel}
          >
            <X />
            Cancel
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={
              props.selectedCount > 0
                ? `Delete ${props.selectedCount} selected worktrees`
                : "Delete selected worktrees"
            }
            data-testid="worktrees-list-delete-selected"
            disabled={props.selectedCount === 0}
            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
            onClick={props.onDeleteSelected}
          >
            <Trash2 />
          </Button>
        </>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Select worktrees"
          disabled={!props.canSelect}
          className="gap-1.5 overflow-visible text-ui-sm text-muted-foreground hover:text-foreground"
          onClick={props.onStart}
        >
          <ListChecks className="size-4" />
          Select
        </Button>
      )}
    </div>
  );
}

function WorktreeSelectionControl(props: {
  readonly entry: WorktreeHostEntry;
  readonly selectionMode: boolean;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly deleting: boolean;
  readonly onToggleSelection: () => void;
}): ReactNode {
  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.selected && props.canSelect ? "true" : "false"}
      aria-disabled={!props.canSelect}
      aria-label={`Select worktree ${branchLabel(props.entry)}`}
      data-testid="worktree-row-select"
      className={cn(
        "flex size-4 items-center justify-center rounded-sm border transition-[border-color,background-color,color,opacity] outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
        worktreeSelectionCheckboxVisibility({
          selectionMode: props.selectionMode,
          isSelected: props.selected,
          canSelect: props.canSelect,
        }),
        props.canSelect ? "cursor-pointer" : "cursor-not-allowed",
        props.selected && props.canSelect
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-transparent hover:border-foreground",
      )}
      onClick={(event) => {
        event.stopPropagation();
        if (props.canSelect) props.onToggleSelection();
      }}
    >
      <Check className="size-3" />
    </button>
  );
  if (props.canSelect || props.deleting) return checkbox;
  return (
    <TooltipWrapper
      label="In use by an active chat or agent"
      side="top"
      sideOffset={undefined}
      align="start"
    >
      <span className="inline-flex shrink-0">{checkbox}</span>
    </TooltipWrapper>
  );
}

function WorktreeRowActions(props: {
  readonly inUse: boolean;
  readonly onManageScripts: () => void;
  readonly onDelete: () => void;
  readonly label: string;
  readonly scriptsLabel: string;
}): ReactNode {
  return (
    <div className="absolute right-5 top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity group-hover/worktree-row:opacity-100 focus-within:opacity-100">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={props.scriptsLabel}
        aria-haspopup="dialog"
        onClick={props.onManageScripts}
        className="text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <FileSliders className="size-4" />
      </Button>
      <WorktreeDeleteButton
        inUse={props.inUse}
        onDelete={props.onDelete}
        label={props.label}
      />
    </div>
  );
}

function WorktreeDeleteButton(props: {
  readonly inUse: boolean;
  readonly onDelete: () => void;
  readonly label: string;
}): ReactNode {
  if (props.inUse) {
    const button = (
      <button
        type="button"
        aria-disabled="true"
        aria-label="Delete worktree (in use by an active chat or agent)"
        className={cn(
          "inline-flex size-7 cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground/50 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <Trash2 className="size-4" />
      </button>
    );
    return (
      <TooltipWrapper
        label="In use by an active chat or agent"
        side="top"
        sideOffset={undefined}
        align="end"
      >
        {button}
      </TooltipWrapper>
    );
  }
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={props.label}
      aria-haspopup="dialog"
      onClick={props.onDelete}
      className={cn(
        "text-muted-foreground hover:bg-destructive/10 hover:text-destructive",
      )}
    >
      <Trash2 className="size-4" />
    </Button>
  );
  return button;
}

function WorktreeScriptReviewDialog(props: {
  readonly target: WorktreeHostEntry | null;
  readonly scriptSeed: RepoScriptsSeed | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts,
  ) => void;
}): ReactNode {
  const target = props.target;
  if (target === null) {
    return <Dialog open={false} onOpenChange={props.onOpenChange} />;
  }
  const onSave = props.onSave;
  return (
    <ScriptsReviewDialog
      key={target.worktreePath}
      testId="worktree-script-review-dialog"
      title="Manage setup and teardown scripts"
      description={`Edit the setup and teardown scripts for ${branchLabel(target)}.`}
      pathLabel="Worktree path"
      pathValue={target.worktreePath}
      scriptSeed={props.scriptSeed}
      seedPending={false}
      errorNote={null}
      inUseNote={
        target.inUse
          ? "This worktree is in use by an active chat or agent."
          : null
      }
      // Settings stashes the reviewed scripts synchronously for its delete flow;
      // wrap in a resolved promise so the shared dialog's success path runs.
      onSave={(scripts) => Promise.resolve(onSave(target, scripts))}
      onOpenChange={props.onOpenChange}
    />
  );
}

function WorktreesStateMessage(props: {
  readonly tone: "muted" | "error";
  readonly spinner: boolean;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <div
      className={cn(
        "flex min-h-40 flex-1 items-center justify-center gap-2 px-6 py-12 text-center text-ui-sm",
        props.tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {props.spinner ? (
        <AgentSpinningDots
          className={undefined}
          testId={undefined}
          variant={undefined}
        />
      ) : null}
      <span className="max-w-md wrap-anywhere">{props.children}</span>
    </div>
  );
}

interface WorktreeRepoGroup {
  readonly key: string;
  readonly label: string;
  readonly items: WorktreeHostEntry[];
}

type WorktreeRepoCollapseAction =
  | {
      readonly type: "collapse";
      readonly key: string;
    }
  | {
      readonly type: "expand";
      readonly key: string;
    }
  | {
      readonly type: "collapse-all";
      readonly keys: readonly string[];
    }
  | {
      readonly type: "expand-all";
    };

function collapsedRepoKeysReducer(
  state: ReadonlySet<string>,
  action: WorktreeRepoCollapseAction,
): ReadonlySet<string> {
  if (action.type === "collapse") {
    return withMemberAdded(state, action.key);
  }
  if (action.type === "expand") {
    return withMemberRemoved(state, action.key);
  }
  if (action.type === "collapse-all") {
    return action.keys.length === 0 ? EMPTY_REPO_KEY_SET : new Set(action.keys);
  }
  return state.size === 0 ? state : EMPTY_REPO_KEY_SET;
}

/**
 * Groups worktrees by repo for display, keyed on the resolved identifier when
 * present (real `owner/repo`) and otherwise on the display label (local repos
 * and orphans).
 */
function groupByRepo(
  worktrees: readonly WorktreeHostEntry[],
): WorktreeRepoGroup[] {
  const byKey = new Map<string, WorktreeRepoGroup>();
  for (const entry of worktrees) {
    const key =
      entry.repoIdentifier !== null
        ? `repo:${entry.repoIdentifier.owner}/${entry.repoIdentifier.repo}`
        : `label:${entry.repoLabel}`;
    const existing = byKey.get(key);
    if (existing !== undefined) {
      existing.items.push(entry);
    } else {
      byKey.set(key, { key, label: entry.repoLabel, items: [entry] });
    }
  }
  return [...byKey.values()];
}

function deleteDialogCopy(entry: WorktreeHostEntry): {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
} {
  const branch = branchLabel(entry);
  if (entry.uncommittedCount > 0) {
    const count = entry.uncommittedCount;
    const plural = count === 1 ? "" : "s";
    return {
      title: `Discard ${count} uncommitted change${plural}?`,
      description: `${branch} has ${count} uncommitted change${plural} that will be permanently lost. Traycer runs the repo's teardown script, then force-removes ${entry.worktreePath}.`,
      actionLabel: "Delete and discard",
    };
  }
  return {
    title: "Delete worktree?",
    description: `Traycer runs the repo's teardown script, then removes ${branch} (${entry.worktreePath}).`,
    actionLabel: "Delete worktree",
  };
}

function deleteDialogCopyForTargets(
  targets: ReadonlyArray<WorktreeHostEntry>,
): {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
} {
  if (targets.length === 1) return deleteDialogCopy(targets[0]);
  const uncommittedCount = targets.reduce(
    (total, entry) => total + entry.uncommittedCount,
    0,
  );
  if (uncommittedCount > 0) {
    const changePlural = uncommittedCount === 1 ? "" : "s";
    return {
      title: `Discard ${uncommittedCount} uncommitted change${changePlural} across ${targets.length} worktrees?`,
      description:
        "Traycer runs each repo's teardown script, then force-removes the selected worktrees. Uncommitted changes in those worktrees will be permanently lost.",
      actionLabel: "Delete and discard",
    };
  }
  return {
    title: `Delete ${targets.length} worktrees?`,
    description:
      "Traycer runs each repo's teardown script, then removes the selected worktrees.",
    actionLabel: "Delete worktrees",
  };
}

function worktreeCanBeSelected(
  entry: WorktreeHostEntry,
  deleteStatusByPath: ReadonlyMap<string, WorktreeRowDeleteStatus>,
): boolean {
  return !entry.inUse && !deleteStatusByPath.has(entry.worktreePath);
}

function worktreeRowDeleteStatus(
  run: WorktreeDeleteRunState,
): WorktreeRowDeleteStatus | null {
  if (
    run.status === "queued" ||
    run.status === "running" ||
    (run.status === "complete" && run.deleted)
  ) {
    return "deleting";
  }
  return null;
}

function removeSelectedWorktrees(
  selectedPaths: ReadonlySet<string>,
  targets: ReadonlyArray<WorktreeHostEntry>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const target of targets) {
    if (!selectedPaths.has(target.worktreePath)) continue;
    if (next === null) next = new Set(selectedPaths);
    next.delete(target.worktreePath);
  }
  return next ?? selectedPaths;
}

function worktreeSelectionCheckboxVisibility(args: {
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly canSelect: boolean;
}): string {
  if (args.selectionMode || (args.isSelected && args.canSelect)) {
    return args.canSelect ? "opacity-100" : "opacity-50";
  }
  if (args.canSelect) {
    return "opacity-0 group-hover/worktree-row:opacity-100";
  }
  return "opacity-0 group-hover/worktree-row:opacity-50 focus-visible:opacity-50";
}

function branchLabel(entry: WorktreeHostEntry): string {
  return entry.branch ?? "detached HEAD";
}

function hostOptionLabel(host: HostDirectoryEntry): string {
  const label = host.label.length > 0 ? host.label : host.hostId;
  return host.status === "unavailable" ? `${label} (offline)` : label;
}

function invalidateWorktreeDeleteCaches(
  queryClient: QueryClient,
  hostId: string,
): void {
  // `refetchType: "all"` forces inactive queries to refetch too, not just the
  // mounted ones. The binding-backed pickers (git-diff worktree picker, the
  // folder chip, the create-worktree dialog) are often unmounted when a delete
  // runs from Settings, and the app's query defaults skip refetch-on-focus
  // (and the git picker pins `staleTime: Infinity`), so a plain invalidate
  // would leave them serving the pre-delete binding until they next remounted.
  const refetchType = "all" as const;
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "worktree.listAllForHost"),
    refetchType,
  });
  for (const method of WORKTREE_BINDING_INVALIDATIONS) {
    void queryClient.invalidateQueries({
      queryKey: hostQueryKeys.methodScope(hostId, method),
      refetchType,
    });
  }
  // A deleted worktree's directory is gone, so its cached `git.getCapabilities`
  // (5-min staleTime) would otherwise keep reporting the stale `available: true`
  // and strand the git panel. Force a re-probe so the gate sees the repo is
  // gone and the panel routes selection to a healthy worktree.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "git.getCapabilities"),
  });
}
