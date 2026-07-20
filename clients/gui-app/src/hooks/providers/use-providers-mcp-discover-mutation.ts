import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderNativeScope } from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  mapProvidersListToMcpDiscover,
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
    onMutate: (variables) => ({
      hostId: client.getActiveHostId(),
      listParams: {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      },
    }),
    onSuccess: (data, _variables, ctx) => {
      if (ctx.hostId === null) return;
      const listKey = providersNativeQueryKeys.mcpList(
        ctx.hostId,
        ctx.listParams,
      );
      queryClient.setQueryData<McpListData>(listKey, (prev) => {
        if (prev === undefined) {
          return { servers: [data.server] };
        }
        const found = prev.servers.some(
          (server) => server.name === data.server.name,
        );
        if (!found) {
          return { servers: [...prev.servers, data.server] };
        }
        return {
          servers: prev.servers.map((server) =>
            server.name === data.server.name ? data.server : server,
          ),
        };
      });
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't refresh MCP server tools."),
  });
}
