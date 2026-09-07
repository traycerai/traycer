import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersPluginsMutateAction,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  isProviderNativeRpcError,
  mapNativeMutateToPluginsMutate,
  type PluginsListData,
  type PluginsMutateData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type PluginsMutateVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly mutation: ProvidersPluginsMutateAction;
  /** Same escape hatch as `useProvidersMcpMutate`: the plugins tab reports failures in its own error slot, and without this the user gets the toast AND the inline message for one failure. */
  readonly suppressToast: boolean | undefined;
};

interface PluginsMutateContext {
  readonly hostId: string | null;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

export function useProvidersPluginsMutate(): UseMutationResult<
  PluginsMutateData,
  HostRpcError,
  PluginsMutateVariables,
  PluginsMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    PluginsMutateData,
    HostRpcError,
    PluginsMutateVariables,
    PluginsMutateContext
  >({
    mutationKey: providersMutationKeys.pluginsMutate(),
    mutationFn: async (variables) => {
      const response = await client.request("providers.nativeMutate", {
        providerId: variables.providerId,
        mutation: {
          kind: "plugins",
          scope: variables.scope,
          workspaceRoot: variables.workspaceRoot,
          mutation: variables.mutation,
        },
      });
      return mapNativeMutateToPluginsMutate({ response });
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
      queryClient.setQueryData<PluginsListData>(
        providersNativeQueryKeys.pluginsList(ctx.hostId, ctx.listParams),
        data,
      );
      // Writing the list is not enough: icons are cached SEPARATELY, under `staleTime: Infinity` with polling off, keyed by the plugin's reported version.
      const hostId = ctx.hostId;
      void queryClient.invalidateQueries({
        predicate: (query) =>
          providersNativeQueryKeys.isPluginIconKey(hostId, query.queryKey),
      });
    },
    onError: (error, variables) => {
      if (variables.suppressToast === true && isProviderNativeRpcError(error)) {
        return;
      }
      toastFromHostError(error, "Couldn't update plugins.");
    },
  });
}
