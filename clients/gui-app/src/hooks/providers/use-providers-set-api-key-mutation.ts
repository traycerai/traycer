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

export function useProvidersSetApiKey(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setApiKey">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setApiKey",
    mutationKey: providersMutationKeys.setApiKey(),
    errorMessage: "Couldn't save the API key.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
