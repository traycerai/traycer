import type {
  CloudListTasksRequest,
  CloudTaskFilters,
} from "@traycer/protocol/host/organization/schemas";
import {
  getNegotiatedHostMethodVersion,
  getNegotiatedHostMethods,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  queryOptions,
  replaceEqualDeep,
  type QueryClient,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcServingTierHostId,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import { readHostServingDecision } from "@/lib/host/serving-decision";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import type {
  ListTasksRequest,
  ListTasksResponse,
  TaskOwnershipScope,
  TaskRepoIdentifier,
} from "@traycer/protocol/host/epic/unary-schemas";
import { formatRepoIdentifier } from "@traycer/protocol/host/epic/unary-schemas";
import {
  CURRENT_EPIC_VERSION,
  CURRENT_PHASE_VERSION,
} from "@traycer-clients/shared/epic/epic-version";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";
import {
  getCloudEpicTasksClient,
  registerCloudEpicTasksClient,
} from "@/lib/cloud-epic-tasks-query/client-registry";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { beginLocalFirstRevalidationEpisode } from "@/lib/cloud-epic-tasks-query/local-first-revalidation-coordinator";
import { CloudEpicTasksRequestContextTimeoutError } from "@/lib/cloud-epic-tasks-query/request-context-timeout-error";
import { CloudEpicTasksVerdictWithdrawnError } from "@/lib/cloud-epic-tasks-query/verdict-withdrawn-error";
import { negotiatedOrganizationHistorySortsByCreated } from "@/lib/cloud-epic-tasks-query/created-sort-admission";
import {
  admitCloudEpicTasksFirstPage,
  removeDeletedEpicsFromCloudTaskCaches,
} from "@/lib/cloud-epic-tasks-query/cache";
import { rememberHistoryFirstPage } from "@/lib/view-replica/history-replica";
import {
  composeHistoryPage,
  composeHistoryPageWithoutPool,
  hostLocalHistoryPage,
  type ComposeHistoryPageInput,
  type HistoryHostContribution,
} from "@/lib/history-composition/compose-history-page";
import {
  noteHistoryContribution,
  noteUnfilteredHistoryContributionPending,
  readHistoryHostContribution,
  startUnfilteredHistoryContributionRead,
} from "@/lib/history-composition/history-local-contribution";
import type { HistorySearchState } from "@/lib/history-search";
import { dedupSortWorkspaces } from "@/components/home/data/home-page.data";
import {
  cloudEpicTasksPageIdentity,
  cloudEpicTasksFirstPageDispatchKeepsPages,
  cloudEpicTasksPageGeneration,
  keepCloudEpicTasksRowsLeavingFirstPage,
  resetCloudEpicTasksPageIdentity,
} from "@/stores/epics/cloud-epic-tasks-pages-store";

const PAGE_LIMIT = 20;
// One first-page attempt may wait this long for a matching RequestContext.
// This is deliberately not an end-to-end discovery deadline: the host's
// cloud deadline starts only after this wait authorizes dispatch. The
// QueryClient treats this timeout as terminal so its one ordinary retry cannot
// start one additional full wait and violate this one-attempt policy.
const REQUEST_CONTEXT_WAIT_TIMEOUT_MS = 15_000;

/**
 * Semantic History filters only. Transport-local `localFirstPhase` is kept
 * out of this type and its query key: initial and revalidation pages describe
 * the same list, merely at different freshness points.
 */
export type ListCloudTasksRequest = Omit<
  CloudListTasksRequest,
  "cursor" | "localFirstPhase"
>;

export function historyPageMethod(
  request: ListCloudTasksRequest,
): "epic.listTasks" | "organization.history" {
  return hasOrganizationFilters(request.filters)
    ? "organization.history"
    : "epic.listTasks";
}

export function readHistoryPagePeerId(
  client: HostClient<HostRpcRegistry> | null,
  callerHostId: string | null,
  request: ListCloudTasksRequest,
): string | null {
  const plan = readProcessHostRpcTierPlan();
  if (plan.pool === null) return callerHostId;
  const serving = readHostServingDecision(
    (hostId) => client?.resolveHostById(hostId) ?? null,
  );
  return hostRpcServingTierHostId(
    historyPageMethod(request),
    callerHostId,
    plan,
    null,
    serving,
    null,
  );
}

export function registerHistoryPrefetchPeer(
  client: HostClient<HostRpcRegistry>,
  request: ListCloudTasksRequest,
): string | null {
  const hostId = readHistoryPagePeerId(
    client,
    client.getActiveHostId(),
    request,
  );
  if (hostId === null) return null;
  registerCloudEpicTasksClient(
    hostId,
    readProcessHostRpcTierPlan().pool === null
      ? client
      : client.createRequesterForHostId(hostId),
  );
  return hostId;
}

class HistoryPagePeerChangedError extends Error {
  constructor() {
    super("History's answering device changed.");
  }
}

type LocalFirstPhase = "initial" | "revalidate";

interface FetchCloudEpicTasksScopedPageOptions {
  readonly expectedUserId: string;
  readonly request: ListCloudTasksRequest;
  readonly cursor: string | undefined;
  readonly abortSignal: AbortSignal | undefined;
  /** Cursor pages are ordinary settled requests and omit this directive. */
  readonly localFirstPhase: LocalFirstPhase | undefined;
  /**
   * The initial page may wait for a rotating request context to become usable.
   * A cache-owned follow-up must instead fail closed if that context no longer
   * names its query user: it cannot wait across an A -> B transition and then
   * write B's page under A's infinite-lifetime cache key.
   */
  readonly requestContextPolicy: "wait" | "require-current";
}

interface DispatchedHistoryPage {
  readonly response: ListTasksResponse;
  readonly answeringHostId: string | null;
}

export const LIST_CLOUD_TASKS_REQUEST: ListCloudTasksRequest = {
  limit: PAGE_LIMIT,
  filters: null,
  sort: "recent",
  extensionPhaseVersion: String(CURRENT_PHASE_VERSION),
  extensionEpicVersion: String(CURRENT_EPIC_VERSION),
};

export function cloudEpicTasksQueryKey(
  hostId: string,
  fingerprint: string,
  request: ListCloudTasksRequest,
): readonly unknown[] {
  return queryKeys.cloudEpicTasks(hostId, fingerprint, request);
}

export function cloudEpicTasksLastKnownQueryKey(
  hostId: string,
  fingerprint: string,
): readonly unknown[] {
  return queryKeys.cloudEpicTasksLastKnown(hostId, fingerprint);
}

/**
 * Raw dispatch private to this list-specific module. Its exported first-page
 * and cursor delivery functions both cross the delete-admission boundary.
 *
 * Generic host RPC APIs intentionally remain able to dispatch arbitrary
 * methods, including `epic.listTasks`, and return their raw responses. No
 * current production caller uses those APIs for this list; this function's
 * privacy protects this module's list-specific delivery path, not generic RPC.
 */
function fetchCloudEpicTasksScopedPageByHostId(
  hostId: string,
  options: FetchCloudEpicTasksScopedPageOptions,
): Promise<DispatchedHistoryPage> {
  const client = getCloudEpicTasksClient(hostId);
  if (client === null) {
    return Promise.reject(new Error(`No host client registered for ${hostId}`));
  }
  if (options.requestContextPolicy === "require-current") {
    return dispatchScopedPageWithCurrentRequestContext(client, hostId, options);
  }
  return waitForMatchingRequestContext(client, options).then(() =>
    // Waiting is only permission to try the synchronous boundary below; an
    // already-resolved wait still resumes in a microtask, after which the
    // client may represent a different principal.
    dispatchScopedPageWithCurrentRequestContext(client, hostId, options),
  );
}

interface FetchCloudEpicTasksFirstPageOptions {
  readonly request: ListCloudTasksRequest;
  readonly abortSignal: AbortSignal | undefined;
  readonly localFirstPhase: LocalFirstPhase | undefined;
  readonly requestContextPolicy: "wait" | "require-current";
  /**
   * The cache the page is written to, which the deletion fence edits once
   * the page is in it.
   */
  readonly queryClient: QueryClient;
}

/**
 * Fetches one first page and admits it before exposing it to any Query writer.
 * This is the public first-page delivery API for History.
 *
 * The page is a composition: the serving tier's page (the server pool, in a
 * build with one) and the host's local contribution, read in parallel and
 * composed by `composeHistoryPage` - local homes win their ids, preserved
 * orphans fill gaps, tombstones apply. The replica tier keeps the serving
 * tier's settled page alone, stamped with when it was asked for: a cached
 * page has the host's contribution applied again when it paints, so a
 * deletion recorded since is honoured.
 */
export function fetchCloudEpicTasksFirstPageByHostId(
  hostId: string,
  userId: string,
  options: FetchCloudEpicTasksFirstPageOptions,
): Promise<ListTasksResponse> {
  const observedAt = Date.now();
  const localTarget = historyLocalTarget(hostId);
  const contribution = readHistoryContributionForPage(localTarget, userId, {
    filters: options.request.filters,
    abortSignal: options.abortSignal,
    requestContextPolicy: options.requestContextPolicy,
  });
  const pool = fetchCloudEpicTasksScopedPageByHostId(hostId, {
    expectedUserId: userId,
    request: options.request,
    cursor: undefined,
    abortSignal: options.abortSignal,
    localFirstPhase: options.localFirstPhase,
    requestContextPolicy: options.requestContextPolicy,
  });
  return Promise.allSettled([pool, contribution]).then(
    ([poolResult, contributionResult]) => {
      if (contributionResult.status === "rejected") {
        throw contributionResult.reason;
      }
      const composition: Omit<ComposeHistoryPageInput, "page"> = {
        contribution: contributionResult.value,
        sort: options.request.sort,
        query: options.request.filters?.query,
        placement: hasOrganizationFilters(options.request.filters)
          ? "unprovable-filter"
          : "admit",
      };
      if (poolResult.status === "rejected") {
        if (poolResult.reason instanceof HistoryPagePeerChangedError) {
          throw poolResult.reason;
        }
        const local = composeHistoryPageWithoutPool(composition);
        // A session without a verdict never sends the pool leg, so the host's
        // answer is the whole page it can have - an empty one included. Any
        // other pool failure with nothing local to show is the page's error.
        if (
          local === null ||
          (local.tasks.length === 0 &&
            !(poolResult.reason instanceof CloudEpicTasksVerdictWithdrawnError))
        ) {
          throw poolResult.reason;
        }
        return admitCloudEpicTasksFirstPage(local, { hostId, userId });
      }
      const { response, answeringHostId } = poolResult.value;
      const page = admitCloudEpicTasksFirstPage(response, {
        hostId,
        userId,
      });
      fenceDeletionsAfterPoolPage(hostId, userId, {
        localTarget,
        filters: options.request.filters,
        abortSignal: options.abortSignal,
        queryClient: options.queryClient,
        firstRead: composition.contribution,
      });
      rememberHistoryFirstPage({
        accountId: userId,
        hostId: answeringHostId,
        request: options.request,
        page,
        observedAt,
      });
      // The pool key can stay current while the computer supplying local
      // History changes. Keep the account page independent of that computer.
      if (hostId === POOL_HOST_ID) return page;
      return admitCloudEpicTasksFirstPage(
        composeHistoryPage({ ...composition, page }),
        { hostId, userId },
      );
    },
  );
}

/**
 * What ONE host holds locally, as a page (`hostLocalHistoryPage`), with no
 * serving tier involved. For the readers that ask a specific host about its
 * own local-homed rows: the tab reconciler's exemption and the local pin
 * reading. A local read, so it spends no cloud verdict.
 */
export function fetchHostLocalHistoryPageByHostId(
  hostId: string,
  userId: string,
  options: {
    readonly filters: ListCloudTasksRequest["filters"];
    readonly abortSignal: AbortSignal | undefined;
    readonly requestContextPolicy: "wait" | "require-current";
  },
): Promise<ListTasksResponse> {
  return readHistoryContributionForPage(
    { hostId, client: getCloudEpicTasksClient(hostId) },
    userId,
    options,
  ).then((contribution) => {
    // These readers ask one host what it holds, so a host that could not
    // answer is their failure, not an empty answer: the reconciler then
    // closes nothing, and Home reports its coverage as partial.
    if (contribution.kind === "absent") {
      throw new HostLocalHistoryUnavailableError();
    }
    return admitCloudEpicTasksFirstPage(
      hostLocalHistoryPage(contribution.read),
      {
        hostId,
        userId,
      },
    );
  });
}

/** The host named by a host-local read did not answer it completely. */
export class HostLocalHistoryUnavailableError extends Error {
  constructor() {
    super("The host's local History could not be read.");
    this.name = "HostLocalHistoryUnavailableError";
  }
}

/**
 * The deletion fence, run by every page that reads the host's contribution
 * beside the pool's page. A task the host deletes after that read and before
 * the cloud learns of it is on the pool's page with no tombstone to remove
 * it. A second read, dispatched only once the pool's page has arrived, sees
 * every deletion up to then; what it tombstones that the first did not goes
 * through `removeDeletedEpicsFromCloudTaskCaches`, which edits the History
 * caches and the retained cursor pages and records the deletion ledger, so a
 * page still on its way to a cache is fenced too. The page never waits on
 * this read. A deletion after the fence is any later deletion.
 */
function fenceDeletionsAfterPoolPage(
  hostId: string,
  userId: string,
  input: {
    readonly localTarget: HistoryLocalTarget | null;
    readonly filters: ListCloudTasksRequest["filters"];
    readonly abortSignal: AbortSignal | undefined;
    readonly queryClient: QueryClient;
    readonly firstRead: HistoryHostContribution;
  },
): void {
  const applied = new Set(
    input.firstRead.kind === "contributed"
      ? input.firstRead.read.tombstonedEpicIds
      : [],
  );
  readHistoryContributionForPage(input.localTarget, userId, {
    filters: input.filters,
    abortSignal: input.abortSignal,
    requestContextPolicy: "require-current",
  }).then(
    (fence) => {
      if (fence.kind !== "contributed") return;
      // The pool's cache is the account page. Its current computer's
      // tombstones are applied by the contribution projection.
      if (hostId === POOL_HOST_ID) return;
      removeDeletedEpicsFromCloudTaskCaches(
        input.queryClient,
        { hostId, userId },
        fence.read.tombstonedEpicIds.filter((id) => !applied.has(id)),
      );
    },
    // A fence that cannot be read leaves the page as the first read made it.
    () => undefined,
  );
}

interface HistoryLocalTarget {
  readonly hostId: string;
  readonly client: HostClient<HostRpcRegistry> | null;
}

/** The local leg must retain its computer across the first read and fence. */
function historyLocalTarget(listHostId: string): HistoryLocalTarget | null {
  const client = getCloudEpicTasksClient(listHostId);
  if (readProcessHostRpcTierPlan().pool === null) {
    return { hostId: listHostId, client };
  }
  const peer = useSelectionAuthorityStore.getState().servingPeer;
  if (peer?.kind !== "computer") return null;
  return {
    hostId: peer.hostId,
    client:
      peer.hostId === listHostId
        ? client
        : (client?.createRequesterForHostId(peer.hostId) ?? null),
  };
}

/**
 * The host's contribution to one History page, read under the same
 * request-context rule as the page: it waits for, or requires, a context
 * naming the page's user and refuses one that names anyone else, exactly as
 * the page's own leg does. The unfiltered listing's answer is also recorded
 * for the replica's paint gate.
 */
async function readHistoryContributionForPage(
  target: HistoryLocalTarget | null,
  userId: string,
  options: {
    readonly filters: ListCloudTasksRequest["filters"];
    readonly abortSignal: AbortSignal | undefined;
    readonly requestContextPolicy: "wait" | "require-current";
  },
): Promise<HistoryHostContribution> {
  if (target === null) return { kind: "absent" };
  const { hostId, client } = target;
  if (client !== null && options.requestContextPolicy === "wait") {
    await waitForMatchingRequestContext(client, {
      expectedUserId: userId,
      abortSignal: options.abortSignal,
    });
  }
  if (client !== null && !hasMatchingRequestContext(client, userId)) {
    throw new Error(
      "Cloud epic tasks request context no longer matches its cache user.",
    );
  }
  const unfiltered = options.filters === null;
  const held: { abandon: (() => void) | null } = { abandon: null };
  const readStartedAt = startUnfilteredHistoryContributionRead();
  try {
    const contribution = await readHistoryHostContribution({
      client,
      filters: options.filters,
      signal: options.abortSignal,
      onIncomplete: unfiltered
        ? () => {
            held.abandon = noteUnfilteredHistoryContributionPending(
              userId,
              hostId,
            );
          }
        : null,
    });
    if (unfiltered || readProcessHostRpcTierPlan().pool !== null) {
      noteHistoryContribution(userId, hostId, {
        filters: options.filters,
        contribution,
        readStartedAt,
      });
    }
    return contribution;
  } finally {
    // Its own hold only, whatever the outcome: an answer older than one that
    // settled meanwhile is dropped without clearing a hold this read took
    // after that settle.
    held.abandon?.();
  }
}

interface FetchCloudEpicTasksCursorPageOptions {
  readonly request: ListCloudTasksRequest;
  readonly cursor: string;
  readonly abortSignal: AbortSignal | undefined;
  /** The cache the deletion fence edits; see `fenceDeletionsAfterPoolPage`. */
  readonly queryClient: QueryClient;
}

/**
 * Fetches one cursor page and applies the same ledger before the retained-tail
 * store receives it. `appendPage` repeats the ledger check to fence a delete
 * that lands after this page settles but before it is committed.
 */
export function fetchCloudEpicTasksCursorPageByHostId(
  hostId: string,
  userId: string,
  options: FetchCloudEpicTasksCursorPageOptions,
): Promise<ListTasksResponse> {
  // A cursor page carries no local rows, but the host's tombstones apply to
  // it too: a pool page further down can still list a task deleted here.
  const localTarget = historyLocalTarget(hostId);
  const contribution = readHistoryContributionForPage(localTarget, userId, {
    filters: options.request.filters,
    abortSignal: options.abortSignal,
    requestContextPolicy: "require-current",
  });
  return Promise.all([
    fetchCloudEpicTasksScopedPageByHostId(hostId, {
      expectedUserId: userId,
      request: options.request,
      cursor: options.cursor,
      abortSignal: options.abortSignal,
      localFirstPhase: undefined,
      requestContextPolicy: "require-current",
    }),
    contribution,
  ]).then(([{ response }, hostContribution]) => {
    if (
      readHistoryPagePeerId(
        getCloudEpicTasksClient(hostId),
        hostId,
        options.request,
      ) !== hostId
    ) {
      throw new HistoryPagePeerChangedError();
    }
    fenceDeletionsAfterPoolPage(hostId, userId, {
      localTarget,
      filters: options.request.filters,
      abortSignal: options.abortSignal,
      queryClient: options.queryClient,
      firstRead: hostContribution,
    });
    if (hostId === POOL_HOST_ID) {
      return admitCloudEpicTasksFirstPage(response, { hostId, userId });
    }
    return admitCloudEpicTasksFirstPage(
      composeHistoryPage({
        page: response,
        contribution: hostContribution,
        sort: options.request.sort,
        query: options.request.filters?.query,
        placement: "cursor-page",
      }),
      { hostId, userId },
    );
  });
}

/** The local contribution has its own query identity in a filtered pool listing. */
export function filteredHistoryContributionQueryOptions(input: {
  readonly computerId: string | null;
  readonly userId: string | null;
  readonly filters: ListCloudTasksRequest["filters"];
}) {
  const { computerId, userId, filters } = input;
  return queryOptions({
    queryKey: [
      ...queryKeys.hostMethod<HostRpcRegistry, "epic.localHistory.read">(
        computerId,
        "epic.localHistory.read",
        { filters, awaitComplete: false },
      ),
      userId,
    ],
    queryFn: ({ signal }): Promise<HistoryHostContribution> => {
      const poolClient = getCloudEpicTasksClient(POOL_HOST_ID);
      if (computerId === null || userId === null || poolClient === null) {
        return Promise.resolve({ kind: "absent" });
      }
      return readHistoryContributionForPage(
        {
          hostId: computerId,
          client: poolClient.createRequesterForHostId(computerId),
        },
        userId,
        {
          filters,
          abortSignal: signal,
          requestContextPolicy: "require-current",
        },
      );
    },
    enabled: computerId !== null && userId !== null && filters !== null,
    // The computer may have changed its local rows while it wasn't serving.
    staleTime: 0,
  });
}

export function cloudEpicTasksFirstPageQueryOptions(
  hostId: string,
  userId: string,
  request: ListCloudTasksRequest,
) {
  return queryOptions<ListTasksResponse>({
    queryKey: cloudEpicTasksQueryKey(hostId, userId, request),
    queryFn: ({ signal, client }) => {
      const queryKey = cloudEpicTasksQueryKey(hostId, userId, request);
      const identity = cloudEpicTasksPageIdentity(hostId, userId, request);
      // Query dispatch, not a consumer-owned wrapper, defines this page's
      // replacement boundary. Any active invalidation or raw Query.refetch
      // therefore clears retained cursor pages before either its first page or
      // a late cursor response can reintroduce old rows. A kept-pages read is
      // the exception, and it needs the page it replaces to say which rows
      // leave it.
      const replacedPage = cloudEpicTasksFirstPageDispatchKeepsPages(identity)
        ? client.getQueryData<ListTasksResponse>(queryKey)
        : undefined;
      if (replacedPage === undefined) {
        resetCloudEpicTasksPageIdentity(identity);
      }
      const generation = cloudEpicTasksPageGeneration(identity);
      // The local-first episode is likewise owned by query dispatch so no raw
      // refetch can leave a prior follow-up eligible to overwrite this page.
      beginLocalFirstRevalidationEpisode(client, queryKey);
      const firstPage = fetchCloudEpicTasksFirstPageByHostId(hostId, userId, {
        request,
        abortSignal: signal,
        localFirstPhase: "initial",
        requestContextPolicy: "wait",
        queryClient: client,
      });
      if (replacedPage === undefined) return firstPage;
      return firstPage.then((page) => {
        keepCloudEpicTasksRowsLeavingFirstPage(
          identity,
          generation,
          replacedPage,
          page,
        );
        return page;
      });
    },
    // First-page delivery admits the response before it reaches TanStack so
    // callers see a fenced value. Re-apply that ledger at TanStack's actual
    // write boundary as well: a delete can land in the microtask between that
    // early admission and either an initial fetch or revalidation replacement
    // committing this query. The custom hook must also retain TanStack's
    // default identity behavior, so deep-share the admitted page against the
    // prior cache value rather than unconditionally adopting the new object.
    structuralSharing: (previous, incoming) =>
      replaceEqualDeep(
        previous,
        isListTasksResponse(incoming)
          ? admitCloudEpicTasksFirstPage(incoming, { hostId, userId })
          : incoming,
      ),
    staleTime: Infinity,
    gcTime: Infinity,
    // Cached pages stay fresh until explicitly invalidated. If that happens
    // while History is closed, refresh when it is opened again.
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
export function listCloudTasksRequestForHistorySearch(
  search: HistorySearchState,
): ListCloudTasksRequest {
  // Selection order in `search` reflects toggle order, not display order (the
  // ambient modal state is never re-sorted the way a URL round-trip through
  // `parseHistorySearch` sorts it). Canonicalize every set-like member here so
  // two semantically identical filter selections - regardless of the order the
  // user picked them in - always produce the same request, and therefore the
  // same query key / accumulated-page identity.
  const repoIdentifiers = sortRepoIdentifiers(
    search.repos.flatMap(parseRepoLabel),
  );
  const query = search.query.trim();
  const filters: CloudTaskFilters = {};
  if (search.labelNames?.length) {
    filters.labelNames = [...search.labelNames].sort();
    filters.labelMatchMode = search.labelMode ?? "any";
  }
  if (search.groupIds?.length) filters.groupIds = [...search.groupIds].sort();
  if (search.includeUngrouped) filters.includeUngrouped = true;
  if (query.length > 0) filters.query = query;
  if (repoIdentifiers.length > 0) {
    filters.repoIdentifiers = repoIdentifiers;
    filters.repoMatchMode = search.repoMode;
  }
  if (search.workspaces.length > 0) {
    filters.workspaceIdentifiers = [...dedupSortWorkspaces(search.workspaces)];
    filters.workspaceMatchMode = search.workspaceMode;
  }
  if (search.chatHosts.length > 0) {
    filters.chatHostIds = Array.from(new Set(search.chatHosts)).sort(
      (left, right) => left.localeCompare(right),
    );
    filters.chatHostMatchMode = search.chatHostMode;
  }
  if (search.ownershipScopes.length > 0) {
    filters.ownershipScopes = sortOwnershipScopes(search.ownershipScopes);
  }
  return {
    ...LIST_CLOUD_TASKS_REQUEST,
    filters: Object.keys(filters).length > 0 ? filters : null,
    sort: search.sort,
  };
}

function sortRepoIdentifiers(
  identifiers: ReadonlyArray<TaskRepoIdentifier>,
): TaskRepoIdentifier[] {
  const unique = new Map<string, TaskRepoIdentifier>();
  for (const identifier of identifiers) {
    unique.set(formatRepoIdentifier(identifier), identifier);
  }
  return Array.from(unique.values()).sort((left, right) =>
    formatRepoIdentifier(left).localeCompare(formatRepoIdentifier(right)),
  );
}

export function isListTasksResponse(
  value: unknown,
): value is ListTasksResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "tasks" in value &&
    Array.isArray(value.tasks) &&
    "hasMore" in value &&
    typeof value.hasMore === "boolean"
  );
}

function sortOwnershipScopes(
  scopes: ReadonlyArray<TaskOwnershipScope>,
): TaskOwnershipScope[] {
  return Array.from(new Set(scopes)).sort((left, right) =>
    left.localeCompare(right),
  );
}

function buildListTasksRequest(
  request: ListCloudTasksRequest,
  cursor: string | undefined,
): ListTasksRequest {
  if (cursor === undefined) {
    return request;
  }
  return { ...request, cursor };
}

function parseRepoLabel(label: string): TaskRepoIdentifier[] {
  const separatorIndex = label.indexOf("/");
  if (
    separatorIndex <= 0 ||
    separatorIndex !== label.lastIndexOf("/") ||
    separatorIndex === label.length - 1
  ) {
    return [];
  }
  return [
    {
      owner: label.slice(0, separatorIndex),
      repo: label.slice(separatorIndex + 1),
    },
  ];
}

function waitForMatchingRequestContext(
  client: HostClient<HostRpcRegistry>,
  options: Pick<
    FetchCloudEpicTasksScopedPageOptions,
    "expectedUserId" | "abortSignal"
  >,
): Promise<void> {
  if (hasMatchingRequestContext(client, options.expectedUserId)) {
    return Promise.resolve();
  }
  if (options.abortSignal?.aborted === true) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    const unsubscribe = client.onChange(() => {
      if (!hasMatchingRequestContext(client, options.expectedUserId)) {
        return;
      }
      cleanup();
      resolve();
    });
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    const cleanup = () => {
      unsubscribe();
      options.abortSignal?.removeEventListener("abort", onAbort);
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    options.abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeoutId = window.setTimeout(() => {
      cleanup();
      reject(
        new CloudEpicTasksRequestContextTimeoutError(
          REQUEST_CONTEXT_WAIT_TIMEOUT_MS,
        ),
      );
    }, REQUEST_CONTEXT_WAIT_TIMEOUT_MS);
  });
}

/**
 * Couples the final RequestContext check and HostClient capture in one stack.
 * Both request policies converge here: `wait` may resume after an identity
 * transition, while `require-current` must never wait at all.
 */
async function dispatchScopedPageWithCurrentRequestContext(
  client: HostClient<HostRpcRegistry>,
  hostId: string,
  options: FetchCloudEpicTasksScopedPageOptions,
): Promise<DispatchedHistoryPage> {
  if (!hasMatchingRequestContext(client, options.expectedUserId)) {
    throw new Error(
      "Cloud epic tasks request context no longer matches its cache user.",
    );
  }
  // The verdict, re-read at the POST-WAIT dispatch boundary rather than
  // trusted from the render that started the fetch: `wait` may resume after
  // the session was demoted to `unverified`, and the request-context check
  // above is about the USER, not the verdict. Without one this leg - a cloud
  // read - is not sent at all; an unverified session's first page is the
  // host's own contribution (`epic.localHistory.read`), read beside it.
  if (!authorizesCloudCapability(useAuthStore.getState().status)) {
    throw new CloudEpicTasksVerdictWithdrawnError();
  }
  const answeringHostId = readHistoryPagePeerId(
    client,
    hostId,
    options.request,
  );
  if (answeringHostId !== hostId) {
    throw new HistoryPagePeerChangedError();
  }
  if (historyPageMethod(options.request) === "organization.history") {
    return fetchOrganizationHistory(client, hostId, options);
  }
  const request = buildListTasksRequest(options.request, options.cursor);
  const response = await client.requestWithSignal(
    "epic.listTasks",
    options.localFirstPhase === undefined
      ? request
      : { ...request, localFirstPhase: options.localFirstPhase },
    options.abortSignal,
  );
  return { response, answeringHostId };
}

export function hasOrganizationFilters(
  filters: CloudTaskFilters | null,
): boolean {
  return Boolean(
    filters?.labelNames?.length ||
    filters?.groupIds?.length ||
    filters?.includeUngrouped,
  );
}
async function fetchOrganizationHistory(
  client: HostClient<HostRpcRegistry>,
  hostId: string,
  options: FetchCloudEpicTasksScopedPageOptions,
): Promise<DispatchedHistoryPage> {
  // The tier that serves `organization.history` (the pool, in a build with
  // one), whose manifest is the one that says whether it is there.
  if (!getNegotiatedHostMethods(hostId)?.has("organization.history"))
    return Promise.reject(
      new Error("Update this device to filter by labels or groups."),
    );
  // The tier serving labels and groups can be older than the host that let
  // History offer this sort.
  if (
    options.request.sort === "created-desc" &&
    !negotiatedOrganizationHistorySortsByCreated(
      getNegotiatedHostMethodVersion(hostId, "organization.history"),
    )
  )
    return Promise.reject(
      new Error(
        "Update this device to use Newest created with labels or groups.",
      ),
    );
  const response = await client.requestWithSignal(
    "organization.history",
    {
      ...options.request,
      ...(options.cursor ? { cursor: options.cursor } : {}),
    },
    options.abortSignal,
  );
  return { response, answeringHostId: hostId };
}

function hasMatchingRequestContext(
  client: HostClient<HostRpcRegistry>,
  expectedUserId: string,
): boolean {
  return client.getRequestContextUserId() === expectedUserId;
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
