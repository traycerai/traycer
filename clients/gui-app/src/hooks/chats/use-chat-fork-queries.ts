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
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { chatForkMutationKeys } from "@/lib/query-keys";

/**
 * Ticket 09's fork-resolution surface: read the current host-level fork
 * event, submit an arbitration, and inspect a quarantined candidate.
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
 * (to an error, not silence). The three hooks below additionally gate on the
 * NEGOTIATED manifest (`useHostSupportsMethod`) so the surface never asks an
 * older host at all: `get`/`resolve` gate together (both come from the same
 * host wiring, and a dialog that can observe a fork but not resolve it is
 * worse than none), `readCandidateHead` gates independently (it is the
 * dialog's "view" link, not the dialog's ability to function).
 */

/**
 * The current host-level fork event, or null when none is open.
 *
 * Polled (`poll: true`, table-owned cadence - see
 * `HOST_METHOD_POLL_TABLE["host.chatFork.get"]`) rather than left to refetch
 * on mount/focus alone: no host-pushed invalidation channel exists for this
 * event today (the OS-toast/notification-center path was deliberately not
 * wired - see the implementation report), so without a cadence a fork
 * detected after this query first cached would never surface.
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
  return useHostQuery<HostRpcRegistry, "host.chatFork.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "host.chatFork.get",
    params,
    options: {
      enabled: client !== null && supportsGet && supportsResolve,
      poll: true,
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
  const hostId = useReactiveActiveHostId();
  const supportsReadCandidateHead = useHostSupportsMethod(
    hostId,
    "host.chatFork.readCandidateHead",
  );
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
      enabled: args.enabled && client !== null && supportsReadCandidateHead,
      staleTime: Infinity,
      retry: false,
    },
  });
}

/**
 * Whether the "view candidate" link should render at all - the independent
 * half of degradation. Exported so the dialog can hide the control rather
 * than rendering a button that will only ever answer `E_HOST_UNSUPPORTED`.
 */
export function useChatForkReadCandidateHeadSupported(): boolean {
  const hostId = useReactiveActiveHostId();
  return useHostSupportsMethod(hostId, "host.chatFork.readCandidateHead");
}
