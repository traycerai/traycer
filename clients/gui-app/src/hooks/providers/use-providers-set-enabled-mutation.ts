import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

export function useProvidersSetEnabled(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnabled">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setEnabled">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setEnabled",
    mutationKey: providersMutationKeys.setEnabled(),
    errorMessage: "Couldn't update provider.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
