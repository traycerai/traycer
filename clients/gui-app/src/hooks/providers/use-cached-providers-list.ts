import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { ResponseOfMethod } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderProfile } from "@traycer/protocol/host/provider-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";

type ProvidersListResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.list"
>;

const NO_PROFILES: readonly ProviderProfile[] = [];

/** The classic list entry `useProvidersListForClient` keeps for a host. */
function providersListKey(hostId: string) {
  return hostQueryKeys.method<HostRpcRegistry, "providers.list">(
    hostId,
    "providers.list",
    { native: null },
  );
}

function activeHostId(
  client: HostClient<HostRpcRegistry> | null,
): string | null {
  return client === null ? null : client.getActiveHostId();
}

/**
 * The client's host's `providers.list` as its own poll last cached it, read
 * at render and never fetched. No observer is added: an observer would share
 * the list's cache entry and lend it its own options. A surface calling this
 * is drawn from that same list by a caller that observes it, so it is
 * re-rendered with every change of the entry and the read stays current.
 */
export function useCachedProvidersList(
  client: HostClient<HostRpcRegistry> | null,
): ProvidersListResponse | undefined {
  const queryClient = useQueryClient();
  const hostId = activeHostId(client);
  return hostId === null
    ? undefined
    : queryClient.getQueryData<ProvidersListResponse>(providersListKey(hostId));
}

/** One provider's rows in the cached list, and whether its last read failed. */
export interface CachedProviderProfilesRead {
  readonly profiles: readonly ProviderProfile[];
  readonly readFailed: boolean;
}

export interface CachedProviderProfilesReader {
  /** The rows as cached at the moment of the call; reads nothing. */
  readonly listedProfiles: () => CachedProviderProfilesRead;
  /** Reads the list once more and settles when that read has ended. */
  readonly rereadList: () => Promise<void>;
}

/**
 * A sign-in dialog's view of the cached `providers.list` of the client's
 * host. `listedProfiles` is called when `providers.awaitLogin` settles: that
 * mutation's own success handler re-reads the list and waits for it before
 * the dialog's handler runs, so what it returns then is that re-read.
 * `rereadList` is the dialog's Retry after that read failed: one read of the
 * list per call, nothing else.
 */
export function useCachedProviderProfilesReader(
  client: HostClient<HostRpcRegistry> | null,
  providerId: string,
): CachedProviderProfilesReader {
  const queryClient = useQueryClient();
  return useMemo(
    () => ({
      listedProfiles: () => {
        const hostId = activeHostId(client);
        if (hostId === null)
          return { profiles: NO_PROFILES, readFailed: false };
        const key = providersListKey(hostId);
        const list = queryClient.getQueryData<ProvidersListResponse>(key);
        return {
          profiles:
            list?.providers.find(
              (provider) => provider.providerId === providerId,
            )?.profiles ?? NO_PROFILES,
          readFailed: queryClient.getQueryState(key)?.status === "error",
        };
      },
      rereadList: async () => {
        const hostId = activeHostId(client);
        if (hostId === null) return;
        await queryClient.invalidateQueries({
          queryKey: providersListKey(hostId),
          exact: true,
        });
      },
    }),
    [client, providerId, queryClient],
  );
}
