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
  readonly hostId: string | null;
  readonly listState:
    | {
        readonly data: McpListData | undefined;
        readonly dataUpdateCount: number;
        readonly errorUpdateCount: number;
      }
    | undefined;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
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
  McpMutateVariables
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<McpMutateResult, HostRpcError, McpMutateVariables>({
    // A host switch detaches the observer instead of retargeting queued work.
    mutationKey: providersMutationKeys.mcpMutate(client.getActiveHostId()),
    // Serialize MCP writes so each request sees prior successful writes.
    scope: { id: "providers.mcpMutate" },
    mutationFn: async (variables) => {
      const hostId = client.getActiveHostId();
      const listParams = {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      };
      // onMutate runs before a scoped mutation waits. Capture only once this
      // mutation actually starts, after the previous write has settled.
      const snapshot: McpMutateSnapshot = {
        hostId,
        listParams,
        listState: queryClient.getQueryState<McpListData>(
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
    onSuccess: async ({ data, snapshot }) => {
      if (snapshot.hostId === null) return;
      const listKey = providersNativeQueryKeys.mcpList(
        snapshot.hostId,
        snapshot.listParams,
      );
      const {
        fetchStatus,
        data: currentData,
        dataUpdateCount,
        errorUpdateCount,
        error,
      } = queryClient.getQueryState<McpListData, HostRpcError>(listKey) ?? {};
      if (
        fetchStatus === "fetching" ||
        currentData !== snapshot.listState?.data ||
        dataUpdateCount !== snapshot.listState?.dataUpdateCount
      ) {
        // Newer data or an in-flight list supersedes this mutation's
        // snapshot. Reconcile through the existing list query, preserving its
        // error until that complete read succeeds.
        if (fetchStatus === "fetching") {
          // invalidateQueries alone reuses an initial fetch with no data;
          // this read must begin after the mutation has completed.
          await queryClient.cancelQueries({ queryKey: listKey, exact: true });
        }
        await queryClient.invalidateQueries({ queryKey: listKey, exact: true });
        return;
      }
      // A failed refresh supplies no newer rows. Apply the successful mutation
      // while retaining an error that arrived after this mutation began.
      const refreshError =
        errorUpdateCount !== snapshot.listState?.errorUpdateCount
          ? (error ?? currentData?.refreshError ?? null)
          : null;
      queryClient.setQueryData<McpListData>(listKey, { ...data, refreshError });
    },
    onError: (error, variables) => {
      if (variables.suppressToast === true && isProviderNativeRpcError(error)) {
        return;
      }
      toastFromHostError(error, "Couldn't update MCP server.");
    },
  });
}
