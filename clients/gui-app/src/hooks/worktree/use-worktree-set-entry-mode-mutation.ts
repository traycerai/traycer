import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { worktreeMutationKeys } from "@/lib/query-keys";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";

/** Per-folder mode flip. */
export function useWorktreeSetEntryModeForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.setEntryMode">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.setEntryMode">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "worktree.setEntryMode",
    mutationKey: worktreeMutationKeys.setEntryMode(),
    errorMessage: "Couldn't switch this folder to Local.",
    invalidateMethods: WORKTREE_BINDING_INVALIDATIONS,
  });
}
