import { useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type {
  SyncLinksStopRequest,
  SyncLinksStopResponse,
} from "@traycer/protocol/host/sync-links-schemas";
import {
  useHostScopedMutationForClient,
  type HostScopedMutationContext,
} from "@/hooks/host/use-host-scoped-mutation";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys, providersMutationKeys } from "@/lib/query-keys";

/**
 * Stops syncing the linked folders on the computer `client` names. The save
 * stays pending until the list has been read again, so the ask never shows
 * the folders it has just answered.
 */
export function useProvidersSyncLinksStopMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  SyncLinksStopResponse,
  HostRpcError,
  SyncLinksStopRequest,
  HostScopedMutationContext<undefined>
> {
  const queryClient = useQueryClient();
  return useHostScopedMutationForClient(client, {
    method: "providers.syncLinks.stop",
    mutationKey: providersMutationKeys.syncLinksStop(),
    errorMessage: null,
    invalidateMethods: PROVIDER_INVALIDATIONS,
    onSuccess: async (_data, _variables, hostId) => {
      if (hostId === null) return;
      await queryClient.invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "providers.syncLinks.list"),
      });
    },
  });
}
