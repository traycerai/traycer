import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { providersMutationKeys } from "@/lib/query-keys";

// Spawns the provider CLI's browser-OAuth login on the (local) host. The CLI
// self-completes via a localhost loopback, so there's nothing to invalidate
// here - the re-auth card awaits the honest completion edge via
// `providers.awaitLogin` (the host blocks until the login child closes, then
// re-probes), not by polling `providers.list`.
export function useProvidersStartLogin(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startLogin">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.startLogin",
    mutationKey: providersMutationKeys.startLogin(),
    errorMessage: "Couldn't start the sign-in flow.",
    invalidateMethods: [],
  });
}
