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
  mapNativeMutateToMcpMutate,
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

interface McpMutateSnapshot {
  readonly listData: McpListData | undefined;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

interface McpMutateContext {
  readonly hostId: string | null;
}

interface McpMutateResult {
  readonly data: McpMutateData;
  readonly snapshot: McpMutateSnapshot;
}

/**
 * Mutates MCP config via `providers.nativeMutate` and writes the
 * returned full server list into the semantic mcp list cache. Response-equals-
 * state: the host always returns the post-mutation list for the scope tuple.
 * Typed native errors (`ok: false`) surface as ProviderNativeRpcError so
 * callers can render row-local error codes.
 * Keep the last confirmed list while the row shows its pending state:
 * optimistic list writes would clear refresh errors, and rolling them back
 * could overwrite a newer full-list response or another server's discovery.
 */
export function useProvidersMcpMutate(): UseMutationResult<
  McpMutateResult,
  HostRpcError,
  McpMutateVariables,
  McpMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    McpMutateResult,
    HostRpcError,
    McpMutateVariables,
    McpMutateContext
  >({
    // Settings mounts this hook under a host-keyed subtree with a pinned
    // requester. Keep the observer attached while that host's readiness changes.
    mutationKey: providersMutationKeys.mcpMutate(),
    onMutate: () => ({ hostId: client.getActiveHostId() }),
    mutationFn: async (variables) => {
      const hostId = client.getActiveHostId();
      const listParams = {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      };
      // This snapshot only decides whether to reconcile after applying the
      // confirmed response; it must never suppress a successful mutation.
      const snapshot: McpMutateSnapshot = {
        listParams,
        listData: queryClient.getQueryData<McpListData>(
          providersNativeQueryKeys.mcpList(hostId, listParams),
        ),
      };
      const response = await client.request("providers.nativeMutate", {
        providerId: variables.providerId,
        mutation: {
          kind: "mcp",
          scope: variables.scope,
          workspaceRoot: variables.workspaceRoot,
          mutation: variables.mutation,
        },
      });
      return { data: mapNativeMutateToMcpMutate({ response }), snapshot };
    },
    onSuccess: ({ data, snapshot }, _variables, ctx) => {
      if (ctx.hostId === null) return;
      const listKey = providersNativeQueryKeys.mcpList(
        ctx.hostId,
        snapshot.listParams,
      );
      const {
        fetchStatus,
        data: currentData,
        error,
      } = queryClient.getQueryState<McpListData, HostRpcError>(listKey) ?? {};
      const refreshError = error ?? currentData?.refreshError ?? null;
      // Full mutation responses are applied in completion order. A late
      // response can replace newer rows until a complete read reconciles them.
      // A confirmed config write does not clear a failed list-read warning.
      queryClient.setQueryData<McpListData>(listKey, { ...data, refreshError });
      if (refreshError !== null) {
        void queryClient.invalidateQueries({
          queryKey: listKey,
          exact: true,
          refetchType: "none",
        });
      }
      if (
        fetchStatus === "fetching" ||
        currentData?.servers !== snapshot.listData?.servers
      ) {
        // The cache now has full data even if an initial read was pending,
        // so default invalidation can replace that read. Do not hold mutation
        // settlement (or the row's pending UI) open for another host round trip.
        void queryClient.invalidateQueries({ queryKey: listKey, exact: true });
      }
    },
    onError: (error, variables) => {
      if (variables.suppressToast === true && isProviderNativeRpcError(error)) {
        return;
      }
      toastFromHostError(error, "Couldn't update MCP server.");
    },
  });
}
