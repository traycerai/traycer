import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersMcpMutateAction,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  isProviderNativeRpcError,
  mapSetEnabledToMcpMutate,
  type McpListData,
  type McpMutateData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type McpMutateVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly mutation: ProvidersMcpMutateAction;
  /**
   * When true, the hook skips the global toast so the caller can render a
   * row-local native error. Default toast still fires for non-native errors
   * and when this flag is omitted/false.
   */
  readonly suppressToast: boolean | undefined;
};

interface McpMutateContext {
  readonly hostId: string | null;
  readonly previousServers: McpListData | undefined;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

/**
 * Mutates MCP config via `providers.setEnabled` native arm and writes the
 * returned full server list into the semantic mcp list cache. Response-equals-
 * state: the host always returns the post-mutation list for the scope tuple.
 * Typed native errors (`ok: false`) surface as ProviderNativeRpcError so
 * callers can render row-local error codes.
 */
export function useProvidersMcpMutate(): UseMutationResult<
  McpMutateData,
  HostRpcError,
  McpMutateVariables,
  McpMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    McpMutateData,
    HostRpcError,
    McpMutateVariables,
    McpMutateContext
  >({
    mutationKey: providersMutationKeys.mcpMutate(),
    mutationFn: async (variables) => {
      const response = await client.request("providers.setEnabled", {
        providerId: variables.providerId,
        enabled: null,
        native: {
          kind: "mcp",
          scope: variables.scope,
          workspaceRoot: variables.workspaceRoot,
          mutation: variables.mutation,
        },
        profileAction: null,
      });
      return mapSetEnabledToMcpMutate({ response });
    },
    onMutate: (variables) => {
      const hostId = client.getActiveHostId();
      const listParams = {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      };
      const listKey = providersNativeQueryKeys.mcpList(hostId, listParams);
      const previousServers = queryClient.getQueryData<McpListData>(listKey);

      if (
        previousServers !== undefined &&
        variables.mutation.action === "toggleTool"
      ) {
        const { serverName, toolName, enabled } = variables.mutation;
        queryClient.setQueryData<McpListData>(listKey, {
          servers: previousServers.servers.map((server) => {
            if (server.name !== serverName) return server;
            return {
              ...server,
              tools: server.tools.map((tool) =>
                tool.name === toolName ? { ...tool, enabled } : tool,
              ),
            };
          }),
        });
      }

      if (
        previousServers !== undefined &&
        variables.mutation.action === "toggleServer"
      ) {
        const { name, enabled } = variables.mutation;
        queryClient.setQueryData<McpListData>(listKey, {
          servers: previousServers.servers.map((server) =>
            server.name === name ? { ...server, enabled } : server,
          ),
        });
      }

      return { hostId, previousServers, listParams };
    },
    onSuccess: (data, _variables, ctx) => {
      if (ctx.hostId === null) return;
      queryClient.setQueryData<McpListData>(
        providersNativeQueryKeys.mcpList(ctx.hostId, ctx.listParams),
        data,
      );
    },
    onError: (error, variables, ctx) => {
      if (ctx !== undefined && ctx.hostId !== null) {
        queryClient.setQueryData(
          providersNativeQueryKeys.mcpList(ctx.hostId, ctx.listParams),
          ctx.previousServers,
        );
      }
      if (variables.suppressToast === true && isProviderNativeRpcError(error)) {
        return;
      }
      toastFromHostError(error, "Couldn't update MCP server.");
    },
  });
}
