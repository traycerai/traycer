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
      // MUST stay false, exactly as on the MCP list and the icon query.
      // `providers.list` is a condition-polled method and condition queries
      // join the table-owned poll BY DEFAULT - and `refetchInterval` fires
      // regardless of `staleTime`, so omitting this re-lists on the shared
      // ~800ms cadence. On Codex that is not a cheap read: every list spawns
      // `codex plugin list --json` for the enabled flags, so the tab would sit
      // there launching a CLI process per tick.
      poll: false,
    },
  });

  // Opting out of the table poll removed the LAST thing that refetched this.
  // Mutations made here update the cache themselves, but plugins also change
  // outside the GUI - `codex plugin install` in a terminal - and nothing else
  // would notice: the app's QueryClient sets `refetchOnWindowFocus: false` and
  // `refetchOnReconnect: false`, and the Providers header refresh only targets
  // the classic `{ native: null }` query, so the 30s `staleTime` marks this
  // stale without ever scheduling the request that would clear it. An open tab
  // could sit on a stale list indefinitely.
  //
  // So: a cadence of its own, at the stale window rather than the pending one.
  // That is ~37x slower than the table poll it declined, which is the whole
  // point - one `codex plugin list --json` every 30s, further damped by the
  // host's own short-TTL cache, instead of one per tick.
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
