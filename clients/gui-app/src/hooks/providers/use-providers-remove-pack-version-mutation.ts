import type { UseMutationResult } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostClient } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

type RemovePackVersionMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.removePackVersion">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.removePackVersion">,
  RemovePackVersionMutationContext
>;

interface RemovePackVersionMutationContext {
  readonly hostId: string | null;
}

/**
 * Delete one installed pack version's bytes.
 *
 * Typed `ok: false` results (is-current, holder-reserved, quarantine-reserved,
 * deferred-locked) are success responses the panel renders on the row — not
 * thrown host errors. Real transport/host bugs still throw and the caller
 * can toast; this hook does not auto-toast so deferred-locked is not drawn
 * as a failure.
 */
export function useProvidersRemovePackVersion(): RemovePackVersionMutationResult {
  return useProvidersRemovePackVersionForClient(useHostClient());
}

export function useProvidersRemovePackVersionForClient(
  client: HostClient<HostRpcRegistry> | null,
): RemovePackVersionMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.removePackVersion",
    RemovePackVersionMutationContext
  >({
    client,
    method: "providers.removePackVersion",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.removePackVersion(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_result, _variables, context) => {
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(context.hostId, "providers.list"),
        });
      },
    },
  });
}
