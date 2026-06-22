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

export function useProvidersClearApiKey(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.clearApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.clearApiKey">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.clearApiKey",
    mutationKey: providersMutationKeys.clearApiKey(),
    errorMessage: "Couldn't clear the API key.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
