import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useExecutableWriteGrant } from "@/hooks/environment/use-executable-write-grant";
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
  // A variable can choose what a harness launches, so it carries the grant.
  const grant = useExecutableWriteGrant();
  return useHostScopedMutation({
    method: "providers.setEnvOverride",
    prepareRequest: grant,
    mutationKey: providersMutationKeys.setEnvOverride(),
    errorMessage: "Couldn't save the variable.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
