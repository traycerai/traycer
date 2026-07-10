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
import { providersMutationKeys } from "@/lib/query-keys";

type StartLoginMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.startLogin">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.startLogin">,
  { readonly hostId: string | null }
>;

// Spawns the provider CLI's browser-OAuth login on the (local) host. The CLI
// self-completes via a localhost loopback, so there's nothing to invalidate
// here - the re-auth card awaits the honest completion edge via
// `providers.awaitLogin` (the host blocks until the login child closes, then
// re-probes), not by polling `providers.list`.
export function useProvidersStartLogin(): StartLoginMutationResult {
  return useProvidersStartLoginForClient(useHostClient());
}

/** Client-scoped variant - lets a caller outside `HostRuntimeContext` (e.g.
 *  the picker's tab-scoped "Create new profile" flow) target an explicit
 *  host instead of the app-wide default. */
export function useProvidersStartLoginForClient(
  client: HostClient<HostRpcRegistry> | null,
): StartLoginMutationResult {
  return useHostScopedMutationForClient(client, {
    method: "providers.startLogin",
    mutationKey: providersMutationKeys.startLogin(),
    errorMessage: "Couldn't start the sign-in flow.",
    invalidateMethods: [],
  });
}
