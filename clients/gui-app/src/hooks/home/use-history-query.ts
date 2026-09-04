import type {
  HistoryItem,
  HistoryOwnershipScope,
  HistorySortOption,
  HistoryWorkspaceRef,
} from "@/components/home/data/home-page.data";
import {
  buildHistoryItemsFromTasks,
  collectHistoryRepos,
  dedupSortWorkspaces,
  EMPTY_LOCAL_HOMED_TASK_IDS,
  filterHistoryItems,
  historyPullRequestQueryNumber,
  historyPullRequestSearchEpicIds,
  historyWorktreeSearchEpicIds,
  prioritizePinnedHistoryItems,
  sortHistoryItems,
  withHistoryItemWorktreeMetadata,
  workspaceKey,
} from "@/components/home/data/home-page.data";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useChatHostFilterSupport } from "@/hooks/home/use-chat-host-filter-support";
import { useDebouncedValue } from "@/hooks/ui/use-debounced-value";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import {
  useTaskWorktreeMetadata,
  useWorktreeHostActivityIndex,
  useWorktreeHostIndex,
} from "@/hooks/worktree/use-task-worktree-metadata-query";
import {
  listCloudTasksRequestForHistorySearch,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import type {
  ListTasksCompleteness,
  ListTasksResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { WorktreeHostEntryV12 } from "@traycer/protocol/host/worktree-schemas";
import type { HistorySearchState } from "@/lib/history-search";
import { patchHistorySearch } from "@/lib/history-search";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import Fuse, { type IFuseOptions } from "fuse.js";
import { useCallback, useMemo, useState } from "react";

const SEARCH_DEBOUNCE_MS = 250;
const LOCAL_FUSE_OPTIONS: IFuseOptions<HistoryItem> = {
  includeScore: false,
  ignoreLocation: true,
  threshold: 0.4,
  minMatchCharLength: 1,
  keys: [
    { name: "title", weight: 0.8 },
    { name: "linkedRepos", weight: 0.2 },
    { name: "pullRequestNumbers", weight: 0.8 },
    { name: "worktreeBranches", weight: 0.8 },
    { name: "worktreePaths", weight: 0.3 },
  ],
};

export interface UseHistoryQueryParams {
  search: HistorySearchState;
  nowMs: number | null;
}

export interface UseHistoryQueryResult {
  data: HistoryFetchResult | undefined;
  isPending: boolean;
  isFetching: boolean;
  error: Error | null;
  hostId: string | null;
  refetch: () => Promise<unknown>;
  fetchNextPage: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /**
   * True while the local-first revalidation leg is outstanding - the rendered
   * page is a LOCAL snapshot and its cloud half has not landed yet.
   *
   * The follow-up runs under its own ephemeral query key, so it is invisible to
   * `isFetching` and to every other flag here. A caller that renders an
   * empty-history message must consult this first: the host answers a
   * caller-owned tombstone with an immediate `{tasks: [], cloudPage: "pending"}`
   * page, which is an account nobody has finished asking about, not an empty
   * one.
   */
  readonly cloudPagePending: boolean;
}

export function useHistoryQuery(
  params: UseHistoryQueryParams,
): UseHistoryQueryResult {
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const trimmedQuery = params.search.query.trim();
  const debouncedQuery = useDebouncedValue(trimmedQuery, SEARCH_DEBOUNCE_MS);
  const [fallbackNowMs] = useState(() => Date.now());
  const nowMs = params.nowMs ?? fallbackNowMs;
  // Branch/worktree strings and PR numbers live only in local worktree
  // metadata, never in the cloud task index. The cloud query stays a plain
  // text search; local matches are resolved to epic ids here and fetched by
  // id (`epic.getTaskContexts`) as an additive union below. PR matching needs
  // the activity-enriched listing (`prNumber` is null on the cheap index), so
  // that heavier host-wide probe is gated on a PR-shaped query.
  const worktreeIndex = useWorktreeHostIndex(true);
  const pullRequestQueryNumber = historyPullRequestQueryNumber(debouncedQuery);
  const isPullRequestNumberQuery = pullRequestQueryNumber !== null;
  const activityIndex = useWorktreeHostActivityIndex(isPullRequestNumberQuery);
  const localTaskIds = useMemo(
    () =>
      Array.from(
        new Set([
          ...historyWorktreeSearchEpicIds(
            debouncedQuery,
            worktreeIndex.worktrees,
          ),
          ...(pullRequestQueryNumber === null
            ? []
            : historyPullRequestSearchEpicIds(
                pullRequestQueryNumber,
                activityIndex.worktrees,
              )),
        ]),
      ).sort((left, right) => left.localeCompare(right)),
    [
      activityIndex.worktrees,
      debouncedQuery,
      pullRequestQueryNumber,
      worktreeIndex.worktrees,
    ],
  );
  const request = useMemo<ListCloudTasksRequest>(() => {
    const search = patchHistorySearch(params.search, {
      query: debouncedQuery,
    });
    return listCloudTasksRequestForHistorySearch(search);
  }, [debouncedQuery, params.search]);
  const {
    hostId,
    currentUserId,
    tasks,
    query: tasksQuery,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    // The GUARDED refresh, not `tasksQuery.refetch`. TanStack's own `refetch`
    // overrides `enabled` and resets the page identity before the dispatch-time
    // verdict check can refuse the cloud leg, so a pull-to-refresh that held
    // the raw callback across a demotion (or on a pre-1.6 host after the
    // verdict was withdrawn) discarded every retained cursor page for a
    // request it then never sent. The hook's callback re-reads the verdict at
    // dispatch and resolves without touching the list when it refuses.
    refetch: refetchCloudTasks,
    isCloudPagePending,
    completeness: unionCompleteness,
    initialLegRefused,
  } = useCloudEpicTasksQuery(request, { enabled: true });
  const chatHostFilterActive = params.search.chatHosts.length > 0;
  const hostChatHostSupport = useChatHostFilterSupport(hostId);
  const isQueryDebouncing = debouncedQuery !== trimmedQuery;
  const shouldProjectLocally =
    isQueryDebouncing || tasksQuery.isFetching || tasksQuery.isPlaceholderData;
  // `currentUserId` is the WIDENED identity - `resolveCloudTasksUserId` admits
  // `unverified` so History keeps rendering this machine's own epics - so it
  // cannot double as this batch's authorization. `epic.getTaskContexts` is a
  // cloud lookup for every id the host cannot answer locally, and the ids
  // reaching it here come from a local worktree/PR match, which is precisely
  // the search an `unverified` session still performs. Gate the SPEND on the
  // verdict and let the local rows stand on their own.
  const taskContexts = useEpicGetTaskContexts(localTaskIds, currentUserId, {
    enabled: cloudAuthorized,
  });
  const baseItems = useMemo(
    // The cloud page carries `home` ON the row, so it needs no sibling list.
    () =>
      buildHistoryItemsFromTasks(
        tasks,
        nowMs,
        currentUserId,
        EMPTY_LOCAL_HOMED_TASK_IDS,
      ),
    [currentUserId, nowMs, tasks],
  );
  const contextItems = useMemo(
    () =>
      filterHistoryItemsLocally(
        buildHistoryItemsFromTasks(
          Array.from(taskContexts.tasksById.values()),
          nowMs,
          currentUserId,
          // `epic.getTaskContexts` cannot put `home` on the row, so the home
          // marker for these arrives beside them. A local epic reached ONLY
          // through this path - matched by worktree branch, path, or PR
          // number - has no other source for it.
          taskContexts.localHomedTaskIds,
        ),
        params.search,
      ),
    [
      currentUserId,
      nowMs,
      params.search,
      taskContexts.tasksById,
      taskContexts.localHomedTaskIds,
    ],
  );
  // Locally matched tasks are unioned under the cloud page: the cloud rows
  // keep their server order and the id-fetched extras are appended (dedup by
  // row id). Extras respect the structured filters via the local predicate
  // above; the ordering pass happens in the `data` memo.
  const { allBaseItems, contextExtrasCount } = useMemo(() => {
    if (contextItems.length === 0) {
      return { allBaseItems: baseItems, contextExtrasCount: 0 };
    }
    const seen = new Set(baseItems.map((item) => item.id));
    const extras = contextItems.filter((item) => !seen.has(item.id));
    return {
      allBaseItems: extras.length === 0 ? baseItems : [...baseItems, ...extras],
      contextExtrasCount: extras.length,
    };
  }, [baseItems, contextItems]);
  const historyEpicIds = useMemo(
    () => allBaseItems.map((item) => item.epicId),
    [allBaseItems],
  );
  const worktreeMetadata = useTaskWorktreeMetadata(historyEpicIds);
  const worktreesByEpicId = worktreeMetadata.worktreesByEpicId;
  const allItems = useMemo(
    () => withHistoryItemWorktreeMetadata(allBaseItems, worktreesByEpicId),
    [allBaseItems, worktreesByEpicId],
  );

  const data = useMemo<HistoryFetchResult | undefined>(() => {
    // Ahead of the `undefined` guard, because the refusal PRODUCES that
    // `undefined` and would otherwise be indistinguishable from a first load.
    // A settled result is the whole point: it is what moves the panel off the
    // spinner and onto a sentence that names the actual condition.
    if (initialLegRefused) {
      return {
        items: [],
        availableRepos: EMPTY_REPOS,
        availableWorkspaces: EMPTY_WORKSPACE_REFS,
        totalCount: 0,
        facets: EMPTY_FACETS,
        worktreesByEpicId,
        // No page was served, so the host made no statement to report - the
        // same reason the withheld-rows branch below reports `null`.
        completeness: null,
        chatHostFilterUnsupported: false,
        hostRequiresCloudToList: true,
      };
    }
    if (tasksQuery.data === undefined) {
      return undefined;
    }
    // The settled server order is pinned-first, but an optimistic pin patch
    // flips a cached row's bit without moving it - the stable pinned-first
    // partition lifts it into (or drops it out of) the pinned block
    // instantly, and is an order-preserving no-op on untouched server data.
    // When id-fetched extras joined the settled list they arrive appended out
    // of order, so that path re-sorts the union client-side instead.
    const items = shouldProjectLocally
      ? projectHistoryItems(allItems, params.search)
      : settledHistoryItems(
          allItems,
          contextExtrasCount,
          params.search.sort,
          debouncedQuery,
        );
    const canUseServerFacets =
      !isQueryDebouncing && !tasksQuery.isPlaceholderData;
    const facets = canUseServerFacets
      ? mapHistoryFacets(tasksQuery.data.facets)
      : EMPTY_FACETS;
    // The union's statement, not the first page's. `items` is assembled from
    // the first page AND every retained "Show more" tail, so reading
    // `tasksQuery.data.completeness` alone presented first-page-complete status
    // over a list a later page had already reported as truncated, cloud-less or
    // partially faceted - and that same first-page-only read decided the
    // facet-union below, so a tail's `partial` could not restore the filter
    // options for its own device-only rows either.
    const completeness = canUseServerFacets ? unionCompleteness : null;
    // `facets: "partial"` is the host saying the server's own faceting ran
    // over a DIFFERENT set from the rows it returned - host rows were injected
    // beside them. Preferring the server arrays outright then hid the filter
    // OPTION for a repo or workspace that exists only on this device, so a
    // displayed local epic could not be filtered to. Union instead: the server
    // counts stay the (partial) counts, but every displayed row can be
    // selected.
    //
    // A context EXTRA is the second way the rendered union outgrows the
    // server-faceted set, and it is invisible to `facets` because it never went
    // through a page at all: branch / worktree-path / PR search adds those rows
    // through `epic.getTaskContexts` after the fact. A settled page can
    // therefore report `facets: "server"` honestly while a row on screen
    // carries a repo or workspace no page ever faceted - and that row's filter
    // option was missing for exactly the search that surfaced it.
    const unionLocalOptions =
      completeness?.facets === "partial" || contextExtrasCount > 0;
    const availableWorkspaces = availableFilterWorkspaces(
      facets.workspaces.map((workspace) => workspace.workspace),
      allItems,
      unionLocalOptions,
    );
    const availableRepos = availableFilterRepos(
      facets.repos.map((repo) => repo.label),
      allItems,
      unionLocalOptions,
    );
    // Fail closed on BOTH skew directions. The host arm is the negotiated
    // minor; the cloud arm is a first page that came back without the
    // `chatHosts` group at all, which is how an old cloud tier - it has no
    // version negotiation, it simply drops request keys it does not know -
    // reveals that it never applied the filter. In either case the rows in
    // hand are UNFILTERED, and showing them under an active host filter is
    // the exact failure this whole gate exists to prevent. Withhold them and
    // let the panel say why.
    //
    // A MISSING `facets` object counts too, and deliberately has no exemption:
    // this query never carries a cursor ("Show more" pages append through a
    // separate mutation and store), so its response is always a first page,
    // and a first page without facets is a server that never computed them.
    const chatHostFilterUnsupported =
      chatHostFilterActive &&
      (hostChatHostSupport === "unsupported" ||
        (canUseServerFacets && facets.chatHosts === null));
    if (chatHostFilterUnsupported) {
      return {
        items: [],
        availableRepos: EMPTY_REPOS,
        availableWorkspaces: EMPTY_WORKSPACE_REFS,
        totalCount: 0,
        facets: EMPTY_FACETS,
        worktreesByEpicId,
        // Withheld rows are not a page the host made a statement about, so
        // there is nothing to report here - and `null` already reads as
        // "unknown" at every render site.
        completeness: null,
        chatHostFilterUnsupported: true,
        hostRequiresCloudToList: false,
      };
    }
    return {
      items,
      availableRepos,
      availableWorkspaces,
      totalCount: items.length,
      facets,
      worktreesByEpicId,
      hostRequiresCloudToList: false,
      // Only from a SETTLED page. While the query is debouncing or serving
      // placeholder data the statement describes a different request than the
      // rows on screen, which is the same reason the server facets are
      // suppressed above.
      completeness,
      chatHostFilterUnsupported: false,
    };
  }, [
    allItems,
    chatHostFilterActive,
    contextExtrasCount,
    hostChatHostSupport,
    debouncedQuery,
    initialLegRefused,
    isQueryDebouncing,
    params.search,
    shouldProjectLocally,
    tasksQuery.data,
    tasksQuery.isPlaceholderData,
    unionCompleteness,
    worktreesByEpicId,
  ]);

  const refetch = useCallback(() => refetchCloudTasks(), [refetchCloudTasks]);

  return {
    data,
    // A refused leg is SETTLED, not pending. The underlying query reports
    // `pending` forever - it has no data and never will - and passing that
    // through is what put a permanent skeleton on History.
    isPending: !initialLegRefused && tasksQuery.isPending,
    isFetching:
      tasksQuery.isFetching ||
      isQueryDebouncing ||
      (isPullRequestNumberQuery && activityIndex.isFetching) ||
      taskContexts.isFetching,
    error:
      (tasksQuery.error instanceof Error ? tasksQuery.error : null) ??
      (isPullRequestNumberQuery ? activityIndex.error : null) ??
      taskContexts.error,
    hostId,
    refetch,
    fetchNextPage,
    // Pagination follows the plain cloud query; id-fetched local matches are
    // complete per query (not paginated). Keep the guard so "Show more"
    // cannot fetch against a stale request during debouncing / placeholder
    // handoff.
    hasNextPage:
      hasNextPage && !isQueryDebouncing && !tasksQuery.isPlaceholderData,
    isFetchingNextPage,
    // Passed through unsuppressed by the debounce, unlike the completeness
    // statement above: this describes a REQUEST that is genuinely outstanding
    // right now, not a claim about the rows on screen, so a caller must not be
    // told "nothing is coming" while the previous page's cloud half is still
    // in flight.
    cloudPagePending: isCloudPagePending,
  };
}

const EMPTY_REPOS: ReadonlyArray<string> = [];
const EMPTY_WORKSPACE_REFS: ReadonlyArray<HistoryWorkspaceRef> = [];

export interface HistoryFetchResult {
  items: ReadonlyArray<HistoryItem>;
  availableRepos: ReadonlyArray<string>;
  availableWorkspaces: ReadonlyArray<HistoryWorkspaceRef>;
  totalCount: number;
  facets: HistoryFacets;
  worktreesByEpicId: ReadonlyMap<string, readonly WorktreeHostEntryV12[]>;
  /**
   * The host's own statement about what this page is (`epic.listTasks@1.5`).
   *
   * `null` when the host did not say - an older host, or a pre-`@1.5`
   * negotiation - and that must be read as "unknown", never as complete. The
   * render sites only ever ADD a caveat from this, so an absent statement
   * leaves exactly today's rendering.
   */
  completeness: ListTasksCompleteness | null;
  /**
   * The chat-host filter is active but the serving peer cannot apply it, so
   * `items` is deliberately EMPTY rather than unfiltered. Render an
   * explanation, never an empty-history message.
   */
  chatHostFilterUnsupported: boolean;
  /**
   * No listing was requested at all: this session holds no cloud verdict and
   * the negotiated host predates the local-first `epic.listTasks` leg, so it
   * can only answer by spending the account's cloud credential.
   *
   * `items` is EMPTY because nothing was asked, not because nothing exists.
   * Render the explanation ahead of every other empty branch - both "No tasks
   * yet" and a loading skeleton are false statements here, and this is the
   * only field that can tell them apart from the truth.
   */
  hostRequiresCloudToList: boolean;
}

export interface HistoryFacets {
  readonly repos: ReadonlyArray<HistoryRepoFacet>;
  readonly workspaces: ReadonlyArray<HistoryWorkspaceFacet>;
  /** `null` when the peer did not report the group at all. */
  readonly chatHosts: ReadonlyArray<HistoryChatHostFacet> | null;
  readonly ownershipScopes: ReadonlyArray<HistoryOwnershipFacet>;
}

export interface HistoryChatHostFacet {
  readonly hostId: string;
  readonly count: number;
}

export interface HistoryRepoFacet {
  readonly label: string;
  readonly count: number;
}

export interface HistoryWorkspaceFacet {
  readonly workspace: HistoryWorkspaceRef;
  readonly count: number;
}

export interface HistoryOwnershipFacet {
  readonly value: HistoryOwnershipScope;
  readonly count: number;
}

const EMPTY_FACETS: HistoryFacets = {
  repos: [],
  workspaces: [],
  chatHosts: null,
  ownershipScopes: [],
};

function mapHistoryFacets(
  facets: NonNullable<ListTasksResponse["facets"]> | undefined,
): HistoryFacets {
  if (facets === undefined) return EMPTY_FACETS;
  return {
    repos: facets.repos.map((facet) => ({
      label: `${facet.repoIdentifier.owner}/${facet.repoIdentifier.repo}`,
      count: facet.count,
    })),
    workspaces: facets.workspaces.map((facet) => ({
      workspace: facet.workspaceIdentifier,
      count: facet.count,
    })),
    // Absence is preserved as `null` rather than flattened to `[]`. It is the
    // only signal that the CLOUD tier (which has no version negotiation of its
    // own - an old server's body schema just drops unknown request keys)
    // could not evaluate the filter, and `[]` would read as a truthful
    // "no host owns any chat".
    chatHosts: facets.chatHosts ?? null,
    ownershipScopes: facets.ownershipScopes,
  };
}

function settledHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  contextExtrasCount: number,
  sort: HistorySortOption,
  query: string,
): ReadonlyArray<HistoryItem> {
  if (contextExtrasCount > 0) {
    return sortProjectedHistoryItems(items, sort, query);
  }
  return prioritizePinnedHistoryItems(items);
}

function projectHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  search: HistorySearchState,
): ReadonlyArray<HistoryItem> {
  const filtered = filterHistoryItemsLocally(items, search);
  const query = search.query.trim();
  const searched =
    query.length === 0
      ? filtered
      : new Fuse(filtered, LOCAL_FUSE_OPTIONS)
          .search(query)
          .map((result) => result.item);
  return sortProjectedHistoryItems(searched, search.sort, query);
}

function filterHistoryItemsLocally(
  items: ReadonlyArray<HistoryItem>,
  search: HistorySearchState,
): ReadonlyArray<HistoryItem> {
  return filterHistoryItems(items, {
    repoNames: search.repos,
    repoMatchMode: search.repoMode,
    workspaces: search.workspaces,
    workspaceMatchMode: search.workspaceMode,
    // Rows carry the caller's own chat hosts, so the host filter is
    // re-applied locally: to id-fetched worktree/PR matches, which never went
    // through the server's filter, and to cached rows while a request for a
    // newly-toggled host is still in flight.
    chatHosts: search.chatHosts,
    chatHostMatchMode: search.chatHostMode,
    ownershipScopes: search.ownershipScopes,
  });
}

/**
 * The workspace filter options.
 *
 * An empty server array means the server did not facet at all, so the options
 * come entirely from the rows. A `partial` one means it faceted a DIFFERENT
 * set from the rows, so the locally-held rows' workspaces are unioned in - or
 * a device-only workspace has no option to select even though its epic is on
 * screen. Otherwise the server's own list stands.
 */
function availableFilterWorkspaces(
  serverWorkspaces: ReadonlyArray<HistoryWorkspaceRef>,
  allItems: ReadonlyArray<HistoryItem>,
  unionLocalOptions: boolean,
): ReadonlyArray<HistoryWorkspaceRef> {
  if (serverWorkspaces.length === 0) return collectHistoryWorkspaces(allItems);
  if (!unionLocalOptions) return serverWorkspaces;
  return unionSortedWorkspaces(
    serverWorkspaces,
    collectHistoryWorkspaces(allItems),
  );
}

/** Repo filter options, on the same three-way rule as the workspaces above. */
function availableFilterRepos(
  serverRepos: ReadonlyArray<string>,
  allItems: ReadonlyArray<HistoryItem>,
  unionLocalOptions: boolean,
): ReadonlyArray<string> {
  if (serverRepos.length === 0) return collectHistoryRepos(allItems);
  if (!unionLocalOptions) return serverRepos;
  return unionSortedLabels(serverRepos, collectHistoryRepos(allItems));
}

/** Server-provided labels first (their order is the server's ranking), then
 * any label only the locally-held rows carry. */
function unionSortedLabels(
  serverLabels: ReadonlyArray<string>,
  localLabels: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set(serverLabels);
  const extras = localLabels.filter((label) => !seen.has(label));
  return extras.length === 0 ? serverLabels : [...serverLabels, ...extras];
}

/** Same ranking rule as {@link unionSortedLabels}: the server's order is
 * the ranking, local-only workspaces are appended. `dedupSortWorkspaces`
 * re-sorts the whole set and is reserved for {@link collectHistoryWorkspaces},
 * which has no server ranking to preserve. */
function unionSortedWorkspaces(
  serverWorkspaces: ReadonlyArray<HistoryWorkspaceRef>,
  localWorkspaces: ReadonlyArray<HistoryWorkspaceRef>,
): ReadonlyArray<HistoryWorkspaceRef> {
  const seen = new Set(serverWorkspaces.map(workspaceKey));
  const extras = localWorkspaces.filter(
    (workspace) => !seen.has(workspaceKey(workspace)),
  );
  return extras.length === 0
    ? serverWorkspaces
    : [...serverWorkspaces, ...extras];
}

function collectHistoryWorkspaces(
  items: ReadonlyArray<HistoryItem>,
): ReadonlyArray<HistoryWorkspaceRef> {
  return dedupSortWorkspaces(...items.map((item) => item.linkedWorkspaces));
}

function sortProjectedHistoryItems(
  items: ReadonlyArray<HistoryItem>,
  sort: HistorySortOption,
  query: string,
): ReadonlyArray<HistoryItem> {
  if ((sort === "relevance" && query.length > 0) || sort === "last-viewed") {
    return prioritizePinnedHistoryItems(items);
  }
  return sortHistoryItems(items, sort);
}
