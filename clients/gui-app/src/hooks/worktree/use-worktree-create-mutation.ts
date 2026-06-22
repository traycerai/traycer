import type { UseMutationResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostScopedMutationForClient } from "@/hooks/host/use-host-scoped-mutation";
import { worktreeMutationKeys } from "@/lib/query-keys";
import { WORKTREE_BINDING_INVALIDATIONS } from "@/hooks/worktree/invalidations";

export function useWorktreeCreateForClient(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.create">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "worktree.create">,
  { readonly hostId: string | null }
> {
  return useHostScopedMutationForClient(client, worktreeCreateMutationArgs());
}

function worktreeCreateMutationArgs() {
  return {
    method: "worktree.create",
    mutationKey: worktreeMutationKeys.create(),
    errorMessage: "Couldn't create worktree.",
    invalidateMethods: WORKTREE_BINDING_INVALIDATIONS,
  } as const;
}
