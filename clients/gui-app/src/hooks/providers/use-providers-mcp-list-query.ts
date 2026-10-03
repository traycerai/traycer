import { useEffect } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import {
  isDocumentVisible,
  subscribeDocumentVisibility,
} from "@/lib/dom/document-visibility";
import {
  mapProvidersListToMcpServers,
  type McpListData,
} from "@/hooks/providers/native-response-map";
import { nativeMcpListParams } from "@/lib/query-keys/providers-native-query-keys";

const MCP_LIST_PENDING_REFRESH_MS = 800;

export function useProvidersMcpList(args: {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly enabled: boolean;
  readonly pollWhilePending: boolean;
}): UseQueryResult<McpListData, HostRpcError> {
  const client = useHostClient();
  const readiness = useReactiveHostReadiness(client);
  const listParams = {
    providerId: args.providerId,
    scope: args.scope,
    workspaceRoot: args.workspaceRoot,
  };
  const query = useHostQueryWithResponseMap<
    HostRpcRegistry,
    "providers.list",
    McpListData
  >({
    // Semantic suffix: independent of deleted providers.mcpList method name.
    cacheKeyIdentity: ["providers", "native", "mcp"],
    client,
    method: "providers.list",
    params: nativeMcpListParams(listParams),
    mapResponse: ({ response }) => mapProvidersListToMcpServers({ response }),
    options: {
      enabled: args.enabled,
      staleTime: 30_000,
      // Opt out of the table-owned condition polling for `providers.list`:
      // that policy classifies the CLASSIC response shape, while this query
      // caches a mapped MCP shape under its own `cacheKeyIdentity`. The
      // pending cadence below stands in for it.
      poll: false,
    },
  });

  // Table-owned polling can't serve this query (see `poll: false` above) and
  // the host-query layer owns `refetchInterval`, so the pending cadence is
  // driven here: re-list while an explicit auth flow is awaiting completion,
  // or while any server is still discovering/connecting.
  const { refetch } = query;
  const servers = query.data?.servers;
  const needsPoll =
    args.enabled &&
    (args.pollWhilePending ||
      (servers ?? []).some(
        (server) => server.discoveryPending || server.status === "connecting",
      ));
  useEffect(() => {
    if (!needsPoll || !readiness.isReady) return;
    let disposed = false;
    let timer: number | null = null;
    let delay = MCP_LIST_PENDING_REFRESH_MS;
    let refreshing = false;
    const schedule = (): void => {
      if (disposed || !isDocumentVisible()) return;
      timer = window.setTimeout(() => {
        void refresh();
      }, delay);
    };
    const refresh = async (): Promise<void> => {
      if (disposed || !isDocumentVisible() || refreshing) return;
      refreshing = true;
      // Join slow reads; only schedule the next poll after this one settles.
      await refetch({ cancelRefetch: false });
      refreshing = false;
      delay = Math.min(delay * 2, 30_000);
      schedule();
    };
    const unsubscribe = subscribeDocumentVisibility(() => {
      if (timer !== null) window.clearTimeout(timer);
      delay = MCP_LIST_PENDING_REFRESH_MS;
      if (isDocumentVisible()) void refresh();
    });
    schedule();
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
      unsubscribe();
    };
  }, [needsPoll, readiness.isReady, refetch]);

  return query;
}
