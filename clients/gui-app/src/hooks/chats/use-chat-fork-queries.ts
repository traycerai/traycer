import { useEffect, useMemo, useRef } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { chatForkMutationKeys } from "@/lib/query-keys";
import { invalidateNotificationIndicators } from "@/lib/notifications/notification-indicator-cache";

/**
 * Ticket 09's fork-resolution surface: read the current host-level fork
 * event and submit an arbitration. The challenger candidate is never
 * separately fetched - it is identified by the summary metadata the event
 * payload already carries (turn count, last activity, part count), per the
 * user's ruling that it needs to be identified, not inspected.
 *
 * App-wide, not tab-scoped: a fork episode is a HOST fact, not tied to any
 * one open tab (`useHostClient()`, matching the indicator/dialog's own
 * scope - never `useTabHostClient()`).
 *
 * ## Degradation is NOT just retry suppression
 *
 * `retry: (…) => error.code !== "E_HOST_UNSUPPORTED"` stops a doomed retry
 * loop, but it does not stop the FIRST request - an older host still gets
 * asked, still answers `E_HOST_UNSUPPORTED`, and the query still resolves
 * (to an error, not silence). The query below additionally gates on the
 * NEGOTIATED manifest (`useHostSupportsMethod`) so the surface never asks an
 * older host at all: `get`/`resolve` gate together (both come from the same
 * host wiring, and a dialog that can observe a fork but not resolve it is
 * worse than none).
 */

/**
 * The current host-level fork event, or null when none is open.
 *
 * Polled (`poll: true`, table-owned cadence - see
 * `HOST_METHOD_POLL_TABLE["host.chatFork.get"]`) rather than left to refetch
 * on mount/focus alone: no host-pushed invalidation channel exists for this
 * event today (the OS-toast/notification-center path was deliberately not
 * wired - see the implementation report), so without a cadence a fork
 * detected after this query first cached would never surface. Each change in
 * the open episode also invalidates the existing notification-indicator query
 * family: the host's indicator holder is authoritative, while the fork poll
 * supplies the missing live open/close edge.
 */
export function useChatForkEventQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">,
  HostRpcError
> {
  const client = useHostClient();
  const hostId = useReactiveActiveHostId();
  const supportsGet = useHostSupportsMethod(hostId, "host.chatFork.get");
  const supportsResolve = useHostSupportsMethod(hostId, "host.chatFork.resolve");
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
      enabled: supportsGet && supportsResolve,
      poll: true,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
  useRefreshNotificationIndicatorsOnForkLifecycle(hostId, query.data);
  return query;
}

/**
 * Submits the owner's choice for the CURRENT open episode.
 *
 * Invalidates both `host.chatFork.get` and the host-derived notification
 * indicators on success. The latter is direct rather than waiting for the
 * next fork read, so a mounted row clears as soon as resolution succeeds.
 */
export function useChatForkResolveMutation() {
  return useHostScopedMutation({
    method: "host.chatFork.resolve",
    mutationKey: chatForkMutationKeys.resolve(),
    errorMessage: "Couldn't submit the fork decision",
    invalidateMethods: [
      "host.chatFork.get",
      "host.notifications.indicatorState",
    ],
  });
}

interface ObservedForkIndicatorLifecycle {
  readonly hostId: string;
  readonly key: string | null;
}

function useRefreshNotificationIndicatorsOnForkLifecycle(
  hostId: string | null,
  response:
    | ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">
    | undefined,
): void {
  const queryClient = useQueryClient();
  const previousRef = useRef<ObservedForkIndicatorLifecycle | null>(null);

  useEffect(() => {
    if (hostId === null || response === undefined) return;
    const nextKey = forkIndicatorLifecycleKey(response);
    const previous = previousRef.current;
    const previousKey =
      previous?.hostId === hostId ? previous.key : undefined;
    previousRef.current = { hostId, key: nextKey };

    // The initial empty read establishes a baseline. An initial OPEN read is
    // still an edge: indicatorState may have won the mount race with a stale
    // false response immediately before the holder opened.
    if (previousKey === nextKey || (previousKey === undefined && nextKey === null)) {
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
