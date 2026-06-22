import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

interface HostScopedMutationContext {
  readonly hostId: string | null;
}

interface UseHostScopedMutationArgs<
  Method extends keyof HostRpcRegistry & string,
> {
  readonly method: Method;
  readonly mutationKey: ReadonlyArray<unknown>;
  readonly errorMessage: string;
  /**
   * Method prefixes to invalidate on success. Each entry expands to
   * `["host", hostId, method]`, dropping every cached query for that
   * method regardless of params. Pass the full set of read methods this
   * mutation affects; an empty list means "no automatic invalidation."
   */
  readonly invalidateMethods: ReadonlyArray<keyof HostRpcRegistry & string>;
}

/**
 * Standard host-mutation shape: capture `hostId` in `onMutate` to
 * survive a host swap mid-flight, invalidate the listed read methods
 * for that host on success, surface a host-error toast on failure.
 */
export function useHostScopedMutation<
  Method extends keyof HostRpcRegistry & string,
>(
  args: UseHostScopedMutationArgs<Method>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  HostScopedMutationContext
> {
  const client = useHostClient();
  return useHostScopedMutationForClient(client, args);
}

export function useHostScopedMutationForClient<
  Method extends keyof HostRpcRegistry & string,
>(
  client: HostClient<HostRpcRegistry> | null,
  args: UseHostScopedMutationArgs<Method>,
): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, Method>,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, Method>,
  HostScopedMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, Method, HostScopedMutationContext>({
    client,
    method: args.method,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: args.mutationKey,
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_data, _variables, ctx) => {
        if (ctx.hostId === null) return;
        for (const method of args.invalidateMethods) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(ctx.hostId, method),
          });
        }
      },
      onError: (error) => toastFromHostError(error, args.errorMessage),
    },
  });
}
