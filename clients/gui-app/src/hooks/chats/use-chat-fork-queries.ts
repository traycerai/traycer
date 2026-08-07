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
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { invalidateNotificationIndicators } from "@/lib/notifications/notification-indicator-cache";

/**
 * The client's whole remaining fork surface: an OBSERVATION, never a choice.
 *
 * There was a dialog and an app-wide banner here, and a `host.chatFork.resolve`
 * mutation beside this query. All three are gone (decision log, 2026-08-07,
 * "Fork resolution: detect everywhere, arbitrate nowhere, destroy nothing"):
 * the host now submits the deterministic decision itself and the user is told
 * by a notification afterwards, so there is nothing for a client to arbitrate
 * and nothing to block on.
 *
 * What is left is the per-chat `pendingFork` indicator's live edge. An open
 * episode is real host state - now for the seconds between detection and
 * adoption, and for longer only while the report cannot be filed - and the
 * host's indicator holder is authoritative about it. This query exists purely
 * to notice the open/close transitions the indicator query has no push channel
 * for.
 *
 * App-wide, not tab-scoped: a fork episode is a HOST fact, not tied to any one
 * open tab (`useHostClient()`, never `useTabHostClient()`).
 *
 * ## Degradation is NOT just retry suppression
 *
 * `retry: (…) => error.code !== "E_HOST_UNSUPPORTED"` stops a doomed retry
 * loop, but it does not stop the FIRST request - an older host still gets
 * asked, still answers `E_HOST_UNSUPPORTED`, and the query still resolves (to
 * an error, not silence). The query below additionally gates on the NEGOTIATED
 * manifest (`useHostSupportsMethod`) so it never asks an older host at all.
 */

/**
 * The current host-level fork event, or null when none is open.
 *
 * Polled (`poll: true`, table-owned cadence - see
 * `HOST_METHOD_POLL_TABLE["host.chatFork.get"]`) rather than left to refetch
 * on mount/focus alone: no host-pushed invalidation channel exists for this
 * event today, so without a cadence a fork detected after this query first
 * cached would never surface. Each change in the open episode invalidates the
 * existing notification-indicator query family: the host's indicator holder is
 * authoritative, while this poll supplies the missing live open/close edge.
 */
export function useChatForkEventQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">,
  HostRpcError
> {
  const client = useHostClient();
  const hostId = useReactiveActiveHostId();
  const supportsGet = useHostSupportsMethod(hostId, "host.chatFork.get");
  const params = useMemo(() => ({}), []);
  const query = useHostQuery<HostRpcRegistry, "host.chatFork.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.chatFork.get",
    params,
    options: {
      // `useHostQuery` already gates on a null `client` internally - see
      // `AGENTS.md`'s "owns host key + null gate" - so this only needs the
      // negotiated-manifest check.
      enabled: supportsGet,
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  useRefreshNotificationIndicatorsOnForkLifecycle(hostId, query.data);
  return query;
}

interface ObservedForkIndicatorLifecycle {
  readonly hostId: string;
  readonly key: string | null;
}

function useRefreshNotificationIndicatorsOnForkLifecycle(
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
