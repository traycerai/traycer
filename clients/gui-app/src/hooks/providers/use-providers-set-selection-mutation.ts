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

export function useProvidersSetSelection(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setSelection">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setSelection">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setSelection",
    mutationKey: providersMutationKeys.setSelection(),
    errorMessage: "Couldn't switch provider CLI.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
