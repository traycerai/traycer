import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  HostRpcError,
  RetryableTransportError,
  type ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import {
  useHostQuery,
  useHostQueryWithResponseMap,
} from "@/hooks/host/use-host-query";

export function useWorktreeListBindingsForEpic(args: {
  readonly epicId: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">,
  HostRpcError
> {
  const client = useHostClient();
  return useWorktreeListBindingsForEpicForClient({ ...args, client });
}

export function useWorktreeListBindingsForEpicForClient(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly enabled: boolean;
}): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">,
  HostRpcError
> {
  return useHostQuery<HostRpcRegistry, "worktree.listBindingsForEpic">({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.listBindingsForEpic",
    params: { epicId: args.epicId },
    options: { enabled: args.enabled },
  });
}

/**
 * Terminal selection needs a directory, not a Git repository. Keep this
 * request in its own cache slot (purpose is part of the query key), so a Git
 * picker can never consume the deliberately unverified Git fields.
 */
export function useTerminalWorkspaceBindings(args: {
  readonly epicId: string;
  readonly enabled: boolean;
}) {
  const client = useHostClient();
  return useTerminalWorkspaceBindingsForClient({ ...args, client });
}

export function useTerminalWorkspaceBindingsForClient(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly enabled: boolean;
}) {
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "worktree.listBindingsForEpic",
    ResponseOfMethod<HostRpcRegistry, "worktree.listBindingsForEpic">
  >({
    cacheKeyIdentity: undefined,
    client: args.client,
    method: "worktree.listBindingsForEpic",
    params: { epicId: args.epicId, purpose: "directory" },
    mapResponse: ({ response }) => {
      // An older host strips purpose and can answer with an unresolved Git
      // placeholder. Retry it like a timeout instead of caching a successful
      // response whose disabled row spins forever. v1.3 directory checks fail
      // the RPC on timeout and return only verified directory availability.
      if (
        response.rows.some(
          (row) => row.disabledReason !== null && row.isGitResolvePending,
        )
      ) {
        throw new HostRpcError({
          code: "RPC_ERROR",
          requestId: "terminal-workspace-check",
          method: "worktree.listBindingsForEpic",
          message: "Workspace availability check has not completed. Try again.",
          fatalDetails: null,
        });
      }
      return response;
    },
    options: {
      enabled: args.enabled,
      // The transport already exhausts its own dial retries. Only retry
      // unresolved directory checks here, without multiplying that budget.
      retry: (failureCount, error) =>
        !(error instanceof RetryableTransportError) && failureCount < 2,
      retryDelay: (attempt) => 1_000 * 2 ** attempt,
    },
  });
}
