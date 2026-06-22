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

// Setting (or unsetting, with `value: null`) a provider env override resets the
// provider's adapter host-side, so a warm harness respawns with the new env.
// That can flip availability, so refresh the Settings panel + both harness
// selectors like the other provider mutations.
export function useProvidersSetEnvOverride(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setEnvOverride">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setEnvOverride">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setEnvOverride",
    mutationKey: providersMutationKeys.setEnvOverride(),
    errorMessage: "Couldn't save environment variable.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
