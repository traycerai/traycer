import { useCallback, useMemo, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type {
  ListTasksResponse,
  TaskLight,
} from "@traycer/protocol/host/epic/unary-schemas";
import { useHostClient } from "@/lib/host";
import { useAuthStore, type AuthStatus } from "@/stores/auth/auth-store";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
  cloudEpicTasksQueryKey,
  fetchCloudEpicTasksPage,
  registerCloudEpicTasksClient,
  type ListCloudTasksRequest,
} from "@/lib/cloud-epic-tasks-query";
import { uiQueryKeys } from "@/lib/query-keys";

const EMPTY_TASKS: readonly TaskLight[] = [];
const EMPTY_PAGES: readonly ListTasksResponse[] = [];
const EMPTY_FIRST_PAGE: ListTasksResponse = { tasks: [], hasMore: false };

interface ExtraPagesState {
  readonly identity: string;
  readonly pages: readonly ListTasksResponse[];
}

export interface CloudEpicTasksQueryResult {
  readonly hostId: string | null;
  readonly currentUserId: string | null;
  readonly tasks: readonly TaskLight[];
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

  // Pages are reset and stale cursor responses dropped when this identity
  // flips (host, user, or request scope change).
  const identity = `${hostId ?? ""}|${userId ?? ""}|${JSON.stringify(effectiveRequest)}`;
  const [extraPagesState, setExtraPagesState] = useState<ExtraPagesState>(
    () => ({
      identity,
      pages: [],
    }),
  );
  const extraPages =
    extraPagesState.identity === identity ? extraPagesState.pages : EMPTY_PAGES;
  if (extraPagesState.identity !== identity) {
    setExtraPagesState({ identity, pages: [] });
  }
  const [fetchingNextPageIdentity, setFetchingNextPageIdentity] = useState<
    string | null
  >(null);
  const isFetchingNextPage = fetchingNextPageIdentity === identity;

  const tasks = useMemo<readonly TaskLight[]>(() => {
    if (queryData === undefined) return EMPTY_TASKS;
    const acc: TaskLight[] = [...queryData.tasks];
    for (const page of extraPages) {
      acc.push(...page.tasks);
    }
    return acc;
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
    setFetchingNextPageIdentity(identity);
    void fetchCloudEpicTasksPage(client, effectiveRequest, lastNextCursor).then(
      (page) => {
        setExtraPagesState((prev) =>
          prev.identity === identity
            ? { identity: prev.identity, pages: [...prev.pages, page] }
            : prev,
        );
        setFetchingNextPageIdentity((current) =>
          current === identity ? null : current,
        );
      },
      () => {
        setFetchingNextPageIdentity((current) =>
          current === identity ? null : current,
        );
      },
    );
  }, [client, effectiveRequest, identity, lastNextCursor, isFetchingNextPage]);

  const refetch = useCallback(() => {
    setExtraPagesState((prev) =>
      prev.pages.length === 0 ? prev : { identity: prev.identity, pages: [] },
    );
    void queryRefetch();
  }, [queryRefetch]);

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
