import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersSkillsMutateAction,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useHostClient } from "@/lib/host";
import {
  mapSetEnabledToSkillsMutate,
  type SkillsListData,
  type SkillsMutateData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type SkillsMutateVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly mutation: ProvidersSkillsMutateAction;
};

interface SkillsMutateContext {
  readonly hostId: string | null;
  readonly listParams: {
    readonly providerId: ProviderId;
    readonly scope: ProviderNativeScope;
    readonly workspaceRoot: string | null;
  };
}

export function useProvidersSkillsMutate(): UseMutationResult<
  SkillsMutateData,
  HostRpcError,
  SkillsMutateVariables,
  SkillsMutateContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useMutation<
    SkillsMutateData,
    HostRpcError,
    SkillsMutateVariables,
    SkillsMutateContext
  >({
    mutationKey: providersMutationKeys.skillsMutate(),
    mutationFn: async (variables) => {
      const response = await client.request("providers.setEnabled", {
        providerId: variables.providerId,
        enabled: null,
        native: {
          kind: "skills",
          scope: variables.scope,
          workspaceRoot: variables.workspaceRoot,
          mutation: variables.mutation,
        },
        profileAction: null,
      });
      return mapSetEnabledToSkillsMutate({ response });
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
      queryClient.setQueryData<SkillsListData>(
        providersNativeQueryKeys.skillsList(ctx.hostId, ctx.listParams),
        data,
      );
    },
    onError: (error) => toastFromHostError(error, "Couldn't update skills."),
  });
}
