import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProviderMcpServer,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
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
  readonly server: ProviderMcpServer | undefined;
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
        server: list?.servers.find(
          (server) => server.name === variables.serverName,
        ),
      };
    },
    onSuccess: (data, variables, ctx) => {
      if (ctx.hostId === null) return;
      const listKey = providersNativeQueryKeys.mcpList(
        ctx.hostId,
        ctx.listParams,
      );
      const previous = queryClient.getQueryData<McpListData>(listKey);
      if (
        previous === undefined ||
        previous.servers.find(
          (server) => server.name === variables.serverName,
        ) !== ctx.server
      ) {
        // A changed target row takes priority; identical polls and other rows
        // do not block this probe. Never seed a complete catalog from one row.
        // Only an existing, eligible list query can refetch here.
        void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
        return;
      }
      const error = queryClient.getQueryState<McpListData, HostRpcError>(
        listKey,
      )?.error;
      const refreshError = error ?? previous.refreshError;
      const found = previous.servers.some(
        (server) => server.name === data.server.name,
      );
      queryClient.setQueryData<McpListData>(listKey, {
        servers: found
          ? previous.servers.map((server) =>
              server.name === data.server.name ? data.server : server,
            )
          : [...previous.servers, data.server],
        refreshError,
      });
      if (refreshError !== null) {
        // Manual writes clear Query's error and invalidation. Preserve both
        // the warning and eligibility for a complete read on the next mount.
        void queryClient.invalidateQueries({
          queryKey: listKey,
          exact: true,
          refetchType: "none",
        });
      }
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't refresh MCP server tools."),
  });
}
