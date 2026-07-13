import type { Query, UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

type WorktreeGetBindingResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.getBinding"
>;

/**
 * A caller that polls while setup is in flight passes the function form, which
 * TanStack re-evaluates after each fetch against the freshest binding to decide
 * whether to keep polling (returns an interval) or stop (returns `false`) - so
 * polling ends as soon as every entry settles. `false` disables polling.
 */
export type WorktreeGetBindingRefetchInterval =
  | number
  | false
  | ((
      query: Query<
        WorktreeGetBindingResponse,
        HostRpcError,
        WorktreeGetBindingResponse
      >,
    ) => number | false);

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
  // Background setup runs server-side and only mutates the binding, so a caller
  // that must surface an in-flight setup transition (e.g. the terminal-agent
  // setup card) polls while any entry is non-terminal. `false` disables polling
  // for callers that only need the binding for rendering.
  readonly refetchInterval: WorktreeGetBindingRefetchInterval;
}): UseQueryResult<WorktreeGetBindingResponse, HostRpcError> {
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
      refetchInterval: args.refetchInterval,
    },
  });
}
