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
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronRight,
  CopyMinus,
  CopyPlus,
  FileSliders,
  FolderGit2,
  GitMerge,
  ListFilter,
  Minus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  WorktreeHostEntry,
  WorktreeHostEntryV11,
} from "@traycer/protocol/host/index";
import {
  WORKTREE_TIER_LABEL,
  WORKTREE_TIER_ORDER,
  classifyWorktree,
  classifyWorktreeTier,
  type WorktreeTier,
} from "@/lib/worktree/classify-worktree";
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
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { CopyTextButton } from "@/components/copy-text-button";
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
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { readEpicTitlesFromCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
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
type WorktreeSortMode = "newest" | "oldest";
type WorktreeTierFilter = WorktreeTier | "all";
const WORKTREES_REFRESH_TIMEOUT_MS = 10_000;
const EMPTY_REPO_KEY_SET: ReadonlySet<string> = new Set();
const EMPTY_WORKTREES: readonly WorktreeHostEntryV11[] = [];
const EMPTY_TASK_TITLES: ReadonlyMap<string, string> = new Map();

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
  readonly filterControls: ReactNode | null;
}): ReactNode {
  const {
    canRefresh,
    filterControls,
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
    <div className="flex flex-col gap-2 border-b border-border/40 bg-muted/20 px-5 py-3">
      <div className="flex items-center justify-between gap-2">
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
      {filterControls}
    </div>
  );
}

function WorktreesFilterControls(props: {
  readonly searchText: string;
  readonly onSearchChange: (value: string) => void;
  readonly tierFilter: WorktreeTierFilter;
  readonly availableTiers: readonly WorktreeTier[];
  readonly onTierFilterChange: (filter: WorktreeTierFilter) => void;
  readonly sortMode: WorktreeSortMode;
  readonly onSortModeChange: (mode: WorktreeSortMode) => void;
}): ReactNode {
  return (
    <div className="flex items-center gap-2">
      <div className="relative min-w-0 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          type="search"
          value={props.searchText}
          onChange={(event) => props.onSearchChange(event.target.value)}
          placeholder="Search repo, branch, path, or Task"
          aria-label="Search worktrees"
          className="pl-8"
        />
      </div>
      <WorktreeFilterMenu
        tierFilter={props.tierFilter}
        availableTiers={props.availableTiers}
        onChange={props.onTierFilterChange}
      />
      <WorktreeSortMenu
        sortMode={props.sortMode}
        onSortModeChange={props.onSortModeChange}
      />
    </div>
  );
}

function worktreeTierFilterLabel(filter: WorktreeTierFilter): string {
  return filter === "all" ? "All" : WORKTREE_TIER_LABEL[filter];
}

/**
 * Standard status filter: a dropdown of "All" plus each tier actually present in
 * this host's list (zero-count tiers are not offered). Composes with the search
 * box (both apply). Tier comes from the shared classifier, so the options match
 * the row pills exactly.
 */
function WorktreeFilterMenu(props: {
  readonly tierFilter: WorktreeTierFilter;
  readonly availableTiers: readonly WorktreeTier[];
  readonly onChange: (filter: WorktreeTierFilter) => void;
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="worktrees-filter-trigger"
          aria-label={`Filter: ${worktreeTierFilterLabel(props.tierFilter)}`}
        >
          <ListFilter className="size-4" />
          <span>{worktreeTierFilterLabel(props.tierFilter)}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={props.tierFilter === "all"}
          onSelect={() => props.onChange("all")}
          data-testid="worktrees-filter-all"
        >
          All
        </DropdownMenuCheckboxItem>
        {props.availableTiers.map((tier) => (
          <DropdownMenuCheckboxItem
            key={tier}
            checked={props.tierFilter === tier}
            onSelect={() => props.onChange(tier)}
            data-testid={`worktrees-filter-${tier}`}
          >
            {WORKTREE_TIER_LABEL[tier]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const WORKTREE_SORT_LABEL: Record<WorktreeSortMode, string> = {
  newest: "Newest",
  oldest: "Oldest",
};

/**
 * Standard sort control: a small dropdown with checkmarked items. Orders rows
 * WITHIN each repo group by creation time - "Newest" (default) or "Oldest".
 */
function WorktreeSortMenu(props: {
  readonly sortMode: WorktreeSortMode;
  readonly onSortModeChange: (mode: WorktreeSortMode) => void;
}): ReactNode {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="worktrees-sort-trigger"
          aria-label={`Sort: ${WORKTREE_SORT_LABEL[props.sortMode]}`}
        >
          <ArrowDownWideNarrow className="size-4" />
          <span>{WORKTREE_SORT_LABEL[props.sortMode]}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={props.sortMode === "newest"}
          onSelect={() => props.onSortModeChange("newest")}
          data-testid="worktrees-sort-newest"
        >
          Newest
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={props.sortMode === "oldest"}
          onSelect={() => props.onSortModeChange("oldest")}
          data-testid="worktrees-sort-oldest"
        >
          Oldest
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
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
    client,
    method: "worktree.listAllForHost",
    // v1.1 with the git probes on: this is an on-demand settings surface, so the
    // per-worktree cost of the concurrent, best-effort probes is acceptable.
    // Every enriched field is null-tolerant (probes yield null on failure, and a
    // v1.0 host bridges up to empty `owners` / null timestamps).
    params: { includeActivity: true },
    options: { enabled: reachable },
  });
  // Owning-Task titles come from the cloud epic-tasks caches the app already
  // maintains (keyed by the signed-in user, any host) - no host-side title join.
  const taskTitlesByEpicId = useWorktreeTaskTitles(
    listQuery.data?.worktrees ?? EMPTY_WORKTREES,
  );
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
      // Key by host so a host swap remounts the list with fresh selection /
      // search / collapse state - a pending selection from another host is
      // never carried across. (A same-host refresh keeps the mount; the
      // selectable set is recomputed from the freshest listing every render and
      // `selectedTargets` intersects with it, so a vanished row drops out of the
      // effective selection on its own.)
      <WorktreesList
        key={hostId}
        openStreamTransport={openStreamTransport}
        hostId={hostId}
        worktrees={listQuery.data.worktrees}
        taskTitlesByEpicId={taskTitlesByEpicId}
        toolbarProps={toolbarProps}
      />
    );
  }

  const showStandaloneToolbar = hosts.length > 0 && !listOwnsToolbar;

  return (
    <div className="flex flex-col">
      {showStandaloneToolbar ? (
        <WorktreesToolbar
          {...toolbarProps}
          selectionControls={null}
          filterControls={null}
        />
      ) : null}
      {content}
    </div>
  );
}

/**
 * Resolves each owner `epicId` on the listing to its Task title by reading the
 * cloud epic-tasks caches the app already maintains for the signed-in user
 * (`readEpicTitlesFromCloudTaskCaches`). We warm those caches with the shared
 * first-page query - the same one History/home use, so the cache is reused, not
 * duplicated - and read titles back for the epics this host's worktrees own.
 *
 * Scope is `hostId: null` so an epic cached under any host (epics are
 * user-scoped, not host-scoped) still resolves. An `epicId` with no cached Task
 * (unknown / deleted / not yet loaded) is simply absent from the map, which the
 * chip renderer degrades gracefully.
 */
function useWorktreeTaskTitles(
  worktrees: readonly WorktreeHostEntryV11[],
): ReadonlyMap<string, string> {
  const queryClient = useQueryClient();
  const epicIds = useMemo(
    () => [
      ...new Set(
        worktrees.flatMap((entry) => entry.owners.map((owner) => owner.epicId)),
      ),
    ],
    [worktrees],
  );
  // Only warm the shared cloud-tasks cache when something actually needs a title.
  const cloud = useCloudEpicTasksQuery(undefined, {
    enabled: epicIds.length > 0,
  });
  const userId = cloud.currentUserId;
  const cloudTasks = cloud.tasks;
  return useMemo(() => {
    if (userId === null || epicIds.length === 0) return EMPTY_TASK_TITLES;
    // `cloudTasks` is a recompute trigger: the read scans the query cache
    // directly, so we re-derive whenever a fetched page changes it.
    void cloudTasks;
    return new Map(
      Object.entries(
        readEpicTitlesFromCloudTaskCaches(
          queryClient,
          { hostId: null, userId },
          epicIds,
        ),
      ),
    );
  }, [queryClient, userId, epicIds, cloudTasks]);
}

// List renders many per-worktree states (loading / empty / error / per-row
// actions); branches are independent, not reducible nesting.
// eslint-disable-next-line complexity
export function WorktreesList(props: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  readonly worktrees: readonly WorktreeHostEntryV11[];
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
  readonly toolbarProps: {
    readonly hosts: readonly HostDirectoryEntry[];
    readonly value: string | null;
    readonly onChange: (hostId: string) => void;
    readonly onRefresh: () => Promise<unknown>;
    readonly refreshing: boolean;
    readonly canRefresh: boolean;
  };
}): ReactNode {
  const { hostId, worktrees, taskTitlesByEpicId, openStreamTransport } = props;
  const queryClient = useQueryClient();
  const [searchText, setSearchText] = useState("");
  const [sortMode, setSortMode] = useState<WorktreeSortMode>("newest");
  const [tierFilter, setTierFilter] = useState<WorktreeTierFilter>("all");
  // The status filter composes with the search box (both apply) before repo
  // grouping. Tier comes from the shared classifier, so the filter options
  // exactly match the row pills.
  const filteredWorktrees = useMemo(
    () =>
      filterWorktrees(worktrees, searchText, taskTitlesByEpicId).filter(
        (entry) =>
          tierFilter === "all" || classifyWorktreeTier(entry) === tierFilter,
      ),
    [worktrees, searchText, taskTitlesByEpicId, tierFilter],
  );
  // Only offer filter options for tiers actually present in this host's list.
  const availableTiers = useMemo(() => {
    const present = new Set(
      worktrees.map((entry) => classifyWorktreeTier(entry)),
    );
    return WORKTREE_TIER_ORDER.filter((tier) => present.has(tier));
  }, [worktrees]);

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
  const [pendingDeleteTargets, setPendingDeleteTargets] =
    useState<ReadonlyArray<WorktreeHostEntryV11> | null>(null);
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

  const groups = useMemo(
    () => groupByRepo(filteredWorktrees, sortMode),
    [filteredWorktrees, sortMode],
  );
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
  // Freshest listing keyed by path, so a pending delete captured at dialog-open
  // is always re-resolved to its CURRENT entry (a background refresh may have
  // made a row in-use / mid-delete since the dialog opened).
  const worktreesByPath = useMemo(
    () => new Map(worktrees.map((entry) => [entry.worktreePath, entry])),
    [worktrees],
  );
  // Re-resolve the pending targets against the freshest listing and split into
  // the rows still eligible to delete vs. the ones dropped (gone from the list,
  // or now in-use / mid-delete). All selection is user-driven now, so the only
  // confirm-time gate is "still selectable"; a hand-picked dirty / ahead row
  // proceeds with its FRESHEST loss copy (per-row opt-in is intentional). Both
  // the dialog copy and the confirm action read from this, so what the user sees
  // is what gets deleted.
  const pendingResolution = useMemo(() => {
    if (pendingDeleteTargets === null) return null;
    const kept: WorktreeHostEntryV11[] = [];
    const dropped: WorktreeHostEntryV11[] = [];
    for (const captured of pendingDeleteTargets) {
      const fresh = worktreesByPath.get(captured.worktreePath) ?? null;
      if (fresh === null) {
        dropped.push(captured);
        continue;
      }
      if (selectablePathSet.has(fresh.worktreePath)) kept.push(fresh);
      else dropped.push(fresh);
    }
    return { kept, dropped };
  }, [pendingDeleteTargets, selectablePathSet, worktreesByPath]);
  const keptDeleteTargets = pendingResolution?.kept ?? null;
  const singleDialogCopy =
    keptDeleteTargets !== null && keptDeleteTargets.length === 1
      ? deleteDialogCopy(keptDeleteTargets[0])
      : null;
  const bulkDeleteSummary =
    keptDeleteTargets !== null && keptDeleteTargets.length > 1
      ? summarizeBulkWorktreeDelete(keptDeleteTargets, visibleWorktrees)
      : null;
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
    },
    [selectablePathSet],
  );
  // Standard global tri-state select-all: acts on the CURRENTLY-VISIBLE,
  // selectable rows (post-filter + post-search, across all repo groups). When
  // every visible selectable row is already selected it deselects them;
  // otherwise it selects them all. Hidden (filtered-out) selections are left
  // untouched - the header + count reflect visible rows, and the confirm-time
  // re-resolution + honest dialog still govern what is deleted.
  const allVisibleSelected =
    selectableWorktreePaths.length > 0 &&
    selectedCount === selectableWorktreePaths.length;
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const path of selectableWorktreePaths) next.delete(path);
      } else {
        for (const path of selectableWorktreePaths) next.add(path);
      }
      return next;
    });
  }, [allVisibleSelected, selectableWorktreePaths]);
  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
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
    (targets: ReadonlyArray<WorktreeHostEntryV11>) => {
      const deletableTargets = targets.filter((entry) =>
        selectablePathSet.has(entry.worktreePath),
      );
      if (deletableTargets.length === 0) return;
      setPendingDeleteTargets(deletableTargets);
    },
    [selectablePathSet],
  );

  const clearSelectionForTargets = (
    targets: ReadonlyArray<WorktreeHostEntryV11>,
  ): void => {
    setSelectedPaths((prev) => removeSelectedWorktrees(prev, targets));
    setPendingDeleteTargets(null);
  };

  const handleConfirm = (): void => {
    if (pendingResolution === null || pendingDeleteTargets === null) return;
    // `pendingResolution` already re-resolved each pending path to its freshest
    // entry and split kept vs. dropped (gone from the list, or now in-use /
    // mid-delete). Start the run on the FRESHEST kept entries, and name the drops.
    const { kept, dropped } = pendingResolution;
    if (dropped.length > 0) {
      toast.message(worktreeDropMessage(dropped));
    }
    if (kept.length === 1) {
      start(kept[0], reviewedScriptsByPath.get(kept[0].worktreePath) ?? null);
    } else if (kept.length > 1) {
      startBatchBackgrounded(kept, reviewedScriptsByPath);
    }
    // Prune the ENTIRE confirmed cohort - kept AND dropped - from the selection
    // bookkeeping (even in the all-dropped case), so a dropped row can't linger
    // as stale selected state / counts when selection mode is re-entered.
    clearSelectionForTargets(pendingDeleteTargets);
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
          <WorktreesRepoExpansionControl
            allCollapsed={allReposCollapsed}
            onToggle={toggleAllReposCollapsed}
          />
        }
        filterControls={
          <WorktreesFilterControls
            searchText={searchText}
            onSearchChange={setSearchText}
            tierFilter={tierFilter}
            availableTiers={availableTiers}
            onTierFilterChange={setTierFilter}
            sortMode={sortMode}
            onSortModeChange={setSortMode}
          />
        }
      />
      <WorktreeSelectionActionBar
        selectedCount={selectedCount}
        onDelete={() => {
          requestDeleteTargets(selectedTargets);
        }}
        onClear={clearSelection}
      />
      <WorktreeDeleteProgressStrip
        summary={progressSummary}
        onDismiss={dismissTerminalBackgrounded}
      />

      {groups.length === 0 ? (
        <WorktreesStateMessage tone="muted" spinner={false}>
          No worktrees match your search.
        </WorktreesStateMessage>
      ) : (
        <WorktreeSelectAllHeader
          selectableCount={selectableWorktreePaths.length}
          selectedCount={selectedCount}
          onToggle={toggleSelectAllVisible}
        />
      )}

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
                      taskTitlesByEpicId={taskTitlesByEpicId}
                      deleteStatus={deleteStatus}
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
        open={singleDialogCopy !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTargets(null);
        }}
        title={singleDialogCopy?.title ?? ""}
        description={singleDialogCopy?.description ?? ""}
        cascadeSummary={null}
        actionLabel={singleDialogCopy?.actionLabel ?? "Delete"}
        isPending={false}
        onConfirm={handleConfirm}
      />
      <WorktreeBulkDeleteDialog
        summary={bulkDeleteSummary}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteTargets(null);
        }}
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

/**
 * Standard tri-state global select-all header - one row above the list, its
 * checkbox aligned with the row checkboxes. Selects/deselects every CURRENTLY-
 * VISIBLE, selectable row (post-filter + post-search, across all repo groups).
 * Indeterminate when some-but-not-all are selected; disabled when nothing
 * selectable. In-use / mid-delete rows keep disabled row checkboxes and are
 * excluded here (standard table behavior).
 */
function WorktreeSelectAllHeader(props: {
  readonly selectableCount: number;
  readonly selectedCount: number;
  readonly onToggle: () => void;
}): ReactNode {
  const allSelected =
    props.selectableCount > 0 && props.selectedCount === props.selectableCount;
  const indeterminate =
    props.selectedCount > 0 && props.selectedCount < props.selectableCount;
  const ariaChecked = worktreeSelectAllAriaChecked(allSelected, indeterminate);
  let indicator: ReactNode = null;
  if (allSelected) indicator = <Check className="size-3" />;
  else if (indeterminate) indicator = <Minus className="size-3" />;
  return (
    <div className="flex items-center gap-3 border-b border-border/40 bg-muted/10 px-5 py-1.5">
      <div className="flex w-5 shrink-0 items-center justify-center">
        <button
          type="button"
          role="checkbox"
          aria-checked={ariaChecked}
          aria-label="Select all worktrees"
          data-testid="worktrees-select-all"
          disabled={props.selectableCount === 0}
          onClick={props.onToggle}
          className={cn(
            "flex size-4 items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-40",
            allSelected || indeterminate
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background text-transparent hover:border-foreground",
          )}
        >
          {indicator}
        </button>
      </div>
      <span className="text-ui-xs text-muted-foreground">Select all</span>
    </div>
  );
}

function worktreeSelectAllAriaChecked(
  allSelected: boolean,
  indeterminate: boolean,
): "true" | "mixed" | "false" {
  if (allSelected) return "true";
  if (indeterminate) return "mixed";
  return "false";
}

/**
 * Contextual action bar - present ONLY while a selection is active (empty =
 * absent, so the page has no permanent selection chrome). Shows the count, a
 * destructive "Delete N…" primary action, and a "Clear".
 */
function WorktreeSelectionActionBar(props: {
  readonly selectedCount: number;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}): ReactNode {
  if (props.selectedCount === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-3 border-b border-border/40 bg-muted/20 px-5 py-2"
      data-testid="worktrees-selection-action-bar"
    >
      <span className="text-ui-sm font-medium text-foreground">
        {props.selectedCount} selected
      </span>
      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={props.onClear}
          data-testid="worktrees-clear-selection-inline"
        >
          <X className="size-4" />
          Clear
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={props.onDelete}
          aria-label={`Delete ${props.selectedCount} selected worktrees`}
          data-testid="worktrees-list-delete-selected"
        >
          <Trash2 className="size-4" />
          Delete {props.selectedCount}…
        </Button>
      </div>
    </div>
  );
}

/**
 * Bulk-delete confirmation: aggregate-by-class summary, dirty loss naming, a
 * neutral caveat for the unverified cohort, named exclusions, and the full
 * (path-addressed) target list. Reuses the shared confirm button test ids so
 * the flow stays interchangeable with the single-target dialog.
 */
function WorktreeBulkDeleteDialog(props: {
  readonly summary: WorktreeBulkDeleteSummary | null;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const summary = props.summary;
  return (
    <Dialog open={summary !== null} onOpenChange={props.onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[min(92vw,32rem)] gap-0 overflow-hidden p-0 sm:max-w-lg"
        data-testid="worktree-bulk-delete-dialog"
      >
        {summary !== null ? (
          <>
            <div className="flex min-w-0 items-start gap-3 p-5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-destructive/10 text-destructive">
                <AlertTriangle className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1 space-y-2">
                <DialogTitle className="text-ui font-semibold leading-snug wrap-anywhere">
                  {summary.title}
                </DialogTitle>
                <DialogDescription className="text-ui-sm leading-relaxed text-muted-foreground wrap-anywhere">
                  Deleting {summary.classSummary}. Traycer runs each repo's
                  teardown script, then removes the worktree.
                </DialogDescription>
                {summary.dirtyLoss !== null ? (
                  <p
                    className="text-ui-sm leading-relaxed text-amber-700 dark:text-amber-400"
                    data-testid="worktree-bulk-delete-dirty-loss"
                  >
                    {summary.dirtyLoss}
                  </p>
                ) : null}
                {summary.unverifiedCaveat !== null ? (
                  <p
                    className="text-ui-sm leading-relaxed text-muted-foreground"
                    data-testid="worktree-bulk-delete-caveat"
                  >
                    {summary.unverifiedCaveat}
                  </p>
                ) : null}
                {summary.exclusions !== null ? (
                  <p className="text-ui-xs text-muted-foreground">
                    {summary.exclusions}
                  </p>
                ) : null}
              </div>
            </div>
            <ul className="max-h-[min(30vh,12rem)] overflow-y-auto border-t border-border/60 px-5 py-2">
              {summary.paths.map((path) => (
                <li
                  key={path}
                  className="truncate py-0.5 text-ui-xs text-muted-foreground"
                  title={path}
                >
                  {path}
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t border-border/60 bg-muted/20 px-5 py-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.onOpenChange(false)}
                data-testid="confirm-cancel"
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={props.onConfirm}
                data-testid="confirm-action"
              >
                {summary.actionLabel}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
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
  readonly entry: WorktreeHostEntryV11;
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
  readonly deleteStatus: WorktreeRowDeleteStatus | null;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly onToggleSelection: () => void;
  readonly onManageScripts: () => void;
  readonly onDelete: () => void;
}): ReactNode {
  const {
    entry,
    taskTitlesByEpicId,
    deleteStatus,
    selected,
    canSelect,
    onToggleSelection,
    onManageScripts,
    onDelete,
  } = props;
  const deleting = deleteStatus !== null;
  const selectedForDelete = selected && canSelect;
  const classification = classifyWorktree(entry);
  return (
    <div
      aria-busy={deleting}
      data-testid="worktree-row"
      className={cn(
        "group/worktree-row relative flex items-center gap-3 px-5 py-3 transition-colors",
        deleting ? "pointer-events-none opacity-50" : "hover:bg-accent/30",
        selectedForDelete && "bg-accent/40 ring-1 ring-inset ring-primary/40",
      )}
    >
      <div className="flex w-5 shrink-0 items-center justify-center">
        <WorktreeSelectionControl
          entry={entry}
          selected={selected}
          canSelect={canSelect}
          deleting={deleting}
          onToggleSelection={onToggleSelection}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1 pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <WorktreeTierPill tier={classification.tier} />
          <span className="truncate text-ui-sm font-medium text-foreground">
            {branchLabel(entry)}
          </span>
        </div>
        <WorktreeSecondaryFacts
          facts={classification.facts}
          lastActivityAt={entry.lastActivityAt}
        />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <WorktreeTaskAssociation
            owners={entry.owners}
            taskTitlesByEpicId={taskTitlesByEpicId}
          />
          <WorktreePathAffordance
            worktreePath={entry.worktreePath}
            disabled={deleting}
          />
        </div>
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
      {!deleting ? (
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

/**
 * Evidence-tier pill. Leads every row with a TEXT label (never color-only, for
 * accessibility). Green is reserved for the proven `merged` tier; `unreferenced`
 * is a quieter green; `review` is amber; `orphaned` and `in-use` stay neutral.
 */
function WorktreeTierPill(props: { readonly tier: WorktreeTier }): ReactNode {
  const style = WORKTREE_TIER_PILL_STYLE[props.tier];
  return (
    <Badge
      variant="outline"
      className={cn("gap-1 font-medium", style.className)}
      data-testid="worktree-tier-pill"
      data-tier={props.tier}
    >
      {props.tier === "merged" ? (
        <GitMerge className="size-3" aria-hidden />
      ) : null}
      {WORKTREE_TIER_LABEL[props.tier]}
    </Badge>
  );
}

const WORKTREE_TIER_PILL_STYLE: Record<
  WorktreeTier,
  { readonly className: string }
> = {
  merged: {
    className:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300",
  },
  unreferenced: {
    className:
      "border-emerald-600/20 bg-emerald-500/5 text-emerald-700/80 dark:border-emerald-400/20 dark:text-emerald-300/70",
  },
  review: {
    className:
      "border-amber-600/30 bg-amber-500/10 text-amber-700 dark:border-amber-400/30 dark:text-amber-300",
  },
  orphaned: {
    className: "text-muted-foreground",
  },
  "in-use": {
    className: "bg-muted text-muted-foreground",
  },
};

/**
 * One relevance-gated secondary line: the classifier's evidence facts joined,
 * with the "last active" relative time appended. Renders nothing when there is
 * neither a fact nor a timestamp (silence reads as quiet/clean).
 */
function WorktreeSecondaryFacts(props: {
  readonly facts: readonly string[];
  readonly lastActivityAt: number | null;
}): ReactNode {
  const hasFacts = props.facts.length > 0;
  if (!hasFacts && props.lastActivityAt === null) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-ui-xs text-muted-foreground">
      {hasFacts ? <span>{props.facts.join(" · ")}</span> : null}
      {hasFacts && props.lastActivityAt !== null ? (
        <span aria-hidden>·</span>
      ) : null}
      {props.lastActivityAt !== null ? (
        <WorktreeLastActiveLabel lastActivityAt={props.lastActivityAt} />
      ) : null}
    </p>
  );
}

/**
 * The full worktree path leaves the scan line (it is long and low-signal) but
 * stays one hover/click away: a copy-path affordance whose tooltip is the full
 * path. Confirmation dialogs still list full paths - delete is path-addressed.
 */
function WorktreePathAffordance(props: {
  readonly worktreePath: string;
  readonly disabled: boolean;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.worktreePath}
      side="top"
      sideOffset={undefined}
      align="start"
    >
      <span className="inline-flex shrink-0">
        <CopyTextButton
          value={props.worktreePath}
          label={null}
          ariaLabel={`Copy path ${props.worktreePath}`}
          disabled={props.disabled}
        />
      </span>
    </TooltipWrapper>
  );
}

/**
 * Task association resolved from `owners[].epicId`. Owners in the same epic
 * collapse to one entry. An epic with a resolved title renders a chip; an epic
 * whose title is unknown (deleted / not cached / other user) is DEMOTED to muted
 * "Owner unresolved" text rather than a prominent chip - but it is still a
 * reference, so the classifier keeps such a row out of the green tiers. No owners
 * at all means nothing in Traycer references this worktree - deliberately NOT the
 * "Orphaned" tier, which means `gitRemovable: false`.
 */
function WorktreeTaskAssociation(props: {
  readonly owners: WorktreeHostEntryV11["owners"];
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
}): ReactNode {
  const epicIds = [...new Set(props.owners.map((owner) => owner.epicId))];
  if (epicIds.length === 0) {
    return (
      <span className="text-ui-xs text-muted-foreground">
        Not used by any Task
      </span>
    );
  }
  const resolved = epicIds.map((epicId) => ({
    epicId,
    title: props.taskTitlesByEpicId.get(epicId) ?? null,
  }));
  const named = resolved.filter(
    (item): item is { epicId: string; title: string } => item.title !== null,
  );
  const unresolvedCount = resolved.length - named.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {named.map((item) => (
        <Badge
          key={item.epicId}
          variant="outline"
          className="max-w-[min(60vw,16rem)] font-normal"
          title={item.title}
        >
          <span className="truncate">{item.title}</span>
        </Badge>
      ))}
      {unresolvedCount > 0 ? (
        <span className="text-ui-xs text-muted-foreground/70">
          Owner unresolved
        </span>
      ) : null}
    </span>
  );
}

/**
 * "Last active" label from the derived v1.1 `lastActivityAt`. Rendered inline in
 * the secondary facts line only when a timestamp is present.
 */
function WorktreeLastActiveLabel(props: {
  readonly lastActivityAt: number;
}): ReactNode {
  const relative = useRelativeTimestamp(props.lastActivityAt);
  return (
    <span className="text-ui-xs text-muted-foreground">
      Last active {relative}
    </span>
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

function WorktreeSelectionControl(props: {
  readonly entry: WorktreeHostEntry;
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
  readonly items: WorktreeHostEntryV11[];
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
 * and orphans). Rows WITHIN each repo group are ordered by creation time -
 * "Newest" (default, most recently created first) or "Oldest". A `null`
 * `createdAt` sorts last in both directions.
 */
function groupByRepo(
  worktrees: readonly WorktreeHostEntryV11[],
  sortMode: WorktreeSortMode,
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
  const groups = [...byKey.values()];
  for (const group of groups) {
    group.items.sort((a, b) => compareByCreatedAt(a, b, sortMode));
  }
  return groups;
}

function compareByCreatedAt(
  a: WorktreeHostEntryV11,
  b: WorktreeHostEntryV11,
  sortMode: WorktreeSortMode,
): number {
  const aAt = a.createdAt;
  const bAt = b.createdAt;
  if (aAt === bAt) return 0;
  // A missing creation time sorts last in both directions.
  if (aAt === null) return 1;
  if (bAt === null) return -1;
  return sortMode === "newest" ? bAt - aAt : aAt - bAt;
}

/**
 * Client-side text filter over the four fields the tab searches: repo label,
 * branch, worktree path, and each owning Task's resolved title. Whitespace-only
 * queries pass everything through. Pure renderer work - the full list is already
 * in memory.
 */
function filterWorktrees(
  worktrees: readonly WorktreeHostEntryV11[],
  searchText: string,
  taskTitlesByEpicId: ReadonlyMap<string, string>,
): readonly WorktreeHostEntryV11[] {
  const needle = searchText.trim().toLowerCase();
  if (needle.length === 0) return worktrees;
  return worktrees.filter((entry) =>
    worktreeSearchHaystack(entry, taskTitlesByEpicId).includes(needle),
  );
}

function worktreeSearchHaystack(
  entry: WorktreeHostEntryV11,
  taskTitlesByEpicId: ReadonlyMap<string, string>,
): string {
  const titles = entry.owners.flatMap((owner) => {
    const title = taskTitlesByEpicId.get(owner.epicId);
    return title === undefined ? [] : [title];
  });
  return [entry.repoLabel, entry.branch ?? "", entry.worktreePath, ...titles]
    .join("\n")
    .toLowerCase();
}

function deleteDialogCopy(entry: WorktreeHostEntryV11): {
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
  const status = entry.branchStatus;
  if (
    status !== null &&
    status.ahead !== null &&
    status.ahead > 0 &&
    !status.mergedIntoDefault
  ) {
    const count = status.ahead;
    const plural = count === 1 ? "" : "s";
    return {
      title: `Delete worktree with ${count} unpushed commit${plural}?`,
      description: `${branch} has ${count} commit${plural} not on the default branch. Removing the worktree keeps the branch ref, but that work exists only here. Traycer runs the repo's teardown script, then removes ${entry.worktreePath}.`,
      actionLabel: "Delete worktree",
    };
  }
  // Never-pushed and not contained in the default branch (no upstream, so the
  // commit count is unknown). Removing the worktree keeps the branch ref — the
  // commits survive on the branch — but they were never pushed anywhere, so
  // this machine is the only copy. Honest, not overstated as unrecoverable.
  if (status !== null && status.ahead === null && !status.mergedIntoDefault) {
    return {
      title: "Delete worktree with unpushed local commits?",
      description: `${branch} has local-only commits not on the default branch and was never pushed. Removing the worktree keeps the branch ref, so the commits survive on the branch — but this machine is their only copy. Traycer runs the repo's teardown script, then removes ${entry.worktreePath}.`,
      actionLabel: "Delete worktree",
    };
  }
  return {
    title: "Delete worktree?",
    description: `Traycer runs the repo's teardown script, then removes ${branch} (${entry.worktreePath}).`,
    actionLabel: "Delete worktree",
  };
}

/**
 * Toast copy when confirm-time re-check drops rows that stopped qualifying,
 * class-summarized to stay consistent with the confirmation's exclusion line.
 */
function worktreeDropMessage(dropped: readonly WorktreeHostEntryV11[]): string {
  const summary = countWorktreeClasses(dropped, WORKTREE_EXCLUSION_ORDER);
  const plural = dropped.length === 1 ? "" : "s";
  const verb = dropped.length === 1 ? "was" : "were";
  return `${dropped.length} worktree${plural} became ineligible and ${verb} skipped: ${summary}.`;
}

interface WorktreeBulkDeleteSummary {
  readonly count: number;
  readonly title: string;
  readonly actionLabel: string;
  readonly classSummary: string;
  readonly dirtyLoss: string | null;
  readonly unverifiedCaveat: string | null;
  readonly exclusions: string | null;
  readonly paths: readonly string[];
}

// Buckets a worktree into exactly one delete class, cautionary signals first so
// a would-be-lost row is never mislabeled as a proven-clean one.
type WorktreeDeleteClass =
  | "merged"
  | "clean"
  | "unverified"
  | "unmerged"
  | "detached"
  | "orphaned"
  | "dirty";

function worktreeDeleteClass(entry: WorktreeHostEntryV11): WorktreeDeleteClass {
  const status = entry.branchStatus;
  const merged = status !== null && status.mergedIntoDefault;
  if (entry.uncommittedCount > 0) return "dirty";
  if (entry.branch === null) return "detached";
  // Not merged and not proven at the upstream tip: real local-only commits
  // (`ahead > 0`) OR a never-pushed branch with no upstream to prove them absent
  // (`ahead === null`). Both are would-be-lost; only the PROVEN `ahead === 0`
  // below is "clean". This keeps the never-pushed-diverged cohort out of the
  // "unverified/unreferenced" bucket, matching its Review tier.
  if (
    status !== null &&
    !merged &&
    (status.ahead === null || status.ahead > 0)
  ) {
    return "unmerged";
  }
  if (!entry.gitRemovable) return "orphaned";
  if (merged) return "merged";
  if (status !== null && status.ahead === 0) return "clean";
  return "unverified";
}

const WORKTREE_DELETE_CLASS_LABEL: Record<WorktreeDeleteClass, string> = {
  merged: "merged",
  clean: "clean (no local-only commits)",
  unverified: "unreferenced (branch status unverified)",
  unmerged: "unmerged (local-only commits)",
  detached: "detached HEAD",
  orphaned: "orphaned",
  dirty: "dirty",
};

// Safe-to-risky for the "Deleting" summary; risky-to-safe for the "not selected"
// exclusion line (name the reasons a row was left out first).
const WORKTREE_DELETE_SUMMARY_ORDER: readonly WorktreeDeleteClass[] = [
  "merged",
  "clean",
  "unverified",
  "unmerged",
  "detached",
  "orphaned",
  "dirty",
];
const WORKTREE_EXCLUSION_ORDER: readonly WorktreeDeleteClass[] = [
  "dirty",
  "unmerged",
  "detached",
  "orphaned",
  "unverified",
  "clean",
  "merged",
];

function countWorktreeClasses(
  entries: readonly WorktreeHostEntryV11[],
  order: readonly WorktreeDeleteClass[],
): string {
  const counts = new Map<WorktreeDeleteClass, number>();
  for (const entry of entries) {
    const key = worktreeDeleteClass(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order
    .flatMap((key) => {
      const count = counts.get(key);
      return count === undefined || count === 0
        ? []
        : [`${count} ${WORKTREE_DELETE_CLASS_LABEL[key]}`];
    })
    .join(", ");
}

/**
 * Confirmation copy for a multi-worktree delete. Aggregates the SELECTED targets
 * by class (never 38 stacked warnings), names concrete loss for dirty rows, and
 * — for the null-status cohort — uses deliberately NEUTRAL caveat wording (never
 * "safe" / "loss-free"). Also names what was left out of the selection so the
 * exclusion is transparent. Full paths are carried for the expandable list;
 * delete is path-addressed.
 */
function summarizeBulkWorktreeDelete(
  targets: ReadonlyArray<WorktreeHostEntryV11>,
  visible: readonly WorktreeHostEntryV11[],
): WorktreeBulkDeleteSummary {
  const targetPaths = new Set(targets.map((entry) => entry.worktreePath));
  const dirtyTargets = targets.filter((entry) => entry.uncommittedCount > 0);
  const uncommittedTotal = dirtyTargets.reduce(
    (total, entry) => total + entry.uncommittedCount,
    0,
  );
  const hasUnverified = targets.some(
    (entry) => worktreeDeleteClass(entry) === "unverified",
  );
  const dirtyLoss =
    dirtyTargets.length === 0
      ? null
      : `Uncommitted changes in ${dirtyTargets.length} worktree${
          dirtyTargets.length === 1 ? "" : "s"
        } (${uncommittedTotal} change${
          uncommittedTotal === 1 ? "" : "s"
        }) will be permanently lost.`;
  const unverifiedCaveat = hasUnverified
    ? "For the worktrees with unverified branch status: branch status was unavailable, the branch refs are expected to remain, and unpushed work is not proven. Commit, stash, or push anything you want to keep first."
    : null;
  const excluded = visible.filter(
    (entry) => !entry.inUse && !targetPaths.has(entry.worktreePath),
  );
  const exclusionSummary =
    excluded.length === 0
      ? null
      : countWorktreeClasses(excluded, WORKTREE_EXCLUSION_ORDER);
  return {
    count: targets.length,
    title: `Delete ${targets.length} worktrees?`,
    actionLabel:
      dirtyTargets.length > 0 ? "Delete and discard" : "Delete worktrees",
    classSummary: countWorktreeClasses(targets, WORKTREE_DELETE_SUMMARY_ORDER),
    dirtyLoss,
    unverifiedCaveat,
    exclusions:
      exclusionSummary === null
        ? null
        : `${excluded.length} not selected: ${exclusionSummary}`,
    paths: targets.map((entry) => entry.worktreePath),
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

// Checkboxes are ALWAYS rendered (no selection mode) - subtle by default, full
// once the row is hovered/focused or the box is checked. Standard list pattern.
function worktreeSelectionCheckboxVisibility(args: {
  readonly isSelected: boolean;
  readonly canSelect: boolean;
}): string {
  if (args.isSelected && args.canSelect) return "opacity-100";
  if (args.canSelect) {
    return "opacity-40 group-hover/worktree-row:opacity-100 focus-visible:opacity-100";
  }
  return "opacity-40 group-hover/worktree-row:opacity-70 focus-visible:opacity-70";
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
