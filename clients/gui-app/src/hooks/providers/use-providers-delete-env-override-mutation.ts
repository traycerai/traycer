import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { useSettingsSave } from "@/hooks/environment/use-settings-save";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

const SAVED_KINDS = ["env_override"] as const;

// Removing a provider env override resets the provider's adapter host-side
// (same rationale as the set mutation), so refresh the Settings panel + both
// harness selectors.
export function useProvidersDeleteEnvOverride(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.deleteEnvOverride">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.deleteEnvOverride">,
  { readonly hostId: string | null }
> {
  const prepareSave = useSettingsSave(useHostClient(), SAVED_KINDS);
  return useHostScopedMutation({
    method: "providers.deleteEnvOverride",
    mutationKey: providersMutationKeys.deleteEnvOverride(),
    errorMessage: "Couldn't remove the variable.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
    followSettingsSave: (request, client) =>
      prepareSave(
        { method: "providers.deleteEnvOverride", request },
        client.getActiveHostId(),
      ),
  });
}
