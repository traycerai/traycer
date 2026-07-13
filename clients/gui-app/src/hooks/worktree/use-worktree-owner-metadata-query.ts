import { useMemo } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  WorktreeBinding,
  WorktreeBindingOwnerKind,
  WorktreeHostEntryV12,
} from "@traycer/protocol/host/worktree-schemas";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useWorktreeGetBinding } from "@/hooks/worktree/use-worktree-get-binding-query";
import type { HostRpcRegistry } from "@/lib/host";

const EMPTY_WORKTREES: readonly WorktreeHostEntryV12[] = [];

export interface WorktreeOwnerMetadata {
  readonly binding: WorktreeBinding | null;
  readonly worktrees: readonly WorktreeHostEntryV12[];
  readonly isPending: boolean;
  readonly error: HostRpcError | null;
}

/**
 * Resolves one chat/terminal-agent's binding, then enriches only the worktree
 * paths that owner actually runs in. Supplying `binding` skips the binding RPC
 * (chat status lines already receive it from `chat.subscribe`); `undefined`
 * lets navigator hover resolve it lazily from the owner-scoped host.
 */
export function useWorktreeOwnerMetadata(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly binding: WorktreeBinding | null | undefined;
  readonly enabled: boolean;
}): WorktreeOwnerMetadata {
  const bindingQuery = useWorktreeGetBinding({
    client: args.client,
    epicId: args.epicId,
    ownerId: args.ownerId,
    ownerKind: args.ownerKind,
    enabled: args.enabled && args.binding === undefined,
    refetchInterval: false,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const binding =
    args.binding === undefined
      ? (bindingQuery.data?.binding ?? null)
      : args.binding;
  const worktreePaths = useMemo(
    () =>
      Array.from(
        new Set(
          (binding?.entries ?? []).flatMap((entry) =>
            entry.mode === "worktree" && entry.worktreePath !== null
              ? [entry.worktreePath]
              : [],
          ),
        ),
      ),
    [binding],
  );
  const worktreesQuery = useHostQuery<
    HostRpcRegistry,
    "worktree.listAllForHost"
  >({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.listAllForHost",
    params: {
      includeActivity: true,
      activityPaths: worktreePaths,
      cursor: null,
      limit: null,
    },
    options: { enabled: args.enabled && worktreePaths.length > 0 },
  });

  return {
    binding,
    worktrees: worktreesQuery.data?.worktrees ?? EMPTY_WORKTREES,
    isPending:
      args.enabled &&
      ((args.binding === undefined && bindingQuery.isPending) ||
        (worktreePaths.length > 0 && worktreesQuery.isPending)),
    error: args.enabled
      ? ((args.binding === undefined ? bindingQuery.error : null) ??
        worktreesQuery.error)
      : null,
  };
}
