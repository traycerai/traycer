import { queryOptions, replaceEqualDeep } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
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
import { readNegotiatedMethodVersion } from "@/lib/host/read-negotiated-method-version";
import { queryKeys } from "@/lib/query-keys";
import { getCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import { negotiatedListTasksServesLocalFirst } from "@/lib/cloud-epic-tasks-query/local-first-admission";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { beginLocalFirstRevalidationEpisode } from "@/lib/cloud-epic-tasks-query/local-first-revalidation-coordinator";
import { CloudEpicTasksRequestContextTimeoutError } from "@/lib/cloud-epic-tasks-query/request-context-timeout-error";
import { CloudEpicTasksVerdictWithdrawnError } from "@/lib/cloud-epic-tasks-query/verdict-withdrawn-error";
import { admitCloudEpicTasksFirstPage } from "@/lib/cloud-epic-tasks-query/cache";
import type { HistorySearchState } from "@/lib/history-search";
import { dedupSortWorkspaces } from "@/components/home/data/home-page.data";
import {
  cloudEpicTasksPageIdentity,
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
  ListTasksRequest,
  "cursor" | "localFirstPhase"
>;

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
): Promise<ListTasksResponse> {
  const client = getCloudEpicTasksClient(hostId);
  if (client === null) {
    return Promise.reject(new Error(`No host client registered for ${hostId}`));
  }
  if (options.requestContextPolicy === "require-current") {
    return dispatchScopedPageWithCurrentRequestContext(client, options);
  }
  return waitForMatchingRequestContext(client, options).then(() =>
    // Waiting is only permission to try the synchronous boundary below; an
    // already-resolved wait still resumes in a microtask, after which the
    // client may represent a different principal.
    dispatchScopedPageWithCurrentRequestContext(client, options),
  );
}

interface FetchCloudEpicTasksFirstPageOptions {
  readonly request: ListCloudTasksRequest;
  readonly abortSignal: AbortSignal | undefined;
  readonly localFirstPhase: LocalFirstPhase | undefined;
  readonly requestContextPolicy: "wait" | "require-current";
}

/**
 * Fetches one first page and admits it before exposing it to any Query writer.
 * This is the public first-page delivery API for History and reconciliation.
 */
export function fetchCloudEpicTasksFirstPageByHostId(
  hostId: string,
  userId: string,
  options: FetchCloudEpicTasksFirstPageOptions,
): Promise<ListTasksResponse> {
  return fetchCloudEpicTasksScopedPageByHostId(hostId, {
    expectedUserId: userId,
    request: options.request,
    cursor: undefined,
    abortSignal: options.abortSignal,
    localFirstPhase: options.localFirstPhase,
    requestContextPolicy: options.requestContextPolicy,
  }).then((response) =>
    admitCloudEpicTasksFirstPage(response, { hostId, userId }),
  );
}

interface FetchCloudEpicTasksCursorPageOptions {
  readonly request: ListCloudTasksRequest;
  readonly cursor: string;
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
  return fetchCloudEpicTasksScopedPageByHostId(hostId, {
    expectedUserId: userId,
    request: options.request,
    cursor: options.cursor,
    abortSignal: undefined,
    localFirstPhase: undefined,
    requestContextPolicy: "require-current",
  }).then((response) =>
    admitCloudEpicTasksFirstPage(response, { hostId, userId }),
  );
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
      // Query dispatch, not a consumer-owned wrapper, defines this page's
      // replacement boundary. Any active invalidation or raw Query.refetch
      // therefore clears retained cursor pages before either its first page or
      // a late cursor response can reintroduce old rows.
      resetCloudEpicTasksPageIdentity(
        cloudEpicTasksPageIdentity(hostId, userId, request),
      );
      // The local-first episode is likewise owned by query dispatch so no raw
      // refetch can leave a prior follow-up eligible to overwrite this page.
      beginLocalFirstRevalidationEpisode(client, queryKey);
      return fetchCloudEpicTasksFirstPageByHostId(hostId, userId, {
        request,
        abortSignal: signal,
        localFirstPhase: "initial",
        requestContextPolicy: "wait",
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
    refetchOnMount: false,
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
  const filters: NonNullable<ListTasksRequest["filters"]> = {};
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

function isListTasksResponse(value: unknown): value is ListTasksResponse {
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
  options: FetchCloudEpicTasksScopedPageOptions,
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
function dispatchScopedPageWithCurrentRequestContext(
  client: HostClient<HostRpcRegistry>,
  options: FetchCloudEpicTasksScopedPageOptions,
): Promise<ListTasksResponse> {
  if (!hasMatchingRequestContext(client, options.expectedUserId)) {
    return Promise.reject(
      new Error(
        "Cloud epic tasks request context no longer matches its cache user.",
      ),
    );
  }
  if (!cloudLegAdmittedAtDispatch(client, options)) {
    return Promise.reject(new CloudEpicTasksVerdictWithdrawnError());
  }
  const request = buildListTasksRequest(options.request, options.cursor);
  if (options.localFirstPhase === undefined) {
    return client.requestWithSignal(
      "epic.listTasks",
      request,
      options.abortSignal,
    );
  }
  return client.requestWithSignal(
    "epic.listTasks",
    {
      ...request,
      // On a pre-1.6 host the same-major transport downgrade parses against
      // its frozen request schema and strips this additive field. Its response
      // therefore remains exactly the released one-shot list request.
      localFirstPhase: options.localFirstPhase,
    },
    options.abortSignal,
  );
}

function hasMatchingRequestContext(
  client: HostClient<HostRpcRegistry>,
  expectedUserId: string,
): boolean {
  return client.getRequestContextUserId() === expectedUserId;
}

/**
 * The verdict half of the admission, re-read at the POST-WAIT dispatch
 * boundary rather than trusted from the render that started the fetch.
 *
 * `wait` may resume after an arbitrary interval: a signed-in first page
 * waiting out a reconnect for its host client's request context can see the
 * session demoted to `unverified` before the same-user context arrives, and
 * the request-context check above is about the USER, not the verdict. On a
 * pre-`epic.listTasks@1.6` host the local-first directive is stripped and
 * the continuation is the ordinary cloud-backed list call - so without this
 * the render and manual-refetch gates were bypassed by the one path that
 * waits. Same shape as those gates: the live verdict admits everything; an
 * initial leg is still admitted when the live negotiated version says the
 * host serves it local-first; a page with no directive - a cursor page, or
 * the tab reconciler's local-home probe - needs the verdict. The reconciler
 * only seeds a run under `signed-in`, so this bites it solely when the
 * verdict is withdrawn mid-run, and its combiner reads any error as "do not
 * close anything": the refusal is the fail-closed outcome that path wants.
 */
function cloudLegAdmittedAtDispatch(
  client: HostClient<HostRpcRegistry>,
  options: FetchCloudEpicTasksScopedPageOptions,
): boolean {
  if (authorizesCloudCapability(useAuthStore.getState().status)) return true;
  if (options.localFirstPhase === undefined) return false;
  const hostId = client.getActiveHostId();
  if (hostId === null) return false;
  return negotiatedListTasksServesLocalFirst(
    readNegotiatedMethodVersion(hostId, "epic.listTasks"),
  );
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}
