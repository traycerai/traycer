import type { UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";
import { workspaceMutationKeys } from "@/lib/query-keys";

/**
 * Adds a folder to the owner binding as a Local entry. This shares the
 * `worktree.setEntryMode` RPC with the per-row "switch to Local" action, but
 * carries add-specific error copy and its own pending key - so the "Add folder"
 * affordance never surfaces the row action's "switch to Local" message, and its
 * spinner is not toggled by an unrelated row mode flip.
 */
export function useWorkspaceBindingAddFolderForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.setEntryMode">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.setEntryMode">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "worktree.setEntryMode",
    mutationKey: workspaceMutationKeys.addBindingFolder(),
    errorMessage: "Couldn't add this folder.",
    invalidateMethods: WORKTREE_BINDING_INVALIDATIONS,
  });
}
