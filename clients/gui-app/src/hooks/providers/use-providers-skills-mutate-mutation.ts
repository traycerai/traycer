import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { HostMethodVersionUnsatisfiedError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  ProvidersSkillsMutateAction,
  ProviderNativeScope,
} from "@traycer/protocol/host/provider-native-schemas";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  isProviderNativeRpcError,
  mapNativeMutateToSkillsMutate,
  type SkillsListData,
  type SkillsMutateData,
} from "@/hooks/providers/native-response-map";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import {
  isNativeSkillsListQueryKey,
  providersNativeQueryKeys,
} from "@/lib/query-keys/providers-native-query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

export type SkillsMutateVariables = {
  /** Captured by the team surface; never read again when a queued write resumes. */
  readonly environmentId?: string | null;
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
  // What this installs can run on the host, so it carries the grant.
  const grant = useExecutableWriteGrant();
  return useMutation<
    SkillsMutateData,
    HostRpcError,
    SkillsMutateVariables,
    SkillsMutateContext
  >({
    mutationKey: providersMutationKeys.skillsMutate(),
    mutationFn: async (variables) => {
      const environmentId = variables.environmentId ?? null;
      if (environmentId !== null)
        cloudVerdictPreflight("providers.nativeMutate")();
      const request = await grant<
        RequestOfMethod<HostRpcRegistry, "providers.nativeMutate">
      >(
        {
          providerId: variables.providerId,
          executableWriteGrant: null,
          expectedEnvironmentId: environmentId,
          mutation: {
            kind: "skills",
            scope: variables.scope,
            workspaceRoot: variables.workspaceRoot,
            mutation: variables.mutation,
          },
        },
        client,
      );
      const response =
        environmentId === null
          ? await client.request("providers.nativeMutate", request)
          : await client.requestWithSignalRequiringHostMethodVersion(
              "providers.nativeMutate",
              request,
              undefined,
              {
                method: "providers.nativeMutate",
                version: { major: 1, minor: 4 },
              },
            );
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
      // A dispatch refusal wrote nothing; the tab names the update remedy.
      if (error instanceof HostMethodVersionUnsatisfiedError) return;
      if (
        isProviderNativeRpcError(error) &&
        error.nativeCode === "environment_mismatch"
      ) {
        // The refusal proves this host is no longer a team source. Do not
        // refetch its native list, which could now describe Personal.
        void queryClient.invalidateQueries({
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "environment.host.list",
            ),
        });
        return;
      }
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
