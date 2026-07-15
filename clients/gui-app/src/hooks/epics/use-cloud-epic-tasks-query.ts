import { useCallback, useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  ListTasksResponse,
  ListTaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  useCloudEpicTasksPagesStore,
  cloudEpicTasksPageGeneration,
  registerCloudEpicTasksPageIdentity,
} from "@/stores/epics/cloud-epic-tasks-pages-store";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksQueryKey,
  registerCloudEpicTasksClient,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import { uiQueryKeys } from "@/lib/query-keys";

/**
 * Variables for the next-page mutation. `identity`/`generation` are captured
 * when the fetch starts so the store can drop the response if a refresh reset
 * the identity meanwhile; `request`/`cursor` build the `epic.listTasks` body.
 */
interface NextPageVariables {
  readonly identity: string;
  readonly generation: number;
  readonly request: ListCloudTasksRequest;
  readonly cursor: string;
}

const EMPTY_TASKS: readonly ListTaskLight[] = [];
const EMPTY_PAGES: readonly ListTasksResponse[] = [];
const EMPTY_FIRST_PAGE: ListTasksResponse = { tasks: [], hasMore: false };

export interface CloudEpicTasksQueryResult {
  readonly hostId: string | null;
  readonly currentUserId: string | null;
  readonly tasks: readonly ListTaskLight[];
  readonly query: CloudEpicTasksFirstPageQuery;
  readonly fetchNextPage: () => void;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly refetch: () => void;
}

export type CloudEpicTasksFirstPageQuery = UseQueryResult<ListTasksResponse>;

export function useCloudEpicTasksQuery(
  request: ListCloudTasksRequest | undefined,
  options: { readonly enabled: boolean },
): CloudEpicTasksQueryResult {
  const effectiveRequest = request ?? LIST_CLOUD_TASKS_REQUEST;
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const hostId = readiness.hostId;
  const authIdentity = useAuthIdentity();
  const userId = resolveCloudTasksUserId(
    authIdentity,
    readiness.requestContextUserId,
  );
  if (hostId !== null) {
    registerCloudEpicTasksClient(hostId, client);
  }

  const query = useQuery<ListTasksResponse>(
    !options.enabled || hostId === null || userId === null
      ? {
          queryKey: uiQueryKeys.cloudEpicTasksDisabled(),
          queryFn: (): Promise<ListTasksResponse> =>
            Promise.resolve(EMPTY_FIRST_PAGE),
          enabled: false,
        }
      : {
          ...cloudEpicTasksFirstPageQueryOptions(
            hostId,
            userId,
            effectiveRequest,
          ),
          enabled: true,
          placeholderData: (previousData, previousQuery) =>
            hasSameCloudTasksPlaceholderIdentity(
              previousQuery?.queryKey,
              cloudEpicTasksQueryKey(hostId, userId, effectiveRequest),
            )
              ? previousData
              : undefined,
        },
  );
  const queryData = query.data;
  const queryRefetch = query.refetch;
  const isPlaceholderData = query.isPlaceholderData;

  // Identity (host | user | request scope) keys the accumulated "Show more"
  // pages in the ambient store. Holding them there (instead of this hook's own
  // state) lets loaded pages survive the host surface unmounting/remounting -
  // e.g. closing and reopening the History overlay - and a scope change simply
  // selects that scope's own pages rather than discarding them.
  const identity = `${hostId ?? ""}|${userId ?? ""}|${JSON.stringify(effectiveRequest)}`;
  const extraPages = useCloudEpicTasksPagesStore(
    (state) => state.pagesByIdentity[identity] ?? EMPTY_PAGES,
  );
  const appendPage = useCloudEpicTasksPagesStore((state) => state.appendPage);
  const resetIdentity = useCloudEpicTasksPagesStore(
    (state) => state.resetIdentity,
  );

  // Next-page fetching flows through TanStack Query (host RPC must, per
  // gui-app/AGENTS.md) so retries/errors are handled by Query rather than a
  // hand-rolled promise + Zustand loading flag. `onSuccess` tags the page with
  // the generation captured at mutate time; the store rejects it if a refresh
  // bumped the generation in between.
  const nextPageMutation = useHostMutation<
    HostRpcRegistry,
    "epic.listTasks",
    unknown,
    NextPageVariables
  >({
    client,
    method: "epic.listTasks",
    mapVariables: (variables) => ({
      ...variables.request,
      cursor: variables.cursor,
    }),
    options: {
      onSuccess: (page, variables) => {
        appendPage(variables.identity, variables.generation, page);
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't load more tasks.");
      },
    },
  });
  // Scope the in-flight flag to THIS identity: the mutation is hook-wide, so a
  // "Show more" still resolving for a previous host/user/request scope must not
  // block pagination once the scope changes (the late response still appends to
  // its own identity's bucket via onSuccess).
  const isFetchingNextPage =
    nextPageMutation.isPending &&
    nextPageMutation.variables.identity === identity;
  const mutateNextPage = nextPageMutation.mutate;

  const tasks = useMemo<readonly ListTaskLight[]>(() => {
    if (queryData === undefined) return EMPTY_TASKS;
    // Dedupe by task id, first occurrence wins (the first page outranks the
    // tails): a personal pin moves a row across server page boundaries, so
    // after a pin lands, a refetched first page or a still-in-flight tail
    // can both carry a row the other already has. A task with no id (neither
    // epic nor phase) is always retained.
    const seenTaskIds = new Set<string>();
    return [queryData, ...extraPages]
      .flatMap((page) => page.tasks)
      .filter((task) => {
        const taskId = task.epic?.light?.id ?? task.phase?.light?.id;
        if (taskId === undefined) return true;
        if (seenTaskIds.has(taskId)) return false;
        seenTaskIds.add(taskId);
        return true;
      });
  }, [queryData, extraPages]);

  const lastPage: ListTasksResponse | undefined =
    extraPages.length > 0 ? extraPages[extraPages.length - 1] : queryData;
  const lastNextCursor: string | null =
    lastPage !== undefined &&
    lastPage.hasMore &&
    typeof lastPage.nextCursor === "string" &&
    lastPage.nextCursor.length > 0
      ? lastPage.nextCursor
      : null;
  const hasNextPage = lastNextCursor !== null && !isPlaceholderData;

  const fetchNextPage = useCallback(() => {
    if (lastNextCursor === null || isFetchingNextPage) return;
    // Register the identity before capturing its generation: a scope reset
    // landing while this very first tail request for the identity is still
    // in flight must have an entry to advance, or the stale response's
    // captured generation would still match on arrival.
    registerCloudEpicTasksPageIdentity(identity);
    mutateNextPage({
      identity,
      generation: cloudEpicTasksPageGeneration(identity),
      request: effectiveRequest,
      cursor: lastNextCursor,
    });
  }, [
    effectiveRequest,
    identity,
    lastNextCursor,
    isFetchingNextPage,
    mutateNextPage,
  ]);

  const refetch = useCallback(() => {
    resetIdentity(identity);
    void queryRefetch();
  }, [identity, resetIdentity, queryRefetch]);

  return {
    hostId,
    currentUserId: userId,
    tasks,
    query,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  };
}

function hasSameCloudTasksPlaceholderIdentity(
  previousQueryKey: readonly unknown[] | undefined,
  currentQueryKey: readonly unknown[],
): boolean {
  if (previousQueryKey === undefined) return false;
  return (
    previousQueryKey[0] === currentQueryKey[0] &&
    previousQueryKey[1] === currentQueryKey[1] &&
    previousQueryKey[2] === currentQueryKey[2] &&
    previousQueryKey[4] === currentQueryKey[4] &&
    previousQueryKey[5] === currentQueryKey[5]
  );
}

function resolveCloudTasksUserId(
  authIdentity: {
    readonly status: AuthStatus;
    readonly userId: string | null;
  },
  requestContextUserId: string | null,
): string | null {
  if (authIdentity.status !== "signed-in") return null;
  if (authIdentity.userId === null) return null;
  if (authIdentity.userId !== requestContextUserId) return null;
  return requestContextUserId;
}

/**
 * Cache discriminator keyed by the authenticated identity from the live
 * `RequestContext` metadata, NOT the raw bearer string. The bearer is a
 * persistence-boundary concern and must not leak into TanStack query
 * keys; the `userId` from `contextMetadata` is the canonical authority
 * for "who this cache belongs to".
 */
function useAuthIdentity(): {
  readonly status: AuthStatus;
  readonly userId: string | null;
} {
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.contextMetadata?.userId ?? null);
  return {
    status,
    userId,
  };
}
