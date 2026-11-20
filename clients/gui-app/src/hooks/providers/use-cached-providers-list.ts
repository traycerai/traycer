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
 * Read at render, never fetched; no observer, since it would lend the entry its
 * options. The caller observes the list, so this re-renders with it.
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

export interface CachedProviderProfilesRead {
  readonly profiles: readonly ProviderProfile[];
  readonly readFailed: boolean;
}

export interface CachedProviderProfilesReader {
  readonly listedProfiles: () => CachedProviderProfilesRead;
  readonly rereadList: () => Promise<void>;
}

/** `listedProfiles` is called when `awaitLogin` settles, after that mutation's own re-read. */
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
