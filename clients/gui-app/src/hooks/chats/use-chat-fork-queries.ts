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
import { invalidateChatPublicationTargets } from "@/hooks/chats/use-chat-publication-targets";

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
 *
 * That same edge is the only fork signal any OTHER client-side cache gets, so
 * it drives the fork-derived caches too - today the chat publication-target
 * map (see `useRefreshForkDerivedCachesOnForkLifecycle`). Anything whose
 * correctness changes the moment a fork mints a redirect belongs on this edge
 * rather than on its own poll.
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
  useRefreshForkDerivedCachesOnForkLifecycle(hostId, query.data);
  return query;
}

interface ObservedForkIndicatorLifecycle {
  readonly hostId: string;
  readonly key: string | null;
}

/**
 * Every cache whose answer a fork can invalidate, refreshed on the open/close
 * edges of the host's fork episode.
 *
 * Two of them, and they fail differently, which is why both hang off one edge
 * rather than each growing its own poll:
 *
 * - `host.notifications.indicatorState` owns the per-chat `pendingFork` bit and
 *   has no push channel, so an episode that opens after its last read stays
 *   invisible.
 * - `epic.listChatPublicationTargets` owns the chat -> publication-row redirect
 *   the sidebar folds the cloud list on, and caches it for five minutes because
 *   a redirect is minted once in a chat's life. A FORK is that once. Without
 *   this, a sidebar mounted before the fork keeps folding post-fork rows under
 *   the pre-fork `chatId` for the rest of that stale window, and the forked
 *   chat renders its own backup as a phantom second row.
 *
 * Both are host-scoped and this query is app-wide, so the ACTIVE host id is the
 * right scope for both: a fork episode is a fact about the host that detected
 * it. `hostId` is captured in the observed key so a host swap re-establishes a
 * baseline instead of reading the previous host's episode as an edge.
 */
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
