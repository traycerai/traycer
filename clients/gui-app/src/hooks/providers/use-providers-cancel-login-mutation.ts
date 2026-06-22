import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

// Kills an in-flight `providers.startLogin` child (user cancelled, or the
// re-auth card unmounted before the browser flow finished). Best-effort - no
// invalidation, and the card swallows errors since the child may already be gone.
export function useProvidersCancelLogin(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.cancelLogin">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.cancelLogin",
    mutationKey: providersMutationKeys.cancelLogin(),
    errorMessage: "Couldn't cancel the sign-in flow.",
    invalidateMethods: [],
  });
}
