import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { browserMutationKeys } from "@/lib/query-keys";

/**
 * Ticket 12 - the one-click Stop on the passive borrowed-tile indicator.
 * `browser.stopAgentActivity` interrupts the owner's active browser cell.
 * Nothing here reads back via a host query, so there is nothing to invalidate
 * on success. `data.status` distinguishes an idle owner, a clean stop, and a
 * host call whose page outcome is unknown.
 */
export function useStopBrowserAgentActivity(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "browser.stopAgentActivity">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "browser.stopAgentActivity">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "browser.stopAgentActivity",
    mutationKey: browserMutationKeys.stopAgentActivity(),
    errorMessage: "Couldn't stop the agent's browser activity.",
    invalidateMethods: [],
  });
}
