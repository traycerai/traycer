import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

type CreateApiKeyProfileMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.createApiKeyProfile">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.createApiKeyProfile">,
  { readonly hostId: string | null }
>;

/**
 * D10: "Saving an API-key profile requires a passing test" - the host runs
 * the test before committing and deletes the draft on failure, so a rejected
 * request comes back as an ORDINARY `ok:false` response (never a thrown
 * `HostRpcError`) carrying the scrubbed reason. Callers must check
 * `data.ok` - a resolved promise here is not success.
 */
export function useProvidersCreateApiKeyProfile(): CreateApiKeyProfileMutationResult {
  return useProvidersCreateApiKeyProfileForClient(useHostClient());
}

/** Client-scoped variant - lets a caller outside `HostRuntimeContext` (e.g.
 *  the picker's tab-scoped "Create new profile" flow, `AddProfileDialog`'s
 *  API key tab) target an explicit host instead of the app-wide default. */
export function useProvidersCreateApiKeyProfileForClient(
  client: HostClient<HostRpcRegistry> | null,
): CreateApiKeyProfileMutationResult {
  return useHostScopedMutationForClient(client, {
    method: "providers.createApiKeyProfile",
    mutationKey: providersMutationKeys.createApiKeyProfile(),
    errorMessage: "Couldn't create the profile.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
