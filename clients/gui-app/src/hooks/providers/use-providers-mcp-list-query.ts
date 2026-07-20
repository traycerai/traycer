import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
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
  const listParams = {
    providerId: args.providerId,
    scope: args.scope,
    workspaceRoot: args.workspaceRoot,
  };
  return useHostQueryWithResponseMap<
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
      refetchInterval: (query) => {
        if (args.pollWhilePending) return MCP_LIST_PENDING_REFRESH_MS;
        const servers = query.state.data?.servers;
        if (servers === undefined) return false;
        const needsPoll = servers.some(
          (server) => server.discoveryPending || server.status === "connecting",
        );
        return needsPoll ? MCP_LIST_PENDING_REFRESH_MS : false;
      },
    },
  });
}
