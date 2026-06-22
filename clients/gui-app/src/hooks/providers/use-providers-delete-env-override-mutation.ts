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

// Removing a provider env override resets the provider's adapter host-side
// (same rationale as the set mutation), so refresh the Settings panel + both
// harness selectors.
export function useProvidersDeleteEnvOverride(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.deleteEnvOverride">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.deleteEnvOverride">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.deleteEnvOverride",
    mutationKey: providersMutationKeys.deleteEnvOverride(),
    errorMessage: "Couldn't remove environment variable.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
