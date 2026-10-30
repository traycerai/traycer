import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersRefreshPackDiscoveryForClient } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { hostQueryKeys } from "@/lib/query-keys";

export interface ProviderUpdate {
  /** Updates the harness's provider on the host; `null` where the host cannot. */
  readonly update: ((harnessId: string) => void) | null;
  /** `true` while the update's requests are in flight. */
  readonly pending: boolean;
}

/**
 * Update for a provider whose command-line tool its service refused as out of
 * date (Tracy Bots T71), on `hostId` through `client`: the host checks for the
 * provider's newest version (`providers.refreshPackDiscovery`), then moves its
 * managed copy to it (`providers.ensurePack`, the gesture Settings' retry
 * makes); the next run uses it. The host decided the update can help before
 * the row offered it, so this only asks whether the host has the method.
 * Pressed by a person only: `ensurePack` marks the request user-initiated.
 *
 * The check names the provider's pack, which only `providers.list` carries:
 * it is read from that list's cache, without observing it, and with no list
 * cached the update runs on what the host already knows.
 */
export function useProviderUpdateForClient(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
): ProviderUpdate {
  const queryClient = useQueryClient();
  const canEnsure =
    useHostSupportsMethod(hostId, "providers.ensurePack") && client !== null;
  const canRefresh = useHostSupportsMethod(
    hostId,
    "providers.refreshPackDiscovery",
  );
  const refresh = useProvidersRefreshPackDiscoveryForClient(client, null);
  const ensure = useProvidersEnsurePackForClient(client);
  const update = useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      if (!harness.success) return;
      const providerId = providerCliIdForHarness(harness.data);
      if (providerId === null) return;
      // Filed under the host that answers it, as `useHostQuery` files it.
      const listHostId = client?.getActiveHostId() ?? null;
      const listed =
        listHostId === null
          ? undefined
          : queryClient.getQueryData<
              ResponseOfMethod<HostRpcRegistry, "providers.list">
            >(
              hostQueryKeys.method<HostRpcRegistry, "providers.list">(
                listHostId,
                "providers.list",
                { native: null },
              ),
            );
      const packId =
        listed?.providers.find((row) => row.providerId === providerId)
          ?.packId ?? null;
      const ensurePack = (): void => ensure.mutate({ providerId });
      if (!canRefresh || packId === null) {
        ensurePack();
        return;
      }
      // A refused or failed check is toasted by its hook; the update still
      // runs, on whatever the host already knows.
      void refresh.mutateAsync({ packId }).then(ensurePack, ensurePack);
    },
    [canRefresh, client, ensure, queryClient, refresh],
  );
  return {
    update: canEnsure ? update : null,
    pending: refresh.isPending || ensure.isPending,
  };
}
