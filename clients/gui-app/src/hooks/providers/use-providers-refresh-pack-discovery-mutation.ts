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
import { useHostMutationWithResponseTimeout } from "@/hooks/host/use-host-query";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { toast } from "sonner";
import { PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS } from "@/lib/host-rpc-policy/provider-pack-discovery-check-timeout";
import { refreshPackDiscoveryRefusalMessage } from "@/components/settings/panels/provider-pack-version-manager-model";
import type { VersionManagerPanelToken } from "@/components/settings/panels/provider-pack-version-manager-presence";
import { versionManagerPanelIsMounted } from "@/components/settings/panels/provider-pack-version-manager-presence";

type RefreshPackDiscoveryMutationResult = UseMutationResult<
  ResponseOfMethod<HostRpcRegistry, "providers.refreshPackDiscovery">,
  HostRpcError,
  RequestOfMethod<HostRpcRegistry, "providers.refreshPackDiscovery">,
  RefreshPackDiscoveryMutationContext
>;

interface RefreshPackDiscoveryMutationContext {
  readonly hostId: string | null;
  readonly panel: VersionManagerPanelToken | null;
}

/** ok false rides success; toast only if the capturing panel has unmounted. */
export function useProvidersRefreshPackDiscovery(
  panel: VersionManagerPanelToken | null,
): RefreshPackDiscoveryMutationResult {
  return useProvidersRefreshPackDiscoveryForClient(useHostClient(), panel);
}

export function useProvidersRefreshPackDiscoveryForClient(
  client: HostClient<HostRpcRegistry> | null,
  panel: VersionManagerPanelToken | null,
): RefreshPackDiscoveryMutationResult {
  const queryClient = useQueryClient();
  return useHostMutationWithResponseTimeout<
    HostRpcRegistry,
    "providers.refreshPackDiscovery",
    RefreshPackDiscoveryMutationContext
  >({
    client,
    method: "providers.refreshPackDiscovery",
    mapVariables: (variables) => variables,
    responseTimeoutMs: PROVIDER_PACK_DISCOVERY_CHECK_TIMEOUT_MS,
    options: {
      mutationKey: providersMutationKeys.refreshPackDiscovery(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null, panel }),
      onSuccess: (response, _variables, context) => {
        // The two refusals ran no poll, so their refetch is strictly wasted - it is folded in anyway because every sibling pack mutation invalidates the same way, and one hook that skips it on a subset of its own outcomes is a worse thing to maintain than one redundant read.
        if (context.hostId !== null) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(
              context.hostId,
              "providers.list",
            ),
          });
        }
        if (response.result.ok) return;
        if (versionManagerPanelIsMounted(context.panel)) return;
        toast.error(refreshPackDiscoveryRefusalMessage(response.result.code));
      },
      onError: (error) => {
        toastFromHostError(error, "Couldn't check for updates.");
      },
    },
  });
}
