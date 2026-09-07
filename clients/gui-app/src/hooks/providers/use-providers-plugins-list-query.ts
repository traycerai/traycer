import { useEffect } from "react";
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

/** Matches this query's `staleTime`: refresh exactly when it goes stale. */
const PLUGINS_LIST_REFRESH_MS = 30_000;

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
  const query = useHostQueryWithResponseMap<
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
      // `providers.list` is a condition-polled method and condition queries join the table-owned poll BY DEFAULT - and `refetchInterval` fires regardless of `staleTime`, so omitting this re-lists on the shared ~800ms cadence.
      poll: false,
    },
  });

  // Own 30s cadence: the table poll is gone, window-focus refetch is off, and the Providers header refresh targets the classic `{ native: null }` query, so this would otherwise sit stale.
  const { refetch } = query;
  const enabled = args.enabled;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      void refetch();
    }, PLUGINS_LIST_REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, refetch]);

  return query;
}
