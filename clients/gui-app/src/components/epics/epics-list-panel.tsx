import {
  memo,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { useShallow } from "zustand/react/shallow";
import {
  ArrowDownToLine,
  Check,
  ExternalLink,
  Paintbrush,
  Pencil,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ContextMenuItem } from "@/components/ui/context-menu";
import { openEpicInBackground } from "@/lib/commands/actions/open-epic-in-background";
import {
  useHistoryOpenInNewWindowFlow,
  type HistoryNewWindowFlow,
} from "@/components/epics/use-history-open-in-new-window";
import { UnsyncedEpicMoveDialog } from "@/components/layout/dialogs/unsynced-epic-move-dialog";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { DeleteTasksDialog } from "@/components/epics/delete-tasks-dialog";
import { SweepWorktreesFlow } from "@/components/epics/sweep-worktrees-flow";
import { namesHostOutsideSurface } from "@/components/epics/sweep-host-model";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useEpicBatchDelete,
  usePendingDeleteEpicIds,
} from "@/hooks/epic/use-epic-batch-delete-mutation";
import { useTaskDeleteWorktreeCandidates } from "@/hooks/epic/use-task-delete-worktree-candidates-query";
import { useEpicUpdateTitle } from "@/hooks/epic/use-epic-title-mutation";
import {
  useEpicSetPinned,
  usePendingSetPinnedEpicIds,
} from "@/hooks/epic/use-epic-set-pinned-mutation";
import { useInlineRename } from "@/hooks/ui/use-inline-rename";
import { withMemberToggled } from "@/lib/immutable-set";
import { cn } from "@/lib/utils";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { ClearFiltersButton } from "@/components/home/toolbar/clear-filters-button";
import type {
  HistoryItem,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import type { ListTasksCompleteness } from "@traycer/protocol/host/epic/unary-schemas";
import {
  canDeleteHistoryItem,
  canEditHistoryItemTitle,
  DEFAULT_SORT,
} from "@/components/home/data/home-page.data";
import {
  EpicsListChatHostFilterUnsupported,
  EpicsListError,
  EpicsListHostRequiresCloudToList,
  EpicsListLoading,
  EpicsListNoRows,
  EpicsListShowMore,
} from "@/components/epics/epics-list-shared";
import { HistoryTaskRow } from "@/components/epics/history-task-row";
import { historyItemDisplayTitle } from "@/components/epics/history-item-title";
import { MobileHistoryList } from "@/components/epics/mobile/mobile-history-list";
import { useHistoryOpenItem } from "@/components/epics/use-history-open-item";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { useChatHostFilterSupport } from "@/hooks/home/use-chat-host-filter-support";
import type { HistoryMessageHitsInputs } from "@/components/epics/history-message-hits";
import {
  HistoryScopedResults,
  type HistoryCount,
} from "@/components/epics/history-scope-bar";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import {
  HistoryTaskControls,
  type HistoryTaskControlsProps,
} from "@/components/epics/history-task-controls";
import type { HistoryScope } from "@/lib/history-scope";
import { useHistoryListKeyboardNav } from "@/components/epics/use-history-list-keyboard-nav";
import { onMiddleClick } from "@/lib/dom/on-middle-click";
import { NotificationIndicatorsProvider } from "@/components/notifications/notification-indicators-provider";
import {
  useHistoryQuery,
  type HistoryFacets,
  type HistoryFetchResult,
} from "@/hooks/home/use-history-query";
import { useNotificationIndicators } from "@/hooks/notifications/use-notification-indicators-query";
import {
  useAmbientHistorySearchState,
  useRouteHistorySearchState,
  type HistorySearchController,
} from "@/hooks/home/use-history-search-state";
import { epicDisplayTitle } from "@/lib/display-title";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  DEFAULT_HISTORY_SEARCH,
  patchHistorySearch,
  type HistorySearchPatch,
  type HistorySearchState,
} from "@/lib/history-search";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";

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
const PRESERVED_ORPHAN_DELETE_TOOLTIP =
  "This task was already deleted. Only its unsynced edits remain, so there is nothing left to delete.";
// States the CONDITION rather than predicting a reconnect, for the same reason
// the pin tooltip does: the session may be unverified because authn refused the
// credential, which no amount of waiting fixes - only signing in again does.
// "Once it is" covers both the transient recovery and the re-sign-in without
// promising either.
const DELETE_IN_FLIGHT_TOOLTIP = "This task is being deleted.";
const UNVERIFIED_SESSION_DELETE_TOOLTIP =
  "Your sign-in couldn't be confirmed. Deleting this task will work again once it is.";

export type EpicsListPanelVariant = "page" | "picker";

interface EpicsListPanelProps {
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly variant: EpicsListPanelVariant;
  readonly className: string | undefined;
  /**
   * Called immediately before normal row navigation. The system-tab modal
   * uses this to close its overlay in the same interaction.
   */
  readonly onSelectEpic: ((epicId: string) => void) | null;
  /**
   * Replaces the row's normal navigation when this panel is used in a
   * destination picker. The complete item is provided so callers can preserve
   * the distinct Epic and legacy Phase activation paths.
   */
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly routeSearch: HistorySearchState | null;
  readonly historyNowMs: number | null;
  /**
   * Focus the search input once on mount. Set by the history modal so
   * opening it drops the caret straight into search; left off for the
   * `/epics` route where a full-page focus
   * grab would be unwelcome.
   */
  readonly autoFocusSearch: boolean;
}

interface RouteEpicsListPanelProps {
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly variant: EpicsListPanelVariant;
  readonly className: string | undefined;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly routeSearch: HistorySearchState;
  readonly historyNowMs: number | null;
  readonly autoFocusSearch: boolean;
}

interface AmbientEpicsListPanelProps {
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly variant: EpicsListPanelVariant;
  readonly className: string | undefined;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly historyNowMs: number | null;
  readonly autoFocusSearch: boolean;
}

interface EpicsListPanelBodyProps {
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly variant: EpicsListPanelVariant;
  readonly className: string | undefined;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly historyNowMs: number | null;
  readonly historySearch: HistorySearchController;
  readonly autoFocusSearch: boolean;
}

/** History and destination-picker task list. */
export function EpicsListPanel(props: EpicsListPanelProps): ReactNode {
  if (props.routeSearch === null) {
    return (
      <AmbientEpicsListPanel
        variant={props.variant}
        scope={props.scope}
        onScopeChange={props.onScopeChange}
        className={props.className}
        onSelectEpic={props.onSelectEpic}
        onOpenItem={props.onOpenItem}
        historyNowMs={props.historyNowMs}
        autoFocusSearch={props.autoFocusSearch}
      />
    );
  }
  return (
    <RouteEpicsListPanel
      variant={props.variant}
      scope={props.scope}
      onScopeChange={props.onScopeChange}
      className={props.className}
      onSelectEpic={props.onSelectEpic}
      onOpenItem={props.onOpenItem}
      routeSearch={props.routeSearch}
      historyNowMs={props.historyNowMs}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

export function PickerEpicsListPanel(
  props: Omit<
    AmbientEpicsListPanelProps,
    "variant" | "scope" | "onScopeChange"
  >,
): ReactNode {
  const [search, setSearch] = useState(DEFAULT_HISTORY_SEARCH);
  const update = useCallback((patch: HistorySearchPatch) => {
    setSearch((previous) => patchHistorySearch(previous, patch));
  }, []);
  const clear = useCallback(() => setSearch(DEFAULT_HISTORY_SEARCH), []);
  const historySearch: HistorySearchController = { search, update, clear };
  return (
    <EpicsListPanelBody
      {...props}
      variant="picker"
      scope="tasks"
      onScopeChange={() => {}}
      historySearch={historySearch}
    />
  );
}

function RouteEpicsListPanel(props: RouteEpicsListPanelProps): ReactNode {
  const historySearch = useRouteHistorySearchState(props.routeSearch);
  return (
    <EpicsListPanelBody
      variant={props.variant}
      scope={props.scope}
      onScopeChange={props.onScopeChange}
      className={props.className}
      onSelectEpic={props.onSelectEpic}
      onOpenItem={props.onOpenItem}
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
      scope={props.scope}
      onScopeChange={props.onScopeChange}
      className={props.className}
      onSelectEpic={props.onSelectEpic}
      onOpenItem={props.onOpenItem}
      historyNowMs={props.historyNowMs}
      historySearch={historySearch}
      autoFocusSearch={props.autoFocusSearch}
    />
  );
}

interface HistoryPanelView {
  readonly items: ReadonlyArray<HistoryItem>;
  readonly worktreesByEpicId: ReadonlyMap<
    string,
    readonly WorktreeHostEntryV12[]
  >;
  readonly availableRepos: ReadonlyArray<string>;
  readonly availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  readonly facets: HistoryFacets | undefined;
  readonly completeness: ListTasksCompleteness | null;
}

/** The panel's read of a possibly-absent fetch result, with the no-settled-page
 * defaults stated once. */
function historyPanelView(
  data: HistoryFetchResult | undefined,
): HistoryPanelView {
  if (data === undefined) {
    return {
      items: EMPTY_ITEMS,
      worktreesByEpicId: EMPTY_WORKTREES_BY_EPIC,
      availableRepos: EMPTY_REPOS,
      availableWorkspaces: EMPTY_WORKSPACES,
      facets: undefined,
      completeness: null,
    };
  }
  return {
    items: data.items,
    worktreesByEpicId: data.worktreesByEpicId,
    availableRepos: data.availableRepos,
    availableWorkspaces: data.availableWorkspaces,
    facets: data.facets,
    // `?? null` rather than a straight read: `completeness` is declared
    // non-optional but arrives absent from partial fixtures, and the body
    // below dereferences it. The previous `data?.completeness ?? null` carried
    // that same coercion, so dropping it turned an omitted field into a render
    // crash.
    completeness: data.completeness ?? null,
  };
}

function EpicsListPanelBody(props: EpicsListPanelBodyProps): ReactNode {
  const { variant, onSelectEpic, onOpenItem, historySearch } = props;
  // Destructure the stable `update`/`clear` functions (the hook returns a fresh
  // wrapper object each render, so closing over `historySearch.update` would
  // give the compiler an unstable dependency and re-create every handler each
  // render -> the whole chrome re-renders on each list update). Holding the
  // stable functions directly lets the compiler memoize the handlers, so
  // PanelChromeBar / PanelSearchInput / EpicsSortMenu bail unless their own
  // data actually changes.
  const { search, update: updateSearch, clear: clearSearch } = historySearch;
  const openInNewWindowFlow = useHistoryOpenInNewWindowFlow();
  const openEpicIds = useEpicCanvasStore(
    useShallow((state) =>
      state.openTabOrder.flatMap((tabId) => {
        const tab = state.tabsById[tabId];
        return tab === undefined ? [] : [tab.epicId];
      }),
    ),
  );
  const openEpicIdSet = useMemo(() => new Set(openEpicIds), [openEpicIds]);

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
    cloudPagePending,
    isCountPending,
  } = useHistoryQuery({
    search,
    nowMs: props.historyNowMs,
  });

  // Read at gesture time so pull-to-refresh can install its listeners once,
  // rather than re-attaching a non-passive touch handler whenever the query
  // hands back a fresh `refetch`.
  const refetchRef = useRef(refetch);
  useEffect(() => {
    refetchRef.current = refetch;
  });
  const refreshHistory = useCallback(() => refetchRef.current(), []);

  // One read of the fetch result rather than six independent `data?.x ?? d`
  // sites: the empty-state defaults belong together (they all describe "no
  // settled page yet"), and spreading them through the body made the panel
  // body's branch count grow with every field the query gained.
  const view = historyPanelView(data);
  const items = view.items;
  const worktreesByEpicId = view.worktreesByEpicId;
  const indicatorEpicIds = useMemo(
    () => items.map((item) => item.epicId),
    [items],
  );
  const notificationIndicators = useNotificationIndicators({
    // Epic ids only - see the header tab strip's note: the app-wide active
    // host is the right scope for a shared cloud entity.
    hostId: null,
    epicIds: indicatorEpicIds,
    chatIds: [],
    enabled: indicatorEpicIds.length > 0,
  });
  const { chatHostFilterSupported, chatHostFilterUnsupported } =
    useChatHostFilterGate(hostId, data);
  // `=== true` rather than a straight read, for the reason `historyPanelView`
  // spells out about `completeness`: this field is declared non-optional but
  // partial fixtures omit it, and an `undefined` must read as "not refused"
  // rather than being coerced into the branch that suppresses every row.
  const hostRequiresCloudToList = data?.hostRequiresCloudToList === true;
  const availableRepos = view.availableRepos;
  const availableWorkspaces = view.availableWorkspaces;
  const facets = view.facets;

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
      // Resolved HERE rather than widened into `onSetPinned`, which is
      // declared in seven places across the desktop rows, the mobile row and
      // both list shells. The row that rendered the control came out of this
      // same array, so this is the reading it decided availability from, not a
      // second derivation - and a row missing from it (an id from a stale
      // control) reads cloud-homed, which lands on the verdict gate.
      const isLocalHome =
        items.find((item) => item.epicId === epicId)?.isLocalHome === true;
      // `hostId: null` - follow the window - and here that is CORRECT by
      // construction rather than a shortfall. History takes `isLocalHome` from
      // `useEpicGetTaskContexts`, which dispatches on a SINGLE client
      // (`useHostClient()`, the window's host) and merges `localHomedTaskIds`
      // only across that host's own request chunks. So every id in that set is
      // local-homed ON THE WINDOW'S HOST, and following the window sends the
      // write to exactly the host that reported the row local-homed.
      //
      // An epic local-homed on a DIFFERENT host cannot arrive here down this
      // arm at all: the window's host does not own it, so it never enters
      // `localHomedTaskIds`, `isLocalHome` is false, and the row takes the
      // cloud path every host proxies. The tab strip needs an explicit host
      // because its readings DO span hosts (one per open tab's session); this
      // surface's do not.
      setPinned({ epicId, pinned, isLocalHome, hostId: null });
    },
    [items, setPinned],
  );

  const {
    candidates: worktreeCandidates,
    isFetching: worktreeCandidatesFetching,
  } = useTaskDeleteWorktreeCandidates(pendingDeleteIds);
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

  // `variant="picker"` embeds this panel as a read-only destination browser
  // (the split chooser's History section) - it must never expose the
  // select/delete/sweep flow, so every entry point into it is gated here
  // rather than in the chrome that merely renders it.
  const selectionEnabled = variant !== "picker";
  // Deletion of a cloud-backed row is a capability spend on the account, and
  // History renders under `unverified` where no verdict is held. Read once for
  // the whole panel and hand it to `canDeleteHistoryItem` at each of the three
  // admission points below - selection, the row control, and the confirmation.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );

  // A sweep target is a SET: one id from a row action, the whole selection
  // from the bulk action. The set is load-bearing - a worktree shared between
  // two SELECTED tasks is no longer "shared" and becomes an ordinary
  // candidate.
  const [sweepEpicIds, setSweepEpicIds] =
    useState<ReadonlyArray<string> | null>(null);
  const sweepHostClient = useHostClientForHostId(null);
  const requestSweep = useCallback(
    (epicId: string) => {
      if (!selectionEnabled) return;
      setSweepEpicIds([epicId]);
    },
    [selectionEnabled],
  );
  const sweepTaskTitle = useMemo(() => {
    if (sweepEpicIds === null || sweepEpicIds.length !== 1) return null;
    const item = items.find(
      (candidate) => candidate.epicId === sweepEpicIds[0],
    );
    return item === undefined ? null : historyItemDisplayTitle(item);
  }, [items, sweepEpicIds]);
  // A Task whose deletion is still in flight is not deletable AGAIN: the
  // dialog closes at kickoff, so its row renders with its controls back while
  // the host is still working, and nothing on the wire deduplicates a second
  // `epic.batchDelete` for the same id. Excluded here so the row action, the
  // bulk selection and the confirm re-filter all refuse it from one set.
  const pendingDeleteEpicIds = usePendingDeleteEpicIds();
  const selectableItemIds = useMemo(
    () =>
      items
        .filter(
          (item) =>
            canDeleteHistoryItem(item, cloudAuthorized) &&
            !pendingDeleteEpicIds.has(item.epicId),
        )
        .map((item) => item.epicId),
    [cloudAuthorized, items, pendingDeleteEpicIds],
  );
  const selectableIdSet = useMemo(
    () => new Set(selectableItemIds),
    [selectableItemIds],
  );

  const toggleSelection = useCallback(
    (id: string) => {
      if (!selectionEnabled || !selectableIdSet.has(id)) return;
      setSelectedIds((prev) => withMemberToggled(prev, id));
      setSelectionMode(true);
    },
    [selectableIdSet, selectionEnabled],
  );

  const requestDelete = useCallback(
    (ids: ReadonlyArray<string>) => {
      if (!selectionEnabled) return;
      const deletableIds = ids.filter((id) => selectableIdSet.has(id));
      if (deletableIds.length === 0) return;
      setPendingDeleteIds(deletableIds);
    },
    [selectableIdSet, selectionEnabled],
  );

  const visibleSelectedIds = useMemo(() => {
    return Array.from(selectedIds).filter((id) => selectableIdSet.has(id));
  }, [selectableIdSet, selectedIds]);
  const selectedCount = visibleSelectedIds.length;
  // Delete-eligible and sweepable are different questions: a selection can be
  // entirely tasks that own no worktrees, and opening Sweep on those shows a
  // dialog with nothing to sweep. The row control already gates on this
  // (`useHistoryRowSweep`); the bulk button has to ask the same question, of
  // the SELECTION rather than of one task, so a mixed selection still sweeps.
  //
  // "Owns worktrees" is asked of THIS host - the only reliable per-host
  // worktree oracle - so the second clause is what keeps the affordance live
  // for a Task whose agents ran elsewhere. Without it the picker behind this
  // button is unreachable for exactly the multi-host selections it exists for.
  const canSweepSelected = useMemo(
    () =>
      visibleSelectedIds.some((id) => {
        if ((worktreesByEpicId.get(id) ?? EMPTY_WORKTREES).length > 0) {
          return true;
        }
        const item = items.find((candidate) => candidate.epicId === id);
        return namesHostOutsideSurface({
          hostIds: item?.chatHostIds ?? null,
          surfaceHostId: hostId,
        });
      }),
    [hostId, items, visibleSelectedIds, worktreesByEpicId],
  );
  const enterSelectionMode = useCallback(() => {
    if (!selectionEnabled) return;
    setSelectedIds(new Set());
    setSelectionMode(true);
  }, [selectionEnabled]);
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
    // The host-wide census is asynchronous. Confirming before it settles lets
    // the Task deletion start with zero approved worktrees, silently skipping
    // rows that were about to be offered. Hold confirmation until the choices
    // the person is approving are stable. A disabled query (host unavailable)
    // is not fetching, so cleanup remains additive and never blocks Task
    // deletion indefinitely.
    if (worktreeCandidatesFetching) return;
    // The verdict is re-read HERE, from the store, rather than trusted from the
    // render that opened this dialog. A confirmation is an unbounded pause with
    // a human in it, and `unverified` arrives asynchronously - a wake, a failed
    // refresh, an authn outage - so the session that opened the dialog is not
    // necessarily the session that confirms it. Gating only at selection time
    // leaves an already-open dialog dispatching `epic.batchDelete` on a bearer
    // the cloud stopped vouching for a minute ago.
    //
    // Re-FILTERED rather than refused wholesale, because the local-home rows in
    // a mixed selection are still deletable: they reclaim this machine's disk
    // and spend nothing. A pending id whose row is no longer in `items` cannot
    // be proven local-home, so it survives only while authorized - the one arm
    // that has to fail closed, since "unknown row" is exactly what a withdrawn
    // verdict must not be allowed to wave through.
    const authorizedNow = authorizesCloudCapability(
      useAuthStore.getState().status,
    );
    const itemsByEpicId = new Map(items.map((item) => [item.epicId, item]));
    const ids = pendingDeleteIds.filter((id) => {
      if (pendingDeleteEpicIds.has(id)) return false;
      const item = itemsByEpicId.get(id);
      if (item === undefined) return authorizedNow;
      return canDeleteHistoryItem(item, authorizedNow);
    });
    if (ids.length === 0) {
      closeDeleteDialog();
      return;
    }
    const approvedWorktrees = worktreeCandidates
      .filter((candidate) => isWorktreePathChecked(candidate.worktreePath))
      .map((candidate) => ({
        worktreePath: candidate.worktreePath,
        ownerEpicIds: candidate.ownerEpicIds,
      }));
    deleteMutation.mutate({
      ids: [...ids],
      worktreeCleanup:
        approvedWorktrees.length > 0 ? { candidates: approvedWorktrees } : null,
    });
    // The mutation cache owns the deletion after kickoff, exactly as the
    // Sweep flow's kickoff does. Do not hold the person in the modal while the
    // host deletes the Task(s) and streams the approved worktree cleanup: the
    // hook's own `onSuccess` / `onError` toast the outcome and prune the rows
    // wherever they are by then. No per-call callbacks either - TanStack
    // drops `mutate(vars, { onSuccess })` callbacks on unmount, and this
    // panel can be left before the host answers.
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
  };

  const hasActiveFilters = hasActiveHistoryFilters(search);

  const handleClear = () => {
    clearSearch();
  };
  const handleRetry = () => {
    void refetch();
  };

  const showPageSearch = variant === "page";
  const showToolbarSearch = variant === "picker";

  // ArrowDown out of the search box walks the results; ArrowUp off the first
  // row lands back in the query. At most one of the two search placements is
  // ever mounted, so a single ref covers whichever one is live.
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The SCROLL CONTAINER, not one `<ul>`: preserved-orphan rows render in a
  // second list above the ordinary results, and arrow traversal has to cover
  // both. See `rowTargets`.
  const rowsScopeRef = useRef<HTMLDivElement>(null);
  const keyboardNav = useHistoryListKeyboardNav(searchInputRef, rowsScopeRef);

  // The message-hit section under the list. `null` withholds it entirely:
  // `picker` is a task picker, where a message is not a destination. Selection
  // derives Tasks scope below; the message controller still answers its badge.
  const messageHits: HistoryMessageHitsInputs | null =
    variant === "picker"
      ? null
      : {
          query: search.query,
          filtersActive: hasActiveHistoryTaskFilters(search),
          taskListSettled: !isPending,
          onRowKeyDown: keyboardNav.onRowKeyDown,
        };

  const pageSearch = showPageSearch ? (
    <PanelSearchInput
      inputRef={searchInputRef}
      value={search.query}
      onChange={(next) => {
        updateSearch({ query: next });
      }}
      onKeyDown={keyboardNav.onSearchKeyDown}
      isFetching={isFetching}
      focusOnMount={props.autoFocusSearch}
      scope={selectionMode ? "tasks" : props.scope}
      hostId={hostId}
      placement="page"
      placeholder="Search by title, repo, branch, or PR"
      ariaLabel="Search tasks"
    />
  ) : null;
  const controls: HistoryTaskControlsProps = {
    filters: { active: hasActiveFilters, onClear: handleClear },
    showSelection: selectionEnabled,
    selection: selectionMode
      ? {
          kind: "active",
          canSelect: selectableItemIds.length > 0,
          selectedCount,
          allVisibleSelected:
            selectableItemIds.length > 0 &&
            selectedCount === selectableItemIds.length,
          isDeletePending: deleteMutation.isPending,
          canSweepSelected,
          onSelectAll: selectAllVisible,
          onDeselectAll: deselectAllVisible,
          onCancel: cancelSelection,
          onDeleteSelected: () => {
            requestDelete(visibleSelectedIds);
          },
          onSweepSelected: () => {
            // The whole selection goes in as ONE set so a worktree
            // shared between two selected tasks is judged against the
            // selection, not one task, and stops reading as "shared".
            if (!canSweepSelected) return;
            setSweepEpicIds(visibleSelectedIds);
          },
        }
      : {
          kind: "idle",
          canSelect: selectableItemIds.length > 0,
          onStart: enterSelectionMode,
        },
    sort: search.sort,
    onSortChange: (next) => {
      updateSearch({ sort: next, sortExplicit: true });
    },
    availableRepos: availableRepos,
    availableWorkspaces: availableWorkspaces,
    search: search,
    onSearchChange: updateSearch,
    facets: facets,
    chatHostFilterSupported: chatHostFilterSupported,
    refresh: { isFetching, hostId, onRefetch: refetch },
  };

  return (
    <TooltipProvider>
      <section
        className={cn(
          "flex min-h-0 w-full flex-col",
          variant === "page"
            ? "mx-auto max-w-3xl flex-1 px-4 pt-4 md:px-6 md:pt-6"
            : "mt-8",
          props.className,
        )}
      >
        <NotificationIndicatorsProvider indicators={notificationIndicators}>
          <HistoryListBody
            isCountPending={isCountPending}
            scope={selectionMode ? "tasks" : props.scope}
            onScopeChange={selectionMode ? () => {} : props.onScopeChange}
            pageSearch={pageSearch}
            chrome={
              <PanelChromeBar
                leading={
                  showToolbarSearch ? (
                    <PanelSearchInput
                      inputRef={searchInputRef}
                      value={search.query}
                      onChange={(next) => {
                        updateSearch({ query: next });
                      }}
                      onKeyDown={keyboardNav.onSearchKeyDown}
                      isFetching={isFetching}
                      focusOnMount={props.autoFocusSearch}
                      scope="tasks"
                      hostId={hostId}
                      placement="toolbar"
                      placeholder="Search by title, repo, branch, or PR"
                      ariaLabel="Search tasks"
                    />
                  ) : null
                }
                controls={controls}
              />
            }
            controls={controls}
            variant={variant}
            error={error}
            isPending={isPending}
            isFetching={isFetching}
            hasActiveFilters={hasActiveFilters}
            chatHostFilterUnsupported={chatHostFilterUnsupported}
            hostRequiresCloudToList={hostRequiresCloudToList}
            items={items}
            onRetry={handleRetry}
            selectionMode={selectionMode}
            selectionEnabled={selectionEnabled}
            selectedIds={selectedIds}
            onToggleSelection={toggleSelection}
            onRequestDelete={requestDelete}
            onRequestSweep={requestSweep}
            onSetPinned={handleSetPinned}
            pendingSetPinnedEpicIds={pendingSetPinnedEpicIds}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            onLoadMore={fetchNextPage}
            onSelectEpic={onSelectEpic}
            onOpenItem={onOpenItem}
            onOpenInNewWindow={openInNewWindowFlow.requestOpen}
            openInNewWindowAvailable={openInNewWindowFlow.isAvailable}
            worktreesByEpicId={worktreesByEpicId}
            surfaceHostId={hostId}
            openEpicIds={openEpicIdSet}
            completeness={view.completeness}
            cloudPagePending={cloudPagePending}
            rowsScopeRef={rowsScopeRef}
            onRowKeyDown={keyboardNav.onRowKeyDown}
            messageHits={messageHits}
            onRefresh={refreshHistory}
          />
        </NotificationIndicatorsProvider>
      </section>
      <DeleteTasksDialog
        open={pendingDeleteIds !== null}
        onOpenChange={(open) => {
          if (!open) closeDeleteDialog();
        }}
        title={describeDeleteTitle(pendingDeleteIds, items)}
        description="This action cannot be undone."
        isCheckingWorktrees={worktreeCandidatesFetching}
        onConfirm={handleConfirmDelete}
        candidates={worktreeCandidates}
        isPathChecked={isWorktreePathChecked}
        onTogglePath={toggleWorktreePathChecked}
      />
      <SweepWorktreesFlow
        epicIds={sweepEpicIds}
        // The Epics list is app chrome: its sweep proves and sweeps the
        // app-wide host's worktrees (the following client - `null` resolves
        // to the effective host's requester, the same seam the landing
        // composer's following state uses). On a fleet with more than one
        // dialable host the flow asks WHICH first and resolves that pick
        // instead; at one host this is byte-for-byte the previous wiring.
        surfaceHostClient={sweepHostClient}
        // The host this panel is ALREADY reading from, so the picker opens
        // marked where Sweep used to go without a second app-wide read. It is
        // the same client family: the list's `hostId` is what the app-wide
        // client currently addresses, which is what `useHostClientForHostId(null)`
        // follows.
        surfaceHostId={hostId}
        taskTitle={sweepTaskTitle}
        onOpenChange={(open) => {
          if (!open) setSweepEpicIds(null);
        }}
      />
      <UnsyncedEpicMoveDialog flow={openInNewWindowFlow.epicFlow} />
    </TooltipProvider>
  );
}

/**
 * The two chat-host gate answers the panel needs, kept together because they
 * are two faces of one decision: whether to OFFER the filter, and whether the
 * rows in hand were withheld because it could not be applied.
 *
 * "unknown" (no handshake yet) stays OFFERABLE. The manifest fills in on the
 * first RPC to the host, and hiding the section until then would make it
 * flicker in on every cold open. A filter actually issued against a host that
 * turns out to be too old is caught by the fail-closed arm in
 * `useHistoryQuery`, which withholds rows rather than showing them unfiltered.
 */
function useChatHostFilterGate(
  hostId: string | null,
  data: HistoryFetchResult | undefined,
): { chatHostFilterSupported: boolean; chatHostFilterUnsupported: boolean } {
  const support = useChatHostFilterSupport(hostId);
  return {
    chatHostFilterSupported: support !== "unsupported",
    chatHostFilterUnsupported: data?.chatHostFilterUnsupported ?? false,
  };
}

function hasActiveHistoryFilters(search: HistorySearchState): boolean {
  return (
    search.repos.length > 0 ||
    search.workspaces.length > 0 ||
    search.chatHosts.length > 0 ||
    search.ownershipScopes.length > 0 ||
    (search.sortExplicit && search.sort !== DEFAULT_SORT) ||
    search.query.trim().length > 0
  );
}

/**
 * The narrower question the message-hit section asks: is History showing a
 * SUBSET of the account's tasks right now?
 *
 * Deliberately not {@link hasActiveHistoryFilters}. The query is not a
 * narrowing the hits ignore - it is the thing they are searching for - and a
 * sort reorders the task list without removing anything from it, so neither
 * belongs in a label that says the hits below were not filtered the same way.
 */
function hasActiveHistoryTaskFilters(search: HistorySearchState): boolean {
  return (
    search.repos.length > 0 ||
    search.workspaces.length > 0 ||
    search.chatHosts.length > 0 ||
    search.ownershipScopes.length > 0
  );
}

interface PanelSearchInputProps {
  /** Owned by the panel body so ArrowUp off the first row can return here. */
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  readonly isFetching: boolean;
  readonly focusOnMount: boolean;
  readonly placement: "page" | "toolbar";
  readonly scope: HistoryScope;
  readonly hostId: string | null;
  readonly placeholder: string;
  readonly ariaLabel: string;
}

function PanelSearchInput(props: PanelSearchInputProps): ReactNode {
  const isMobileViewport = useIsMobileViewport();
  if (props.placement === "page" && !isMobileViewport) {
    return <ScopedPanelSearchInput {...props} />;
  }
  return <PanelSearchInputBody {...props} searchesMessages={false} />;
}

function ScopedPanelSearchInput(props: PanelSearchInputProps): ReactNode {
  const hostEntry = useHostDirectoryEntry(props.hostId);
  const labels: Record<HistoryScope, string> = {
    all: "Search tasks and messages",
    tasks: "Search by title, repo, branch, or PR",
    messages: `Search messages on ${hostEntry?.label ?? "this machine"}`,
  };
  return (
    <PanelSearchInputBody
      {...props}
      placeholder={labels[props.scope]}
      ariaLabel={labels[props.scope]}
      searchesMessages
    />
  );
}

function PanelSearchInputBody(
  props: PanelSearchInputProps & { readonly searchesMessages: boolean },
): ReactNode {
  const { inputRef, searchesMessages } = props;
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
  }, [focusOnMount, inputRef]);
  return (
    <div
      className={cn(
        props.placement === "page" ? "px-2 pb-3" : "min-w-0 flex-1 sm:max-w-sm",
      )}
    >
      <InputGroup>
        <InputGroupAddon align="inline-start">
          {props.isFetching ? (
            <AgentSpinningDots
              testId="epics-list-search-spinner"
              variant="orbit"
              className={undefined}
              tone="muted"
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
          onKeyDown={props.onKeyDown}
          placeholder={props.placeholder}
          aria-label={props.ariaLabel}
        />
        {props.value.length > 0 ? (
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              tabIndex={searchesMessages ? -1 : 0}
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

function PanelChromeBar(props: {
  readonly leading: ReactNode;
  readonly controls: HistoryTaskControlsProps;
}): ReactNode {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2"
      data-testid="panel-chrome-bar"
    >
      <div className="flex flex-1 items-center gap-2">
        {props.leading}
        {props.controls.filters.active ? (
          <ClearFiltersButton onClick={props.controls.filters.onClear} />
        ) : null}
      </div>
      <HistoryTaskControls {...props.controls} />
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
  // `match.title` is RAW; apply the source-aware "Untitled task" fallback (prompt
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

interface HistoryListBodyProps extends EpicsListBodyProps {
  readonly isCountPending: boolean;
  readonly scope: HistoryScope;
  readonly onScopeChange: (scope: HistoryScope) => void;
  readonly pageSearch: ReactNode;
  readonly chrome: ReactNode;
  readonly controls: HistoryTaskControlsProps;
  readonly variant: EpicsListPanelVariant;
  /**
   * The DESKTOP scroll container's ref, and only it. Arrow traversal reads
   * every `[data-history-row-target]` under this node, so it has to be the
   * element that contains both the preserved-orphan list and the ordinary
   * results - not either `<ul>`. The mobile branch deliberately does not take
   * it: `MobileHistoryList` owns its own scrolling element for pull-to-refresh
   * and has no keyboard-row contract to anchor.
   */
  readonly rowsScopeRef: React.RefObject<HTMLDivElement | null>;
  /**
   * The message-hit section's inputs, or `null` when this History must not
   * show one. It renders INSIDE `rowsScopeRef`'s node so its hit controls join
   * the arrow traversal in DOM order, after the last task row - which is the
   * whole reason it is threaded down here rather than mounted beside the list.
   * The mobile branch does not take it, for the same reason it does not take
   * the scope ref.
   */
  readonly messageHits: HistoryMessageHitsInputs | null;
  readonly onRefresh: () => Promise<unknown>;
}

/**
 * Picks the list body the form factor calls for, and owns nothing else.
 *
 * FORM FACTOR, not product: the phone list is a layout, and a desktop window
 * narrowed past the breakpoint gets it for the same reason it gets the
 * hamburger and the single-tile canvas. `variant="picker"` is excluded because
 * it is a read-only destination browser - its rows have no actions for a tray
 * to hold and no selection for a hold to enter.
 *
 * Separate from the panel so the choice, the mobile-only activation hook and
 * the desktop scroller travel together instead of adding three more branches
 * to a body that already carries the panel's whole selection and delete flow.
 */
function HistoryListBody(props: HistoryListBodyProps): ReactNode {
  const isMobileViewport = useIsMobileViewport();
  const openHistoryItem = useHistoryOpenItem({
    onSelectEpic: props.onSelectEpic,
    onOpenItem: props.onOpenItem,
  });
  if (isMobileViewport && props.variant !== "picker") {
    return (
      <>
        {props.pageSearch}
        {props.chrome}
        <MobileHistoryList
          error={props.error}
          isPending={props.isPending}
          isFetching={props.isFetching}
          hasActiveFilters={props.hasActiveFilters}
          chatHostFilterUnsupported={props.chatHostFilterUnsupported}
          hostRequiresCloudToList={props.hostRequiresCloudToList}
          items={props.items}
          completeness={props.completeness}
          cloudPagePending={props.cloudPagePending}
          onRetry={props.onRetry}
          selectionMode={props.selectionMode}
          selectedIds={props.selectedIds}
          onToggleSelection={props.onToggleSelection}
          onRequestDelete={props.onRequestDelete}
          onSetPinned={props.onSetPinned}
          pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
          hasNextPage={props.hasNextPage}
          isFetchingNextPage={props.isFetchingNextPage}
          onLoadMore={props.onLoadMore}
          onOpenItem={openHistoryItem}
          onRefresh={props.onRefresh}
        />
      </>
    );
  }
  // Destructured rather than read as `props.rowsScopeRef` in the JSX: the
  // compiler lint treats a ref reached through `props` during render as a ref
  // ACCESS and rejects it (and then flags every sibling prop in the same
  // element). The base component did the same thing with its `listRef`.
  const { messageHits, rowsScopeRef } = props;
  const taskList = (
    <EpicsListBody
      error={props.error}
      isPending={props.isPending}
      isFetching={props.isFetching}
      hasActiveFilters={props.hasActiveFilters}
      chatHostFilterUnsupported={props.chatHostFilterUnsupported}
      hostRequiresCloudToList={props.hostRequiresCloudToList}
      items={props.items}
      onRetry={props.onRetry}
      selectionMode={props.selectionMode}
      selectionEnabled={props.selectionEnabled}
      selectedIds={props.selectedIds}
      onToggleSelection={props.onToggleSelection}
      onRequestDelete={props.onRequestDelete}
      onRequestSweep={props.onRequestSweep}
      onSetPinned={props.onSetPinned}
      pendingSetPinnedEpicIds={props.pendingSetPinnedEpicIds}
      hasNextPage={props.hasNextPage}
      isFetchingNextPage={props.isFetchingNextPage}
      onLoadMore={props.onLoadMore}
      onSelectEpic={props.onSelectEpic}
      onOpenItem={props.onOpenItem}
      onOpenInNewWindow={props.onOpenInNewWindow}
      openInNewWindowAvailable={props.openInNewWindowAvailable}
      worktreesByEpicId={props.worktreesByEpicId}
      surfaceHostId={props.surfaceHostId}
      openEpicIds={props.openEpicIds}
      completeness={props.completeness}
      cloudPagePending={props.cloudPagePending}
      onRowKeyDown={props.onRowKeyDown}
    />
  );
  if (messageHits === null) {
    return (
      <>
        {props.pageSearch}
        {props.chrome}
        <div
          ref={rowsScopeRef}
          className="min-h-0 flex-1 overflow-y-auto pb-10"
        >
          {taskList}
        </div>
      </>
    );
  }
  return (
    <>
      {props.pageSearch}
      <HistoryScopedResults
        hostId={props.surfaceHostId}
        scope={props.scope}
        onScopeChange={props.onScopeChange}
        taskCount={historyTaskCount(props)}
        controls={props.controls}
        taskList={taskList}
        messageHits={messageHits}
        rowsScopeRef={rowsScopeRef}
      />
    </>
  );
}

function historyTaskCount(props: HistoryListBodyProps): HistoryCount {
  if (
    props.surfaceHostId === null ||
    props.error !== null ||
    props.hostRequiresCloudToList ||
    props.chatHostFilterUnsupported
  )
    return null;
  if (props.isCountPending) return "pending";
  if (
    props.items.length === 0 &&
    props.completeness?.cloudPage === "unavailable"
  )
    return null;
  return `${props.items.length}${props.hasNextPage ? "+" : ""}`;
}

interface EpicsListBodyProps {
  readonly error: Error | null;
  readonly isPending: boolean;
  readonly isFetching: boolean;
  readonly hasActiveFilters: boolean;
  readonly chatHostFilterUnsupported: boolean;
  /**
   * Nothing was asked for: no cloud verdict, and a host that cannot list
   * locally. Rendered ahead of every other empty branch - see
   * `EpicsListHostRequiresCloudToList` for why each alternative is a lie.
   */
  readonly hostRequiresCloudToList: boolean;
  readonly items: ReadonlyArray<HistoryItem>;
  readonly onRetry: () => void;
  readonly selectionMode: boolean;
  readonly selectionEnabled: boolean;
  readonly selectedIds: ReadonlySet<string>;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onRequestSweep: (epicId: string) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly pendingSetPinnedEpicIds: ReadonlySet<string>;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly onLoadMore: () => void;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly onOpenInNewWindow: HistoryNewWindowFlow["requestOpen"];
  readonly openInNewWindowAvailable: boolean;
  readonly worktreesByEpicId: ReadonlyMap<
    string,
    readonly WorktreeHostEntryV12[]
  >;
  /**
   * The host this list is reading from - the one whose worktree listing
   * `worktreesByEpicId` is. A row compares its own provenance against it to
   * decide whether the Task reaches past this machine.
   */
  readonly surfaceHostId: string | null;
  readonly openEpicIds: ReadonlySet<string>;
  readonly completeness: ListTasksCompleteness | null;
  /** Local-first cloud revalidation for the first page is still outstanding. */
  readonly cloudPagePending: boolean;
  /** Anchors the arrow-key traversal: DOM order inside it is row order. */
  readonly onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

function EpicsListBody(props: EpicsListBodyProps): ReactNode {
  const {
    error,
    isPending,
    isFetching,
    hasActiveFilters,
    chatHostFilterUnsupported,
    hostRequiresCloudToList,
    items,
    onRetry,
    selectionMode,
    selectionEnabled,
    selectedIds,
    onToggleSelection,
    onRequestDelete,
    onRequestSweep,
    onSetPinned,
    pendingSetPinnedEpicIds,
    hasNextPage,
    isFetchingNextPage,
    onLoadMore,
    onSelectEpic,
    onOpenItem,
    onOpenInNewWindow,
    openInNewWindowAvailable,
    worktreesByEpicId,
    surfaceHostId,
    openEpicIds,
    completeness,
    cloudPagePending,
    onRowKeyDown,
  } = props;

  // Partitioned, not sorted into place. A preserved orphan is not a task with
  // an unusual status - the server has deleted it and only the serving host's
  // never-uploaded edits remain - so mixing it into the ordinary list under
  // whatever sort happens to be active is how it stayed effectively invisible
  // even once it was listable. The heading says the task was deleted and its
  // edits kept; it does not say which side deleted it or which side kept them.
  const preservedItems = items.filter(
    (item) => item.isPreservedOrphan === true,
  );
  const ordinaryItems =
    preservedItems.length === 0
      ? items
      : items.filter((item) => item.isPreservedOrphan !== true);

  if (error !== null) {
    return <EpicsListError error={error} onRetry={onRetry} />;
  }
  // Ahead of the spinner, because this state IS the spinner's false positive:
  // the underlying query never ran, so it reports `pending` forever and every
  // downstream branch below would describe a load that is not happening.
  if (hostRequiresCloudToList) {
    return <EpicsListHostRequiresCloudToList />;
  }
  if (isPending) {
    return <EpicsListLoading />;
  }
  // Ahead of every other empty state: the rows were WITHHELD, not absent, and
  // "No tasks yet" would be an outright false statement about the account.
  if (chatHostFilterUnsupported) {
    return <EpicsListChatHostFilterUnsupported />;
  }
  // Every "there are no rows" reading, decided once for both responsive bodies
  // in `EpicsListNoRows` - the ordering there is load-bearing.
  if (items.length === 0) {
    return (
      <EpicsListNoRows
        cloudPagePending={cloudPagePending}
        cloudPageUnavailable={completeness?.cloudPage === "unavailable"}
        hasActiveFilters={hasActiveFilters}
        isFetching={isFetching}
        onRetry={onRetry}
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={onLoadMore}
      />
    );
  }
  const rowProps = {
    selectionMode,
    selectionEnabled,
    selectedIds,
    onToggleSelection,
    onRequestDelete,
    onRequestSweep,
    onSetPinned,
    pendingSetPinnedEpicIds,
    onSelectEpic,
    onOpenItem,
    onOpenInNewWindow,
    openInNewWindowAvailable,
    worktreesByEpicId,
    openEpicIds,
  };
  return (
    <>
      {preservedItems.length > 0 ? (
        <section
          className="mb-3 flex flex-col gap-2"
          data-testid="epics-list-preserved-section"
        >
          <h2 className="text-ui-xs font-medium text-destructive">
            Deleted &mdash; unsynced edits kept
          </h2>
          <ul className="flex flex-col gap-2">
            {preservedItems.map((item) => (
              <EpicsListRow
                key={item.id}
                item={item}
                {...rowProps}
                surfaceHostId={surfaceHostId}
                onRowKeyDown={onRowKeyDown}
                isSelected={selectedIds.has(item.epicId)}
                isPinPending={pendingSetPinnedEpicIds.has(item.epicId)}
                worktrees={
                  worktreesByEpicId.get(item.epicId) ?? EMPTY_WORKTREES
                }
                isOpen={openEpicIds.has(item.epicId)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {ordinaryItems.length > 0 ? (
        <ul className="flex flex-col gap-2" data-testid="epics-list-rows">
          {ordinaryItems.map((item) => (
            <EpicsListRow
              key={item.id}
              item={item}
              selectionMode={selectionMode}
              selectionEnabled={selectionEnabled}
              isSelected={selectedIds.has(item.epicId)}
              onToggleSelection={onToggleSelection}
              onRequestDelete={onRequestDelete}
              onRequestSweep={onRequestSweep}
              onSetPinned={onSetPinned}
              isPinPending={pendingSetPinnedEpicIds.has(item.epicId)}
              onSelectEpic={onSelectEpic}
              onOpenItem={onOpenItem}
              onOpenInNewWindow={onOpenInNewWindow}
              openInNewWindowAvailable={openInNewWindowAvailable}
              worktrees={worktreesByEpicId.get(item.epicId) ?? EMPTY_WORKTREES}
              surfaceHostId={surfaceHostId}
              isOpen={openEpicIds.has(item.epicId)}
              onRowKeyDown={onRowKeyDown}
            />
          ))}
        </ul>
      ) : null}
      {/*
        No "no tasks match" here: zero rows returned above through
        `EpicsListNoRows`, and a page whose only rows are preserved orphans is
        not an empty filter result - telling the person "no tasks match" over a
        section they can see would be the same untruth from the other direction.
      */}
      <EpicsListShowMore
        hasNextPage={hasNextPage}
        isFetchingNextPage={isFetchingNextPage}
        onLoadMore={onLoadMore}
      />
    </>
  );
}

interface EpicsListRowProps {
  readonly item: HistoryItem;
  readonly selectionMode: boolean;
  /** False for the read-only `variant="picker"` embed - disables the sweep
   * affordance instead of leaving it live-looking but inert. */
  readonly selectionEnabled: boolean;
  readonly isSelected: boolean;
  readonly onToggleSelection: (id: string) => void;
  readonly onRequestDelete: (ids: ReadonlyArray<string>) => void;
  readonly onRequestSweep: (epicId: string) => void;
  readonly onSetPinned: (epicId: string, pinned: boolean) => void;
  readonly isPinPending: boolean;
  readonly onSelectEpic: ((epicId: string) => void) | null;
  readonly onOpenItem: ((item: HistoryItem) => void) | null;
  readonly onOpenInNewWindow: HistoryNewWindowFlow["requestOpen"];
  readonly openInNewWindowAvailable: boolean;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  /** See `EpicsListBodyProps.surfaceHostId`. */
  readonly surfaceHostId: string | null;
  readonly isOpen: boolean;
  /** Arrow-key traversal, bound to whichever control covers the whole card. */
  readonly onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * Marks a row activation target that opens a tooltip of its own on focus (the
 * selection-mode toggle of a row that cannot be selected). `onRowFocus` does
 * not hold a status mark's tooltip open beside it - see `HistoryRowStatusSlot`.
 */
const ROW_TARGET_OWN_TOOLTIP_ATTRIBUTE = "data-history-row-target-own-tooltip";

const EpicsListRow = memo(function EpicsListRow(props: EpicsListRowProps) {
  const {
    item,
    selectionMode,
    selectionEnabled,
    isSelected,
    onToggleSelection,
    onRequestDelete,
    onRequestSweep,
    onSetPinned,
    isPinPending,
    onSelectEpic,
    onOpenItem,
    onOpenInNewWindow,
    openInNewWindowAvailable,
    worktrees,
    surfaceHostId,
    isOpen,
    onRowKeyDown,
  } = props;
  const isPhase = item.taskType === "phase";
  const rowSweep = useHistoryRowSweep({
    item,
    worktrees,
    surfaceHostId,
    selectionMode,
    selectionEnabled,
    onRequestSweep,
  });
  const displayTitle = historyItemDisplayTitle(item);
  // The same verdict the panel gates selection on, read here too rather than
  // threaded down as a prop: this row renders for a picker variant that never
  // computes the panel's copy, and a control that admits on a rule its own
  // panel does not is how the class reopens at a second surface.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const canEditTitle = canEditHistoryItemTitle(item, cloudAuthorized);
  const { canDeleteItem, deleteDisabledTooltip } = useHistoryRowDeleteGate(
    item,
    cloudAuthorized,
  );
  const selectionDisabled = historySelectionDisabled(
    selectionMode,
    canDeleteItem,
  );
  const { mutate: renameEpicTitle, isPending: isRenamePending } =
    useEpicUpdateTitle();
  const openHistoryItem = useHistoryOpenItem({ onSelectEpic, onOpenItem });
  const linkTabId = useEpicCanvasStore(
    (s) => s.resolveTabIdForEpic(item.epicId) ?? item.epicId,
  );
  const openInBackground = useCallback(() => {
    if (isOpen) {
      toast("Task already open", {
        id: "history-task-already-open",
        description: displayTitle,
      });
      return;
    }
    openEpicInBackground(item.epicId, item.title);
  }, [isOpen, displayTitle, item.epicId, item.title]);
  const openInNewWindow = useCallback(() => {
    onOpenInNewWindow(item);
  }, [onOpenInNewWindow, item]);
  const commitEpicTitle = useCallback(
    (nextTitle: string) => {
      if (isPhase) return;
      // Re-checked at COMMIT, not only at admission: a rename started before
      // a demotion would otherwise land on the retained credential after the
      // verdict was withdrawn. Same exemption as the gate - a local-home row
      // spends nothing.
      if (
        item.isLocalHome !== true &&
        !authorizesCloudCapability(useAuthStore.getState().status)
      ) {
        return;
      }
      renameEpicTitle({
        epicDelta: {
          id: item.epicId,
          title: nextTitle,
          updatedAt: Date.now(),
        },
      });
    },
    [isPhase, item.epicId, item.isLocalHome, renameEpicTitle],
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
    openHistoryItem(item);
  }, [item, openHistoryItem]);
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
  // A middle button arrives as `auxclick`, never `click` (`on-middle-click.ts`),
  // and the app's convention for it is a background open (`tile-open/intent.ts`
  // maps `button === 1` to `background`). Without this the anchor's own
  // default ran instead - a window open the desktop shell denies. A phase has
  // no background open (see `backgroundMenuItem`) and opens in place.
  const openEpicRowInBackground = (
    event: React.MouseEvent<HTMLAnchorElement>,
  ) => {
    event.preventDefault();
    if (isPhase) {
      openEpic();
      return;
    }
    openInBackground();
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
          : "border-border bg-background text-transparent hover:border-foreground active:border-foreground active:press-scrim",
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
  const deleteControl = selectionMode ? null : (
    <HistoryRowDeleteControl
      item={item}
      canDeleteItem={canDeleteItem}
      deleteDisabledTooltip={deleteDisabledTooltip}
      onRequestDelete={onRequestDelete}
      onBlockUnavailableDelete={blockUnavailableDeleteAction}
    />
  );
  // Phases have no background-open: a phase only opens through its migration
  // route (migrationSource=phase), which a plain canvas tab can't carry, so it
  // would activate into the wrong (non-migration) surface. New Window stays
  // available - it goes through the route.
  const backgroundMenuItem = isPhase ? null : (
    <ContextMenuItem
      onSelect={openInBackground}
      disabled={isOpen}
      data-testid="epics-list-row-open-background"
    >
      <ArrowDownToLine className="mt-0.5 self-start" />
      <span className="flex flex-col">
        <span>Open in Background</span>
        <span hidden={!isOpen} className="text-ui-xs">
          Already open
        </span>
      </span>
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
    <HistoryTaskRow
      item={item}
      selectionMode={selectionMode}
      selectionDisabled={selectionDisabled}
      selectedForDelete={historySelectedForDelete({
        selectionMode,
        isSelected,
        canDeleteItem,
      })}
      selectionControl={selectionControl}
      renderInteractionTarget={(describedBy) =>
        selectionMode ? (
          <HistorySelectionOverlay
            item={item}
            canDeleteItem={canDeleteItem}
            deleteDisabledTooltip={deleteDisabledTooltip}
            describedById={describedBy}
            onToggleSelection={toggleEpicSelection}
            onBlockUnavailableDelete={blockUnavailableDeleteAction}
            onRowKeyDown={onRowKeyDown}
          />
        ) : (
          <Link
            aria-describedby={describedBy}
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
            onAuxClick={onMiddleClick(openEpicRowInBackground)}
            onKeyDown={onRowKeyDown}
            aria-label={`Open task ${displayTitle}`}
            data-history-row-target=""
            className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        )
      }
      renameEditor={
        isRenaming ? (
          <input
            {...renameInputProps}
            type="text"
            aria-label={`Rename ${displayTitle}`}
            data-testid="epics-list-row-title-input"
            className="pointer-events-auto w-full min-w-0 flex-1 rounded border border-input bg-background/90 px-1.5 py-0.5 font-medium text-foreground outline-none focus:border-ring/70 focus-visible:ring-0"
          />
        ) : null
      }
      renameControl={titleEditControl}
      deleteControl={deleteControl}
      sweepControl={
        <HistoryRowSweepControl sweep={rowSweep} displayTitle={displayTitle} />
      }
      sweepMenuItem={
        rowSweep.canSweep ? <HistorySweepMenuItem sweep={rowSweep} /> : null
      }
      hasSweepControl={rowSweep.isVisible}
      contextMenuItems={backgroundMenuItem}
      openInNewWindowControl={newWindowMenuItem}
      onSetPinned={onSetPinned}
      isPinPending={isPinPending}
      pinAlwaysVisible={false}
      showOpenBadge
      isOpen={isOpen}
      worktrees={worktrees}
    />
  );
});

function historySelectionDisabled(
  selectionMode: boolean,
  canDeleteItem: boolean,
): boolean {
  return selectionMode && !canDeleteItem;
}

/**
 * The row's delete admission plus the reason shown when it is refused. The
 * in-flight arm sits ahead of the static verdict: deletion runs in the
 * background and the dialog closes at kickoff, so this row is back on screen
 * before the host has answered, and a second `epic.batchDelete` for the same
 * id is not deduplicated anywhere on the wire.
 */
function useHistoryRowDeleteGate(
  item: HistoryItem,
  cloudAuthorized: boolean,
): {
  readonly canDeleteItem: boolean;
  readonly deleteDisabledTooltip: string;
} {
  const isDeleteInFlight = usePendingDeleteEpicIds().has(item.epicId);
  if (isDeleteInFlight) {
    return {
      canDeleteItem: false,
      deleteDisabledTooltip: DELETE_IN_FLIGHT_TOOLTIP,
    };
  }
  return {
    canDeleteItem: canDeleteHistoryItem(item, cloudAuthorized),
    deleteDisabledTooltip: historyDeleteDisabledTooltip(item, cloudAuthorized),
  };
}

function historyDeleteDisabledTooltip(
  item: HistoryItem,
  cloudAuthorized: boolean,
): string {
  // Ahead of the role arms: a preserved orphan can carry an `owner` role and
  // still be undeletable, so a role-derived reason would read as a permissions
  // problem the user could fix by asking someone.
  if (item.isPreservedOrphan === true) return PRESERVED_ORPHAN_DELETE_TOOLTIP;
  // Also ahead of them, and for the sharper version of that reason: an
  // unverified session leaves every role on screen exactly as it was, so a
  // withdrawn verdict reported as "you don't have permission" sends the user to
  // ask a collaborator for access they already hold. Behind the orphan arm
  // though - that row could never be deleted, verdict or not, and naming the
  // recoverable condition for it would be the same misdirection in reverse.
  if (!cloudAuthorized && item.isLocalHome !== true) {
    return UNVERIFIED_SESSION_DELETE_TOOLTIP;
  }
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

interface HistoryRowSweepState {
  /** The control renders at all (hidden for phases / during selection). */
  readonly isVisible: boolean;
  /** There is something to open the dialog for. */
  readonly canSweep: boolean;
  readonly requestSweep: () => void;
}

/**
 * Sweep is offered whenever the task owns worktrees on this host, eligible or
 * not: the dialog lists every worktree with its proof state and pre-checks
 * only the safe ones, so the affordance no longer pre-judges eligibility.
 * Cheap and reactive - derived from the same enriched listing the PR pills
 * already join, with no extra host call to render the affordance.
 *
 * ...OR the Task's own provenance names a machine other than this one. That
 * second clause is the multi-host half, and it is not a nicety: the listing
 * above is THIS host's, so without it the host picker behind this control is
 * unreachable for precisely the Tasks it exists for. Still zero-RPC -
 * `chatHostIds` is already on the row - and still a hint, with the dialog's
 * own act-time proof as the judge. See `namesHostOutsideSurface` for what the
 * hint under- and over-claims.
 */
function useHistoryRowSweep(args: {
  readonly item: HistoryItem;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  /** The host `worktrees` was listed from — see `EpicsListBodyProps`. */
  readonly surfaceHostId: string | null;
  readonly selectionMode: boolean;
  readonly selectionEnabled: boolean;
  readonly onRequestSweep: (epicId: string) => void;
}): HistoryRowSweepState {
  const {
    item,
    worktrees,
    surfaceHostId,
    selectionMode,
    selectionEnabled,
    onRequestSweep,
  } = args;
  const requestSweep = useCallback(() => {
    onRequestSweep(item.epicId);
  }, [item.epicId, onRequestSweep]);
  // Visible-but-disabled when the Task owns no worktrees, matching how the
  // delete control and the bulk Sweep button behave: the affordance keeps its
  // place in the row instead of appearing and disappearing per row. Phases are
  // still skipped entirely - they never have worktrees, so a permanently dead
  // control there would be noise rather than consistency. The read-only picker
  // embed (`selectionEnabled=false`) uses the same disabled treatment rather
  // than a live-looking button whose click is silently neutered upstream.
  const hasSweepTarget =
    worktrees.length > 0 ||
    namesHostOutsideSurface({ hostIds: item.chatHostIds, surfaceHostId });
  return {
    isVisible: !selectionMode && item.taskType !== "phase",
    canSweep:
      selectionEnabled &&
      !selectionMode &&
      item.taskType !== "phase" &&
      hasSweepTarget,
    requestSweep,
  };
}

function HistoryRowSweepControl(props: {
  readonly sweep: HistoryRowSweepState;
  readonly displayTitle: string;
}): ReactNode {
  if (!props.sweep.isVisible) return null;
  if (props.sweep.canSweep) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Sweep worktrees for ${props.displayTitle}`}
            aria-haspopup="dialog"
            data-testid="epics-list-row-sweep"
            className="absolute right-11 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100"
            onClick={props.sweep.requestSweep}
          >
            <Paintbrush />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Sweep this task's worktrees</TooltipContent>
      </Tooltip>
    );
  }
  // `aria-disabled` rather than `disabled`, matching the delete control: a
  // truly disabled button swallows pointer events, and the tooltip is the only
  // place the reason is stated.
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-disabled="true"
          aria-label={`No worktrees to sweep for ${props.displayTitle}`}
          data-testid="epics-list-row-sweep-disabled"
          className="absolute right-11 top-1/2 inline-flex size-8 -translate-y-1/2 cursor-not-allowed items-center justify-center rounded-md text-muted-foreground/50 opacity-0 transition-opacity outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50 group-hover:opacity-100"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <Paintbrush className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent>This task has no worktrees on this host</TooltipContent>
    </Tooltip>
  );
}

function HistorySweepMenuItem(props: {
  readonly sweep: HistoryRowSweepState;
}): ReactNode {
  if (!props.sweep.canSweep) return null;
  return (
    <ContextMenuItem
      onSelect={props.sweep.requestSweep}
      data-testid="epics-list-row-sweep-menu"
    >
      <Paintbrush />
      Sweep Worktrees…
    </ContextMenuItem>
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
        className="pointer-events-auto size-5 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
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
  /** The row's status slot, so the toggle is described by the same sentence
   * the overlay link is - see `HistoryRowStatusSlot`. */
  readonly describedById: string;
  readonly onToggleSelection: () => void;
  readonly onBlockUnavailableDelete: (
    event: React.MouseEvent<HTMLElement>,
  ) => void;
  readonly onRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  if (props.canDeleteItem) {
    return (
      <button
        type="button"
        aria-label={`Toggle selection for ${historyItemDisplayTitle(props.item)}`}
        aria-describedby={props.describedById}
        data-history-row-target=""
        className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        onClick={props.onToggleSelection}
        onKeyDown={props.onRowKeyDown}
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
          aria-describedby={props.describedById}
          data-history-row-target=""
          {...{ [ROW_TARGET_OWN_TOOLTIP_ATTRIBUTE]: "" }}
          className="absolute inset-0 cursor-not-allowed rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={props.onBlockUnavailableDelete}
          onKeyDown={props.onRowKeyDown}
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
        variant="muted-destructive"
        size="icon-sm"
        aria-label={`Delete ${historyItemDisplayTitle(props.item)}`}
        aria-haspopup="dialog"
        data-testid="epics-list-row-delete"
        className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
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
