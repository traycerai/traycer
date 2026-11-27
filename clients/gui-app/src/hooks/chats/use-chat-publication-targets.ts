import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
  type Query,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { getNegotiatedHostMethods } from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  useHostQueryEntryHash,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";
import { readHostMethodSchemaVersion } from "@/hooks/host/use-host-supports-method";
import { useProjectedRecordCounter } from "@/hooks/chats/use-record-list-stamp";
import { queryKeys } from "@/lib/query-keys";
import { appLogger } from "@/lib/logger";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const PUBLICATION_TARGETS_METHOD = "epic.listChatPublicationTargets" as const;

interface PublicationTargetsAnswer extends ResponseOfMethod<
  HostRpcRegistry,
  typeof PUBLICATION_TARGETS_METHOD
> {
  readonly chatIdsAuthoritative: boolean;
  readonly publicationRedirectRevision: string | null;
}

interface TargetFetchCoverage {
  readonly signal: AbortSignal;
  readonly recordGeneration: number;
  readonly answerSequence: number;
  readonly dataUpdateCount: number;
  readonly authoritative: boolean;
  readonly revision: string | null;
}

// Cache entries outlive an observer. Every observer must compare against the
// same fetch, including one started automatically by the query.
const targetFetchCoverage = new WeakMap<Query, TargetFetchCoverage>();

export interface UseChatPublicationTargetsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly chatIds: readonly string[];
  readonly chatIdsAuthoritative: boolean;
  readonly chatRecordListFailed: boolean;
  readonly publicationRedirectRevision: string | null;
  readonly publicationRedirectRevisionSupported: boolean | null;
  readonly recordListStore: OpenEpicStoreHandle["store"] | null;
  readonly enabled: boolean;
}

/** Null until the manifest is known; response upgrades alone cannot prove support. */
export function hostSupportsPublicationRedirectRevision(
  hostId: string | null,
): boolean | null {
  if (hostId === null || getNegotiatedHostMethods(hostId) === null) return null;
  const version = readHostMethodSchemaVersion(hostId, "epic.listChatRecords");
  return version !== null && version.major === 1 && version.minor >= 6;
}

/**
 * Publication identity for the session host's local chats. A supporting host
 * shares one task/viewer slot, with the dispatch revision recorded alongside its answer.
 * Revision changes decide freshness rather than creating a cache entry per revision,
 * preserving the last good map through a failed refresh. Older hosts retain the
 * sorted chat-id-set key. Fork edges still invalidate the host's targets maps.
 */
export function useChatPublicationTargets(
  args: UseChatPublicationTargetsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>,
  HostRpcError
> {
  const query = useChatPublicationTargetsQuery(args);
  useLogUnsupportedDegrade(args.epicId, query.error);
  return query;
}

/** A fork episode names chats, so invalidate every task's map on that host. */
export function invalidateChatPublicationTargets(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.hostMethodScope(hostId, PUBLICATION_TARGETS_METHOD),
  });
}

function publicationTargetsParams(
  epicId: string,
  chatIds: readonly string[],
  supportsRevision: boolean,
): {
  epicId: string;
  chatIds: string[];
} {
  return { epicId, chatIds: supportsRevision ? [] : [...chatIds].sort() };
}

/** The newest answer naming this chat, within its host, task and viewer. */
export function readCachedChatPublicationId(
  queryClient: QueryClient,
  hostId: string | null,
  epicId: string,
  chat: { readonly chatId: string; readonly viewerUserId: string | null },
): string | null {
  if (
    hostId === null ||
    chat.viewerUserId === null ||
    chat.viewerUserId.length === 0
  )
    return null;
  const entries = queryClient.getQueryCache().findAll({
    queryKey: [
      ...queryKeys.hostMethodScope(hostId, PUBLICATION_TARGETS_METHOD),
      { epicId },
    ],
    predicate: (entry) => entry.queryKey[4] === chat.viewerUserId,
  });
  let publicationChatId: string | null = null;
  let newestAnswer = -1;
  for (const entry of entries) {
    if (entry.state.dataUpdatedAt < newestAnswer) continue;
    const data = queryClient.getQueryData<
      ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
    >(entry.queryKey);
    const redirect = data?.redirected.find((row) => row.chatId === chat.chatId);
    if (redirect === undefined) continue;
    newestAnswer = entry.state.dataUpdatedAt;
    publicationChatId = redirect.publicationChatId;
  }
  return publicationChatId;
}

function useLogUnsupportedDegrade(
  epicId: string,
  error: HostRpcError | null,
): void {
  const loggedFor = useRef<string | null>(null);
  useEffect(() => {
    if (error === null || error.code !== "E_HOST_UNSUPPORTED") return;
    if (loggedFor.current === epicId) return;
    loggedFor.current = epicId;
    appLogger.info(
      "chat publication targets unsupported; folding the cloud list on chatId equality (a forked chat may render its backup as a second row)",
      { epicId },
    );
  }, [epicId, error]);
}

function canReadPublicationTargets(
  args: UseChatPublicationTargetsArgs,
  viewerUserId: string,
): boolean {
  // The first answer must cover the full record list, except on terminal failure.
  return (
    args.enabled &&
    viewerUserId.length > 0 &&
    args.publicationRedirectRevisionSupported !== null &&
    (args.chatIdsAuthoritative || args.chatRecordListFailed) &&
    args.epicId.length > 0 &&
    args.chatIds.length > 0
  );
}

function publicationTargetsStaleTime(
  args: UseChatPublicationTargetsArgs,
): number {
  return args.publicationRedirectRevisionSupported === true &&
    args.publicationRedirectRevision !== null &&
    !args.chatRecordListFailed
    ? Infinity
    : 5 * 60_000;
}

function hasRecordAnswerAfter(
  attempted: TargetFetchCoverage | undefined,
  answerSequence: number,
  recordGeneration: number,
  readMatchingAnswerSequence: () => number | null,
): boolean {
  // A replacement store must answer before it can sponsor recovery on the
  // retained publication-target cache entry.
  const attemptedGeneration = attempted?.recordGeneration ?? 0;
  return (
    answerSequence > 0 &&
    readMatchingAnswerSequence() === answerSequence &&
    (recordGeneration > attemptedGeneration ||
      (recordGeneration === attemptedGeneration &&
        answerSequence > (attempted?.answerSequence ?? 0)))
  );
}

function shouldRecoverPublicationTargets(
  state: Query["state"],
  attempted: TargetFetchCoverage | undefined,
  current: {
    readonly hasNewAnswer: boolean;
    readonly noDataFailure: boolean;
    readonly revision: string | null;
    readonly authoritative: boolean;
  },
): boolean {
  if (state.status === "error") {
    const unsupported =
      state.error instanceof HostRpcError &&
      state.error.code === "E_HOST_UNSUPPORTED";
    return (
      !unsupported &&
      (state.data !== undefined || current.noDataFailure) &&
      current.hasNewAnswer
    );
  }
  return (
    attempted === undefined ||
    current.hasNewAnswer ||
    attempted.dataUpdateCount !== state.dataUpdateCount ||
    attempted.revision !== current.revision ||
    attempted.authoritative !== current.authoritative
  );
}

function useChatPublicationTargetsQuery(
  args: UseChatPublicationTargetsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>,
  HostRpcError
> {
  const viewerUserId = useCloudChatViewerId();
  const params = useMemo(
    () =>
      publicationTargetsParams(
        args.epicId,
        args.chatIds,
        args.publicationRedirectRevisionSupported === true,
      ),
    [args.epicId, args.chatIds, args.publicationRedirectRevisionSupported],
  );
  const queryClient = useQueryClient();
  const entry = {
    cacheKeyIdentity: [viewerUserId],
    client: args.client,
    method: PUBLICATION_TARGETS_METHOD,
    params,
  };
  const queryHash = useHostQueryEntryHash(entry);
  const readMatchingAnswerSequence = useCallback((): number | null => {
    const auth = useAuthStore.getState();
    const records = args.recordListStore?.getState();
    if (
      auth.contextMetadata?.userId !== viewerUserId ||
      (auth.profile !== null && auth.profile.userId !== viewerUserId) ||
      records === undefined ||
      records.chatRecordListAuthoritative !== args.chatIdsAuthoritative ||
      records.chatPublicationRedirectRevision !==
        args.publicationRedirectRevision ||
      records.chatPublicationRedirectRevisionSupported !==
        args.publicationRedirectRevisionSupported
    ) {
      return null;
    }
    return records.chatRecordListAnswerSequence;
  }, [
    args.chatIdsAuthoritative,
    args.publicationRedirectRevision,
    args.publicationRedirectRevisionSupported,
    args.recordListStore,
    viewerUserId,
  ]);
  const renderedAnswerSequence = readMatchingAnswerSequence() ?? 0;
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    typeof PUBLICATION_TARGETS_METHOD,
    PublicationTargetsAnswer,
    { readonly authoritative: boolean; readonly revision: string | null }
  >({
    ...entry,
    // Cover the snapshot's own IDs before its worker projection arrives.
    // Unchanged polls retain that coverage without walking it again.
    buildRequest: (base) =>
      args.publicationRedirectRevisionSupported
        ? {
            ...base,
            chatIds: [
              ...new Set([
                ...args.chatIds,
                ...(args.recordListStore?.getState()
                  .chatPublicationTargetCoverage ?? []),
              ]),
            ],
          }
        : base,
    captureRequestContext: (signal) => {
      const context = {
        authoritative: args.chatIdsAuthoritative,
        revision: args.publicationRedirectRevisionSupported
          ? args.publicationRedirectRevision
          : null,
      };
      const cached = queryClient.getQueryCache().get(queryHash);
      if (
        cached !== undefined &&
        targetFetchCoverage.get(cached)?.signal !== signal
      ) {
        // TanStack's retries share this signal. They do not spend another
        // record answer's budget, even if one arrives before the fetch settles.
        const records = args.recordListStore?.getState();
        targetFetchCoverage.set(cached, {
          ...context,
          signal,
          recordGeneration: records?.ingestFenceIdentity ?? 0,
          // An invalidation can call old observer options before React renders
          // the new record answer. Only count live coverage if the request's
          // viewer, revision and authority still match it.
          answerSequence:
            readMatchingAnswerSequence() ?? renderedAnswerSequence,
          dataUpdateCount: cached.state.dataUpdateCount,
        });
      }
      return context;
    },
    mapResponse: ({ response, requestContext }) => ({
      ...response,
      chatIdsAuthoritative: requestContext?.authoritative === true,
      publicationRedirectRevision: requestContext?.revision ?? null,
    }),
    options: {
      enabled: canReadPublicationTargets(args, viewerUserId),
      staleTime: publicationTargetsStaleTime(args),
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  const { data, isEnabled, isFetching, refetch } = query;
  const partial =
    data !== undefined &&
    args.chatIdsAuthoritative &&
    !data.chatIdsAuthoritative;
  const behind =
    args.publicationRedirectRevisionSupported &&
    args.publicationRedirectRevision !== null &&
    data?.publicationRedirectRevision !== args.publicationRedirectRevision;
  const noDataFailure =
    query.isError && data === undefined && args.chatIdsAuthoritative;
  const needsRecovery = partial || behind || noDataFailure;
  // A quiet poll updates one counter without re-rendering an up-to-date tree.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!needsRecovery || args.recordListStore === null)
        return () => undefined;
      return args.recordListStore.subscribe(onChange);
    },
    [args.recordListStore, needsRecovery],
  );
  const readSequence = useCallback(
    () => (needsRecovery ? (readMatchingAnswerSequence() ?? 0) : 0),
    [needsRecovery, readMatchingAnswerSequence],
  );
  const answerSequence =
    useProjectedRecordCounter(subscribe, readSequence) ?? 0;
  const recordGeneration =
    args.recordListStore?.getState().ingestFenceIdentity ?? 0;

  useEffect(() => {
    if (!isEnabled || !needsRecovery || isFetching) return;
    const cached = queryClient.getQueryCache().get(queryHash);
    if (cached === undefined || cached.state.fetchStatus !== "idle") return;
    const attempted = targetFetchCoverage.get(cached);
    const hasNewAnswer = hasRecordAnswerAfter(
      attempted,
      answerSequence,
      recordGeneration,
      readMatchingAnswerSequence,
    );
    if (
      !shouldRecoverPublicationTargets(cached.state, attempted, {
        hasNewAnswer,
        noDataFailure,
        revision: args.publicationRedirectRevision,
        authoritative: args.chatIdsAuthoritative,
      })
    ) {
      return;
    }
    // refetch marks the shared Query busy synchronously. Other observers see
    // that status, and dispatch captures the coverage before the request leaves.
    void refetch({ cancelRefetch: false });
  }, [
    answerSequence,
    args.chatIdsAuthoritative,
    args.publicationRedirectRevision,
    needsRecovery,
    noDataFailure,
    isEnabled,
    isFetching,
    query.dataUpdatedAt,
    query.errorUpdatedAt,
    queryClient,
    queryHash,
    readMatchingAnswerSequence,
    recordGeneration,
    refetch,
  ]);
  return query;
}

/** The cloud-list fold's chat id to publication id map, retaining a last good answer on errors. */
export function publicationTargetMap(
  data:
    | ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
    | undefined,
): ReadonlyMap<string, string> {
  return new Map(
    data?.redirected.map((entry) => [entry.chatId, entry.publicationChatId]) ??
      [],
  );
}
