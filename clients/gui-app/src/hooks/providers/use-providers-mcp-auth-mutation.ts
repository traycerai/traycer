import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  NativeAuthAction,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  mapMcpAuthResponse,
  type McpAuthData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import {
  isNativeMcpListQueryKey,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * External auth variables keep the previous flat shape used by MCP tab:
 * scope tuple + `auth: { action, serverName, code? }`.
 */
export type McpAuthVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly auth: {
    readonly action: NativeAuthAction["action"];
    readonly serverName: string;
    readonly code: string | undefined;
  };
};

interface McpAuthContext {
  readonly hostId: string | null;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

function toMcpAuthAction(variables: McpAuthVariables): NativeAuthAction {
  const base = {
    scope: variables.scope,
    workspaceRoot: variables.workspaceRoot,
    serverName: variables.auth.serverName,
  };
  switch (variables.auth.action) {
    case "login":
      return { action: "login", ...base };
    case "logout":
      return { action: "logout", ...base };
    case "clearAuth":
      return { action: "clearAuth", ...base };
    case "forceReauth":
      return { action: "forceReauth", ...base };
    case "submitCode":
      return {
        action: "submitCode",
        ...base,
        code: variables.auth.code ?? "",
      };
  }
}

/**
 * Starts an MCP auth action via the dedicated `providers.mcpAuth` method.
 * Callers open `authorizationUrl` when returned. Login/forceReauth may return
 * `{ kind: "pending" }` immediately — poll list (and optionally
 * `providers.awaitMcpAuth` with the same scope tuple) for settlement. Success
 * invalidates the mcp list so status dots update promptly.
 */
export function useProvidersMcpAuth(): UseMutationResult<
  McpAuthData,
  HostRpcError,
  McpAuthVariables,
  McpAuthContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    McpAuthData,
    HostRpcError,
    McpAuthVariables,
    McpAuthContext
  >({
    mutationKey: providersMutationKeys.mcpAuth(),
    mutationFn: async (variables) => {
      const response = await client.request("providers.mcpAuth", {
        providerId: variables.providerId,
        action: toMcpAuthAction(variables),
      });
      return mapMcpAuthResponse({ response });
    },
    onMutate: (variables) => ({
      hostId: client.getActiveHostId(),
      listParams: {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      },
    }),
    onSuccess: (_data, _variables, ctx) => {
      if (ctx.hostId === null) return;
      void queryClient.invalidateQueries({
        queryKey: providersNativeQueryKeys.mcpKindScope(ctx.hostId),
        predicate: (query) => isNativeMcpListQueryKey(query.queryKey),
      });
    },
    onError: (error) =>
      toastFromHostError(error, "Couldn't complete MCP authentication."),
  });
}
