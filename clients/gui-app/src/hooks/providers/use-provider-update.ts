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
 * Where the last press stands: its requests in flight, the host's install
 * after the host took it (watched on the host's provider list from `since`),
 * or refused outright.
 */
type UpdatePhase =
  | { readonly kind: "idle" }
  | { readonly kind: "requesting" }
  | {
      readonly kind: "installing";
      readonly providerId: ProviderId;
      readonly since: number;
    }
  | { readonly kind: "refused"; readonly message: string };

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
 * host only starts the install, so after it takes the request this watches
 * the host's list (which polls fast while bytes move) and stays pending until
 * the provider's install settles, then says why it failed if it did. A
 * refused request says why too.
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
  const watching = phase.kind === "installing";
  const listed = useProvidersListForClient(client, {
    enabled: watching,
    subscribed: watching,
  });
  const update = useCallback(
    (harnessId: string) => {
      const harness = guiHarnessIdSchema.safeParse(harnessId);
      if (!harness.success || client === null) return;
      const providerId = providerCliIdForHarness(harness.data);
      if (providerId === null) return;
      setPhase({ kind: "requesting" });
      // Filed under the host that answers it, as `useHostQuery` files it.
      const listHostId = client.getActiveHostId();
      const readPackId = async (): Promise<string | null> => {
        if (!canRefresh || listHostId === null) return null;
        const list = await queryClient
          .fetchQuery(
            queryOptions({
              queryKey: hostQueryKeys.method<HostRpcRegistry, "providers.list">(
                listHostId,
                "providers.list",
                { native: null },
              ),
              queryFn: () => client.request("providers.list", { native: null }),
              // A cached list names the pack as well as a fresh one.
              staleTime: Number.POSITIVE_INFINITY,
              retry: false,
            }),
          )
          .catch(() => null);
        return (
          list?.providers.find((row) => row.providerId === providerId)
            ?.packId ?? null
        );
      };
      void (async () => {
        const packId = await readPackId();
        // A refused or failed check is toasted by its hook; the update still
        // runs, on whatever the host already knows.
        if (packId !== null) {
          await refresh.mutateAsync({ packId }).catch(() => undefined);
        }
        await ensure.mutateAsync({ providerId }).then(
          () => setPhase({ kind: "installing", providerId, since: Date.now() }),
          (error: Error) =>
            setPhase({ kind: "refused", message: error.message }),
        );
      })();
    },
    [canRefresh, client, ensure, queryClient, refresh],
  );
  return {
    update: canEnsure ? update : null,
    ...presentPhase(phase, listed.data, listed.dataUpdatedAt),
  };
}

function presentPhase(
  phase: UpdatePhase,
  list: ResponseOfMethod<HostRpcRegistry, "providers.list"> | undefined,
  listUpdatedAt: number,
): Omit<ProviderUpdate, "update"> {
  switch (phase.kind) {
    case "idle":
      return { pending: false, failure: null };
    case "requesting":
      return { pending: true, failure: null };
    case "refused":
      return { pending: false, failure: phase.message };
    case "installing": {
      // A list read before the host took the request says nothing about it.
      if (list === undefined || listUpdatedAt < phase.since) {
        return { pending: true, failure: null };
      }
      const state = list.providers.find(
        (row) => row.providerId === phase.providerId,
      )?.managedInstallState;
      if (state?.status === "downloading") {
        return { pending: true, failure: null };
      }
      if (state?.status === "error") {
        return {
          pending: false,
          failure: `The update failed: ${providerPackErrorDetail(state.reason)}`,
        };
      }
      return { pending: false, failure: null };
    }
  }
}
