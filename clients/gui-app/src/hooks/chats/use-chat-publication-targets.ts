import { useEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  useHostQueryEntryHash,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";
import { queryKeys } from "@/lib/query-keys";
import { appLogger } from "@/lib/logger";

const PUBLICATION_TARGETS_METHOD = "epic.listChatPublicationTargets" as const;

interface PublicationTargetsAnswer extends ResponseOfMethod<
  HostRpcRegistry,
  typeof PUBLICATION_TARGETS_METHOD
> {
  readonly chatIdsAuthoritative: boolean;
  readonly unexplainedCloudChatIdsKey: string;
}

/**
 * Which cloud row each of this task's local chats publishes into.
 *
 * The sidebar folds a task's cloud list against its local tree, and after a
 * fork the two disagree about which row is which: the local lineage steps aside
 * into a derived clone row, while the row still carrying its `chatId` belongs
 * to the other host's lineage. This is the mapping that tells them apart -
 * the clone id is a server-side digest of content no client holds, so it cannot
 * be derived here. See `lib/chats/unified-chat-list.ts` for what the fold does
 * with it.
 *
 * Scoped to the task's session host: redirects describe that host's local
 * chats, the same source the sidebar and chat opener fold.
 *
 * Degradation is the whole reason this is a separate optional call rather than
 * a field on the cloud list: a host that predates it answers
 * `E_HOST_UNSUPPORTED`, the map comes back empty, and the fold falls back to
 * `chatId` equality - which is right for every chat that has not forked. The
 * retry gate stops a doomed loop; the first request still happens, and a
 * settled refusal is the answer.
 */

export interface UseChatPublicationTargetsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /**
   * The full current local id set, sent at dispatch rather than keyed.
   */
  readonly chatIds: readonly string[];
  readonly cloudChatIds: readonly string[];
  readonly chatIdsAuthoritative: boolean;
  readonly chatRecordListFailed: boolean;
  readonly enabled: boolean;
}

export function useChatPublicationTargets(
  args: UseChatPublicationTargetsArgs,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">,
  HostRpcError
> {
  const query = useChatPublicationTargetsQuery(args);
  useLogUnsupportedDegrade(args.epicId, query.error);
  return query;
}

/**
 * Drops every cached redirect map for `hostId`, across all its tasks.
 *
 * The five-minute `staleTime` below is the reason this exists rather than a
 * comment saying the answer is immutable. A redirect is minted ONCE - but it is
 * minted by a fork, which is precisely the event that happens while a sidebar is
 * already mounted and already holding the pre-fork answer. Without this, the
 * fold goes on matching post-fork cloud rows against the old `chatId` for up to
 * five minutes: the forked chat's own lineage renders as a second, phantom row -
 * the exact symptom `useLogUnsupportedDegrade` describes for a host that cannot
 * answer at all.
 *
 * Host-scoped rather than epic-scoped on purpose. A fork episode names chats,
 * not their tasks. Re-reading the host's handful of maps avoids deriving a
 * task set from an episode and missing a task it touched.
 *
 * The owner of this key format is {@link useChatPublicationTargetsQuery} below,
 * through `queryKeys.hostMethod`; this uses the same builder's method SCOPE so
 * the two cannot drift into two spellings of one key.
 */
export function invalidateChatPublicationTargets(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.hostMethodScope(hostId, PUBLICATION_TARGETS_METHOD),
  });
}

/** Capture the publication identity before deletion removes the local row. */
export function readCachedChatPublicationId(
  queryClient: QueryClient,
  hostId: string | null,
  epicId: string,
  chatId: string,
): string | null {
  if (hostId === null) return null;
  const data = queryClient.getQueryData<
    ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
  >(
    queryKeys.hostMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>(
      hostId,
      PUBLICATION_TARGETS_METHOD,
      { epicId, chatIds: [] },
    ),
  );
  return (
    data?.redirected.find((entry) => entry.chatId === chatId)
      ?.publicationChatId ?? null
  );
}

/**
 * States the degrade ONCE per epic, at `info`.
 *
 * A degrade that is correct and invisible is still a trap: the fold silently
 * falls back to `chatId` equality, and the symptom - a forked chat rendering
 * its own backup as a phantom second row - looks like a de-duplication bug in
 * the sidebar rather than a missing host capability. Whoever chases that
 * deserves to find the reason in the log instead of deriving it.
 *
 * `info`, not `warn`: an older host is an expected, designed state, not a
 * fault. Once per epic rather than per render, and never a toast - there is
 * nothing for a user to do about it.
 */
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
  ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">,
  HostRpcError
> {
  const params = useMemo(
    () => ({ epicId: args.epicId, chatIds: [] }),
    [args.epicId],
  );
  const queryClient = useQueryClient();
  const entry = {
    cacheKeyIdentity: undefined,
    client: args.client,
    method: PUBLICATION_TARGETS_METHOD,
    params,
  };
  const queryHash = useHostQueryEntryHash(entry);
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    typeof PUBLICATION_TARGETS_METHOD,
    PublicationTargetsAnswer,
    boolean
  >({
    ...entry,
    // New chats use the fold's own-id fallback. Unexplained cloud rows refresh
    // the map on every host; addressable-host fork edges refresh it earlier.
    buildRequest: (base) => ({ ...base, chatIds: [...args.chatIds] }),
    captureRequestContext: () => args.chatIdsAuthoritative,
    mapResponse: ({ response, requestContext }) => ({
      ...response,
      chatIdsAuthoritative: requestContext === true,
      unexplainedCloudChatIdsKey: unexplainedCloudChatIdsKey(
        args.chatIds,
        args.cloudChatIds,
        response,
      ),
    }),
    options: {
      // Wait for the initial full list, except when its read has failed.
      enabled:
        args.enabled &&
        (args.chatIdsAuthoritative || args.chatRecordListFailed) &&
        args.epicId.length > 0 &&
        args.chatIds.length > 0,
      // A redirect is minted once in a chat's life, so a long stale window
      // costs nothing and saves a request per sidebar mount. The matching
      // `poll: null` in the policy table carries the same reasoning.
      staleTime: 5 * 60_000,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  const { data, dataUpdatedAt, isEnabled, isFetching, refetch } = query;
  const unexplainedKey = useMemo(
    () => unexplainedCloudChatIdsKey(args.chatIds, args.cloudChatIds, data),
    [args.chatIds, args.cloudChatIds, data],
  );
  const lastRefresh = useRef<string | null>(null);
  useEffect(() => {
    if (!isEnabled || isFetching || data === undefined) {
      return;
    }
    const partial = args.chatIdsAuthoritative && !data.chatIdsAuthoritative;
    if (!partial && unexplainedKey === data.unexplainedCloudChatIdsKey) return;
    const cached = queryClient.getQueryCache().get(queryHash);
    // Check the shared entry too: another observer's effect can start the
    // refresh before this observer renders its fetching state. Failed refreshes
    // wait for an external retry rather than looping over the retained answer.
    if (
      cached?.state.fetchStatus !== "idle" ||
      cached.state.status === "error" ||
      cached.state.dataUpdatedAt !== dataUpdatedAt
    ) {
      return;
    }
    const refreshKey = JSON.stringify([
      queryHash,
      dataUpdatedAt,
      unexplainedKey,
      partial,
    ]);
    if (lastRefresh.current === refreshKey) return;
    lastRefresh.current = refreshKey;
    // Settling an in-flight partial read re-arms this effect even when Query's
    // structural sharing preserves `data`. Never join that read as recovery.
    void refetch({ cancelRefetch: false });
  }, [
    args.chatIdsAuthoritative,
    data,
    dataUpdatedAt,
    isEnabled,
    isFetching,
    queryClient,
    queryHash,
    refetch,
    unexplainedKey,
  ]);
  return query;
}

function unexplainedCloudChatIdsKey(
  chatIds: readonly string[],
  cloudChatIds: readonly string[],
  data:
    | ResponseOfMethod<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>
    | undefined,
): string {
  const explained = new Set(chatIds);
  for (const entry of data?.redirected ?? []) {
    explained.add(entry.publicationChatId);
  }
  return JSON.stringify(
    [...new Set(cloudChatIds)].filter((id) => !explained.has(id)).sort(),
  );
}

/**
 * The response as the fold wants it: chat id -> the row it publishes into.
 *
 * An empty map for an absent, failed or in-flight answer, which is exactly the
 * degraded input `selectUnfoldedCloudChats` documents - so no caller needs a
 * second branch for "we do not know yet".
 */
export function publicationTargetMap(
  data:
    | ResponseOfMethod<HostRpcRegistry, "epic.listChatPublicationTargets">
    | undefined,
): ReadonlyMap<string, string> {
  if (data === undefined) return new Map();
  return new Map(
    data.redirected.map((entry) => [entry.chatId, entry.publicationChatId]),
  );
}
