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

export function useProvidersRemoveCustomPath(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.removeCustomPath">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.removeCustomPath">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.removeCustomPath",
    mutationKey: providersMutationKeys.removeCustomPath(),
    errorMessage: "Couldn't remove custom CLI path.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
