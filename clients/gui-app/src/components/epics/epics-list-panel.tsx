import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  Layers,
  ListChecks,
  Pencil,
  Pin,
  RefreshCwIcon,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { openEpicInBackground } from "@/lib/commands/actions/open-epic-in-background";
import {
  useHistoryOpenInNewWindowFlow,
  type HistoryNewWindowFlow,
} from "@/components/epics/use-history-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { DeleteTasksDialog } from "@/components/epics/delete-tasks-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useEpicBatchDelete } from "@/hooks/epic/use-epic-batch-delete-mutation";
import { useTaskDeleteWorktreeCandidates } from "@/hooks/epic/use-task-delete-worktree-candidates-query";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { withMemberToggled } from "@/lib/immutable-set";
import { cn } from "@/lib/utils";
import { createReportIssueContext } from "@/lib/report-issue-context";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Skeleton } from "@/components/ui/skeleton";
import { ClearFiltersButton } from "@/components/home/toolbar/clear-filters-button";
import type {
  HistoryItem,
  HistoryWorkspaceRef,
  HistorySortOption,
} from "@/components/home/data/home-page.data";
import {
  canDeleteHistoryItem,
  canEditHistoryItemTitle,
  DEFAULT_SORT,
} from "@/components/home/data/home-page.data";
import { EpicsFilterPopover } from "@/components/epics/epics-filter-popover";
import { EpicsSortMenu } from "@/components/epics/epics-sort-menu";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  useHistoryQuery,
  type HistoryFacets,
} from "@/hooks/home/use-history-query";
import { useEpicActivityStatus } from "@/hooks/epic/use-epic-activity-status";
import { useHostNotificationIndicators } from "@/hooks/notifications/use-host-notification-indicators-query";
import {
  useAmbientHistorySearchState,
  useRouteHistorySearchState,
  type HistorySearchController,
} from "@/hooks/home/use-history-search-state";
import { useRefreshSpinner } from "@/hooks/use-refresh-spinner";
import { phaseMigrationRoute } from "@/lib/routes";
import { epicDisplayTitle } from "@/lib/display-title";
import { openEpicFromList as openEpicFromCommand } from "@/lib/commands/actions/open-epic-from-list";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  HistorySearchPatch,
  HistorySearchState,
} from "@/lib/history-search";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import { WorktreePrPills } from "@/components/worktree/worktree-pr-metadata";
import { worktreePrReferences } from "@/components/worktree/worktree-pr-metadata-model";

const EMPTY_REPOS: ReadonlyArray<string> = [];
const EMPTY_WORKSPACES: ReadonlyArray<HistoryWorkspaceRef> = [];
const EMPTY_ITEMS: ReadonlyArray<HistoryItem> = [];
const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];
const EMPTY_WORKTREES_BY_EPIC: ReadonlyMap<
  string,
  readonly WorktreeHostEntryV12[]
> = new Map();
const VIEWER_DELETE_TOOLTIP = "Viewers cannot select task for deletion.";
const NO_DELETE_PERMISSION_TOOLTIP =
  "You don't have permission to delete this task.";
const HISTORY_REFRESH_TIMEOUT_MS = 10_000;

// Single source of a row's display label for both visible text and accessible
// names. `item.title` is the RAW title (epics can be empty); apply the
// source-aware "Untitled epic" fallback for epics, while phases already carry
// their own baked fallback and render verbatim.
function historyItemDisplayTitle(item: HistoryItem): string {
  return item.taskType === "phase"
    ? item.title
    : epicDisplayTitle({
        title: item.title,
        initialUserPrompt: item.initialUserPrompt,
      });
}

export type EpicsListPanelVariant = "page" | "embedded";

interface EpicsListPanelProps {
  readonly variant: EpicsListPanelVariant;
  /**
   * When set, row clicks invoke this callback instead of navigating
   * via the embedded `<Link>`. Used by the system-tab modal to close
   * the modal and route the user to the epic in one step.
   */
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly routeSearch: HistorySearchState | null;
  readonly historyNowMs: number | null;
  /**
   * Focus the search input once on mount. Set by the history modal so
   * opening it drops the caret straight into search; left off for the
   * `/epics` route and the embedded home list where a full-page focus
   * grab would be unwelcome.
   */
  readonly autoFocusSearch: boolean;
}

interface RouteEpicsListPanelProps {
  readonly variant: EpicsListPanelVariant;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly routeSearch: HistorySearchState;
  readonly historyNowMs: number | null;
  readonly autoFocusSearch: boolean;
}

interface AmbientEpicsListPanelProps {
  readonly variant: EpicsListPanelVariant;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly historyNowMs: number | null;
  readonly autoFocusSearch: boolean;
}

interface EpicsListPanelBodyProps {
  readonly variant: EpicsListPanelVariant;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly historyNowMs: number | null;
  readonly historySearch: HistorySearchController;
  readonly autoFocusSearch: boolean;
}

/**
 * Unified task-list panel rendered both inline on the home page
 * (`variant="embedded"`) and on the `/epics` route (`variant="page"`).
 *
 * Both variants share the same data source (`useHistoryQuery` →
 * `useCloudEpicTasksQuery`), filter / sort chrome, row visuals, and
 * "Show more" pagination. The page variant additionally renders the
 * route header (title + count) and the search input; the embedded
 * variant trims those to keep the landing page focused on the
 * composer.
 */
export function EpicsListPanel(props: EpicsListPanelProps): ReactNode {
  if (props.routeSearch === null) {
    return (
      <AmbientEpicsListPanel
        variant={props.variant}
        onSelectEpic={props.onSelectEpic}
        historyNowMs={props.historyNowMs}
        autoFocusSearch={props.autoFocusSearch}
      />
    );
  }
  return (
    <RouteEpicsListPanel
      variant={props.variant}
      onSelectEpic={props.onSelectEpic}
      routeSearch={props.routeSearch}
      historyNowMs={props.historyNowMs}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

function RouteEpicsListPanel(props: RouteEpicsListPanelProps): ReactNode {
  const historySearch = useRouteHistorySearchState(props.routeSearch);
  return (
    <EpicsListPanelBody
      variant={props.variant}
      onSelectEpic={props.onSelectEpic}
      historyNowMs={props.historyNowMs}
      historySearch={historySearch}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

function AmbientEpicsListPanel(props: AmbientEpicsListPanelProps): ReactNode {
  const historySearch = useAmbientHistorySearchState();
  return (
    <EpicsListPanelBody
      variant={props.variant}
      onSelectEpic={props.onSelectEpic}
      historyNowMs={props.historyNowMs}
      historySearch={historySearch}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

function EpicsListPanelBody(props: EpicsListPanelBodyProps): ReactNode {
  const { variant, onSelectEpic, historySearch } = props;
  // Destructure the stable `update`/`clear` functions (the hook returns a fresh
  // wrapper object each render, so closing over `historySearch.update` would
  // give the compiler an unstable dependency and re-create every handler each
  // render -> the whole chrome re-renders on each list update). Holding the
  // stable functions directly lets the compiler memoize the handlers, so
  // PanelChromeBar / PanelSearchInput / EpicsSortMenu bail unless their own
  // data actually changes.
  const { search, update: updateSearch, clear: clearSearch } = historySearch;
  const openInNewWindowFlow = useHistoryOpenInNewWindowFlow();

  const {
    data,
    isPending,
    isFetching,
    error,
    hostId,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useHistoryQuery({
    search,
    nowMs: props.historyNowMs,
  });

  const items = data?.items ?? EMPTY_ITEMS;
  const worktreesByEpicId = data?.worktreesByEpicId ?? EMPTY_WORKTREES_BY_EPIC;
  const indicatorEpicIds = useMemo(
    () => items.map((item) => item.epicId),
    [items],
  );
  const notificationIndicators = useHostNotificationIndicators({
    epicIds: indicatorEpicIds,
    chatIds: [],
    enabled: indicatorEpicIds.length > 0,
  });
  const availableRepos = data?.availableRepos ?? EMPTY_REPOS;
  const availableWorkspaces = data?.availableWorkspaces ?? EMPTY_WORKSPACES;
  const facets = data?.facets;

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectionMode, setSelectionMode] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] =
    useState<ReadonlyArray<string> | null>(null);
  // Explicit user overrides of the per-worktree checkbox. Absent entries fall
  // back to the default: only PROVEN-removable candidates (clean + a non-null
  // branch status that is merged or has no local-only commits) start checked;
  // unproven (null status) and dirty rows start unchecked. Cleared when the
  // dialog closes so a reopened dialog starts from defaults again.
  const [worktreeCheckOverrides, setWorktreeCheckOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());
  const deleteMutation = useEpicBatchDelete();
  const setPinnedMutation = useEpicSetPinned();
  const setPinned = setPinnedMutation.mutate;
  const pendingSetPinnedEpicIds = usePendingSetPinnedEpicIds();
  const handleSetPinned = useCallback(
    (epicId: string, pinned: boolean) => {
      setPinned({ epicId, pinned });
    },
    [setPinned],
  );

  const { candidates: worktreeCandidates } =
    useTaskDeleteWorktreeCandidates(pendingDeleteIds);
  const defaultCheckedByPath = useMemo(
    () =>
      new Map(
        worktreeCandidates.map((candidate) => [
          candidate.worktreePath,
          candidate.provenRemovable,
        ]),
      ),
    [worktreeCandidates],
  );
  const isWorktreePathChecked = useCallback(
    (worktreePath: string): boolean => {
      const override = worktreeCheckOverrides.get(worktreePath);
      if (override !== undefined) return override;
      return defaultCheckedByPath.get(worktreePath) ?? false;
    },
    [defaultCheckedByPath, worktreeCheckOverrides],
  );
  const toggleWorktreePathChecked = useCallback(
    (worktreePath: string, checked: boolean) => {
      setWorktreeCheckOverrides((prev) => {
        const next = new Map(prev);
        next.set(worktreePath, checked);
        return next;
      });
    },
    [],
  );
  const closeDeleteDialog = useCallback(() => {
    setPendingDeleteIds(null);
    setWorktreeCheckOverrides(new Map());
  }, []);

  const selectableItemIds = useMemo(
    () =>
      items
        .filter((item) => canDeleteHistoryItem(item))
        .map((item) => item.epicId),
    [items],
  );
  const selectableIdSet = useMemo(
    () => new Set(selectableItemIds),
    [selectableItemIds],
  );

  const toggleSelection = useCallback(
    (id: string) => {
      if (!selectableIdSet.has(id)) return;
      setSelectedIds((prev) => withMemberToggled(prev, id));
      setSelectionMode(true);
    },
    [selectableIdSet],
  );

  const requestDelete = useCallback(
    (ids: ReadonlyArray<string>) => {
      const deletableIds = ids.filter((id) => selectableIdSet.has(id));
      if (deletableIds.length === 0) return;
      setPendingDeleteIds(deletableIds);
    },
    [selectableIdSet],
  );

  const visibleSelectedIds = useMemo(() => {
    return Array.from(selectedIds).filter((id) => selectableIdSet.has(id));
  }, [selectableIdSet, selectedIds]);
  const selectedCount = visibleSelectedIds.length;
  const enterSelectionMode = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionMode(true);
  }, []);
  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(selectableItemIds));
  }, [selectableItemIds]);
  const deselectAllVisible = useCallback(() => {
    // Clear every check but stay in selection mode so "Deselect all" is a pure
    // toggle back to "Select all" rather than exiting the selection chrome.
    setSelectedIds(new Set());
  }, []);
  const cancelSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  }, []);

  const handleConfirmDelete = () => {
    if (pendingDeleteIds === null) return;
    const ids = pendingDeleteIds;
    const approvedWorktrees = worktreeCandidates
      .filter((candidate) => isWorktreePathChecked(candidate.worktreePath))
      .map((candidate) => ({
        worktreePath: candidate.worktreePath,
        ownerEpicIds: candidate.ownerEpicIds,
      }));
    deleteMutation.mutate(
      {
        ids: [...ids],
        worktreeCleanup:
          approvedWorktrees.length > 0
            ? { candidates: approvedWorktrees }
            : null,
      },
      {
        onSuccess: () => {
          setSelectedIds((prev) => {
            let next: Set<string> | null = null;
            for (const id of ids) {
              if (!prev.has(id)) continue;
              if (next === null) next = new Set(prev);
              next.delete(id);
            }
            return next ?? prev;
          });
          setSelectionMode(false);
          closeDeleteDialog();
        },
      },
    );
  };

  const hasActiveFilters = hasActiveHistoryFilters(search);

  const handleClear = () => {
    clearSearch();
  };
  const handleRetry = () => {
    void refetch();
  };

  const showChrome = variant === "page";

  return (
    <TooltipProvider>
      <section
        className={cn(
          "flex min-h-0 w-full flex-col",
          variant === "page" ? "mx-auto max-w-3xl flex-1 px-6 pt-6" : "mt-8",
        )}
      >
        {showChrome ? (
          <PanelSearchInput
            value={search.query}
            onChange={(next) => {
              updateSearch({ query: next });
            }}
            isFetching={isFetching}
            focusOnMount={props.autoFocusSearch}
          />
        ) : null}
        <PanelChromeBar
          filters={{ active: hasActiveFilters, onClear: handleClear }}
          selection={
            selectionMode
              ? {
                  kind: "active",
                  canSelect: selectableItemIds.length > 0,
                  selectedCount,
                  allVisibleSelected:
                    selectableItemIds.length > 0 &&
                    selectedCount === selectableItemIds.length,
                  isDeletePending: deleteMutation.isPending,
                  onSelectAll: selectAllVisible,
                  onDeselectAll: deselectAllVisible,
                  onCancel: cancelSelection,
                  onDeleteSelected: () => {
                    requestDelete(visibleSelectedIds);
                  },
                }
              : {
                  kind: "idle",
                  canSelect: selectableItemIds.length > 0,
                  onStart: enterSelectionMode,
                }
          }
          sort={search.sort}
          onSortChange={(next) => {
            updateSearch({ sort: next, sortExplicit: true });
          }}
          availableRepos={availableRepos}
          availableWorkspaces={availableWorkspaces}
          search={search}
          onSearchChange={updateSearch}
          facets={facets}
          refresh={{ isFetching, hostId, onRefetch: refetch }}
        />
        <NotificationIndicatorsProvider
          indicators={notificationIndicators.data}
        >
          <div className="min-h-0 flex-1 overflow-y-auto pb-10">
            <EpicsListBody
              error={error}
              isPending={isPending}
              isFetching={isFetching}
              hasActiveFilters={hasActiveFilters}
              items={items}
              onRetry={handleRetry}
              selectionMode={selectionMode}
              selectedIds={selectedIds}
              onToggleSelection={toggleSelection}
              onRequestDelete={requestDelete}
              onSetPinned={handleSetPinned}
              pendingSetPinnedEpicIds={pendingSetPinnedEpicIds}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              onLoadMore={fetchNextPage}
              onSelectEpic={onSelectEpic}
              onOpenInNewWindow={openInNewWindowFlow.requestOpen}
              openInNewWindowAvailable={openInNewWindowFlow.isAvailable}
              worktreesByEpicId={worktreesByEpicId}
            />
          </div>
        </NotificationIndicatorsProvider>
      </section>
      <DeleteTasksDialog
        open={pendingDeleteIds !== null}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
        title={describeDeleteTitle(pendingDeleteIds, items)}
        description="This action cannot be undone."
        isPending={deleteMutation.isPending}
        onConfirm={handleConfirmDelete}
        candidates={worktreeCandidates}
        isPathChecked={isWorktreePathChecked}
        onTogglePath={toggleWorktreePathChecked}
      />
      <UnsyncedEpicMoveDialog flow={openInNewWindowFlow.epicFlow} />
    </TooltipProvider>
  );
}

function hasActiveHistoryFilters(search: HistorySearchState): boolean {
  return (
    search.repos.length > 0 ||
    search.workspaces.length > 0 ||
    search.ownershipScopes.length > 0 ||
    (search.sortExplicit && search.sort !== DEFAULT_SORT) ||
    search.query.trim().length > 0
  );
}

interface PanelSearchInputProps {
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly isFetching: boolean;
  readonly focusOnMount: boolean;
}

function PanelSearchInput(props: PanelSearchInputProps): ReactNode {
  const inputRef = useRef<HTMLInputElement>(null);
  // Defer the focus to the next frame so it lands after Radix Dialog's
  // own mount focus-trap runs (the modal host wraps this surface). A
  // synchronous focus here would be clobbered by the dialog's
  // ancestor-level focus scope; the rAF wins the race.
  const { focusOnMount } = props;
  useEffect(() => {
    if (!focusOnMount) return;
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [focusOnMount]);
  return (
    <div className="px-2 pb-3">
      <InputGroup>
        <InputGroupAddon align="inline-start">
          {props.isFetching ? (
            <AgentSpinningDots
              testId="epics-list-search-spinner"
              variant="orbit"
              className="text-muted-foreground"
            />
          ) : (
            <Search />
          )}
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="text"
          role="searchbox"
          value={props.value}
          onChange={(event) => {
            props.onChange(event.target.value);
          }}
          placeholder="Search by title, repo, or PR"
          aria-label="Search tasks"
        />
        {props.value.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label="Clear search"
              onClick={() => {
                props.onChange("");
              }}
            >
              <X />
            </InputGroupButton>
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}

interface PanelFilterControls {
  readonly active: boolean;
  readonly onClear: () => void;
}

type PanelSelectionControls =
  | {
      readonly kind: "idle";
      readonly canSelect: boolean;
      readonly onStart: () => void;
    }
  | {
      readonly kind: "active";
      readonly canSelect: boolean;
      readonly selectedCount: number;
      readonly allVisibleSelected: boolean;
      readonly isDeletePending: boolean;
      readonly onSelectAll: () => void;
      readonly onDeselectAll: () => void;
      readonly onCancel: () => void;
      readonly onDeleteSelected: () => void;
    };

interface PanelRefreshControls {
  readonly isFetching: boolean;
  readonly hostId: string | null;
  readonly onRefetch: () => void | Promise<unknown>;
}

interface PanelChromeBarProps {
  readonly filters: PanelFilterControls;
  readonly selection: PanelSelectionControls;
  readonly sort: HistorySortOption;
  readonly onSortChange: (next: HistorySortOption) => void;
  readonly availableRepos: ReadonlyArray<string>;
  readonly availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  readonly search: HistorySearchState;
  readonly onSearchChange: (patch: HistorySearchPatch) => void;
  readonly facets: HistoryFacets | undefined;
  readonly refresh: PanelRefreshControls;
}

function PanelChromeBar(props: PanelChromeBarProps): ReactNode {
  const { isFetching, hostId, onRefetch } = props.refresh;
  const refreshTasks = useCallback(async () => {
    await onRefetch();
  }, [onRefetch]);
  const refresh = useRefreshSpinner({
    onRefresh: refreshTasks,
    externalRefreshing: isFetching,
    timeoutMs: HISTORY_REFRESH_TIMEOUT_MS,
  });

  return (
    <div className="flex items-center justify-between gap-2 px-2 pb-2">
      <div className="min-w-0">
        {props.filters.active ? (
          <ClearFiltersButton onClick={props.filters.onClear} />
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {props.selection.kind === "active" ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!props.selection.canSelect}
              onClick={
                props.selection.allVisibleSelected
                  ? props.selection.onDeselectAll
                  : props.selection.onSelectAll
              }
            >
              {props.selection.allVisibleSelected
                ? "Deselect all"
                : "Select all"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={props.selection.onCancel}
            >
              <X />
              Cancel
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={
                props.selection.selectedCount > 0
                  ? `Delete ${props.selection.selectedCount} selected epics`
                  : "Delete selected epics"
              }
              data-testid="epics-list-delete-selected"
              disabled={
                props.selection.selectedCount === 0 ||
                props.selection.isDeletePending
              }
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={props.selection.onDeleteSelected}
            >
              <Trash2 />
            </Button>
          </>
        ) : (
          <>
            <EpicsSortMenu value={props.sort} onChange={props.onSortChange} />
            <EpicsFilterPopover
              availableRepos={props.availableRepos}
              availableWorkspaces={props.availableWorkspaces}
              search={props.search}
              onSearchChange={props.onSearchChange}
              facets={props.facets}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label="Select history items"
              disabled={!props.selection.canSelect}
              className="gap-1.5 overflow-visible text-ui-sm text-muted-foreground hover:text-foreground"
              onClick={props.selection.onStart}
            >
              <ListChecks className="size-4" />
              Select
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh tasks"
              data-testid="epics-list-refresh"
              disabled={refresh.refreshing || hostId === null}
              onClick={refresh.trigger}
            >
              <RefreshCwIcon
                className={cn("size-4", refresh.refreshing && "animate-spin")}
              />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function describeDeleteTitle(
  ids: ReadonlyArray<string> | null,
  items: ReadonlyArray<HistoryItem>,
): string {
  if (ids === null || ids.length === 0) return "";
  if (ids.length > 1) return `Delete ${ids.length} epics?`;
  const match = items.find((item) => item.epicId === ids[0]);
  if (match === undefined) return "Delete 1 epic?";
  // `match.title` is RAW; apply the source-aware "Untitled epic" fallback (prompt
  // slice, else literal) for the rendered confirmation. Phases already carry
  // their own baked fallback.
  const matchTitle =
    match.taskType === "phase"
      ? match.title
      : epicDisplayTitle({
          title: match.title,
          initialUserPrompt: match.initialUserPrompt,
        });
  return `Delete "${matchTitle}"?`;
}

interface EpicsListBodyProps {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly hasActiveFilters: boolean;
  readonly items: ReadonlyArray<HistoryItem>;
  readonly onRetry: () => void;
  readonly selectionMode: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenInNewWindow: HistoryNewWindowFlow["requestOpen"];
  readonly openInNewWindowAvailable: boolean;
  readonly worktreesByEpicId: ReadonlyMap<
    string,
    readonly WorktreeHostEntryV12[]
  >;
}

function EpicsListBody(props: EpicsListBodyProps): ReactNode {
  const {
    error,
    isPending,
    isFetching,
    hasActiveFilters,
    items,
    onRetry,
    selectionMode,
    selectedIds,
    onToggleSelection,
    onRequestDelete,
    onSetPinned,
    pendingSetPinnedEpicIds,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    onSelectEpic,
    onOpenInNewWindow,
    openInNewWindowAvailable,
    worktreesByEpicId,
  } = props;

  if (error !== null) {
    return <EpicsListError error={error} onRetry={onRetry} />;
  }
  if (isPending) {
    return <EpicsListLoading />;
  }
  if (items.length === 0 && !hasActiveFilters) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
        data-testid="epics-list-empty"
      >
        <p className="font-medium text-foreground">No tasks yet</p>
      </div>
    );
  }
  if (items.length === 0 && hasActiveFilters && isFetching) {
    return <EpicsListFilteringLoading />;
  }
  return (
    <>
      {items.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="epics-list-rows">
          {items.map((item) => (
            <EpicsListRow
              key={item.id}
              item={item}
              selectionMode={selectionMode}
              isSelected={selectedIds.has(item.epicId)}
              onToggleSelection={onToggleSelection}
              onRequestDelete={onRequestDelete}
              onSetPinned={onSetPinned}
              isPinPending={pendingSetPinnedEpicIds.has(item.epicId)}
              onSelectEpic={onSelectEpic}
              onOpenInNewWindow={onOpenInNewWindow}
              openInNewWindowAvailable={openInNewWindowAvailable}
              worktrees={worktreesByEpicId.get(item.epicId) ?? EMPTY_WORKTREES}
            />
          ))}
        </ul>
      ) : (
        <div
          className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
          data-testid="epics-list-filtered-empty"
        >
          <p className="font-medium text-foreground">
            No tasks match these filters.
          </p>
        </div>
      )}
      {hasNextPage ? (
        <div className="mt-3 flex justify-center">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isFetchingNextPage}
            onClick={onLoadMore}
            data-testid="epics-list-show-more"
          >
            {isFetchingNextPage ? (
              <AgentSpinningDots
                variant="dots"
                className="text-muted-foreground"
                testId={undefined}
              />
            ) : null}
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function EpicsListFilteringLoading() {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 py-16 text-center text-ui-sm text-muted-foreground"
      data-testid="epics-list-filter-loading"
      aria-busy="true"
      aria-live="polite"
    >
      <AgentSpinningDots
        variant="dots"
        className="text-muted-foreground"
        testId={undefined}
      />
      <p className="font-medium text-foreground">Searching tasks</p>
    </div>
  );
}

interface EpicsListRowProps {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly isPinPending: boolean;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenInNewWindow: HistoryNewWindowFlow["requestOpen"];
  readonly openInNewWindowAvailable: boolean;
  readonly worktrees: readonly WorktreeHostEntryV12[];
}

function HistoryRowTrailingMetadata(props: {
  readonly epicId: string;
  readonly selectionMode: boolean;
  readonly updatedLabel: string;
  readonly worktrees: readonly WorktreeHostEntryV12[];
}): ReactNode {
  const hasPrPills =
    !props.selectionMode && worktreePrReferences(props.worktrees).length > 0;
  return (
    <span className="grid shrink-0 items-center justify-items-end text-ui-xs">
      <span
        className={cn(
          "col-start-1 row-start-1 text-muted-foreground",
          hasPrPills &&
            "transition-opacity group-hover/list-row:opacity-0 group-focus-within/list-row:opacity-0",
        )}
      >
        updated {props.updatedLabel}
      </span>
      {hasPrPills ? (
        <WorktreePrPills
          worktrees={props.worktrees}
          detailOnHover
          className="pointer-events-none col-start-1 row-start-1 max-w-[min(36vw,22rem)] opacity-0 transition-opacity group-hover/list-row:pointer-events-auto group-hover/list-row:opacity-100 group-focus-within/list-row:pointer-events-auto group-focus-within/list-row:opacity-100"
          testId={`task-history-prs-${props.epicId}`}
        />
      ) : null}
    </span>
  );
}

const EpicsListRow = memo(function EpicsListRow(props: EpicsListRowProps) {
  const {
    item,
    selectionMode,
    isSelected,
    onToggleSelection,
    onRequestDelete,
    onSetPinned,
    isPinPending,
    onSelectEpic,
    onOpenInNewWindow,
    openInNewWindowAvailable,
    worktrees,
  } = props;
  const isPhase = item.taskType === "phase";
  const displayTitle = historyItemDisplayTitle(item);
  const canEditTitle = canEditHistoryItemTitle(item);
  const canDeleteItem = canDeleteHistoryItem(item);
  const selectionDisabled = historySelectionDisabled(
    selectionMode,
    canDeleteItem,
  );
  const deleteDisabledTooltip = historyDeleteDisabledTooltip(item);
  const { mutate: renameEpicTitle, isPending: isRenamePending } =
    useEpicUpdateTitle();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const linkTabId = useEpicCanvasStore(
    (s) => s.resolveTabIdForEpic(item.epicId) ?? item.epicId,
  );
  const openInBackground = useCallback(() => {
    openEpicInBackground(item.epicId, item.title);
  }, [item.epicId, item.title]);
  const openInNewWindow = useCallback(() => {
    onOpenInNewWindow(item);
  }, [onOpenInNewWindow, item]);
  const commitEpicTitle = useCallback(
    (nextTitle: string) => {
      if (isPhase) return;
      renameEpicTitle({
        epicDelta: {
          id: item.epicId,
          title: nextTitle,
          updatedAt: Date.now(),
        },
      });
    },
    [isPhase, item.epicId, renameEpicTitle],
  );
  const {
    isEditing: isRenaming,
    startEditing: startRenaming,
    inputProps: renameInputProps,
  } = useInlineRename({
    value: item.title,
    canEdit: canEditTitle && !isRenamePending,
    onCommit: commitEpicTitle,
  });
  const startRename = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      startRenaming();
    },
    [startRenaming],
  );
  const blockDisabledEditTitleClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );
  const blockDisabledEditTitleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );
  const openEpic = useCallback(() => {
    onSelectEpic?.(item.epicId);
    if (isPhase) {
      void navigate(phaseMigrationRoute(item.epicId));
      return;
    }
    // Passing the row's title threads it through tab creation so the
    // cold-open canvas skeleton can render the real epic title at +0ms,
    // not "Untitled epic" until the snapshot arrives.
    openEpicFromCommand(navigate, item.epicId, pathname, item.title);
  }, [isPhase, item.epicId, item.title, navigate, onSelectEpic, pathname]);
  const toggleEpicSelection = () => {
    if (!canDeleteItem) return;
    onToggleSelection(item.epicId);
  };
  const openEpicRow = (event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      toggleEpicSelection();
      return;
    }
    openEpic();
  };
  const blockUnavailableDeleteAction = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      event.preventDefault();
      event.stopPropagation();
    },
    [],
  );
  const titleEditControl = (
    <HistoryTitleEditControl
      item={item}
      selectionMode={selectionMode}
      canEditTitle={canEditTitle}
      isRenamePending={isRenamePending}
      onStartRename={startRename}
      onBlockDisabledEditTitleClick={blockDisabledEditTitleClick}
      onBlockDisabledEditTitleKeyDown={blockDisabledEditTitleKeyDown}
    />
  );
  const checkboxChecked = historyCheckboxChecked(isSelected, canDeleteItem);
  const checkboxVisibilityClass = historySelectionCheckboxVisibility({
    selectionMode,
    isSelected,
    canDeleteItem,
  });
  const selectionCheckbox = (
    <button
      type="button"
      role="checkbox"
      aria-checked={checkboxChecked}
      aria-disabled={!canDeleteItem}
      aria-label={`Select ${displayTitle}`}
      data-testid="epics-list-row-select"
      className={cn(
        "flex size-4 items-center justify-center rounded-sm border transition-[border-color,background-color,color,opacity] outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50",
        checkboxVisibilityClass,
        canDeleteItem ? "cursor-pointer" : "cursor-not-allowed",
        isSelected && canDeleteItem
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-transparent hover:border-foreground",
      )}
      onClick={
        canDeleteItem ? toggleEpicSelection : blockUnavailableDeleteAction
      }
    >
      <Check className="size-3" />
    </button>
  );
  const selectionControl = canDeleteItem ? (
    selectionCheckbox
  ) : (
    <Tooltip>
      <TooltipTrigger asChild>{selectionCheckbox}</TooltipTrigger>
      <TooltipContent>{deleteDisabledTooltip}</TooltipContent>
    </Tooltip>
  );
  const pinControl = (
    <HistoryPinControl
      item={item}
      isPending={isPinPending}
      selectionMode={selectionMode}
      onSetPinned={onSetPinned}
    />
  );
  const rowInteractionLayer = selectionMode ? (
    <HistorySelectionOverlay
      item={item}
      canDeleteItem={canDeleteItem}
      deleteDisabledTooltip={deleteDisabledTooltip}
      onToggleSelection={toggleEpicSelection}
      onBlockUnavailableDelete={blockUnavailableDeleteAction}
    />
  ) : (
    <Link
      to="/epics/$epicId/$tabId"
      params={{ epicId: item.epicId, tabId: linkTabId }}
      search={{
        focusedAt: undefined,
        focusArtifactId: undefined,
        focusThreadId: undefined,
        migrationSource: isPhase ? "phase" : undefined,
        focusPaneId: undefined,
        focusTileInstanceId: undefined,
      }}
      onClick={openEpicRow}
      aria-label={`Open task ${displayTitle}`}
      className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    />
  );
  const deleteControl = selectionMode ? null : (
    <HistoryRowDeleteControl
      item={item}
      canDeleteItem={canDeleteItem}
      deleteDisabledTooltip={deleteDisabledTooltip}
      onRequestDelete={onRequestDelete}
      onBlockUnavailableDelete={blockUnavailableDeleteAction}
    />
  );
  const rowCard = (
    <div
      data-testid="epics-list-row-card"
      data-selection-disabled={selectionDisabled ? "true" : undefined}
      className={historyRowCardClassName({
        selectionDisabled,
        selectedForDelete: historySelectedForDelete({
          selectionMode,
          isSelected,
          canDeleteItem,
        }),
      })}
    >
      {rowInteractionLayer}
      <div className="pointer-events-none relative z-10 flex items-center justify-between gap-3 p-3 pr-12 text-ui-sm">
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          <HistoryRowLeadingIcon item={item} />
          {isRenaming ? (
            <input
              {...renameInputProps}
              type="text"
              aria-label={`Rename ${displayTitle}`}
              data-testid="epics-list-row-title-input"
              className="pointer-events-auto w-full min-w-0 flex-1 rounded border border-input bg-background/90 px-1.5 py-0.5 font-medium text-foreground outline-none focus:border-ring/70 focus-visible:ring-0"
            />
          ) : (
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
              <span className="truncate font-medium text-foreground">
                {displayTitle}
              </span>
              {pinControl}
              {titleEditControl}
            </span>
          )}
        </span>
        <HistoryRowTrailingMetadata
          epicId={item.epicId}
          selectionMode={selectionMode}
          updatedLabel={item.updatedLabel}
          worktrees={worktrees}
        />
      </div>
      {deleteControl}
    </div>
  );
  // Phases have no background-open: a phase only opens through its migration
  // route (migrationSource=phase), which a plain canvas tab can't carry, so it
  // would activate into the wrong (non-migration) surface. New Window stays
  // available - it goes through the route.
  const backgroundMenuItem = isPhase ? null : (
    <ContextMenuItem
      onSelect={openInBackground}
      data-testid="epics-list-row-open-background"
    >
      <ArrowDownToLine />
      Open in Background
    </ContextMenuItem>
  );
  const newWindowMenuItem = openInNewWindowAvailable ? (
    <ContextMenuItem
      onSelect={openInNewWindow}
      data-testid="epics-list-row-open-new-window"
    >
      <ExternalLink />
      Open in New Window
    </ContextMenuItem>
  ) : null;
  return (
    <li
      data-testid="epics-list-row"
      data-pinned={item.isPinned}
      className="group/list-row flex items-stretch gap-1.5"
    >
      <div className="flex w-5 shrink-0 items-center justify-center">
        {selectionControl}
      </div>
      {/* Skip the context menu entirely when no action qualifies (e.g. a phase
          row in the browser build with no windows bridge) so right-click never
          opens an empty popover. */}
      {backgroundMenuItem === null && newWindowMenuItem === null ? (
        rowCard
      ) : (
        <ContextMenu>
          <ContextMenuTrigger asChild>{rowCard}</ContextMenuTrigger>
          <ContextMenuContent
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            {backgroundMenuItem}
            {newWindowMenuItem}
          </ContextMenuContent>
        </ContextMenu>
      )}
    </li>
  );
});

function HistoryPinControl(props: {
  readonly item: HistoryItem;
  readonly isPending: boolean;
  readonly selectionMode: boolean;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
}): ReactNode {
  if (props.selectionMode || props.item.taskType === "phase") return null;
  const displayTitle = historyItemDisplayTitle(props.item);
  const label = props.item.isPinned
    ? `Unpin ${displayTitle} from top`
    : `Pin ${displayTitle} to top`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={props.item.isPinned}
          data-testid="epics-list-row-pin"
          disabled={props.isPending}
          className={cn(
            "pointer-events-auto flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-[color,opacity] hover:bg-muted focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-wait",
            props.item.isPinned
              ? "text-primary opacity-100"
              : "text-muted-foreground opacity-0 group-hover/list-row:opacity-100 group-focus-within/list-row:opacity-100",
          )}
          onClick={() => {
            props.onSetPinned(props.item.epicId, !props.item.isPinned);
          }}
        >
          {/* The pin state is optimistic - it flips at click time - so the
              icon always shows the row's current state; the brief disabled
              window only serializes rapid re-toggles, with no spinner. */}
          <Pin
            className={cn("size-3.5", props.item.isPinned && "fill-current")}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function HistoryRowLeadingIcon(props: { readonly item: HistoryItem }) {
  const activityStatus = useEpicActivityStatus(
    props.item.taskType === "epic" ? props.item.epicId : null,
  );
  const indicatorState = useSurfaceNotificationIndicatorState({
    epicId: props.item.epicId,
  });
  return (
    <NotificationIndicatorIcon
      state={indicatorState}
      running={activityStatus === "running"}
      subjectId={props.item.epicId}
      testIdPrefix="epics-list-row"
      className="text-muted-foreground group-hover/list-row:text-foreground"
      style={undefined}
      runningTitle="Task activity in progress"
      defaultIcon={
        <Layers className="size-4 shrink-0 text-muted-foreground group-hover/list-row:text-foreground" />
      }
      statusPresentation="message"
    />
  );
}

function historySelectionDisabled(
  selectionMode: boolean,
  canDeleteItem: boolean,
): boolean {
  return selectionMode && !canDeleteItem;
}

function historyDeleteDisabledTooltip(item: HistoryItem): string {
  if (item.permissionRole === "viewer") return VIEWER_DELETE_TOOLTIP;
  return NO_DELETE_PERMISSION_TOOLTIP;
}

function historyCheckboxChecked(
  isSelected: boolean,
  canDeleteItem: boolean,
): boolean {
  return isSelected && canDeleteItem;
}

function historySelectedForDelete(args: {
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly canDeleteItem: boolean;
}): boolean {
  return args.selectionMode && args.isSelected && args.canDeleteItem;
}

function historyRowCardClassName(args: {
  readonly selectionDisabled: boolean;
  readonly selectedForDelete: boolean;
}): string {
  return cn(
    "group relative min-w-0 flex-1 rounded-md transition-colors hover:bg-accent/40",
    args.selectionDisabled && "opacity-50",
    args.selectedForDelete && "bg-accent/40 ring-1 ring-inset ring-primary/40",
  );
}

function HistoryTitleEditControl(props: {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  readonly canEditTitle: boolean;
  readonly isRenamePending: boolean;
  readonly onStartRename: (event: React.MouseEvent<HTMLButtonElement>) => void;
  readonly onBlockDisabledEditTitleClick: (
    event: React.MouseEvent<HTMLButtonElement>,
  ) => void;
  readonly onBlockDisabledEditTitleKeyDown: (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => void;
}): ReactNode {
  if (props.selectionMode) return null;
  if (props.canEditTitle) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Edit title for ${historyItemDisplayTitle(props.item)}`}
        data-testid="epics-list-row-edit-title"
        disabled={props.isRenamePending}
        className="pointer-events-auto size-5 opacity-0 transition-opacity hover:bg-muted focus-visible:opacity-100 group-hover:opacity-100"
        onClick={props.onStartRename}
      >
        <Pencil className="size-3.5" />
      </Button>
    );
  }
  if (props.item.permissionRole !== "viewer") return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          aria-label={`Viewers can't edit title for ${historyItemDisplayTitle(props.item)}`}
          data-testid="epics-list-row-edit-title-disabled"
          className="pointer-events-auto inline-flex size-5 cursor-not-allowed items-center justify-center rounded-sm text-muted-foreground/60 opacity-0 transition-opacity outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
          onClick={props.onBlockDisabledEditTitleClick}
          onKeyDown={props.onBlockDisabledEditTitleKeyDown}
        >
          <Pencil className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Viewers cannot edit epic titles.</TooltipContent>
    </Tooltip>
  );
}

function historySelectionCheckboxVisibility(args: {
  readonly selectionMode: boolean;
  readonly isSelected: boolean;
  readonly canDeleteItem: boolean;
}): string {
  if (args.selectionMode || (args.isSelected && args.canDeleteItem)) {
    return args.canDeleteItem ? "opacity-100" : "opacity-50";
  }
  if (args.canDeleteItem) {
    return "opacity-0 group-hover/list-row:opacity-100";
  }
  return "opacity-0 group-hover/list-row:opacity-50 focus-visible:opacity-50";
}

function HistorySelectionOverlay(props: {
  readonly item: HistoryItem;
  readonly canDeleteItem: boolean;
  readonly deleteDisabledTooltip: string;
  readonly onToggleSelection: () => void;
  readonly onBlockUnavailableDelete: (
    event: React.MouseEvent<HTMLElement>,
  ) => void;
}): ReactNode {
  if (props.canDeleteItem) {
    return (
      <button
        type="button"
        aria-label={`Toggle selection for ${historyItemDisplayTitle(props.item)}`}
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={props.onToggleSelection}
      />
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          aria-label={`Cannot select ${historyItemDisplayTitle(props.item)}`}
          className="absolute inset-0 cursor-not-allowed rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={props.onBlockUnavailableDelete}
        />
      </TooltipTrigger>
      <TooltipContent>{props.deleteDisabledTooltip}</TooltipContent>
    </Tooltip>
  );
}

function HistoryRowDeleteControl(props: {
  readonly item: HistoryItem;
  readonly canDeleteItem: boolean;
  readonly deleteDisabledTooltip: string;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onBlockUnavailableDelete: (
    event: React.MouseEvent<HTMLElement>,
  ) => void;
}): ReactNode {
  if (props.canDeleteItem) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${historyItemDisplayTitle(props.item)}`}
        aria-haspopup="dialog"
        data-testid="epics-list-row-delete"
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
        onClick={() => {
          props.onRequestDelete([props.item.epicId]);
        }}
      >
        <Trash2 />
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          aria-label={`Cannot delete ${historyItemDisplayTitle(props.item)}`}
          data-testid="epics-list-row-delete-disabled"
          className="absolute right-2 top-1/2 inline-flex size-8 -translate-y-1/2 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
          onClick={props.onBlockUnavailableDelete}
        >
          <Trash2 className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{props.deleteDisabledTooltip}</TooltipContent>
    </Tooltip>
  );
}

function EpicsListLoading() {
  return (
    <div
      className="flex flex-col gap-2"
      data-testid="epics-list-loading"
      aria-busy="true"
      aria-label="Loading tasks"
    >
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-12 w-full rounded-md" />
      ))}
    </div>
  );
}

interface EpicsListErrorProps {
  readonly error: Error;
  readonly onRetry: () => void;
}

function EpicsListError(props: EpicsListErrorProps) {
  const { error, onRetry } = props;
  const [showDetails, setShowDetails] = useState<boolean>(false);
  return (
    <div
      className="flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-ui-sm"
      data-testid="epics-list-error"
      role="alert"
    >
      <p className="font-medium text-destructive">{errorHeadline(error)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="epics-list-error-retry"
          onClick={onRetry}
        >
          Retry
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="epics-list-error-toggle-details"
          aria-expanded={showDetails}
          onClick={() => {
            setShowDetails((value) => !value);
          }}
        >
          {showDetails ? "Hide details" : "Show details"}
        </Button>
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Failed to load Epics",
            message: "The Epic list could not be loaded.",
            code: error instanceof HostRpcError ? error.code : null,
            source: "Epic list",
          })}
          presentation="text"
          className={undefined}
        />
      </div>
      {showDetails ? (
        <pre
          className="w-full overflow-x-auto rounded-md bg-background/70 p-2 font-mono text-code-xs text-muted-foreground"
          data-testid="epics-list-error-details"
        >
          {formatError(error)}
        </pre>
      ) : null}
    </div>
  );
}

function errorHeadline(error: Error): string {
  if (error instanceof HostRpcError) {
    if (error.code === "UNAUTHORIZED") return "Please sign in again.";
    if (error.code === "FORBIDDEN") {
      return "You don't have permission to view these epics.";
    }
  }
  return "Couldn't reach Traycer Cloud";
}

function formatError(error: Error): string {
  return `${error.name}: ${error.message}`;
}
