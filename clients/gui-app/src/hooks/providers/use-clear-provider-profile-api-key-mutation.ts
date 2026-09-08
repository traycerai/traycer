import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import {
  PROFILE_API_KEY_MUTATION_SCOPE,
  PROVIDER_INVALIDATIONS,
} from "@/hooks/providers/invalidations";
import { providersMutationKeys } from "@/lib/query-keys";

/**
 * Remove the API key stored against ONE profile.
 *
 * A separate method from `providers.setProfileApiKey` rather than an
 * empty-string paste through it: the set request's `apiKey` is `min(1)`
 * precisely so a slipped empty paste cannot delete a credential, and the clear
 * request carries no `apiKey` field at all, so a key that reaches it is
 * dropped rather than stored. Deleting has to be the thing the caller asked
 * for. Same off-floor `degrade: { kind: "unsupported" }` posture as the setter,
 * and no `…ForClient` variant for the same reason - see the setter's note,
 * which also covers why the invalidation set is the full one.
 */
export function useClearProviderProfileApiKey(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.clearProfileApiKey">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.clearProfileApiKey">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.clearProfileApiKey",
    mutationKey: providersMutationKeys.clearProfileApiKey(),
    errorMessage: "Couldn't remove the API key.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
    scope: PROFILE_API_KEY_MUTATION_SCOPE,
  });
}
