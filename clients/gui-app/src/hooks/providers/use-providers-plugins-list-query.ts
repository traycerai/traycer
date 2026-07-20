import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import {
  mapProvidersListToPlugins,
  type PluginsListData,
} from "@/hooks/providers/native-response-map";
import { nativePluginsListParams } from "@/lib/query-keys/providers-native-query-keys";

export function useProvidersPluginsList(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
}): UseQueryResult<PluginsListData, HostRpcError> {
  const client = useHostClient();
  const listParams = {
    providerId: args.providerId,
    scope: args.scope,
    workspaceRoot: args.workspaceRoot,
  };
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    PluginsListData
  >({
    cacheKeyIdentity: ["providers", "native", "plugins"],
    client,
    method: "providers.list",
    params: nativePluginsListParams(listParams),
    mapResponse: ({ response }) => mapProvidersListToPlugins({ response }),
    options: {
      enabled: args.enabled,
      staleTime: 30_000,
    },
  });
}
