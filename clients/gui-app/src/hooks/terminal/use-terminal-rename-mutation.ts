import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

interface RenameTerminalMutationContext {
  readonly hostId: string | null;
}

/**
 * Mutation hook for `terminal.rename@1.0`. Stores a user-supplied
 * display title on the host's in-memory session record so the sidebar
 * row and any future tab-open use the override instead of the
 * cwd-derived label. Invalidates the `terminal.list` query on success so
 * the row updates.
 */
export function useTerminalRename(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.rename">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.rename">,
  RenameTerminalMutationContext
> {
  const client = useHostClient();
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "terminal.rename",
    RenameTerminalMutationContext
  >({
    client,
    method: "terminal.rename",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: terminalMutationKeys.rename(),
      onMutate: () => ({ hostId: client.getActiveHostId() }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(ctx.hostId, "terminal.list"),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't rename the terminal."),
    },
  });
}
