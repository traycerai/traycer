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
 * D10: a real turn through the same spawn path the GUI uses, bounded timeout.
 * The verdict (`endpoint.lastTest`) lands on the row through the next
 * `providers.list` fetch - `invalidateMethods` covers that rather than an
 * optimistic write, since the verdict is exactly what this RPC just computed
 * host-side and there is nothing for the client to predict.
 */
export function useProvidersTestProfileConnection(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.testProfileConnection">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.testProfileConnection">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "providers.testProfileConnection",
    mutationKey: providersMutationKeys.testProfileConnection(),
    errorMessage: "Couldn't test the connection.",
    invalidateMethods: PROVIDER_INVALIDATIONS,
  });
}
