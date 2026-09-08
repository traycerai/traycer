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

/**
 * D02: flips a managed profile's per-category (skills/plugins) ownership
 * between Linked (symlinked to the Default account) and Own (a private
 * copy). `PROVIDER_INVALIDATIONS` includes `providers.list`, whose prefix
 * covers every native skills/plugins list cache too (they key off the same
 * method), so the physical root a subsequent list reads is never stale.
 */
export function useProvidersSetProfileOwnership(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.setProfileOwnership">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.setProfileOwnership">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.setProfileOwnership",
    mutationKey: providersMutationKeys.setProfileOwnership(),
    errorMessage: "Couldn't update ownership.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
