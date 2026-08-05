import type { UseMutationResult } from "@tanstack/react-query";
import type {
  RequestOfMethod,
  ResponseOfMethod,
  HostRpcError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useHostMutation } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/** The tab-bound GUI repair route for a fail-closed local store refusal. */
export function useRebindLocalStoreMutation(): UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "host.rebindLocalStore">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "host.rebindLocalStore">
> {
  const client = useTabHostClient();
  return useHostMutation<HostRpcRegistry, "host.rebindLocalStore">({
    client,
    method: "host.rebindLocalStore",
    mapVariables: (variables) => variables,
    options: { mutationKey: ["host", "rebind-local-store"] },
  });
}
