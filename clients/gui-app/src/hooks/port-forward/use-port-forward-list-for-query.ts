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
 * `poll` re-reads it on the method's table cadence (`HOST_METHOD_POLL_TABLE`):
 * every 15 seconds while the window is visible, never in the background. The
 * host has no change signal for port forwards - nothing is pushed when a
 * forward stops, binds or is cut - so a list read once goes stale the moment
 * an agent or another machine acts. Settings ▸ Overview ▸ Ports puts a count
 * of these rows on its tab, and a count has to stay current to be worth
 * showing; 15 seconds while the page is open was the user's call when the
 * work was broken down. Rows carry live counters, so a caller that shows no
 * count passes `false` rather than paying for a cadence nobody is watching.
 *
 * It also refetches when the window regains focus, on the tab's Refresh, and
 * after a stop or cut invalidates it. `enabled` is how the caller withholds
 * the read from a host it cannot reach or one that does not serve the method.
 */
export function usePortForwardListFor(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
  poll: boolean,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "portForward.listForHost">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "portForward.listForHost">({
    cacheKeyIdentity: undefined,
    client,
    method: "portForward.listForHost",
    params: {},
    options: { enabled, refetchOnWindowFocus: true, poll },
  });
}
