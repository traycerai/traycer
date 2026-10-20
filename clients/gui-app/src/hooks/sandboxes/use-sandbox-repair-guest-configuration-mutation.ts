import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { sandboxMutationKeys } from "@/lib/query-keys";

const NO_INVALIDATIONS: readonly [] = [];

/**
 * `host.sandbox.repairGuestConfiguration` on the surface's host: re-applies a
 * sandbox's guest configuration (trust files, hosts aliases, the env layer,
 * git setup) and refetches it. The card's repair action, so it runs on the
 * host the card describes - the Settings scope.
 *
 * Nothing is invalidated here: the outcome reaches the card on the sandbox
 * row's next read (`guestConfigured` rides the host's heartbeat), which the
 * caller asks for once this settles.
 */
export function useSandboxRepairGuestConfiguration(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.sandbox.repairGuestConfiguration">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "host.sandbox.repairGuestConfiguration",
    mutationKey: sandboxMutationKeys.repairGuestConfiguration(),
    errorMessage: "Couldn't repair this sandbox's setup.",
    invalidateMethods: NO_INVALIDATIONS,
  });
}
