import { useCallback, useState } from "react";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import { guiHarnessIdSchema } from "@traycer/protocol/host/agent/shared";
import { providerPackErrorDetail } from "@/components/providers/provider-pack-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersEnsurePackForClient } from "@/hooks/providers/use-providers-ensure-pack-mutation";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import { useProvidersRefreshPackDiscoveryForClient } from "@/hooks/providers/use-providers-refresh-pack-discovery-mutation";
import type { HostRpcRegistry } from "@/lib/host";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { hostQueryKeys } from "@/lib/query-keys";

export interface ProviderUpdate {
  /** Updates the harness's provider on the host; `null` where the host cannot. */
  readonly update: ((harnessId: string) => void) | null;
  /** `true` from the press until the host's install of the update settles. */
  readonly pending: boolean;
  /** Why the last update did not take, for the row to say; `null` otherwise. */
  readonly failure: string | null;
}

/**
 * Where the last press stands: its requests in flight, up to and including
 * the first list read the host answered after it took the request; the
 * host's install state for the provider from then on; or failed.
 */
type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | { readonly kind: "following"; readonly providerId: ProviderId }
  | { readonly kind: "failed"; readonly message: string };

type ProvidersList = ResponseOfMethod<HostRpcRegistry, "providers.list">;

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
 * read from its cache, or fetched through `client` when none is cached. The
 * host only starts the install, so this stays pending until a list read the
 * host answered after it took the request, then reports the provider's
 * install state as the host's list presents it: pending while it downloads,
 * the host's reason when the install is in error, and done otherwise. It
 * infers nothing about versions. The list says an install is in error only
 * while no copy of the provider is runnable: a replacement that fails beside
 * a runnable old copy reads as installed, so it settles here, and the next
 * refused turn offers Update again.
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
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });
  const watching = phase.kind === "following";
  const listed = useProvidersListForClient(client, {
    enabled: watching,
    subscribed: watching,
  });
  const update = useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      if (!harness.success || client === null) return;
      const providerId = providerCliIdForHarness(harness.data);
      // Filed under the host that answers it, as `useHostQuery` files it.
      const listHostId = client.getActiveHostId();
      if (providerId === null || listHostId === null) return;
      setPhase({ kind: "requesting" });
      const listKey = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
        listHostId,
        "providers.list",
        { native: null },
      );
      void (async () => {
        // A cached list names the pack as well as a fresh one.
        const cached = canRefresh
          ? await queryClient
              .fetchQuery(
                queryOptions({
                  queryKey: listKey,
                  queryFn: () =>
                    client.request("providers.list", { native: null }),
                  staleTime: Number.POSITIVE_INFINITY,
                  retry: false,
                }),
              )
              .catch(() => null)
          : null;
        const packId =
          cached?.providers.find(
            (candidate) => candidate.providerId === providerId,
          )?.packId ?? null;
        // A refused or failed check is toasted by its hook; the update still
        // runs, on whatever the host already knows.
        if (packId !== null) {
          await refresh.mutateAsync({ packId }).catch(() => undefined);
        }
        try {
          await ensure.mutateAsync({ providerId });
          // Sent once the host has answered the update, so answered after it
          // took it; sent past the list cache, which other reads and writes
          // can cancel, revert or overwrite meanwhile.
          queryClient.setQueryData(
            listKey,
            await client.request("providers.list", { native: null }),
          );
        } catch (error) {
          setPhase({
            kind: "failed",
            message: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        setPhase({ kind: "following", providerId });
      })();
    },
    [canRefresh, client, ensure, queryClient, refresh],
  );
  return {
    update: canEnsure ? update : null,
    ...presentPhase(phase, listed.data),
  };
}

function presentPhase(
  phase: UpdatePhase,
  list: ProvidersList | undefined,
): Omit<ProviderUpdate, "update"> {
  switch (phase.kind) {
    case "idle":
      return { pending: false, failure: null };
    case "requesting":
      return { pending: true, failure: null };
    case "failed":
      return { pending: false, failure: phase.message };
    case "following": {
      const slot = list?.providers.find(
        (candidate) => candidate.providerId === phase.providerId,
      )?.managedInstallState;
      if (slot?.status === "downloading") {
        return { pending: true, failure: null };
      }
      if (slot?.status === "error") {
        return {
          pending: false,
          failure: `The update failed: ${providerPackErrorDetail(slot.reason)}`,
        };
      }
      return { pending: false, failure: null };
    }
  }
}
