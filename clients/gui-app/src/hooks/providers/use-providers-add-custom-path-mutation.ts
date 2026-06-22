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

export function useProvidersAddCustomPath(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.addCustomPath">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.addCustomPath">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.addCustomPath",
    mutationKey: providersMutationKeys.addCustomPath(),
    errorMessage: "Couldn't add custom CLI path.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
