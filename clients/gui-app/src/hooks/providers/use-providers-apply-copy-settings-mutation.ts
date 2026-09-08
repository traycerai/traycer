import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { toastFromHostError } from "@/lib/host-error-toast";
import type { HostRpcRegistry } from "@/lib/host";
import {
  hostQueryKeys,
  providersCopyPreviewQueryKey,
  providersMutationKeys,
} from "@/lib/query-keys";

interface ApplyCopySettingsContext {
  readonly hostId: string | null;
}

/**
 * D13 apply step: `providers.applyCopySettings` for a draft (the reviewed
 * one, or a retry narrowed to only the previously failed target ids - apply
 * is idempotent per target, so a retry is just another ordinary call, never
 * a special-cased path). A copy can change CLI selection, env and native
 * config, so a successful apply invalidates `PROVIDER_INVALIDATIONS` - the
 * same catalogs every other provider mutation refreshes - and drops the
 * cached preview for the exact draft just applied, since re-previewing it
 * unchanged would now show no diff.
 */
export function useProvidersApplyCopySettings(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.applyCopySettings">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.applyCopySettings">,
  ApplyCopySettingsContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.applyCopySettings",
    ApplyCopySettingsContext
  >({
    client,
    method: "providers.applyCopySettings",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.applyCopySettings(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onError: (error) => {
        toastFromHostError(error, "Couldn't copy settings.");
      },
      onSuccess: (_data, variables, context) => {
        // `onSuccess` always receives the `onMutate` context (unlike
        // `onSettled` below, which may run without one), and that context's
        // `hostId` is `string | null` - so `null` is the only absent case.
        if (context.hostId === null) return;
        queryClient.removeQueries({
          queryKey: providersCopyPreviewQueryKey(context.hostId, variables),
          exact: true,
        });
      },
      onSettled: async (_data, _error, _variables, context) => {
        if (context?.hostId === null || context?.hostId === undefined) return;
        await Promise.all(
          PROVIDER_INVALIDATIONS.map((method) =>
            queryClient.invalidateQueries({
              queryKey: hostQueryKeys.methodScope(context.hostId, method),
            }),
          ),
        );
      },
    },
  });
}
