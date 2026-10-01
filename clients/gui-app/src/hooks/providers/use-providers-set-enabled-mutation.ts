import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import {
  providersNativeQueryKeys,
  CLASSIC_PROVIDERS_LIST_PARAMS,
} from "@/lib/query-keys/providers-native-query-keys";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

export function useProvidersSetEnabled(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
  { readonly hostId: string | null }
> {
  const queryClient = useQueryClient();
  return useHostScopedMutation({
    method: "providers.setEnabled",
    mutationKey: providersMutationKeys.setEnabled(),
    errorMessage: "Couldn't update provider.",
    invalidateMethods: PROVIDER_INVALIDATIONS.filter(
      (method) => method !== "providers.list",
    ),
    onSuccess: (_data, variables, hostId) => {
      if (hostId === null) return;
      // Native skills/plugins share the RPC method, but a toggle does not
      // change every provider's setup. Refresh only this provider and catalog.
      for (const queryKey of [
        hostQueryKeys.method<HostRpcRegistry, "providers.list">(
          hostId,
          "providers.list",
          CLASSIC_PROVIDERS_LIST_PARAMS,
        ),
        providersNativeQueryKeys.providerScope(hostId, variables.providerId),
      ]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
