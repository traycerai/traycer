import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
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
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";

const PUBLICATION_TARGETS_METHOD = "epic.listChatPublicationTargets" as const;

interface PublicationTargetsAnswer extends ResponseOfMethod<
  HostRpcRegistry,
  typeof PUBLICATION_TARGETS_METHOD
> {
  readonly chatIdsAuthoritative: boolean;
  readonly publicationRedirectRevision: string | null;
}

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
  return version !== null && version.major === 1 && version.minor >= 5;
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
    captureRequestContext: () => ({
      authoritative: args.chatIdsAuthoritative,
      revision: args.publicationRedirectRevisionSupported
        ? args.publicationRedirectRevision
        : null,
    }),
    mapResponse: ({ response, requestContext }) => ({
      ...response,
      chatIdsAuthoritative: requestContext?.authoritative === true,
      publicationRedirectRevision: requestContext?.revision ?? null,
    }),
    options: {
      // The first answer must cover the full record list, except on terminal failure.
      enabled:
        args.enabled &&
        viewerUserId.length > 0 &&
        args.publicationRedirectRevisionSupported !== null &&
        (args.chatIdsAuthoritative || args.chatRecordListFailed) &&
        args.epicId.length > 0 &&
        args.chatIds.length > 0,
      staleTime:
        args.publicationRedirectRevisionSupported === true &&
        args.publicationRedirectRevision !== null &&
        !args.chatRecordListFailed
          ? Infinity
          : 5 * 60_000,
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
  // A quiet poll updates one counter without re-rendering an up-to-date tree.
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!behind || args.recordListStore === null) return () => undefined;
      return args.recordListStore.subscribe(onChange);
    },
    [args.recordListStore, behind],
  );
  const readSequence = useCallback(
    () =>
      behind
        ? (args.recordListStore?.getState().chatRecordListAnswerSequence ?? 0)
        : 0,
    [args.recordListStore, behind],
  );
  const answerSequence = useProjectedRecordCounter(subscribe, readSequence);
  const lastAttempt = useRef<string | null>(null);

  // Each record-list answer retries a revision mismatch. A successful in-flight
  // partial read advances the cache write count and re-arms recovery; never join it.
  useEffect(() => {
    if (!isEnabled) return;
    const cached = queryClient.getQueryCache().get(queryHash);
    if (cached === undefined) return;
    const attempt = JSON.stringify([
      queryHash,
      cached.state.dataUpdateCount,
      answerSequence,
      args.publicationRedirectRevision,
      partial,
    ]);
    // Every observer remembers the same in-flight attempt, including on failure.
    // Only a later poll or successful write permits another attempt.
    if (isFetching || cached.state.fetchStatus !== "idle") {
      lastAttempt.current = attempt;
      return;
    }
    if (
      cached.state.error instanceof HostRpcError &&
      cached.state.error.code === "E_HOST_UNSUPPORTED"
    )
      return;
    if ((!partial && !behind) || lastAttempt.current === attempt) return;
    lastAttempt.current = attempt;
    void refetch({ cancelRefetch: false });
  }, [
    answerSequence,
    args.publicationRedirectRevision,
    behind,
    isEnabled,
    isFetching,
    partial,
    query.dataUpdatedAt,
    queryClient,
    queryHash,
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
