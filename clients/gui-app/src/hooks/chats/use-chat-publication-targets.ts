import { useEffect, useMemo, useRef } from "react";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { queryKeys } from "@/lib/query-keys";
import { appLogger } from "@/lib/logger";

const PUBLICATION_TARGETS_METHOD = "epic.listChatPublicationTargets" as const;

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
 * App-wide (`useHostClient`), not tab-scoped: the redirect is a fact about this
 * device's own chats, not about any open tab's host.
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
   * The local chat ids to resolve. SORTED by the caller so the query identity
   * is stable across the projection churn that does not change the id set.
   */
  readonly chatIds: readonly string[];
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
 * Drops every cached redirect map for `hostId`, whatever epic or id set it was
 * keyed by.
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
 * Host-scoped rather than epic-scoped on purpose. A fork episode names the chats
 * it touched, but those chats' epics are not what this query is keyed by
 * (`{ epicId, chatIds }` - an id set that churns with the sidebar's projection),
 * so a precise filter would have to re-derive an epic set from an episode and
 * would silently miss any epic whose chat set had drifted since. One host's
 * redirect maps are a handful of cache entries; re-reading them after a fork is
 * cheaper than being subtly wrong about which ones to keep.
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
    () => ({ epicId: args.epicId, chatIds: [...args.chatIds] }),
    [args.epicId, args.chatIds],
  );
  return useHostQuery<HostRpcRegistry, typeof PUBLICATION_TARGETS_METHOD>({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: PUBLICATION_TARGETS_METHOD,
    params,
    options: {
      enabled:
        args.enabled && args.epicId.length > 0 && args.chatIds.length > 0,
      // A redirect is minted once in a chat's life, so a long stale window
      // costs nothing and saves a request per sidebar mount. The matching
      // `poll: null` in the policy table carries the same reasoning.
      staleTime: 5 * 60_000,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
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
