import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host/runtime";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { chatForkMutationKeys } from "@/lib/query-keys";

/**
 * Ticket 09's fork-resolution surface: read the current host-level fork
 * event, submit an arbitration, and inspect a quarantined candidate.
 *
 * App-wide, not tab-scoped: a fork episode is a HOST fact, not tied to any
 * one open tab (`useHostClient()`, matching the indicator/dialog's own
 * scope - never `useTabHostClient()`).
 *
 * All three degrade the same way every optional RPC does: an older host
 * answers `E_HOST_UNSUPPORTED`, retried is disabled, and the dialog/indicator
 * simply have nothing to show - no broken surface, no toast about an old
 * host.
 */

/**
 * The current host-level fork event, or null when none is open.
 *
 * Not polled - see `HOST_METHOD_POLL_TABLE`'s note on this method: the event
 * is host-pushed on change, so a client refetches on mount/focus (React
 * Query defaults) rather than an interval. This is also the ONE query the
 * dialog and the indicator both read, so a resolve's invalidation
 * (`chatFork.get`) is what makes them agree the moment a decision lands.
 */
export function useChatForkEventQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.chatFork.get">,
  HostRpcError
> {
  const client = useHostClient();
  const params = useMemo(() => ({}), []);
  return useHostQuery<HostRpcRegistry, "host.chatFork.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.chatFork.get",
    params,
    options: {
      enabled: client !== null,
      retry: (failureCount, error) =>
        error.code !== "E_HOST_UNSUPPORTED" && failureCount < 2,
    },
  });
}

/**
 * Submits the owner's choice for the CURRENT open episode.
 *
 * Invalidates `host.chatFork.get` on success so the dialog's terminal
 * confirmation and the indicator both read the post-decision state - an
 * episode that closed reads back as `event: null`, one that is still
 * settling reads back with updated per-chat results.
 */
export function useChatForkResolveMutation() {
  return useHostScopedMutation({
    method: "host.chatFork.resolve",
    mutationKey: chatForkMutationKeys.resolve(),
    errorMessage: "Couldn't submit the fork decision",
    invalidateMethods: ["host.chatFork.get"],
  });
}

/**
 * One candidate's head document, fetched on demand for the dialog's
 * "view" link - never automatically. See the decision log: automatic
 * fetching was rejected in favor of a user-initiated inspect link, so a
 * fork prompt costs zero egress unless the user asks.
 */
export function useChatForkCandidateHeadQuery(args: {
  readonly taskId: string;
  readonly chatId: string;
  readonly headSha256: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "host.chatFork.readCandidateHead">,
  HostRpcError
> {
  const client = useHostClient();
  const params = useMemo(
    () => ({
      taskId: args.taskId,
      chatId: args.chatId,
      headSha256: args.headSha256,
    }),
    [args.taskId, args.chatId, args.headSha256],
  );
  return useHostQuery<HostRpcRegistry, "host.chatFork.readCandidateHead">({
    // No extra identity needed: `params` above (task/chat/head digest)
    // already differentiates the key, and the digest makes it immutable.
    cacheKeyIdentity: undefined,
    client,
    method: "host.chatFork.readCandidateHead",
    params,
    options: {
      enabled: args.enabled && client !== null,
      staleTime: Infinity,
      retry: false,
    },
  });
}
