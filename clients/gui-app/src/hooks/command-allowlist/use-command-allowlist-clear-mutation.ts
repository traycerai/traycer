import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutation } from "@/hooks/host/use-host-scoped-mutation";
import { commandAllowlistMutationKeys } from "@/lib/query-keys";

/** Clear every saved command allowlist rule and refresh the list. */
export function useCommandAllowlistClear(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "commandAllowlist.clear">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "commandAllowlist.clear">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutation({
    method: "commandAllowlist.clear",
    mutationKey: commandAllowlistMutationKeys.clear(),
    errorMessage: "Couldn't clear the command rules.",
    invalidateMethods: ["commandAllowlist.list"],
  });
}
