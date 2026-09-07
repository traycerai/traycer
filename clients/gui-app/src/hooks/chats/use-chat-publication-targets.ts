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

/** App-wide, not tab-scoped. Clone ids cannot be derived here. E_HOST_UNSUPPORTED yields an empty map; fold falls back to chatId equality. */

export interface UseChatPublicationTargetsArgs {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  /** SORTED by the caller so the query identity is stable across the projection churn that does not change the id set. */
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

/** Host-scoped invalidation after a fork. Epic-scoped would miss chats whose id set has drifted. */
export function invalidateChatPublicationTargets(
  queryClient: QueryClient,
  hostId: string,
): void {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.hostMethodScope(hostId, PUBLICATION_TARGETS_METHOD),
  });
}

/**
 * Log the fold degrade once per epic at `info`, never a toast. An older host is expected; the fold falls back to `chatId` equality.
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

/** An empty map for an absent, failed or in-flight answer, which is exactly the degraded input `selectUnfoldedCloudChats` documents - so no caller needs a second branch for "we do not know yet". */
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
