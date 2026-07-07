import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

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
