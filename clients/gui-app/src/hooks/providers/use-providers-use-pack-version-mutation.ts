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

type UsePackVersionMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.usePackVersion">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.usePackVersion">,
  UsePackVersionMutationContext
>;

interface UsePackVersionMutationContext {
  readonly hostId: string | null;
}

/**
 * Pin a pack to a version, or clear the pin (`version: null` → auto).
 *
 * Typed refusals (`pin-below-floor`, `verification-failed`) return on the
 * response; the panel draws them on the row. No auto-toast for the same reason
 * as install/remove.
 */
export function useProvidersUsePackVersion(): UsePackVersionMutationResult {
  return useProvidersUsePackVersionForClient(useHostClient());
}

export function useProvidersUsePackVersionForClient(
  client: HostClient<HostRpcRegistry> | null,
): UsePackVersionMutationResult {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "providers.usePackVersion",
    UsePackVersionMutationContext
  >({
    client,
    method: "providers.usePackVersion",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: providersMutationKeys.usePackVersion(),
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
