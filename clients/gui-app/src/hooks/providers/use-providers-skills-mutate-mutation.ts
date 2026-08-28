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
  isProviderNativeRpcError,
  mapNativeMutateToSkillsMutate,
  type SkillsListData,
  type SkillsMutateData,
} from "@/hooks/providers/native-response-map";
import { providersMutationKeys } from "@/lib/query-keys";
import {
  isNativeSkillsListQueryKey,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type SkillsMutateVariables = {
  readonly providerId: ProviderId;
  readonly scope: ProviderNativeScope;
  readonly workspaceRoot: string | null;
  readonly mutation: ProvidersSkillsMutateAction;
  /**
   * When true, the hook skips the global toast so the caller can render the
   * native error inline. Same escape hatch as `useProvidersMcpMutate`: the
   * skills tab reports failures in its own error slot, and without this the
   * user gets the toast AND the inline message for one failure. The toast
   * still fires for non-native errors and when this is omitted/false.
   */
  readonly suppressToast: boolean | undefined;
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
      const response = await client.request("providers.nativeMutate", {
        providerId: variables.providerId,
        mutation: {
          kind: "skills",
          scope: variables.scope,
          workspaceRoot: variables.workspaceRoot,
          mutation: variables.mutation,
        },
      });
      return mapNativeMutateToSkillsMutate({ response });
    },
    onMutate: (variables) => ({
      hostId: client.getActiveHostId(),
      listParams: {
        providerId: variables.providerId,
        scope: variables.scope,
        workspaceRoot: variables.workspaceRoot,
      },
    }),
    onSuccess: (data, variables, ctx) => {
      if (ctx.hostId === null) return;
      if (data.kind !== "skills") return;
      queryClient.setQueryData<SkillsListData>(
        providersNativeQueryKeys.skillsList(ctx.hostId, ctx.listParams),
        { skills: data.skills },
      );
      const mutation = variables.mutation;
      const affectsSharedStore =
        mutation.action === "edit" ||
        mutation.action === "update" ||
        mutation.action === "remove" ||
        ("providerScoped" in mutation && !mutation.providerScoped);
      if (affectsSharedStore) {
        const hostPrefix = providersNativeQueryKeys.base(ctx.hostId);
        void queryClient.invalidateQueries({
          predicate: (query) =>
            hostPrefix.every((part, index) => query.queryKey[index] === part) &&
            isNativeSkillsListQueryKey(query.queryKey),
        });
      }
    },
    onError: (error, variables, ctx) => {
      // Any write may land partially before the host reports an error. Inspect
      // is excluded because it never writes.
      if (
        variables.mutation.action !== "inspect" &&
        ctx !== undefined &&
        ctx.hostId !== null
      ) {
        void queryClient.invalidateQueries({
          queryKey: providersNativeQueryKeys.skillsList(
            ctx.hostId,
            ctx.listParams,
          ),
        });
      }
      if (variables.suppressToast === true && isProviderNativeRpcError(error)) {
        return;
      }
      toastFromHostError(error, "Couldn't update skills.");
    },
  });
}
