import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostRpcError as HostRpcErrorCtor,
  withHostRpcErrorBoundary,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { withHostMutationLifecycleBoundary } from "@/hooks/host/use-host-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { toastFromHostError } from "@/lib/host-error-toast";
import { hostQueryKeys, terminalMutationKeys } from "@/lib/query-keys";

interface CreateTerminalMutationContext {
  readonly hostId: string | null;
}

export function useTerminalCreate(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "terminal.create">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "terminal.create">,
  CreateTerminalMutationContext
> {
  const queryClient = useQueryClient();
  return useMutation<
    ResponseOfMethod<HostRpcRegistry, "terminal.create">,
    HostRpcError,
    RequestOfMethod<HostRpcRegistry, "terminal.create">,
    CreateTerminalMutationContext
  >(
    withHostMutationLifecycleBoundary("terminal.create", {
      mutationKey: terminalMutationKeys.create(),
      mutationFn: (variables) =>
        withHostRpcErrorBoundary("terminal.create", () => {
          if (client === null) {
            return Promise.reject(
              new HostRpcErrorCtor({
                code: "RPC_ERROR",
                message: "Cannot create terminal without a host client.",
                requestId: "client-preflight",
                method: "terminal.create",
                fatalDetails: null,
              }),
            );
          }
          return client.request("terminal.create", variables);
        }),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        // Refresh only the terminal-session list (drives `hostHasSession`).
        // Invalidating the whole host scope would also force-refetch the
        // manual-refresh-only cloud-tasks history, dropping a just-created
        // local-first epic that the cloud `listTasks` does not contain yet.
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(ctx.hostId, "terminal.list"),
        });
      },
      onError: (error) =>
        toastFromHostError(error, "Could not create terminal"),
    }),
  );
}
