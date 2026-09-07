import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { providerCliIdForHarness } from "@/lib/provider-ordering";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";
import { resolveSeededProfileId } from "@/lib/composer/resolve-seeded-profile-id";

const SEEDED_PROFILE_REFRESH_MS = 15 * 60 * 1000;

/**
 * Validate a fork's seeded `profileId` against `client`'s `providers.list`, not the app-wide host.
 */
export function useResolvedSeededProfileId(
  harnessId: GuiHarnessId,
  profileId: string | null,
  active: boolean,
  client: HostClient<HostRpcRegistry> | null,
): string | null {
  const providerId = providerCliIdForHarness(harnessId);
  const providersQuery = useHostQuery<HostRpcRegistry, "providers.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.list",
    params: { native: null },
    options: {
      enabled: active,
      subscribed: active,
      staleTime: SEEDED_PROFILE_REFRESH_MS,
    },
  });
  // `providers.list` always returns every configured provider in one atomic response - once this has landed, a missing/empty entry for `providerId` is a real "no support" verdict, not a partial load.
  const settled = providerId !== null && providersQuery.data !== undefined;
  const profiles =
    providerId === null
      ? undefined
      : providersQuery.data?.providers.find(
          (provider) => provider.providerId === providerId,
        )?.profiles;
  return resolveSeededProfileId(profileId, profiles, settled);
}
