import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { QueryActivityOptions } from "@/hooks/harnesses/use-gui-harness-catalog";

const PROVIDERS_LIST_REFRESH_MS = 15 * 60 * 1_000;

type ProvidersListQueryResult = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "providers.list">,
  HostRpcError
>;

export function useProvidersList(
  activity: QueryActivityOptions,
): ProvidersListQueryResult {
  return useProvidersListForClient(useHostClient(), activity);
}

/** Client-scoped variant - lets a caller outside `HostRuntimeContext` (e.g.
 *  the picker's globally-mounted "Create new profile" flow host, resolving a
 *  transient client for a captured tab host id) target an explicit host
 *  instead of the app-wide default. */
export function useProvidersListForClient(
  client: HostClient<HostRpcRegistry> | null,
  activity: QueryActivityOptions,
): ProvidersListQueryResult {
  return useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: {},
    options: {
      enabled: activity.enabled,
      subscribed: activity.subscribed,
      staleTime: PROVIDERS_LIST_REFRESH_MS,
    },
  });
}
