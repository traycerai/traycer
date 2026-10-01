import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import type { HostRpcRegistry } from "@/lib/host";

/** Whether a chat-search request can be sent to a host, and why not. */
export interface ChatSearchHostGate {
  readonly hostReachable: boolean;
  readonly methodUnsupported: boolean;
}

/**
 * Whether a request can be sent to this host at all. A query on a host with no
 * dialable row, or before its handshake has named its methods, is disabled by
 * `useHostQueries` and never answers - so it must not read as "loading".
 * `methodUnsupported` is a host that answered the handshake without the method;
 * the other unsupported signal (an `E_HOST_UNSUPPORTED` answer) is read off the
 * search status, after the request it came from.
 *
 * Shared by every chat-search surface: the dialog searches the effective host,
 * a task-scoped surface its own session host, and the gate is the same
 * question either way.
 */
export function useChatSearchHost(
  hostId: string | null,
  client: HostClient<HostRpcRegistry> | null,
): ChatSearchHostGate {
  const methodSupport = useHostMethodSupport(hostId, "chat.search");
  const readiness = useReactiveHostReadiness(client);
  return {
    hostReachable:
      hostId !== null && readiness.canExecute && methodSupport !== null,
    methodUnsupported: methodSupport === false,
  };
}
