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

export function useWorktreeImportForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.import">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.import">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, {
    method: "worktree.import",
    mutationKey: worktreeMutationKeys.import(),
    errorMessage: "Couldn't import worktree.",
    invalidateMethods: WORKTREE_BINDING_INVALIDATIONS,
  });
}
