import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { invalidateNotificationIndicators } from "@/lib/notifications/notification-indicator-cache";
import { invalidateChatPublicationTargets } from "@/hooks/chats/use-chat-publication-targets";

/** Observation only, via useHostClient(), never useTabHostClient(). Gate on useHostSupportsMethod so an older host is never asked. */

/** Polled (no push channel). Open/close edges also refresh fork-derived caches. */
export function useChatForkEventQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">,
  HostRpcError
> {
  const client = useHostClient();
  const hostId = useAddressableHostId();
  const supportsGet = useHostSupportsMethod(hostId, "host.chatFork.get");
  const params = useMemo(() => ({}), []);
  const query = useHostQuery<HostRpcRegistry, "host.chatFork.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.chatFork.get",
    params,
    options: {
      // `useHostQuery` already gates a null client; this only needs the negotiated-manifest check.
      enabled: supportsGet,
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  useRefreshForkDerivedCachesOnForkLifecycle(hostId, query.data);
  return query;
}

interface ObservedForkIndicatorLifecycle {
  readonly hostId: string;
  readonly key: string | null;
}

/** On fork open/close, invalidate pendingFork indicators and publication-target redirects for the active host. */
function useRefreshForkDerivedCachesOnForkLifecycle(
  hostId: string | null,
  response: ResponseOfMethod<HostRpcRegistry, "host.chatFork.get"> | undefined,
): void {
  const queryClient = useQueryClient();
  const previousRef = useRef<ObservedForkIndicatorLifecycle | null>(null);

  useEffect(() => {
    if (hostId === null || response === undefined) return;
    const nextKey = forkIndicatorLifecycleKey(response);
    const previous = previousRef.current;
    const previousKey = previous?.hostId === hostId ? previous.key : undefined;
    previousRef.current = { hostId, key: nextKey };

    // The initial empty read establishes a baseline. An initial OPEN read is
    // still an edge: indicatorState may have won the mount race with a stale
    // false response immediately before the holder opened.
    if (
      previousKey === nextKey ||
      (previousKey === undefined && nextKey === null)
    ) {
      return;
    }
    invalidateNotificationIndicators(queryClient, hostId, null);
    invalidateChatPublicationTargets(queryClient, hostId);
  }, [hostId, queryClient, response]);
}

function forkIndicatorLifecycleKey(
  response: ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">,
): string | null {
  const event = response.event;
  if (event === null) return null;
  const chatIds = [...new Set(event.chats.map((chat) => chat.chatId))].sort();
  return JSON.stringify([event.episodeId, chatIds]);
}
