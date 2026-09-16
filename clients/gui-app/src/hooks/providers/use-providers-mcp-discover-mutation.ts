import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  mapProvidersListToMcpDiscover,
  nextMcpCacheRevision,
  type McpDiscoverData,
  type McpListData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import {
  nativeMcpDiscoverParams,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type McpDiscoverVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly serverName: string;
  readonly forceRefresh: boolean;
};

interface McpDiscoverContext {
  readonly hostId: string | null;
  readonly completeListRevision: number | null;
  readonly requestRevision: number;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

/**
 * Discovers tools/schemas/instructions for one server via `providers.list`
 * with `native.kind: "mcpDiscover"` and merges the returned row into the
 * semantic mcp list cache.
 */
export function useProvidersMcpDiscover(): UseMutationResult<
  McpDiscoverData,
  HostRpcError,
  McpDiscoverVariables,
  McpDiscoverContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    McpDiscoverData,
    HostRpcError,
    McpDiscoverVariables,
    McpDiscoverContext
  >({
    mutationKey: providersMutationKeys.mcpDiscover(),
    mutationFn: async (variables) => {
      const response = await client.request(
        "providers.list",
        nativeMcpDiscoverParams(variables),
      );
      return mapProvidersListToMcpDiscover({ response });
    },
    onMutate: (variables) => {
      const hostId = client.getActiveHostId();
      const listParams = {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      };
      const list = queryClient.getQueryData<McpListData>(
        providersNativeQueryKeys.mcpList(hostId, listParams),
      );
      return {
        hostId,
        listParams,
        completeListRevision: list?.completeListRevision ?? null,
        requestRevision: nextMcpCacheRevision(),
      };
    },
    onSuccess: (data, _variables, ctx) => {
      if (ctx.hostId === null) return;
      const listKey = providersNativeQueryKeys.mcpList(
        ctx.hostId,
        ctx.listParams,
      );
      queryClient.setQueryData<McpListData>(listKey, (prev) => {
        const previous: McpListData = prev ?? {
          servers: [],
          refreshError: null,
          completeListRevision: null,
          discoveryRevisions: {},
        };
        const servers = previous.servers;
        const appliedRevision = previous.discoveryRevisions[data.server.name];
        if (
          previous.completeListRevision !== ctx.completeListRevision ||
          (typeof appliedRevision === "number" &&
            appliedRevision > ctx.requestRevision)
        ) {
          // A newer complete list or this server's own update takes priority;
          // request order survives structural sharing of identical row data.
          // Discoveries of other servers still merge independently.
          return undefined;
        }
        // setQueryData clears TanStack's error even though this response
        // refreshes only one server. Keep the full-list error in this same
        // entry until a successful complete list replaces it.
        const error = queryClient.getQueryState<McpListData, HostRpcError>(
          listKey,
        )?.error;
        const found = servers.some(
          (server) => server.name === data.server.name,
        );
        return {
          servers: found
            ? servers.map((server) =>
                server.name === data.server.name ? data.server : server,
              )
            : [...servers, data.server],
          refreshError: error ?? previous.refreshError,
          completeListRevision: previous.completeListRevision,
          discoveryRevisions: {
            ...previous.discoveryRevisions,
            [data.server.name]: ctx.requestRevision,
          },
        };
      });
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't refresh MCP server tools."),
  });
}
