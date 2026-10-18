import type { UseQueryResult } from "@tanstack/react-query";
import type { EnvironmentHostBinding } from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

const EMPTY_PARAMS = {};

/**
 * The one environment the host behind `client` is bound to, for the signed-in
 * user (`environment.host.read`). `explicit: false` means the owner never bound
 * it and it sits in their personal environment - the only default there is.
 *
 * Per host by construction: a binding is a fact about one machine, so the
 * caller names the host through the client it passes (the scoped Settings
 * client, a tab's client, a create form's candidate host) and this hook never
 * reaches for the app-wide one on its own.
 */
export function useEnvironmentHostReadQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<EnvironmentHostBinding, HostRpcError> {
  return useHostQuery<HostRpcRegistry, "environment.host.read">({
    cacheKeyIdentity: undefined,
    client,
    method: "environment.host.read",
    params: EMPTY_PARAMS,
    options: { enabled, refetchOnWindowFocus: false },
  });
}
