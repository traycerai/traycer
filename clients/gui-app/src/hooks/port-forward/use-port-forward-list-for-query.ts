import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * `portForward.listForHost` against an EXPLICIT host client: the forwards that
 * host owns and the ports other machines hold on it. It is the only place the
 * non-owning machine's half is visible at all.
 *
 * It does not poll. The rows carry live counters, and a list that ticked to
 * keep them fresh would be a per-second RPC for a number nobody is watching;
 * it refetches when the window regains focus, on the panel's Refresh, and
 * after a stop or cut invalidates it. `enabled` is how the panel hides itself
 * on a host that does not serve the method.
 */
export function usePortForwardListFor(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "portForward.listForHost">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "portForward.listForHost">({
    cacheKeyIdentity: undefined,
    client,
    method: "portForward.listForHost",
    params: {},
    options: { enabled, refetchOnWindowFocus: true },
  });
}
