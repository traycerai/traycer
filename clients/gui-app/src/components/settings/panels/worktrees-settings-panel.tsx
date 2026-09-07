import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode,
  type RefCallback,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CopyMinus,
  CopyPlus,
  ExternalLink,
  FileSliders,
  FolderGit2,
  GitCommitHorizontal,
  GitMerge,
  HelpCircle,
  ListFilter,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import type {
  WorktreeHostEntry,
  WorktreeHostEntryV14,
} from "@traycer/protocol/host/index";
import type {
  WorktreeEntryScripts,
  WorktreePrState,
  WorktreeSubmoduleMergeFactV12,
} from "@traycer/protocol/host/worktree-schemas";
import {
  WORKTREE_TIER_LABEL,
  WORKTREE_TIER_ORDER,
  WORKTREE_TIER_TOOLTIP,
  classifyWorktree,
  classifyWorktreeTier,
  describeReviewReasons,
  provenRemovable,
  type WorktreeTier,
} from "@traycer-clients/shared/worktree/classify-worktree";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  buildTaskMergeRollups,
  taskMergeRollupEqual,
  taskMergeRollupLabel,
  type TaskMergeRollup,
} from "@/lib/worktree/task-merge-rollup";
import { cn } from "@/lib/utils";
import {
  withMemberAdded,
  withMemberRemoved,
  withMemberToggled,
} from "@/lib/immutable-set";
import { type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { useSettingsDensity } from "@/providers/settings-density-context";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SelectAllToggle } from "@/components/ui/select-all-toggle";
import { ConfirmDestructiveDialog } from "@/components/ui/confirm-destructive-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { ScriptsReviewDialog } from "@/components/workspaces/scripts-review-dialog";
import { TeardownForceDeleteDialog } from "@/components/worktree/teardown-force-delete-dialog";
import { type RepoScriptsSeed } from "@/components/workspaces/repo-scripts-form";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import { HostScopeGate } from "@/components/settings/host-scope/host-scope-gate";
import { isHostScopeUsable } from "@/components/settings/host-scope/host-scope-status";
import {
  useHostScope,
  type HostScope,
} from "@/components/settings/host-scope/use-host-scope";
import { useClipboardCopy } from "@/hooks/ui/use-clipboard-copy";
import { useWorktreeDeleteStreamTransportFactory } from "@/lib/host/use-worktree-delete-stream-transport";
import type { DurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { useRelativeTimestamp } from "@/lib/relative-time";
import { useWorktreeTaskTitles } from "./use-worktree-task-titles";
import { invalidateWorktreeListingAndBindingCaches } from "@/hooks/worktree/invalidations";
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
import { WorktreeListRenderProfiler } from "@/components/settings/panels/worktree-list-render-profiler";
import { useWorktreeActivityEnrichment } from "@/components/settings/panels/worktrees-enrichment";
import { useWorktreeListing } from "@/components/settings/panels/worktrees-listing-query";
import {
  navigateToTabIntent,
  openOrFocusEpicIntent,
} from "@/lib/tab-navigation";
import { useOpenLink } from "@/lib/links/open-link";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  useWorktreesSettingsViewStore,
  type WorktreeSortMode,
} from "@/stores/settings/worktrees-settings-view-store";
import {
  EMPTY_SELECTED_WORKTREE_PATHS,
  useWorktreesSettingsSelectionStore,
  type SelectedWorktreePathsUpdate,
} from "@/stores/settings/worktrees-settings-selection-store";
import { onMiddleClick } from "@/lib/dom/on-middle-click";

type WorktreeRowDeleteStatus = "deleting";
// Per-row activity-enrichment state, driving only the tier pill's presentation.
type WorktreeEnrichmentState = "ready" | "pending" | "unknown" | "unavailable";
// Multi-select status filter. An empty set means "no filter" (show every tier); a non-empty set shows only the
// selected tiers (union). Composes with search.
type WorktreeTierFilterSet = ReadonlySet<WorktreeTier>;

const STALE_CLASSIFICATION_ENTRY_CACHE = new WeakMap<
  WorktreeHostEntryV14,
  WeakMap<WorktreeHostEntryV14, WorktreeHostEntryV14>
>();
const WORKTREES_REFRESH_TIMEOUT_MS = 10_000;
const EMPTY_REPO_KEY_SET: ReadonlySet<string> = new Set();

// Row/header heights are estimates only - each rendered item is measured (`virtualizer.measureElement`) so
// variable-height rows (a wrapping Task-chip line, an optional facts line) still position correctly.
const WORKTREE_ROW_ESTIMATE_PX = 88;
const WORKTREE_REPO_HEADER_ESTIMATE_PX = 40;
const WORKTREE_VIRTUAL_OVERSCAN = 8;

// `GAP_PX` covers the bar's own `bottom-4` offset plus breathing room above it; `MIN_PX` matches the bar's
// normal single-line height and only seeds the very first frame.
const WORKTREE_ACTION_BAR_GAP_PX = 32;
const WORKTREE_ACTION_BAR_MIN_CLEARANCE_PX = 64;

/** Mirrors the `useComposerNarrowObserver` pattern in `src/components/home/composer/composer-narrow-hooks.ts`;
 * kept local here because nothing else in the app needs it yet. */
function useObservedHeight(): {
  readonly ref: RefCallback<HTMLDivElement>;
  readonly height: number;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const ref = useCallback((nextElement: HTMLDivElement | null) => {
    setElement(nextElement);
  }, []);
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (element === null) return () => {};
      const observer = new ResizeObserver(onStoreChange);
      observer.observe(element);
      return () => observer.disconnect();
    },
    [element],
  );
  const getSnapshot = useCallback(() => {
    if (element === null) return 0;
    return element.getBoundingClientRect().height;
  }, [element]);
  const getServerSnapshot = useCallback(() => 0, []);
  return {
    ref,
    height: useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot),
  };
}

/** The scoped host comes from the one picker in the sidebar (`useHostScope`), which reaches a non-active host
 * through a transient client. */
export function WorktreesSettingsPanel(): ReactNode {
  const scope = useHostScope();
  // One-shot `worktree.deleteByPath` stream transport: it survives the panel unmounting (a backgrounded delete
  // keeps its socket) but wires no proactive reconnect and no auth revalidation.
  const openStreamTransport = useWorktreeDeleteStreamTransportFactory();
  const compact = useSettingsDensity() === "compact";

  return (
    <SettingsPanelShell
      title="Worktrees"
      description="Traycer-created worktrees on this host."
      fillHeight
      bodyClassName="relative rounded-none border-none bg-transparent"
    >
      <div
        className={cn(
          "flex h-full min-h-0 flex-col",
          compact ? "gap-2.5" : "gap-3",
        )}
      >
        <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-card/40">
          <WorktreesBody
            client={scope.client}
            openStreamTransport={openStreamTransport}
            hostId={scope.hostId}
            scope={scope}
          />
        </div>
      </div>
    </SettingsPanelShell>
  );
}

function WorktreesToolbar(props: {
  readonly onRefresh: () => Promise<unknown>;
  readonly refreshing: boolean;
  readonly canRefresh: boolean;
  readonly lastUpdatedAt: number | null;
  readonly selectionControls: ReactNode | null;
  readonly filterControls: ReactNode | null;
}): ReactNode {
  const {
    canRefresh,
    filterControls,
    lastUpdatedAt,
    onRefresh,
    refreshing,
    selectionControls,
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
    <div className="flex flex-col gap-2 border-b border-border/40 px-5 py-2.5">
      {/* Both are gone: the sidebar names that host one row away and never scrolls, so this toolbar carries only what
         it owns. */}
      <div className="flex items-center justify-end gap-2">
        <div
          className="flex shrink-0 items-center gap-2"
          data-testid="worktrees-toolbar-actions"
        >
          {selectionControls}
          {refresh.refreshing ? null : (
            <WorktreesUpdatedAgoLabel updatedAt={lastUpdatedAt} />
          )}
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

/** Split into an outer null-gate and an inner hook caller so the shared 60s relative-time clock only re-renders
 * this leaf, never the toolbar. */
function WorktreesUpdatedAgoLabel(props: {
  readonly updatedAt: number | null;
}): ReactNode {
  if (props.updatedAt === null) return null;
  return <WorktreesUpdatedAgoText updatedAt={props.updatedAt} />;
}

function WorktreesUpdatedAgoText(props: {
  readonly updatedAt: number;
}): ReactNode {
  const ago = useRelativeTimestamp(props.updatedAt);
  return (
    <span
      className="text-ui-xs whitespace-nowrap text-muted-foreground"
      data-testid="worktrees-updated-ago"
    >
      Updated {ago}
    </span>
  );
}

function WorktreesFilterControls(props: {
  readonly searchText: string;
  readonly onSearchChange: (value: string) => void;
  readonly tierFilters: WorktreeTierFilterSet;
  readonly availableTiers: readonly WorktreeTier[];
  readonly onToggleTier: (tier: WorktreeTier) => void;
  readonly onClearTierFilters: () => void;
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
          placeholder="Search repo, branch, path, PR, or Task"
          aria-label="Search worktrees"
          className="pl-8"
        />
      </div>
      <WorktreeFilterMenu
        tierFilters={props.tierFilters}
        availableTiers={props.availableTiers}
        onToggleTier={props.onToggleTier}
        onClearTierFilters={props.onClearTierFilters}
      />
      <WorktreeSortMenu
        sortMode={props.sortMode}
        onSortModeChange={props.onSortModeChange}
      />
    </div>
  );
}

function worktreeTierFilterLabel(
  tierFilters: WorktreeTierFilterSet,
  availableTiers: readonly WorktreeTier[],
): string {
  // `availableTiers` includes every selected tier even when it currently has no
  // matches, so a strict persisted filter never masquerades as "All".
  const active = availableTiers.filter((tier) => tierFilters.has(tier));
  if (active.length === 0) return "All";
  if (active.length === 1) return WORKTREE_TIER_LABEL[active[0]];
  return `${active.length} tiers`;
}

/** Kept open across toggles (`onSelect` preventDefault) so the user can pick e.g. Landed + At base commit in
 * one visit. */
function WorktreeFilterMenu(props: {
  readonly tierFilters: WorktreeTierFilterSet;
  readonly availableTiers: readonly WorktreeTier[];
  readonly onToggleTier: (tier: WorktreeTier) => void;
  readonly onClearTierFilters: () => void;
}): ReactNode {
  const label = worktreeTierFilterLabel(
    props.tierFilters,
    props.availableTiers,
  );
  const noneSelected = props.availableTiers.every(
    (tier) => !props.tierFilters.has(tier),
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="worktrees-filter-trigger"
          aria-label={`Filter: ${label}`}
        >
          <ListFilter className="size-4" />
          <span>{label}</span>
          <ChevronDown className="size-4 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={noneSelected}
          onSelect={(event) => {
            event.preventDefault();
            props.onClearTierFilters();
          }}
          data-testid="worktrees-filter-all"
        >
          All
        </DropdownMenuCheckboxItem>
        {props.availableTiers.map((tier) => (
          <DropdownMenuCheckboxItem
            key={tier}
            checked={props.tierFilters.has(tier)}
            onSelect={(event) => {
              event.preventDefault();
              props.onToggleTier(tier);
            }}
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

/** Orders rows within each repo group by creation time - "Newest" (default) or "Oldest". */
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

function WorktreesBody(props: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string | null;
  readonly scope: HostScope;
}): ReactNode {
  const { client, openStreamTransport, hostId, scope } = props;
  const reachability = useHostReachability(hostId ?? "");
  // `useHostReachability` is the tab-binding check and can call a host reachable that this settings scope cannot
  // dial (a registry row with no websocket URL).
  const scopeUsable = isHostScopeUsable(scope.status);
  const reachable =
    scopeUsable && hostId !== null && reachability.status === "reachable";
  const listing = useWorktreeListing(client, reachable);
  // The full listing's paths seed the background enrichment sweep: rows the user never scrolls to still get
  // probed (in bounded chunks), so tier pills and filtered counts converge without manual scrolling.
  const worktreePaths = useMemo(
    () => listing.worktrees.map((entry) => entry.worktreePath),
    [listing.worktrees],
  );
  const enrichment = useWorktreeActivityEnrichment(
    client,
    reachable,
    hostId,
    worktreePaths,
  );
  // Owning-Task titles: tier 1 scans free cloud listTasks caches; tier 2 batches
  // still-unresolved ids through epic.getTaskContexts on this host.
  const taskTitlesByEpicId = useWorktreeTaskTitles(client, listing.worktrees);
  const canRefresh = reachable && client !== null;
  const { prepareEnrichmentRefresh } = enrichment;
  const onRefresh = useCallback(async () => {
    const completeEnrichmentRefresh = prepareEnrichmentRefresh();
    await listing.refresh();
    completeEnrichmentRefresh();
  }, [listing, prepareEnrichmentRefresh]);
  const toolbarProps = {
    onRefresh,
    // Only the explicit Refresh mutation locks the button - not enrichment.
    refreshing: listing.isRefreshPending,
    canRefresh,
    lastUpdatedAt: listing.lastUpdatedAt,
  };

  let content: ReactNode;
  let listOwnsToolbar = false;
  if (reachability.status === "checking") {
    content = (
      <WorktreesStateMessage tone="muted" spinner>
        Checking {reachability.hostLabel}…
      </WorktreesStateMessage>
    );
  } else if (reachability.status === "host-starting") {
    content = (
      <WorktreesStateMessage tone="muted" spinner>
        Waiting for the host to start…
      </WorktreesStateMessage>
    );
  } else if (!reachable) {
    // A `plan-restricted` host is running and its worktrees are intact; saying it is offline sends someone to fix
    // a machine that is fine and hides the only thing that would actually restore this panel.
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        {reachability.unavailability === "plan-restricted"
          ? `${reachability.hostLabel} is local only on your current plan. Upgrade to manage its worktrees from here.`
          : `${reachability.hostLabel} is offline. Worktrees can only be managed on a reachable host.`}
      </WorktreesStateMessage>
    );
  } else if (client === null) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        Sign in to manage worktrees on this host.
      </WorktreesStateMessage>
    );
  } else if (listing.isPending) {
    content = (
      <WorktreesStateMessage tone="muted" spinner>
        Loading worktrees…
      </WorktreesStateMessage>
    );
  } else if (listing.isError) {
    content = (
      <WorktreesStateMessage tone="error" spinner={false}>
        {listing.errorMessage}
      </WorktreesStateMessage>
    );
  } else if (listing.isEmpty) {
    content = (
      <WorktreesStateMessage tone="muted" spinner={false}>
        No worktrees created on this host.
      </WorktreesStateMessage>
    );
  } else {
    listOwnsToolbar = true;
    content = (
      // Key by host so a host swap remounts the list with fresh selection / search / collapse state - a pending
      // selection from another host is never carried across.
      <WorktreesList
        key={hostId}
        openStreamTransport={openStreamTransport}
        hostId={hostId}
        worktrees={listing.worktrees}
        enrichedByPath={enrichment.enrichedByPath}
        erroredPaths={enrichment.erroredPaths}
        seededPaths={enrichment.seededPaths}
        onVisiblePathsChange={enrichment.reportVisiblePaths}
        taskTitlesByEpicId={taskTitlesByEpicId}
        toolbarProps={toolbarProps}
      />
    );
  }

  const showStandaloneToolbar = scope.hosts.length > 0 && !listOwnsToolbar;

  return (
    <div className="flex h-full flex-col">
      {showStandaloneToolbar ? (
        <WorktreesToolbar
          {...toolbarProps}
          selectionControls={null}
          filterControls={null}
        />
      ) : null}
      {/* The reachability/listing content renders as the gate's children (not beside it) so the list - a script
         review mid-read, an armed delete, selection and collapse state. */}
      <HostScopeGate
        scope={scope}
        skeleton={
          <WorktreesStateMessage tone="muted" spinner>
            Connecting to {scope.hostLabel}…
          </WorktreesStateMessage>
        }
      >
        {listing.isPartial ? (
          <WorktreesPartialListingBanner
            message={listing.errorMessage}
            onRetry={listing.retryPartial}
          />
        ) : null}
        {content}
      </HostScopeGate>
    </div>
  );
}

/** The list still renders below (partial data is useful), but this banner is the only signal that it is
 * truncated, so it must never be dropped silently. */
function WorktreesPartialListingBanner(props: {
  readonly message: string | null;
  readonly onRetry: () => Promise<unknown>;
}): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2 border-b border-border/60 bg-amber-500/10 px-4 py-2 text-ui-sm text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 wrap-anywhere">
        Some worktrees could not be loaded
        {props.message !== null ? `: ${props.message}` : ""}. The list below is
        incomplete.
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 px-2 text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200"
        onClick={() => void props.onRetry()}
      >
        Retry
      </Button>
      <ReportIssueAction
        context={createReportIssueContext({
          title: "Some worktrees could not be loaded",
          message: null,
          code: null,
          source: "Worktrees",
        })}
        presentation="link"
        className="h-auto shrink-0 p-0 text-current"
      />
    </div>
  );
}

/** `firstInGroup` / `showDivider` carry the hairline borders the old nested `divide-y` layout gave for free
 * (absolutely-positioned virtual items can't rely on `:first-child`). */
type WorktreeFlatItem =
  | {
      readonly kind: "header";
      readonly group: WorktreeRepoGroup;
      readonly collapsed: boolean;
      readonly showDivider: boolean;
    }
  | {
      readonly kind: "row";
      readonly entry: WorktreeHostEntryV14;
      readonly group: WorktreeRepoGroup;
      readonly firstInGroup: boolean;
    };

function worktreeFlatItemKey(item: WorktreeFlatItem): string {
  return item.kind === "header"
    ? `header:${item.group.key}`
    : `row:${item.entry.worktreePath}`;
}

function buildWorktreeFlatItems(
  groups: readonly WorktreeRepoGroup[],
  collapsedRepoKeys: ReadonlySet<string>,
): WorktreeFlatItem[] {
  const items: WorktreeFlatItem[] = [];
  for (const group of groups) {
    const collapsed = collapsedRepoKeys.has(group.key);
    items.push({
      kind: "header",
      group,
      collapsed,
      showDivider: items.length > 0,
    });
    if (collapsed) continue;
    group.items.forEach((entry, index) => {
      items.push({ kind: "row", entry, group, firstInGroup: index === 0 });
    });
  }
  return items;
}

// eslint-disable-next-line complexity
// List renders many per-worktree states (loading / empty / error / per-row
/** Identity-stable wrapper for callbacks passed to memoized rows. */
function useStableRowCallback<Args extends readonly unknown[]>(
  callback: (...args: Args) => void,
): (...args: Args) => void {
  const latestRef = useRef(callback);
  useLayoutEffect(() => {
    latestRef.current = callback;
  });
  return useCallback((...args: Args) => {
    latestRef.current(...args);
  }, []);
}

export function WorktreesList(props: {
  readonly openStreamTransport: (hostId: string) => DurableStreamTransport;
  readonly hostId: string;
  // The BASE listing (cheap fields for every row). Per-row activity enrichment
  // arrives lazily through `enrichedByPath`.
  readonly worktrees: readonly WorktreeHostEntryV14[];
  // On-screen rows fill in first; the background sweep covers the rest of the list without scrolling.
  readonly enrichedByPath: ReadonlyMap<string, WorktreeHostEntryV14>;
  // Such a row is un-enriched just like a pending one (kept out of tier filtering, base presentation), but its
  // pill reads a non-animated "Unknown" instead of an infinite "Checking…" spinner.
  readonly erroredPaths: ReadonlySet<string>;
  // Paths whose overlay entry is the restored warm-open seed (last run's data, not yet re-verified by this
  // session's probes).
  readonly seededPaths: ReadonlySet<string>;
  // Called whenever the on-screen set changes; the owner debounces + batches.
  readonly onVisiblePathsChange: (paths: readonly string[]) => void;
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
  readonly toolbarProps: {
    readonly onRefresh: () => Promise<unknown>;
    readonly refreshing: boolean;
    readonly canRefresh: boolean;
    readonly lastUpdatedAt: number | null;
  };
}): ReactNode {
  const {
    hostId,
    worktrees,
    enrichedByPath,
    erroredPaths,
    seededPaths,
    onVisiblePathsChange,
    taskTitlesByEpicId,
    openStreamTransport,
  } = props;
  const queryClient = useQueryClient();
  // A newly-unresolved base row must fail closed even when a previous resolved overlay is still cached; resolved
  // overlays only win when they are at least as fresh as the resolved base row.
  const acceptedEnrichedByPath = useMemo(() => {
    const accepted = new Map<string, WorktreeHostEntryV14>();
    for (const base of worktrees) {
      const enriched = enrichedByPath.get(base.worktreePath);
      if (
        base.resolvedAt !== null &&
        enriched !== undefined &&
        enriched.resolvedAt !== null &&
        enriched.resolvedAt >= base.resolvedAt
      ) {
        accepted.set(base.worktreePath, enriched);
      }
    }
    return accepted;
  }, [worktrees, enrichedByPath]);
  // It is display-only: destructive actions continue to use `acceptedEnrichedByPath` below and therefore never
  // trust an overlay older than the refreshed base row.
  const classificationEntryByPath = useMemo(() => {
    const known = new Map<string, WorktreeHostEntryV14>();
    for (const base of worktrees) {
      const enriched = enrichedByPath.get(base.worktreePath);
      if (
        enriched !== undefined &&
        enriched.resolvedAt !== null &&
        hasMatchingActivityIdentity(base, enriched)
      ) {
        known.set(
          base.worktreePath,
          mergeStaleActivityOntoBase(base, enriched),
        );
      }
    }
    return known;
  }, [worktrees, enrichedByPath]);
  // The merged view every downstream computation reads. A row is "pending"
  // until a freshness-valid overlay exists for its current base row.
  const mergedWorktrees = useMemo(
    () =>
      worktrees.map(
        (entry) => acceptedEnrichedByPath.get(entry.worktreePath) ?? entry,
      ),
    [worktrees, acceptedEnrichedByPath],
  );
  // Search/display may keep using a last-known overlay while it revalidates. This mirrors tier filtering:
  // entering a loading state must not erase a PR number the user could search a moment earlier.
  const displayWorktrees = useMemo(
    () =>
      mergedWorktrees.map(
        (entry) => classificationEntryByPath.get(entry.worktreePath) ?? entry,
      ),
    [mergedWorktrees, classificationEntryByPath],
  );
  // The row PILL, however, distinguishes the two: an errored row reads a settled
  // "Unknown" (non-animated), never an infinite "Checking…" spinner.
  const enrichmentStateFor = useCallback(
    (worktreePath: string): WorktreeEnrichmentState => {
      if (classificationEntryByPath.has(worktreePath)) {
        return erroredPaths.has(worktreePath) ? "unavailable" : "ready";
      }
      if (erroredPaths.has(worktreePath)) return "unknown";
      return "pending";
    },
    [classificationEntryByPath, erroredPaths],
  );
  // DELETE surfaces read this variant instead: a snapshot-seeded row reads "pending" (its restored tier is
  // last-run display data, not verified truth), so it can't unlock a delete confirmation.
  const deleteEnrichmentStateFor = useCallback(
    (worktreePath: string): WorktreeEnrichmentState => {
      if (seededPaths.has(worktreePath)) return "pending";
      if (acceptedEnrichedByPath.has(worktreePath)) return "ready";
      return erroredPaths.has(worktreePath) ? "unknown" : "pending";
    },
    [seededPaths, acceptedEnrichedByPath, erroredPaths],
  );
  // Built from the merged view: an un-enriched entry contributes its base (no-PR) fields, so the rollup can only
  // under-count merged branches and fills UP as rows enrich - it never over-claims a merge.
  const taskRollupByEpicId = useMemo(
    () => buildTaskMergeRollups(mergedWorktrees),
    [mergedWorktrees],
  );
  const searchText = useWorktreesSettingsViewStore((state) => state.searchText);
  const setSearchText = useWorktreesSettingsViewStore(
    (state) => state.setSearchText,
  );
  const sortMode = useWorktreesSettingsViewStore((state) => state.sortMode);
  const setSortMode = useWorktreesSettingsViewStore(
    (state) => state.setSortMode,
  );
  const tierFilterValues = useWorktreesSettingsViewStore(
    (state) => state.tierFilters,
  );
  const toggleTierFilter = useWorktreesSettingsViewStore(
    (state) => state.toggleTierFilter,
  );
  const clearTierFilters = useWorktreesSettingsViewStore(
    (state) => state.clearTierFilters,
  );
  const deferredSearchText = useDeferredValue(searchText);
  const tierFilters = useMemo(
    () => new Set(tierFilterValues),
    [tierFilterValues],
  );
  const searchHaystackByPath = useMemo(
    () => buildWorktreeSearchHaystackByPath(worktrees, taskTitlesByEpicId),
    [worktrees, taskTitlesByEpicId],
  );
  // Keyed on the enriched list, unlike the text haystack above: a PR number only exists once a path's activity
  // probe has landed.
  const prHaystackByPath = useMemo(
    () => buildWorktreePrHaystackByPath(displayWorktrees),
    [displayWorktrees],
  );
  // Un-enriched rows have no known tier, so they cannot contribute an option - the menu fills in as rows enrich
  // (on-screen rows first, then the background sweep over the rest).
  const availableTiers = useMemo(() => {
    const present = new Set<WorktreeTier>();
    for (const entry of classificationEntryByPath.values()) {
      present.add(classifyWorktreeTier(entry));
    }
    // A persisted/selected tier remains visible even when it currently has no matches. Otherwise its trigger would
    // silently read "All" and broaden the list while never-classified rows are still resolving.
    return WORKTREE_TIER_ORDER.filter(
      (tier) => present.has(tier) || tierFilters.has(tier),
    );
  }, [classificationEntryByPath, tierFilters]);
  // A PR-number query cannot match them yet (their `prNumber` is null), so an empty result set only honestly
  // reads "no matches" once this hits zero - until then the empty state says "still checking".
  const stillCheckingCount = useMemo(() => {
    return mergedWorktrees.filter(
      (entry) => enrichmentStateFor(entry.worktreePath) === "pending",
    ).length;
  }, [mergedWorktrees, enrichmentStateFor]);
  const searchStillCheckingCount = useMemo(() => {
    const needle = deferredSearchText.trim().toLowerCase();
    if (needle.length === 0) return stillCheckingCount;
    const couldMatchUnknownPr = needle === "#" || /^#?\d+$/.test(needle);
    return mergedWorktrees.filter((entry) => {
      if (enrichmentStateFor(entry.worktreePath) !== "pending") return false;
      return (
        couldMatchUnknownPr ||
        (searchHaystackByPath.get(entry.worktreePath) ?? "").includes(needle)
      );
    }).length;
  }, [
    deferredSearchText,
    stillCheckingCount,
    mergedWorktrees,
    enrichmentStateFor,
    searchHaystackByPath,
  ]);
  const unavailableStatusCount = useMemo(
    () =>
      mergedWorktrees.filter((entry) => {
        const state = enrichmentStateFor(entry.worktreePath);
        return state === "unknown" || state === "unavailable";
      }).length,
    [mergedWorktrees, enrichmentStateFor],
  );
  // Never-classified rows are accounted for by the checking/unavailable status outside the results, then appear
  // only if their first successful classification matches.
  const filteredWorktrees = useMemo(() => {
    const searched = filterWorktrees(
      mergedWorktrees,
      deferredSearchText,
      searchHaystackByPath,
      prHaystackByPath,
    );
    if (tierFilters.size === 0) return searched;
    return searched.filter((entry) => {
      const classification = classificationEntryByPath.get(entry.worktreePath);
      return (
        classification !== undefined &&
        tierFilters.has(classifyWorktreeTier(classification))
      );
    });
  }, [
    mergedWorktrees,
    deferredSearchText,
    searchHaystackByPath,
    prHaystackByPath,
    tierFilters,
    classificationEntryByPath,
  ]);
  // Refresh the host-wide list plus the shared worktree/binding caches the file-tree / home / create-worktree
  // surfaces read, captured against the host the delete ran on.
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
  const selectedPaths = useWorktreesSettingsSelectionStore(
    (state) =>
      state.selectedPathsByHost.get(hostId) ?? EMPTY_SELECTED_WORKTREE_PATHS,
  );
  const setSelectedPathsForHost = useWorktreesSettingsSelectionStore(
    (state) => state.setSelectedPaths,
  );
  const setSelectedPaths = useCallback(
    (update: SelectedWorktreePathsUpdate): void => {
      setSelectedPathsForHost(hostId, update);
    },
    [hostId, setSelectedPathsForHost],
  );
  const [pendingDeleteTargets, setPendingDeleteTargets] =
    useState<ReadonlyArray<WorktreeHostEntryV14> | null>(null);
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
  const listedWorktreePathSet = useMemo(
    () => new Set(worktrees.map((entry) => entry.worktreePath)),
    [worktrees],
  );
  useEffect(() => {
    clearCompletedDeletedMissingFromList(listedWorktreePathSet);
  }, [
    backgrounded,
    clearCompletedDeletedMissingFromList,
    listedWorktreePathSet,
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
          worktreeCanBeSelected(
            entry,
            backgroundedDeleteStatusByPath,
            deleteEnrichmentStateFor(entry.worktreePath),
          ),
        )
        .map((entry) => entry.worktreePath),
    [
      backgroundedDeleteStatusByPath,
      deleteEnrichmentStateFor,
      visibleWorktrees,
    ],
  );
  // Select-all never pre-selects in-use rows: those are a deliberate opt-in
  // because confirming them stops their holders.
  const selectAllWorktreePaths = useMemo(
    () =>
      visibleWorktrees
        .filter((entry) =>
          worktreeIsSelectAllEligible(
            entry,
            backgroundedDeleteStatusByPath,
            deleteEnrichmentStateFor(entry.worktreePath),
          ),
        )
        .map((entry) => entry.worktreePath),
    [
      backgroundedDeleteStatusByPath,
      deleteEnrichmentStateFor,
      visibleWorktrees,
    ],
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
  // Select-all's checked state is the intersection with its own eligible set, not the full selection.
  const selectAllSelectedCount = selectAllWorktreePaths.filter((path) =>
    selectedPaths.has(path),
  ).length;
  // Live-measured height of the floating selection action bar (see `WorktreeSelectionActionBar` /
  // `WORKTREE_ACTION_BAR_GAP_PX`).
  const actionBarHeightObserver = useObservedHeight();
  const actionBarClearancePx =
    selectedCount > 0
      ? Math.max(
          actionBarHeightObserver.height + WORKTREE_ACTION_BAR_GAP_PX,
          WORKTREE_ACTION_BAR_MIN_CLEARANCE_PX,
        )
      : 0;
  // Selected rows whose tier isn't known yet - bulk delete is disabled while
  // any exist (mirrors the single-row guard: pending status is not safe).
  const checkingSelectedCount = useMemo(
    () =>
      selectedTargets.filter(
        (entry) => deleteEnrichmentStateFor(entry.worktreePath) === "pending",
      ).length,
    [selectedTargets, deleteEnrichmentStateFor],
  );
  // Freshest listing keyed by path, so a pending delete captured at dialog-open is always re-resolved to its
  // current entry (a background refresh may have made a row in-use / mid-delete since the dialog opened).
  const worktreesByPath = useMemo(
    () => new Map(mergedWorktrees.map((entry) => [entry.worktreePath, entry])),
    [mergedWorktrees],
  );
  // Both the dialog copy and the confirm action read from this, so what the user sees is what gets deleted.
  const pendingResolution = useMemo(() => {
    if (pendingDeleteTargets === null) return null;
    const kept: WorktreeHostEntryV14[] = [];
    const dropped: WorktreeHostEntryV14[] = [];
    for (const captured of pendingDeleteTargets) {
      const fresh = worktreesByPath.get(captured.worktreePath) ?? null;
      if (fresh === null) {
        dropped.push(captured);
        continue;
      }
      const stillEligible =
        selectablePathSet.has(fresh.worktreePath) &&
        deleteEnrichmentStateFor(fresh.worktreePath) !== "pending";
      if (stillEligible) kept.push(fresh);
      else dropped.push(fresh);
    }
    return { kept, dropped };
  }, [
    pendingDeleteTargets,
    selectablePathSet,
    worktreesByPath,
    deleteEnrichmentStateFor,
  ]);
  const { singleDialog, bulkDeleteSummary } = deriveWorktreeDeleteDialogs(
    pendingResolution,
    deleteEnrichmentStateFor,
    visibleWorktrees,
    erroredPaths,
  );
  // Left alone, that stale intent would silently reopen the old confirmation once the rows settle back to
  // ready/unknown, without the user choosing Delete again.
  useEffect(() => {
    if (pendingResolution === null) return;
    const { kept, dropped } = pendingResolution;
    if (kept.length > 0 || dropped.length === 0) return;
    toast.message(
      worktreeDropMessage(
        dropped,
        (worktreePath) => deleteEnrichmentStateFor(worktreePath) === "pending",
      ),
    );
    setPendingDeleteTargets(null);
  }, [pendingResolution, deleteEnrichmentStateFor]);
  const progressSummary = useMemo(
    () => summarizeWorktreeDeleteRuns(runs),
    [runs],
  );
  useEffect(
    () => () => {
      // Keep an in-progress foreground delete alive in the background (the store no-ops if it is already terminal),
      // and drop this host's settled successes the now-unmounted list can no longer prune.
      backgroundForegroundWorktreeDeleteForHost(hostId);
      clearSettledWorktreeDeleteSuccessesForHostIfQuiescent(hostId);
    },
    [hostId],
  );

  // Row-prop handlers go through `useStableRowCallback`: their dependencies (`selectablePathSet`, the
  // delete-gating readers) get fresh identities on every enrichment pass.
  const toggleSelection = useStableRowCallback((worktreePath: string) => {
    if (!selectablePathSet.has(worktreePath)) return;
    setSelectedPaths((prev) => withMemberToggled(prev, worktreePath));
  });
  // Hidden (filtered-out) selections are left untouched - the header + count reflect visible rows, and the
  // confirm-time re-resolution + honest dialog still govern what is deleted.
  const allVisibleSelected =
    selectAllWorktreePaths.length > 0 &&
    selectAllWorktreePaths.every((path) => selectedPaths.has(path));
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const path of selectAllWorktreePaths) next.delete(path);
      } else {
        for (const path of selectAllWorktreePaths) next.add(path);
      }
      return next;
    });
  }, [allVisibleSelected, selectAllWorktreePaths, setSelectedPaths]);
  const clearSelection = useCallback(() => {
    setSelectedPaths(new Set());
  }, [setSelectedPaths]);
  const toggleRepoCollapsed = useCallback(
    (group: WorktreeRepoGroup, collapsed: boolean) => {
      if (collapsed) {
        dispatchCollapsedRepoKeys({ type: "expand", key: group.key });
      } else {
        dispatchCollapsedRepoKeys({ type: "collapse", key: group.key });
        setSelectedPaths((prev) => removeSelectedWorktrees(prev, group.items));
      }
    },
    [setSelectedPaths],
  );
  const toggleAllReposCollapsed = useCallback(() => {
    if (allReposCollapsed) {
      dispatchCollapsedRepoKeys({ type: "expand-all" });
      return;
    }
    dispatchCollapsedRepoKeys({ type: "collapse-all", keys: repoKeys });
    setSelectedPaths(new Set());
  }, [allReposCollapsed, repoKeys, setSelectedPaths]);
  const requestDeleteTargets = useCallback(
    (targets: ReadonlyArray<WorktreeHostEntryV14>) => {
      // A `Checking` row's tier isn't known yet, so it never opens a delete
      // confirmation - not even a generic one - until enrichment settles.
      const deletableTargets = targets.filter(
        (entry) =>
          selectablePathSet.has(entry.worktreePath) &&
          deleteEnrichmentStateFor(entry.worktreePath) !== "pending",
      );
      if (deletableTargets.length === 0) return;
      setPendingDeleteTargets(deletableTargets);
    },
    [selectablePathSet, deleteEnrichmentStateFor],
  );
  const requestDeleteTarget = useStableRowCallback(
    (target: WorktreeHostEntryV14) => {
      requestDeleteTargets([target]);
    },
  );
  const requestDeleteSelectedTargets = useCallback(() => {
    requestDeleteTargets(selectedTargets);
  }, [requestDeleteTargets, selectedTargets]);
  const openScriptReviewFor = useCallback((target: WorktreeHostEntryV14) => {
    const reviewedScriptsByPath = reviewedScriptsByPathRef.current;
    setPendingScriptReview({
      target,
      scripts:
        reviewedScriptsByPath?.get(target.worktreePath) ?? target.scripts,
    });
  }, []);

  const clearSelectionForTargets = (
    targets: ReadonlyArray<WorktreeHostEntryV14>,
  ): void => {
    setSelectedPaths((prev) => removeSelectedWorktrees(prev, targets));
    setPendingDeleteTargets(null);
  };

  const handleConfirm = (): void => {
    if (pendingResolution === null || pendingDeleteTargets === null) return;
    // `pendingResolution` already re-resolved each pending path to its freshest entry and split kept vs.
    const { kept, dropped } = pendingResolution;
    if (dropped.length > 0) {
      toast.message(
        worktreeDropMessage(
          dropped,
          (worktreePath) =>
            deleteEnrichmentStateFor(worktreePath) === "pending",
        ),
      );
    }
    if (kept.length === 1) {
      start(
        kept[0],
        reviewedScriptsByPath.get(kept[0].worktreePath) ?? null,
        false,
      );
    } else if (kept.length > 1) {
      startBatchBackgrounded(kept, reviewedScriptsByPath);
    }
    // Prune the entire confirmed cohort - kept and dropped.
    clearSelectionForTargets(pendingDeleteTargets);
  };

  const handleCloseModal = (): void => {
    // Gate on the live run status, not `worktreeRowDeleteStatus` (which reports a just-deleted complete run as
    // still "deleting").
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

  // Row heights vary (an optional facts line, wrapping Task chips), so each item is measured after mount - the
  // estimates only seed the window before the first measure.
  const flatItems = useMemo(
    () => buildWorktreeFlatItems(groups, collapsedRepoKeys),
    [groups, collapsedRepoKeys],
  );
  const stickyHeaderIndexes = useMemo(
    () =>
      flatItems.flatMap((item, index) =>
        item.kind === "header" ? [index] : [],
      ),
    [flatItems],
  );
  const scrollParentRef = useRef<HTMLDivElement>(null);
  const getScrollElement = useCallback(() => scrollParentRef.current, []);
  const estimateVirtualItemSize = useCallback(
    (index: number) =>
      flatItems[index].kind === "header"
        ? WORKTREE_REPO_HEADER_ESTIMATE_PX
        : WORKTREE_ROW_ESTIMATE_PX,
    [flatItems],
  );
  const getVirtualItemKey = useCallback(
    (index: number) => worktreeFlatItemKey(flatItems[index]),
    [flatItems],
  );
  const activeStickyHeaderIndexRef = useRef<number | null>(null);
  const extractWorktreeVirtualRange = useCallback<typeof defaultRangeExtractor>(
    (range) => {
      if (stickyHeaderIndexes.length === 0) {
        activeStickyHeaderIndexRef.current = null;
        return defaultRangeExtractor(range);
      }
      const activeHeaderIndex = stickyHeaderIndexes.reduce(
        (latest, index) => (index <= range.startIndex ? index : latest),
        stickyHeaderIndexes[0],
      );
      activeStickyHeaderIndexRef.current = activeHeaderIndex;
      return [
        ...new Set([activeHeaderIndex, ...defaultRangeExtractor(range)]),
      ].sort((left, right) => left - right);
    },
    [stickyHeaderIndexes],
  );
  // eslint-disable-next-line react-hooks/incompatible-library
  // `useVirtualizer` returns fresh function identities each render; the React
  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement,
    estimateSize: estimateVirtualItemSize,
    getItemKey: getVirtualItemKey,
    rangeExtractor: extractWorktreeVirtualRange,
    overscan: WORKTREE_VIRTUAL_OVERSCAN,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const isVirtualizerScrolling = virtualizer.isScrolling;
  // Keyed by the joined string so the report fires only when the on-screen set changes, not on every scroll tick
  // that leaves the same rows mounted.
  const onScreenPaths = useMemo(
    () =>
      virtualItems.flatMap((virtualItem) => {
        const item = flatItems[virtualItem.index];
        return item.kind === "row" ? [item.entry.worktreePath] : [];
      }),
    [virtualItems, flatItems],
  );
  // Report only when the on-screen set actually changes.
  const onScreenPathsKey = onScreenPaths.join("\n");
  const lastReportedPathsRef = useRef<string | null>(null);
  useEffect(() => {
    if (isVirtualizerScrolling) return;
    if (lastReportedPathsRef.current === onScreenPathsKey) return;
    lastReportedPathsRef.current = onScreenPathsKey;
    onVisiblePathsChange(onScreenPaths);
  }, [
    isVirtualizerScrolling,
    onScreenPathsKey,
    onScreenPaths,
    onVisiblePathsChange,
  ]);

  return (
    <WorktreeListRenderProfiler
      rowCount={mergedWorktrees.length}
      visibleRowCount={visibleWorktrees.length}
    >
      <div className="flex h-full min-h-0 flex-col">
        <WorktreeDeleteForegroundSurface
          confirmed={confirmed}
          run={run}
          reviewedScriptsByPath={reviewedScriptsByPath}
          onForceDelete={(target, scripts) => {
            close();
            start(target, scripts, true);
          }}
          onDismissForceDelete={close}
          onCloseProgress={handleCloseModal}
        />

        <WorktreesToolbar
          {...props.toolbarProps}
          selectionControls={
            <>
              <SelectAllToggle
                accessibleLabel="Select all visible worktrees"
                selectableCount={selectAllWorktreePaths.length}
                selectedCount={selectAllSelectedCount}
                disabled={false}
                testId="worktrees-select-all"
                onToggle={toggleSelectAllVisible}
              />
              <WorktreesRepoExpansionControl
                allCollapsed={allReposCollapsed}
                onToggle={toggleAllReposCollapsed}
              />
            </>
          }
          filterControls={
            <WorktreesFilterControls
              searchText={searchText}
              onSearchChange={setSearchText}
              tierFilters={tierFilters}
              availableTiers={availableTiers}
              onToggleTier={toggleTierFilter}
              onClearTierFilters={clearTierFilters}
              sortMode={sortMode}
              onSortModeChange={setSortMode}
            />
          }
        />
        <WorktreeDeleteProgressStrip
          summary={progressSummary}
          onDismiss={dismissTerminalBackgrounded}
        />
        {shouldShowWorktreeFilterResolutionStatus(
          tierFilters,
          stillCheckingCount,
          unavailableStatusCount,
        ) ? (
          <div
            role="status"
            className="border-b border-border/40 px-5 py-1.5 text-ui-xs text-muted-foreground"
            data-testid="worktrees-filter-resolution-status"
          >
            {worktreeFilterResolutionStatusText(
              stillCheckingCount,
              unavailableStatusCount,
            )}
          </div>
        ) : null}

        {/* Being out of flow means its mount/unmount when a selection starts or clears never shifts the scroll region
           or the rows inside it - the "no inserted top bar" product rule holds regardless of selection state. */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={scrollParentRef}
            data-testid="worktrees-virtual-scroll"
            className="absolute inset-0 overflow-y-auto"
            style={
              actionBarClearancePx > 0
                ? { paddingBottom: actionBarClearancePx }
                : undefined
            }
          >
            {groups.length === 0 ? (
              /** A strict tier filter can legitimately have no proven matches while first-time probes are outstanding. */
              <WorktreesStateMessage
                tone="muted"
                spinner={searchStillCheckingCount > 0}
              >
                {searchStillCheckingCount > 0
                  ? worktreeSearchCheckingNoticeText(searchStillCheckingCount)
                  : worktreeEmptyStateText(
                      deferredSearchText,
                      tierFilters.size > 0,
                    )}
              </WorktreesStateMessage>
            ) : (
              <div
                className="relative w-full"
                style={{ height: `${virtualizer.getTotalSize()}px` }}
              >
                {virtualItems.map((virtualItem) => {
                  const item = flatItems[virtualItem.index];
                  const isStickyHeader =
                    item.kind === "header" &&
                    virtualItem.index === activeStickyHeaderIndexRef.current;
                  return (
                    <div
                      key={virtualItem.key}
                      data-index={virtualItem.index}
                      ref={virtualizer.measureElement}
                      className={cn(
                        "left-0 w-full",
                        isStickyHeader
                          ? "sticky top-0 z-30 bg-background"
                          : "absolute top-0",
                      )}
                      style={
                        isStickyHeader
                          ? undefined
                          : {
                              transform: `translateY(${virtualItem.start}px)`,
                            }
                      }
                    >
                      {item.kind === "header" ? (
                        <div
                          className={cn(
                            "bg-background",
                            item.showDivider && "border-t border-border/40",
                          )}
                        >
                          <WorktreeRepoHeader
                            group={item.group}
                            collapsed={item.collapsed}
                            onToggle={toggleRepoCollapsed}
                          />
                        </div>
                      ) : (
                        <div
                          className={cn(
                            !item.firstInGroup && "border-t border-border/30",
                          )}
                        >
                          <WorktreeRow
                            entry={item.entry}
                            classificationEntry={
                              classificationEntryByPath.get(
                                item.entry.worktreePath,
                              ) ?? null
                            }
                            enrichment={enrichmentStateFor(
                              item.entry.worktreePath,
                            )}
                            deleteEnrichment={deleteEnrichmentStateFor(
                              item.entry.worktreePath,
                            )}
                            taskTitlesByEpicId={taskTitlesByEpicId}
                            taskRollupByEpicId={taskRollupByEpicId}
                            deleteStatus={
                              backgroundedDeleteStatusByPath.get(
                                item.entry.worktreePath,
                              ) ?? null
                            }
                            selected={selectedPaths.has(
                              item.entry.worktreePath,
                            )}
                            canSelect={selectablePathSet.has(
                              item.entry.worktreePath,
                            )}
                            onToggleSelection={toggleSelection}
                            onManageScripts={openScriptReviewFor}
                            onDelete={requestDeleteTarget}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {selectedCount > 0 ? (
            <div
              ref={actionBarHeightObserver.ref}
              className="absolute inset-x-8 bottom-4 z-30 flex flex-wrap items-center gap-3 rounded-lg border border-border/80 bg-popover px-5 py-3 shadow-2xl ring-1 ring-foreground/10"
              data-testid="worktrees-selection-action-bar"
            >
              <WorktreeSelectionActionBar
                selectedCount={selectedCount}
                checkingCount={checkingSelectedCount}
                onDelete={requestDeleteSelectedTargets}
                onClear={clearSelection}
              />
            </div>
          ) : null}
        </div>

        <ConfirmDestructiveDialog
          blockedReason={null}
          open={singleDialog.open}
          onOpenChange={(open) => {
            if (!open) setPendingDeleteTargets(null);
          }}
          title={singleDialog.title}
          description={singleDialog.description}
          cascadeSummary={null}
          actionLabel={singleDialog.actionLabel}
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
    </WorktreeListRenderProfiler>
  );
}

function WorktreeDeleteForegroundSurface(props: {
  readonly confirmed: WorktreeHostEntry | null;
  readonly run: WorktreeDeleteRunState | null;
  readonly reviewedScriptsByPath: ReadonlyMap<string, WorktreeEntryScripts>;
  readonly onForceDelete: (
    target: WorktreeHostEntry,
    scripts: WorktreeEntryScripts | null,
  ) => void;
  readonly onDismissForceDelete: () => void;
  readonly onCloseProgress: () => void;
}): ReactNode {
  const { confirmed, run } = props;
  if (confirmed === null || run === null) return null;
  if (run.pendingBusyHolders !== null && run.pendingBusyHolders.length > 0) {
    return (
      <TeardownForceDeleteDialog
        open
        worktreeLabel={branchLabel(confirmed)}
        holders={run.pendingBusyHolders}
        onConfirm={() => {
          const scripts =
            props.reviewedScriptsByPath.get(confirmed.worktreePath) ??
            confirmed.scripts;
          props.onForceDelete(confirmed, scripts);
        }}
        onDismiss={props.onDismissForceDelete}
      />
    );
  }
  // Gutter padding rather than an inset box, so the child centres inside the safe region while the backdrop
  // below still covers the whole screen - a dim over the status bar is a dim, not a surface.
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center pt-safe-top-gutter pr-safe-right-gutter pb-safe-bottom-gutter pl-safe-left-gutter">
      <div
        aria-hidden
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
      />
      <div className="relative z-10 max-h-[min(80vh,40rem)] w-[min(92vw,32rem)] overflow-y-auto rounded-lg border border-border/60 bg-card shadow-lg">
        <WorktreeDeleteProgressModal
          target={confirmed}
          run={run}
          onClose={props.onCloseProgress}
        />
      </div>
    </div>
  );
}

function WorktreeDeleteProgressStrip(props: {
  readonly summary: WorktreeDeleteProgressSummary;
  readonly onDismiss: () => void;
}): ReactNode {
  if (props.summary.total === 0) return null;
  // Once nothing is in flight, a batch that ended with failures stays put so the user notices; offer an explicit
  // Dismiss to clear it (and the app-wide toast) rather than leaving it stuck forever.
  const showDismiss = props.summary.active === 0 && props.summary.failed > 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 bg-foreground/3 px-5 py-2">
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

/** The caller (`WorktreesList`) wraps this in the absolutely-positioned overlay div that floats over the bottom
 * of the list (out of flow. */
function WorktreeSelectionActionBar(props: {
  readonly selectedCount: number;
  readonly checkingCount: number;
  readonly onDelete: () => void;
  readonly onClear: () => void;
}): ReactNode {
  const blockedByChecking = props.checkingCount > 0;
  const selectedWorktreeNoun =
    props.selectedCount === 1 ? "worktree" : "worktrees";
  const deleteButton = (
    <Button
      type="button"
      variant="destructive"
      size="sm"
      disabled={blockedByChecking}
      onClick={props.onDelete}
      aria-label={`Delete ${props.selectedCount} selected ${selectedWorktreeNoun}`}
      data-testid="worktrees-list-delete-selected"
      className="shrink-0 whitespace-nowrap"
    >
      <Trash2 className="size-4" />
      Delete {props.selectedCount} {selectedWorktreeNoun}
    </Button>
  );
  return (
    <>
      <span className="text-ui-sm font-medium text-foreground">
        {props.selectedCount} selected
      </span>
      {blockedByChecking ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid="worktrees-selection-checking-notice"
        >
          {worktreeCheckingNoticeText(props.checkingCount)}
        </span>
      ) : null}
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
        {blockedByChecking ? (
          <TooltipWrapper
            label={worktreeCheckingNoticeText(props.checkingCount)}
            side="top"
            sideOffset={undefined}
            align="end"
          >
            <span className="inline-flex shrink-0">{deleteButton}</span>
          </TooltipWrapper>
        ) : (
          deleteButton
        )}
      </div>
    </>
  );
}

function worktreeCheckingNoticeText(checkingCount: number): string {
  const plural = checkingCount === 1 ? "worktree is" : "worktrees are";
  return `${checkingCount} selected ${plural} still checking status`;
}

function worktreeSearchCheckingNoticeText(checkingCount: number): string {
  const plural = checkingCount === 1 ? "worktree" : "worktrees";
  return `No matches yet - still checking ${checkingCount} ${plural}.`;
}

function worktreeEmptyStateText(
  searchText: string,
  hasTierFilters: boolean,
): string {
  if (searchText.trim().length > 0) return "No worktrees match your search.";
  if (hasTierFilters) return "No worktrees match the selected tier filters.";
  return "No worktrees found.";
}

function mergeStaleActivityOntoBase(
  base: WorktreeHostEntryV14,
  enriched: WorktreeHostEntryV14,
): WorktreeHostEntryV14 {
  // A v1.4 unresolved base row is a schema-safe sentinel, not fresh truth. Preserve the last resolved entry
  // wholesale until the base becomes authoritative; otherwise its null branch/owners would destabilize tiers.
  if (base.resolvedAt === null) return enriched;
  let byEnriched = STALE_CLASSIFICATION_ENTRY_CACHE.get(base);
  if (byEnriched === undefined) {
    byEnriched = new WeakMap();
    STALE_CLASSIFICATION_ENTRY_CACHE.set(base, byEnriched);
  }
  const cached = byEnriched.get(enriched);
  if (cached !== undefined) return cached;
  const merged: WorktreeHostEntryV14 = {
    ...base,
    lastActivityAt: enriched.lastActivityAt,
    branchStatus: enriched.branchStatus,
    prState: enriched.prState,
    prNumber: enriched.prNumber,
    prUrl: enriched.prUrl,
    mergedHeadShaMatches: enriched.mergedHeadShaMatches,
    submodules: enriched.submodules,
    atBaseCommit: enriched.atBaseCommit,
    resolvedAt: enriched.resolvedAt,
  };
  byEnriched.set(enriched, merged);
  return merged;
}

function hasMatchingActivityIdentity(
  base: WorktreeHostEntryV14,
  enriched: WorktreeHostEntryV14,
): boolean {
  // Use every fact it actually knows to reject stale evidence from a branch switch or a deleted/recreated
  // directory at the same deterministic path; ignore only sentinel-null facts that cannot prove a mismatch.
  if (
    base.createdAt !== null &&
    enriched.createdAt !== null &&
    base.createdAt !== enriched.createdAt
  ) {
    return false;
  }
  if (base.resolvedAt !== null) {
    if (base.branch !== enriched.branch) return false;
    if (base.repoIdentifier === null || enriched.repoIdentifier === null) {
      return (
        base.repoIdentifier === enriched.repoIdentifier &&
        base.repoLabel === enriched.repoLabel
      );
    }
    return (
      base.repoIdentifier.owner === enriched.repoIdentifier.owner &&
      base.repoIdentifier.repo === enriched.repoIdentifier.repo
    );
  }
  if (base.branch !== null && base.branch !== enriched.branch) return false;
  if (base.repoIdentifier !== null) {
    const enrichedRepoIdentifier = enriched.repoIdentifier;
    return (
      enrichedRepoIdentifier !== null &&
      base.repoIdentifier.owner === enrichedRepoIdentifier.owner &&
      base.repoIdentifier.repo === enrichedRepoIdentifier.repo
    );
  }
  if (base.repoLabel !== enriched.repoLabel) return false;
  return true;
}

function worktreeFilterResolutionStatusText(
  checkingCount: number,
  unavailableCount: number,
): string {
  const parts: string[] = [];
  if (checkingCount > 0) {
    const plural = checkingCount === 1 ? "worktree" : "worktrees";
    parts.push(`Checking ${checkingCount} ${plural}…`);
  }
  if (unavailableCount > 0) {
    const plural = unavailableCount === 1 ? "worktree" : "worktrees";
    parts.push(`Status unavailable for ${unavailableCount} ${plural}.`);
  }
  return parts.join(" ");
}

function shouldShowWorktreeFilterResolutionStatus(
  tierFilters: WorktreeTierFilterSet,
  checkingCount: number,
  unavailableCount: number,
): boolean {
  return tierFilters.size > 0 && (checkingCount > 0 || unavailableCount > 0);
}

/** Bulk-delete confirmation: aggregate-by-class summary, dirty loss naming, a neutral caveat for the unverified
 * cohort, named exclusions, and the full (path-addressed) target list. */
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
                {summary.unknownRiskCaveat !== null ? (
                  <p
                    className="text-ui-sm leading-relaxed text-amber-700 dark:text-amber-400"
                    data-testid="worktree-bulk-delete-unknown-caveat"
                  >
                    {summary.unknownRiskCaveat}
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
                <TooltipWrapper
                  key={path}
                  label={path}
                  side="top"
                  sideOffset={undefined}
                  align={undefined}
                >
                  <li className="truncate py-0.5 text-ui-xs text-muted-foreground">
                    {path}
                  </li>
                </TooltipWrapper>
              ))}
            </ul>
            <div className="flex justify-end gap-2 border-t border-border/60 bg-foreground/3 px-5 py-3">
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

/**
 * Repo group header - a quiet sticky divider, not a second status row: no
 * filled high-emphasis background, and muted/regular-weight text so it never
 * competes with a row's bold branch name or colored tier pill. Collapse/expand
 * stays a full-width button for a generous hit target; the chevron carries the
 * only state-change affordance.
 */
const WorktreeRepoHeader = memo(function WorktreeRepoHeader(props: {
  readonly group: WorktreeRepoGroup;
  readonly collapsed: boolean;
  readonly onToggle: (group: WorktreeRepoGroup, collapsed: boolean) => void;
}): ReactNode {
  const { collapsed, group, onToggle } = props;
  const handleToggle = useCallback(() => {
    onToggle(group, collapsed);
  }, [onToggle, group, collapsed]);
  const action = collapsed ? "Expand" : "Collapse";
  return (
    <button
      type="button"
      aria-expanded={!collapsed}
      aria-label={`${action} ${group.label}`}
      data-testid="worktree-repo-header"
      className="flex w-full min-w-0 items-center gap-2 border-b border-border/40 bg-background px-5 py-1.5 text-left transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
      onClick={handleToggle}
    >
      <ChevronRight
        className={cn(
          "size-3.5 shrink-0 text-muted-foreground transition-transform",
          !collapsed && "rotate-90",
        )}
        aria-hidden
      />
      <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-ui-sm font-normal text-muted-foreground">
        {group.label}
      </span>
      <span className="shrink-0 text-ui-xs text-muted-foreground">
        {group.items.length}
      </span>
    </button>
  );
});

/** An `Unknown` row (settled enrichment error) is not disabled here - it is still deletable, just through the
 * unknown-risk confirmation instead of the generic one, even when the host never stamped `resolvedAt`. */
function worktreeDeleteDisabledReason(
  entry: WorktreeHostEntryV14,
  enrichment: WorktreeEnrichmentState,
): "checking" | null {
  if (enrichment === "unknown") return null;
  if (entry.resolvedAt === null || enrichment === "pending") return "checking";
  return null;
}

interface WorktreeRowProps {
  readonly entry: WorktreeHostEntryV14;
  readonly classificationEntry: WorktreeHostEntryV14 | null;
  // Base fields paint regardless.
  readonly enrichment: WorktreeEnrichmentState;
  // The DELETE-scoped variant: identical except a snapshot-seeded row reads "pending" until its live probe
  // lands, so the delete affordance stays disabled while the pill still shows the restored tier.
  readonly deleteEnrichment: WorktreeEnrichmentState;
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
  readonly taskRollupByEpicId: ReadonlyMap<string, TaskMergeRollup>;
  readonly deleteStatus: WorktreeRowDeleteStatus | null;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly onToggleSelection: (worktreePath: string) => void;
  readonly onManageScripts: (target: WorktreeHostEntryV14) => void;
  readonly onDelete: (target: WorktreeHostEntryV14) => void;
}

/** Custom memo comparator: the task title/rollup maps are rebuilt wholesale on every listing/enrichment pass. */
function worktreeRowPropsEqual(
  prev: WorktreeRowProps,
  next: WorktreeRowProps,
): boolean {
  if (
    prev.entry !== next.entry ||
    prev.classificationEntry !== next.classificationEntry ||
    prev.enrichment !== next.enrichment ||
    prev.deleteEnrichment !== next.deleteEnrichment ||
    prev.deleteStatus !== next.deleteStatus ||
    prev.selected !== next.selected ||
    prev.canSelect !== next.canSelect ||
    prev.onToggleSelection !== next.onToggleSelection ||
    prev.onManageScripts !== next.onManageScripts ||
    prev.onDelete !== next.onDelete
  ) {
    return false;
  }
  // `prev.entry === next.entry` (checked above), so both sides read the same
  // owner epic ids - the only keys this row looks up in either map.
  return next.entry.owners.every(
    ({ epicId }) =>
      prev.taskTitlesByEpicId.get(epicId) ===
        next.taskTitlesByEpicId.get(epicId) &&
      taskMergeRollupEqual(
        prev.taskRollupByEpicId.get(epicId),
        next.taskRollupByEpicId.get(epicId),
      ),
  );
}

const WorktreeRow = memo(function WorktreeRow(
  props: WorktreeRowProps,
): ReactNode {
  const {
    entry,
    classificationEntry,
    enrichment,
    deleteEnrichment,
    taskTitlesByEpicId,
    taskRollupByEpicId,
    deleteStatus,
    selected,
    canSelect,
    onToggleSelection,
    onManageScripts,
    onDelete,
  } = props;
  const deleting = deleteStatus !== null;
  const selectedForDelete = selected && canSelect;
  const deleteDisabledReason = worktreeDeleteDisabledReason(
    entry,
    deleteEnrichment,
  );
  // Do not classify those placeholders: the isGitRepo/dirty-count cliff makes an unresolved row look clean
  // enough to delete when it is actually still unknown.
  const classification =
    entry.resolvedAt === null ? null : classifyWorktree(entry);
  const tierClassification =
    classificationEntry === null ? null : classifyWorktree(classificationEntry);
  const displayEntry = classificationEntry ?? entry;
  const navigate = useNavigate();
  const openTask = useCallback(
    (epicId: string): void => {
      navigateToTabIntent(
        navigate,
        openOrFocusEpicIntent({ epicId, focus: undefined }),
        undefined,
      );
    },
    [navigate],
  );
  const toggleSelection = useCallback(() => {
    onToggleSelection(entry.worktreePath);
  }, [onToggleSelection, entry.worktreePath]);
  const manageScripts = useCallback(() => {
    onManageScripts(entry);
  }, [onManageScripts, entry]);
  const deleteWorktree = useCallback(() => {
    onDelete(entry);
  }, [onDelete, entry]);
  const { copy: copyToClipboard } = useClipboardCopy({
    resetMs: 2000,
    onSuccess: () => toast.success("Copied worktree path"),
    onError: () =>
      reportableErrorToast("Couldn't copy path to clipboard.", undefined, {
        title: "Could not copy worktree path",
        message: null,
        code: null,
        source: "Worktrees",
      }),
  });
  const copyPath = useCallback(() => {
    copyToClipboard(entry.worktreePath);
  }, [copyToClipboard, entry.worktreePath]);
  return (
    <div
      aria-busy={deleting}
      data-testid="worktree-row"
      className={cn(
        "group/worktree-row relative flex items-center gap-3 px-5 py-3 transition-colors",
        deleting ? "pointer-events-none opacity-50" : "hover:bg-accent/30",
        selectedForDelete && "bg-foreground/3",
      )}
    >
      <div className="flex w-5 shrink-0 items-center justify-center">
        <WorktreeSelectionControl
          entry={entry}
          selected={selected}
          canSelect={canSelect}
          deleting={deleting}
          selectDisabledReason={deleteDisabledReason}
          onToggleSelection={toggleSelection}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-1 pr-10">
        <div className="flex flex-wrap items-center gap-2">
          <WorktreeTierPill
            entry={classificationEntry ?? entry}
            tier={tierClassification?.tier ?? classification?.tier ?? "review"}
            state={enrichment}
          />
          {displayEntry.resolvedAt === null ? null : (
            <WorktreePrChips entry={displayEntry} />
          )}
          <span className="truncate text-ui-sm font-medium text-foreground">
            {branchLabel(entry)}
          </span>
        </div>
        {classification === null ? (
          <span className="text-ui-xs text-muted-foreground">
            {unresolvedWorktreeSecondaryCopy(enrichment)}
          </span>
        ) : (
          <WorktreeSecondaryFacts
            facts={classification.nonPrFacts}
            lastActivityAt={entry.lastActivityAt}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <WorktreeTaskAssociation
            owners={entry.owners}
            taskTitlesByEpicId={taskTitlesByEpicId}
            taskRollupByEpicId={taskRollupByEpicId}
            onOpenTask={openTask}
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
          deleteDisabledReason={deleteDisabledReason}
          onCopyPath={copyPath}
          onManageScripts={manageScripts}
          onDelete={deleteWorktree}
          triggerLabel={`Worktree actions for ${branchLabel(entry)}`}
          label={`Delete worktree ${branchLabel(entry)}`}
          scriptsLabel="Manage script"
        />
      ) : null}
    </div>
  );
}, worktreeRowPropsEqual);

/** Leads every row with a text label (never color-only, for accessibility). */
function WorktreeTierPill(props: {
  readonly entry: WorktreeHostEntryV14;
  readonly tier: WorktreeTier;
  readonly state: WorktreeEnrichmentState;
}): ReactNode {
  // A dashed border + full-contrast text (never the muted/faded treatment a resolved-safe pill would use) reads
  // as "still resolving", not "quiet and fine" - pending status is not safe, so it must not look neutral-safe.
  if (props.state === "pending") {
    return (
      <TooltipWrapper
        label="Still checking this worktree's branch and PR state."
        side="top"
        sideOffset={undefined}
        align="center"
      >
        <Badge
          variant="outline"
          className="gap-1 font-medium border-dashed border-border bg-foreground/5 text-foreground"
          data-testid="worktree-tier-pill"
          data-tier="pending"
        >
          <AgentSpinningDots
            className={undefined}
            testId="worktree-tier-pill-pending-spinner"
            variant={undefined}
          />
          Checking…
        </Badge>
      </TooltipWrapper>
    );
  }
  // Styled in the same caution family the unknown-risk delete confirmation already uses (amber), but with a
  // dashed border and a distinct icon/label so it never reads as the proven "Review" tier.
  if (props.state === "unknown") {
    return (
      <TooltipWrapper
        label="Activity status couldn't be loaded. Refresh or scroll to retry."
        side="top"
        sideOffset={undefined}
        align="center"
      >
        <Badge
          variant="outline"
          className="gap-1 font-medium border-dashed border-amber-600/40 bg-amber-500/5 text-amber-700 dark:border-amber-400/40 dark:text-amber-300/90"
          data-testid="worktree-tier-pill"
          data-tier="unknown"
        >
          <HelpCircle className="size-3" aria-hidden />
          Unknown
        </Badge>
      </TooltipWrapper>
    );
  }
  const unavailable = props.state === "unavailable";
  const style = WORKTREE_TIER_PILL_STYLE[props.tier];
  const reviewReasons = reviewTooltipReasons(props.entry, props.tier);
  const tierTooltip =
    reviewReasons.length === 0 ? (
      WORKTREE_TIER_TOOLTIP[props.tier]
    ) : (
      <div className="max-w-[min(90vw,24rem)] space-y-1">
        {reviewReasons.map((reason) => (
          <p key={reason}>{reason}</p>
        ))}
      </div>
    );
  const tooltip = unavailable ? (
    <div className="max-w-[min(90vw,24rem)] space-y-1">
      <p>Status couldn't be refreshed; showing the last known tier.</p>
      {typeof tierTooltip === "string" ? <p>{tierTooltip}</p> : tierTooltip}
    </div>
  ) : (
    tierTooltip
  );
  return (
    <TooltipWrapper
      label={tooltip}
      side="top"
      sideOffset={undefined}
      align="center"
    >
      <Badge
        variant="outline"
        className={cn("gap-1 font-medium", style.className)}
        data-testid="worktree-tier-pill"
        data-tier={props.tier}
        data-status={unavailable ? "unavailable" : "ready"}
      >
        <WorktreeTierPillIcon tier={props.tier} />
        {unavailable ? <HelpCircle className="size-3" aria-hidden /> : null}
        {WORKTREE_TIER_LABEL[props.tier]}
      </Badge>
    </TooltipWrapper>
  );
}

function WorktreeTierPillIcon(props: {
  readonly tier: WorktreeTier;
}): ReactNode {
  if (props.tier === "merged") {
    return <GitMerge className="size-3" aria-hidden />;
  }
  if (props.tier === "at-base-commit") {
    return <GitCommitHorizontal className="size-3" aria-hidden />;
  }
  return null;
}

const WORKTREE_TIER_PILL_STYLE: Record<
  WorktreeTier,
  { readonly className: string }
> = {
  merged: {
    className:
      "border-emerald-600/30 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-300",
  },
  "at-base-commit": {
    className:
      "border-emerald-600/25 bg-emerald-500/8 text-emerald-700/90 dark:border-emerald-400/25 dark:text-emerald-300/85",
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
    className: "bg-foreground/8 text-muted-foreground",
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

interface WorktreePrChipModel {
  readonly key: string;
  readonly label: string;
  readonly ariaLabel: string;
  readonly prState: WorktreeDisplayedPrState;
  readonly prUrl: string;
}

interface WorktreeMutedPrChipModel {
  readonly key: string;
  readonly label: string;
  readonly tooltip: ReactNode;
}

function WorktreePrChips(props: {
  readonly entry: WorktreeHostEntryV14;
}): ReactNode {
  const chips = worktreePrChips(props.entry);
  if (chips.length === 0) return null;
  return chips.map((chip) =>
    "prUrl" in chip ? (
      <WorktreePrChip key={chip.key} chip={chip} />
    ) : (
      <WorktreeMutedPrChip key={chip.key} chip={chip} />
    ),
  );
}

function worktreePrChips(
  entry: WorktreeHostEntryV14,
): readonly (WorktreePrChipModel | WorktreeMutedPrChipModel)[] {
  return [
    ...superprojectPrChip(entry),
    ...entry.submodules.flatMap((submodule) => [
      ...submodulePrChip(submodule),
      ...submoduleUnmergedChip(submodule),
    ]),
  ];
}

function superprojectPrChip(
  entry: WorktreeHostEntryV14,
): readonly WorktreePrChipModel[] {
  const prState = displayedPrState(entry.prState);
  if (prState === null || entry.prNumber === null || entry.prUrl === null) {
    return [];
  }
  return [
    {
      key: `superproject:${entry.prNumber}:${entry.prUrl}`,
      label: `#${entry.prNumber} ${WORKTREE_PR_STATE_LABEL[prState]}`,
      ariaLabel: `Open PR #${entry.prNumber} ${WORKTREE_PR_STATE_LABEL[prState]}`,
      prState,
      prUrl: entry.prUrl,
    },
  ];
}

function submodulePrChip(
  submodule: WorktreeSubmoduleMergeFactV12,
): readonly WorktreePrChipModel[] {
  const prState = displayedPrState(submodule.prState);
  if (
    prState === null ||
    submodule.prNumber === null ||
    submodule.prUrl === null
  ) {
    return [];
  }
  const repoName = submodule.repoIdentifier.repo;
  return [
    {
      key: `submodule:${submodule.repoIdentifier.owner}/${repoName}:${submodule.branch}:${submodule.prNumber}:${submodule.prUrl}`,
      label: `${repoName} #${submodule.prNumber} ${WORKTREE_PR_STATE_LABEL[prState]}`,
      ariaLabel: `Open ${repoName} PR #${submodule.prNumber} ${WORKTREE_PR_STATE_LABEL[prState]}`,
      prState,
      prUrl: submodule.prUrl,
    },
  ];
}

function submoduleUnmergedChip(
  submodule: WorktreeSubmoduleMergeFactV12,
): readonly WorktreeMutedPrChipModel[] {
  if (
    submodule.prState !== "none" ||
    submodule.mergedIntoDefault ||
    submodule.atPinnedCommit
  ) {
    return [];
  }
  const count = submodule.unmergedCommitCount ?? null;
  const subjects = submodule.unmergedCommitSubjects ?? null;
  // Subjects are display-only and not unique ("wip", "Merge branch …" repeat), so key each by its occurrence
  // ordinal - unique without leaning on the array index (react/no-array-index-key).
  const occurrences = new Map<string, number>();
  const subjectItems = (subjects ?? []).map((subject) => {
    const ordinal = (occurrences.get(subject) ?? 0) + 1;
    occurrences.set(subject, ordinal);
    return { key: `${subject}#${ordinal}`, subject };
  });
  return [
    {
      key: `submodule-unmerged:${submodule.repoIdentifier.owner}/${submodule.repoIdentifier.repo}:${submodule.branch}`,
      label:
        count !== null && count >= 1
          ? `${submodule.repoIdentifier.repo} · ${count} unmerged commit${count === 1 ? "" : "s"}`
          : `${submodule.repoIdentifier.repo} · unmerged commits`,
      tooltip: (
        <div className="max-w-[min(90vw,24rem)] space-y-1.5">
          <p>
            This submodule branch has commits that never landed on{" "}
            {submodule.repoIdentifier.repo}'s main branch. Deleting the worktree
            deletes the branch and these commits with it
            {subjects === null ? "." : ":"}
          </p>
          {subjects === null ? null : (
            <>
              <ul className="list-inside list-disc">
                {subjectItems.map((item) => (
                  <li key={item.key}>{item.subject}</li>
                ))}
              </ul>
              {count !== null && count > subjects.length ? (
                <p>…and {count - subjects.length} more</p>
              ) : null}
            </>
          )}
        </div>
      ),
    },
  ];
}

type WorktreeDisplayedPrState = "open" | "closed" | "merged";

const WORKTREE_PR_STATE_LABEL: Record<WorktreeDisplayedPrState, string> = {
  open: "Open",
  closed: "Closed",
  merged: "Merged",
};

function WorktreePrChip(props: {
  readonly chip: WorktreePrChipModel;
}): ReactNode {
  const style = WORKTREE_PR_PILL_STYLE[props.chip.prState];
  return (
    <Badge
      asChild
      variant="outline"
      className={cn("gap-1 font-medium", style.className)}
    >
      <WorktreePrAnchor
        href={props.chip.prUrl}
        ariaLabel={props.chip.ariaLabel}
        className="max-w-[min(60vw,16rem)]"
        testId="worktree-pr-chip"
        prState={props.chip.prState}
      >
        <span className="truncate">{props.chip.label}</span>
        <ExternalLink className="size-3" aria-hidden />
      </WorktreePrAnchor>
    </Badge>
  );
}

function displayedPrState(
  prState: WorktreePrState | null,
): WorktreeDisplayedPrState | null {
  if (prState === "open" || prState === "closed" || prState === "merged") {
    return prState;
  }
  return null;
}

const WORKTREE_PR_PILL_STYLE: Record<
  WorktreeDisplayedPrState,
  { readonly className: string }
> = {
  open: {
    className:
      "border-green-600/30 bg-green-500/10 text-green-700 dark:border-green-400/30 dark:text-green-300",
  },
  closed: {
    className:
      "border-red-600/25 bg-red-500/10 text-red-700 dark:border-red-400/25 dark:text-red-300",
  },
  merged: {
    className:
      "border-purple-600/30 bg-purple-500/10 text-purple-700 dark:border-purple-400/30 dark:text-purple-300",
  },
};

function WorktreeMutedPrChip(props: {
  readonly chip: WorktreeMutedPrChipModel;
}): ReactNode {
  return (
    <TooltipWrapper
      label={props.chip.tooltip}
      side="top"
      sideOffset={undefined}
      align="center"
    >
      <Badge
        variant="outline"
        className="gap-1 border-border/40 bg-foreground/3 font-medium text-muted-foreground"
        data-testid="worktree-pr-chip"
        data-pr-state="unmerged"
      >
        <span className="max-w-[min(60vw,16rem)] truncate">
          {props.chip.label}
        </span>
      </Badge>
    </TooltipWrapper>
  );
}

function WorktreePrAnchor(props: {
  readonly href: string;
  readonly ariaLabel: string;
  readonly className: string | undefined;
  readonly testId: string | undefined;
  readonly prState: WorktreeDisplayedPrState | undefined;
  readonly children: ReactNode;
}): ReactNode {
  const openLink = useOpenLink();
  const openExternal = useCallback(
    (event: MouseEvent<HTMLAnchorElement>): void => {
      event.stopPropagation();
      event.preventDefault();
      void openLink(props.href, "github", event);
    },
    [openLink, props.href],
  );
  return (
    <a
      href={props.href}
      aria-label={props.ariaLabel}
      className={props.className}
      data-testid={props.testId}
      data-pr-state={props.prState}
      onClick={openExternal}
      onAuxClick={onMiddleClick(openExternal)}
    >
      {props.children}
    </a>
  );
}

/** Unknown epic titles demote to muted text but still keep the row out of green tiers. No owners is not the Orphaned tier (`gitRemovable: false`). */
function WorktreeTaskAssociation(props: {
  readonly owners: WorktreeHostEntryV14["owners"];
  readonly taskTitlesByEpicId: ReadonlyMap<string, string>;
  readonly taskRollupByEpicId: ReadonlyMap<string, TaskMergeRollup>;
  readonly onOpenTask: (epicId: string) => void;
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
        <span key={item.epicId} className="flex items-center gap-1">
          <Badge
            asChild
            variant="outline"
            className="max-w-[min(60vw,16rem)] cursor-pointer font-normal hover:bg-foreground/5 hover:text-muted-foreground"
          >
            <TooltipWrapper
              label={item.title}
              side="top"
              sideOffset={undefined}
              align={undefined}
            >
              <button
                type="button"
                aria-label={`Open Task ${item.title}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onOpenTask(item.epicId);
                }}
              >
                <span className="truncate">{item.title}</span>
              </button>
            </TooltipWrapper>
          </Badge>
          <TaskMergeRollupBadge
            rollup={props.taskRollupByEpicId.get(item.epicId) ?? null}
          />
        </span>
      ))}
      {unresolvedCount > 0 ? (
        <span className="text-ui-xs text-muted-foreground/70">
          Owner unresolved
        </span>
      ) : null}
    </span>
  );
}

/** Quiet caption, never a colored badge - must not compete with the row's worktree-tier pill. Renders nothing when there is no merged progress to claim. */
function TaskMergeRollupBadge(props: {
  readonly rollup: TaskMergeRollup | null;
}): ReactNode {
  const rollup = props.rollup;
  if (rollup === null || rollup.status === "none") return null;
  const fullyMerged = rollup.status === "merged";
  return (
    <TooltipWrapper
      label={
        fullyMerged
          ? "Every branch this Task owns has a merged PR"
          : `${rollup.merged} of ${rollup.total} owned branches merged`
      }
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        className="text-ui-xs text-muted-foreground"
        data-testid="task-merge-rollup"
        data-rollup-status={rollup.status}
      >
        Task {taskMergeRollupLabel(rollup)}
      </span>
    </TooltipWrapper>
  );
}

/** Rendered inline in the secondary facts line only when a timestamp is present. */
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
    <TooltipWrapper
      label={label}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
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
    </TooltipWrapper>
  );
}

const WORKTREE_DELETE_DISABLED_COPY: Record<
  "checking",
  { readonly ariaLabel: string; readonly selectTooltip: string }
> = {
  checking: {
    ariaLabel: "Delete worktree (status is still being checked)",
    selectTooltip: "Status is still being checked",
  },
};

function WorktreeSelectionControl(props: {
  readonly entry: WorktreeHostEntry;
  readonly selected: boolean;
  readonly canSelect: boolean;
  readonly deleting: boolean;
  readonly selectDisabledReason: "checking" | null;
  readonly onToggleSelection: () => void;
}): ReactNode {
  // Defaulting would announce "In use by an active agent" to assistive tech for a row nobody is using.
  const selectDisabledReason = props.selectDisabledReason;
  const checkbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.selected && props.canSelect ? "true" : "false"}
      aria-disabled={!props.canSelect}
      aria-label={`Select worktree ${branchLabel(props.entry)}`}
      aria-description={
        props.canSelect || selectDisabledReason === null
          ? undefined
          : WORKTREE_DELETE_DISABLED_COPY[selectDisabledReason].selectTooltip
      }
      data-testid="worktree-row-select"
      className={cn(
        "flex size-4 items-center justify-center rounded-sm border transition-[border-color,background-color,color,opacity] outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
        worktreeSelectionCheckboxVisibility({
          isSelected: props.selected,
          canSelect: props.canSelect,
        }),
        props.canSelect ? "cursor-pointer" : "cursor-not-allowed",
        props.selected && props.canSelect
          ? "border-foreground/70 bg-foreground text-background"
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
  if (props.canSelect || props.deleting || selectDisabledReason === null) {
    return checkbox;
  }
  return (
    <TooltipWrapper
      label={WORKTREE_DELETE_DISABLED_COPY[selectDisabledReason].selectTooltip}
      side="top"
      sideOffset={undefined}
      align="start"
    >
      <span className="inline-flex shrink-0">{checkbox}</span>
    </TooltipWrapper>
  );
}

/** Persistent row-end actions: one quiet overflow trigger at rest. */
function WorktreeRowActions(props: {
  readonly deleteDisabledReason: "checking" | null;
  readonly onCopyPath: () => void;
  readonly onManageScripts: () => void;
  readonly onDelete: () => void;
  readonly triggerLabel: string;
  readonly label: string;
  readonly scriptsLabel: string;
}): ReactNode {
  const deleteDisabled = props.deleteDisabledReason !== null;
  const deleteLabel =
    props.deleteDisabledReason === null
      ? props.label
      : WORKTREE_DELETE_DISABLED_COPY[props.deleteDisabledReason].ariaLabel;
  return (
    <div className="absolute right-4 top-1/2 flex -translate-y-1/2 items-center gap-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={props.triggerLabel}
            data-testid="worktree-row-actions-trigger"
            className="text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-max min-w-32 max-w-[min(80vw,14rem)] p-1.5"
          data-testid="worktree-row-actions-menu"
        >
          <DropdownMenuItem
            data-testid="worktree-row-copy-path"
            onSelect={props.onCopyPath}
            className="gap-2 px-2 py-2"
          >
            <Copy className="size-3.5" aria-hidden />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="worktree-row-manage-scripts"
            aria-haspopup="dialog"
            onSelect={props.onManageScripts}
            className="items-start gap-2 whitespace-normal px-2 py-2 text-left leading-snug"
          >
            <FileSliders className="size-3.5" aria-hidden />
            {props.scriptsLabel}
          </DropdownMenuItem>
          <TooltipWrapper
            label={deleteLabel}
            side="top"
            sideOffset={undefined}
            align={undefined}
          >
            {/* `flex w-full`, not `inline-flex`: the guard becomes the menu content's layout child, and a shrink-to-fit one
               would narrow the row to its text. */}
            <span className="flex w-full">
              <DropdownMenuItem
                data-testid="worktree-row-delete"
                variant="destructive"
                aria-label={deleteLabel}
                disabled={deleteDisabled}
                onSelect={props.onDelete}
                className="gap-2 px-2 py-2"
              >
                <Trash2 className="size-3.5" aria-hidden />
                Delete worktree
              </DropdownMenuItem>
            </span>
          </TooltipWrapper>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
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
      scriptsNote={null}
      repositoryDefaultsSlot={null}
      inUseNote={
        target.inUse ? "This worktree is in use by an active agent." : null
      }
      saveLabel="Save"
      // Settings stashes the reviewed scripts synchronously for its delete flow;
      // wrap in a resolved promise so the shared dialog's success path runs.
      onSave={(scripts) => Promise.resolve(onSave(target, scripts))}
      // No nested editor to protect here (no Branch naming section) - plain
      // Escape-closes-the-dialog behavior.
      onEscapeKeyDown={() => {}}
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
      {props.tone === "error" ? (
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Could not load worktrees",
            message: null,
            code: null,
            source: "Worktrees",
          })}
          presentation="icon"
          className="text-current"
        />
      ) : null}
    </div>
  );
}

interface WorktreeRepoGroup {
  readonly key: string;
  readonly label: string;
  readonly items: WorktreeHostEntryV14[];
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

/** Rows within each repo group are ordered by creation time - "Newest" (default, most recently created first)
 * or "Oldest". */
function groupByRepo(
  worktrees: readonly WorktreeHostEntryV14[],
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
  a: WorktreeHostEntryV14,
  b: WorktreeHostEntryV14,
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

/** Whitespace-only queries pass everything through. A hit in either matches, so a query is never made narrower
 * by the PR leg being cold. */
function filterWorktrees(
  worktrees: readonly WorktreeHostEntryV14[],
  searchText: string,
  searchHaystackByPath: ReadonlyMap<string, string>,
  prHaystackByPath: ReadonlyMap<string, string>,
): readonly WorktreeHostEntryV14[] {
  const needle = searchText.trim().toLowerCase();
  if (needle.length === 0) return worktrees;
  return worktrees.filter(
    (entry) =>
      (searchHaystackByPath.get(entry.worktreePath) ?? "").includes(needle) ||
      (prHaystackByPath.get(entry.worktreePath) ?? "").includes(needle),
  );
}

function buildWorktreeSearchHaystackByPath(
  worktrees: readonly WorktreeHostEntryV14[],
  taskTitlesByEpicId: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(
    worktrees.map((entry) => [
      entry.worktreePath,
      worktreeSearchHaystack(entry, taskTitlesByEpicId),
    ]),
  );
}

function worktreeSearchHaystack(
  entry: WorktreeHostEntryV14,
  taskTitlesByEpicId: ReadonlyMap<string, string>,
): string {
  const titles = entry.owners.flatMap((owner) => {
    const title = taskTitlesByEpicId.get(owner.epicId);
    return title === undefined ? [] : [title];
  });
  return [
    entry.repoLabel,
    entry.branch ?? "",
    gitUnreadableOf(entry) ? "unreadable" : "",
    entry.worktreePath,
    ...titles,
  ]
    .join("\n")
    .toLowerCase();
}

/** PR numbers get their own index because they live on a different clock to the base fields: the host pins
 * `prNumber: null` on every base row and only the per-path activity probe fills it in. */
function buildWorktreePrHaystackByPath(
  worktrees: readonly WorktreeHostEntryV14[],
): ReadonlyMap<string, string> {
  return new Map(
    worktrees.map((entry) => [entry.worktreePath, worktreePrHaystack(entry)]),
  );
}

function worktreePrHaystack(entry: WorktreeHostEntryV14): string {
  return [entry.prNumber, ...entry.submodules.map((sub) => sub.prNumber)]
    .filter((prNumber): prNumber is number => prNumber !== null)
    .map((prNumber) => `#${prNumber}`)
    .join("\n");
}

function deleteDialogCopy(entry: WorktreeHostEntryV14): {
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
    !status.mergedIntoDefault &&
    !provenRemovable(entry)
  ) {
    const count = status.ahead;
    const plural = count === 1 ? "" : "s";
    return {
      title: `Delete worktree with ${count} unpushed commit${plural}?`,
      description: `${branch} has ${count} commit${plural} not on the default branch. Removing the worktree keeps the branch ref, but that work exists only here. Traycer runs the repo's teardown script, then removes ${entry.worktreePath}.`,
      actionLabel: "Delete worktree",
    };
  }
  // Removing the worktree keeps the branch ref - the commits survive on the branch - but they were never pushed
  // anywhere, so this machine is the only copy.
  if (
    status !== null &&
    status.ahead === null &&
    !status.mergedIntoDefault &&
    !provenRemovable(entry)
  ) {
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

/** Names that explicitly instead of falling back to the generic "clean" copy, which would understate the risk. */
function unknownRiskDeleteDialogCopy(entry: WorktreeHostEntryV14): {
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
      description: `${branch} has ${count} uncommitted change${plural} that will be permanently lost. Its branch and activity status also could not be verified, so Traycer cannot confirm the rest of this worktree is safe to remove either. Traycer runs the repo's teardown script, then force-removes ${entry.worktreePath}.`,
      actionLabel: "Delete and discard",
    };
  }
  return {
    title: "Delete worktree with unknown status?",
    description: `${branch}'s branch and activity status could not be verified, so Traycer cannot confirm this worktree is safe to remove or free of unpushed work. Traycer runs the repo's teardown script, then removes ${entry.worktreePath}.`,
    actionLabel: "Delete anyway",
  };
}

/** The single dialog's fields are pre-defaulted so the render site reads them unconditionally. */
function deriveWorktreeDeleteDialogs(
  resolution: {
    readonly kept: readonly WorktreeHostEntryV14[];
    readonly dropped: readonly WorktreeHostEntryV14[];
  } | null,
  deleteEnrichmentStateFor: (worktreePath: string) => WorktreeEnrichmentState,
  visibleWorktrees: readonly WorktreeHostEntryV14[],
  erroredPaths: ReadonlySet<string>,
): {
  readonly singleDialog: {
    readonly open: boolean;
    readonly title: string;
    readonly description: string;
    readonly actionLabel: string;
  };
  readonly bulkDeleteSummary: WorktreeBulkDeleteSummary | null;
} {
  const kept = resolution === null ? null : resolution.kept;
  const singleTarget = kept !== null && kept.length === 1 ? kept[0] : null;
  const singleCopy =
    singleTarget === null
      ? null
      : singleWorktreeDeleteDialogCopy(
          singleTarget,
          deleteEnrichmentStateFor(singleTarget.worktreePath),
        );
  return {
    singleDialog:
      singleCopy === null
        ? { open: false, title: "", description: "", actionLabel: "Delete" }
        : { open: true, ...singleCopy },
    bulkDeleteSummary:
      kept !== null && kept.length > 1
        ? summarizeBulkWorktreeDelete(kept, visibleWorktrees, erroredPaths)
        : null,
  };
}

/** An `Unknown` row (settled enrichment error) is deletable, but only through explicit unknown-risk copy -
 * never the generic confirmation, which would understate that its branch/activity status was never proven. */
function singleWorktreeDeleteDialogCopy(
  entry: WorktreeHostEntryV14,
  enrichment: WorktreeEnrichmentState,
): {
  readonly title: string;
  readonly description: string;
  readonly actionLabel: string;
} {
  if (enrichment === "unknown" || gitUnreadableOf(entry)) {
    return unknownRiskDeleteDialogCopy(entry);
  }
  return deleteDialogCopy(entry);
}

/** A row that regressed to `Checking` (a refresh/retry re-armed its enrichment between dialog-open and confirm)
 * is named separately. */
function worktreeDropMessage(
  dropped: readonly WorktreeHostEntryV14[],
  isChecking: (worktreePath: string) => boolean,
): string {
  const checkingDropped = dropped.filter((entry) =>
    isChecking(entry.worktreePath),
  );
  const otherDropped = dropped.filter(
    (entry) => !isChecking(entry.worktreePath),
  );
  const parts = [
    ...(checkingDropped.length === 0
      ? []
      : [`${checkingDropped.length} still checking status`]),
    ...(otherDropped.length === 0
      ? []
      : [countWorktreeClasses(otherDropped, WORKTREE_EXCLUSION_ORDER)]),
  ];
  const plural = dropped.length === 1 ? "" : "s";
  const verb = dropped.length === 1 ? "was" : "were";
  return `${dropped.length} worktree${plural} became ineligible and ${verb} skipped: ${parts.join(", ")}.`;
}

interface WorktreeBulkDeleteSummary {
  readonly count: number;
  readonly title: string;
  readonly actionLabel: string;
  readonly classSummary: string;
  readonly dirtyLoss: string | null;
  readonly unverifiedCaveat: string | null;
  readonly unknownRiskCaveat: string | null;
  readonly exclusions: string | null;
  readonly paths: readonly string[];
}

// Buckets a worktree into exactly one delete class, cautionary signals first so
// a would-be-lost row is never mislabeled as a proven-clean one.
type WorktreeDeleteClass =
  | "in-use"
  | "merged"
  | "at-base"
  | "clean"
  | "unverified"
  | "unmerged"
  | "detached"
  | "orphaned"
  | "unreadable"
  | "dirty";

function worktreeDeleteClass(entry: WorktreeHostEntryV14): WorktreeDeleteClass {
  if (entry.inUse) return "in-use";
  // Derive the tier-level bucket from the one shared classifier so the bulk copy and the row pill can never
  // disagree (no parallel precedence ladder).
  const tier = classifyWorktreeTier(entry);
  if (tier === "merged") return "merged";
  if (tier === "at-base-commit") return "at-base";
  if (tier === "unreferenced") return "clean";
  if (tier === "orphaned") return "orphaned";
  // Handing it to the loss sub-classifier would bucket it as `detached` and the confirmation would report a git
  // state nobody observed - the exact false-precision this row exists to avoid.
  if (gitUnreadableOf(entry)) return "unreadable";
  return worktreeReviewLossClass(entry);
}

/** Called only for the `review` tier now that green, orphaned, and in-use cases are already handled above. */
function worktreeReviewLossClass(
  entry: WorktreeHostEntryV14,
): WorktreeDeleteClass {
  const status = entry.branchStatus;
  if (entry.uncommittedCount > 0) return "dirty";
  if (entry.branch === null) return "detached";
  // Not proven at the upstream tip: real local-only commits (`ahead > 0`) OR a never-pushed branch with no
  // upstream to prove them absent (`ahead === null`).
  if (status !== null && (status.ahead === null || status.ahead > 0)) {
    return "unmerged";
  }
  if (status !== null && status.ahead === 0) return "clean";
  return "unverified";
}

const WORKTREE_DELETE_CLASS_LABEL: Record<WorktreeDeleteClass, string> = {
  "in-use": "in use",
  merged: "merged",
  "at-base": "at base commit",
  clean: "clean (no local-only commits)",
  unverified: "unreferenced (branch status unverified)",
  unmerged: "unmerged (local-only commits)",
  detached: "detached HEAD",
  orphaned: "orphaned",
  unreadable: "unreadable (git can't read the worktree)",
  dirty: "dirty",
};

// Safe-to-risky for the "Deleting" summary; risky-to-safe for the "not selected"
// exclusion line (name the reasons a row was left out first).
const WORKTREE_DELETE_SUMMARY_ORDER: readonly WorktreeDeleteClass[] = [
  "merged",
  "at-base",
  "clean",
  "unverified",
  "unmerged",
  "detached",
  "orphaned",
  "unreadable",
  "dirty",
  "in-use",
];
const WORKTREE_EXCLUSION_ORDER: readonly WorktreeDeleteClass[] = [
  "in-use",
  "dirty",
  "unreadable",
  "unmerged",
  "detached",
  "orphaned",
  "unverified",
  "clean",
  "at-base",
  "merged",
];

function countWorktreeClasses(
  entries: readonly WorktreeHostEntryV14[],
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

/** Aggregates the selected targets by class (never 38 stacked warnings), names concrete loss for dirty rows,
 * and - for the null-status cohort - uses deliberately neutral caveat wording (never "safe" / "loss-free"). */
function summarizeBulkWorktreeDelete(
  targets: ReadonlyArray<WorktreeHostEntryV14>,
  visible: readonly WorktreeHostEntryV14[],
  unknownPaths: ReadonlySet<string>,
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
  const unknownTargets = targets.filter(
    (entry) => unknownPaths.has(entry.worktreePath) || gitUnreadableOf(entry),
  );
  const unknownRiskCaveat =
    unknownTargets.length === 0
      ? null
      : `Activity status for ${unknownTargets.length} worktree${
          unknownTargets.length === 1 ? "" : "s"
        } could not be checked. Traycer cannot confirm those are safe to remove or free of unpushed work. Commit, stash, or push anything you want to keep first.`;
  const excluded = visible.filter(
    (entry) => !targetPaths.has(entry.worktreePath),
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
    unknownRiskCaveat,
    exclusions:
      exclusionSummary === null
        ? null
        : `${excluded.length} not selected: ${exclusionSummary}`,
    paths: targets.map((entry) => entry.worktreePath),
  };
}

function worktreeCanBeSelected(
  entry: WorktreeHostEntryV14,
  deleteStatusByPath: ReadonlyMap<string, WorktreeRowDeleteStatus>,
  deleteEnrichment: WorktreeEnrichmentState,
): boolean {
  return (
    (entry.resolvedAt !== null || deleteEnrichment === "unknown") &&
    !deleteStatusByPath.has(entry.worktreePath)
  );
}

function worktreeIsSelectAllEligible(
  entry: WorktreeHostEntryV14,
  deleteStatusByPath: ReadonlyMap<string, WorktreeRowDeleteStatus>,
  deleteEnrichment: WorktreeEnrichmentState,
): boolean {
  return (
    worktreeCanBeSelected(entry, deleteStatusByPath, deleteEnrichment) &&
    !entry.inUse
  );
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

// Checkboxes are always rendered (no selection mode) - subtle by default, full once the row is hovered/focused
// or the box is checked. Standard list pattern.
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
  if (gitUnreadableOf(entry)) return "unreadable";
  return entry.branch ?? "detached HEAD";
}

function gitUnreadableOf(entry: WorktreeHostEntry): boolean {
  return (
    "gitUnreadable" in entry &&
    typeof entry.gitUnreadable === "boolean" &&
    entry.gitUnreadable
  );
}

function reviewTooltipReasons(
  entry: WorktreeHostEntryV14,
  tier: WorktreeTier,
): readonly string[] {
  if (tier !== "review") return [];
  if (!gitUnreadableOf(entry) && entry.branchStatus === null) return [];
  return describeReviewReasons(entry);
}

function unresolvedWorktreeSecondaryCopy(
  enrichment: WorktreeEnrichmentState,
): string {
  if (enrichment === "unknown") {
    return "Couldn't verify this worktree with git. Refresh to retry, or delete it.";
  }
  return "Waiting for host verification…";
}

function invalidateWorktreeDeleteCaches(
  queryClient: QueryClient,
  hostId: string,
): void {
  // Listing ("active", sweep-aware) + binding-backed pickers ("all") - the
  // shared post-delete slice; see the helper for the refetchType rationale.
  invalidateWorktreeListingAndBindingCaches(queryClient, hostId);
  // A deleted worktree's directory is gone, so its cached `git.getCapabilities` (5-min staleTime) would
  // otherwise keep reporting the stale `available: true` and strand the git panel.
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "git.getCapabilities"),
  });
}
