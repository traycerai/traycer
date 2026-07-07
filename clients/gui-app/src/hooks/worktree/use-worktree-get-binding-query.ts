import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

export function useWorktreeGetBinding(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly enabled: boolean;
  // The response carries the host-recomputed `missingWorktreePaths`, so a
  // caller surfacing that signal sets `staleTime: 0` + `refetchOnWindowFocus`
  // (typically gated on surface visibility) to re-check on focus. A caller that
  // only needs the binding for rendering passes a normal staleTime + `false`.
  readonly staleTime: number;
  readonly refetchOnWindowFocus: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.getBinding">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "worktree.getBinding">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.getBinding",
    params: {
      epicId: args.epicId,
      ownerId: args.ownerId,
      ownerKind: args.ownerKind,
    },
    options: {
      enabled: args.enabled,
      staleTime: args.staleTime,
      refetchOnWindowFocus: args.refetchOnWindowFocus,
    },
  });
}
