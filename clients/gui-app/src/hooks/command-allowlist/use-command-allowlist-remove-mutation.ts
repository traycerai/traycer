import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { commandAllowlistMutationKeys } from "@/lib/query-keys";

/** Delete a saved command allowlist rule and refresh the list. */
export function useCommandAllowlistRemove(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "commandAllowlist.remove">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "commandAllowlist.remove">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "commandAllowlist.remove",
    mutationKey: commandAllowlistMutationKeys.remove(),
    errorMessage: "Couldn't remove the command rule.",
    invalidateMethods: ["commandAllowlist.list"],
  });
}
