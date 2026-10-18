import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type {
  EnvironmentHostBinding,
  EnvironmentHostBindRequest,
} from "@traycer/protocol/host/environment/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { environmentMutationKeys, hostQueryKeys } from "@/lib/query-keys";

/**
 * Binds the host behind `client` to one of the user's environments
 * (`environment.host.bind`). Binding to the personal environment removes the
 * binding; the host refuses an environment the user does not belong to, and
 * refuses any rebind while a live bot of another environment is bound to it.
 *
 * No toast: the refusal is the picker's own inline notice, because the reason
 * ("a bot of another environment is still bound here") is an instruction the
 * reader acts on next to the control, not an interruption. `hostId` is the
 * host the client addresses, captured so the read query it refreshes is the
 * same host's whatever the scope does during the round trip.
 *
 * A bind or unbind also moves which machines an environment lists
 * (`environment.host.list`). That list is cloud-backed and the same through
 * every host, so its cache is invalidated on every host scope, not only this
 * one's: Settings' machine list and Home's row states both read it.
 */
export function useEnvironmentHostBindMutation(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): UseMutationResult<
  EnvironmentHostBinding,
  HostRpcError,
  EnvironmentHostBindRequest,
  { readonly hostId: string | null }
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "environment.host.bind",
    { readonly hostId: string | null }
  >({
    client,
    method: "environment.host.bind",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: environmentMutationKeys.hostBind(),
      onMutate: () => ({ hostId }),
      onSuccess: (binding, _variables, ctx) => {
        queryClient.setQueriesData<EnvironmentHostBinding>(
          {
            queryKey: hostQueryKeys.methodScope(
              ctx.hostId,
              "environment.host.read",
            ),
          },
          binding,
        );
        void queryClient.invalidateQueries({
          predicate: (query) =>
            hostQueryKeys.matchesMethodOnAnyHost(
              query.queryKey,
              "environment.host.list",
            ),
        });
      },
    },
  });
}
