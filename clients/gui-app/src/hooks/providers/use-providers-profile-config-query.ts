import type { UseQueryResult } from "@tanstack/react-query";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { ProvidersGetProfileConfigResponse } from "@traycer/protocol/host/provider-profile-config-schemas";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

/**
 * A managed profile's own scalar config (D16) - CLI selection, terminal args,
 * env, endpoint, skills/plugins ownership. `null` addresses the Default
 * account's row. Callers must gate on `useHostSupportsMethod(hostId,
 * "providers.getProfileConfig")` (D21: brand-new method, `degrade:
 * unsupported`) before enabling this query against an old host.
 */
export function useProvidersProfileConfig(args: {
  readonly providerId: ProviderId;
  readonly profileId: string | null;
  readonly enabled: boolean;
}): UseQueryResult<ProvidersGetProfileConfigResponse, HostRpcError> {
  const client = useHostClient();
  return useHostQuery<HostRpcRegistry, "providers.getProfileConfig">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.getProfileConfig",
    params: { providerId: args.providerId, profileId: args.profileId },
    options: {
      enabled: args.enabled,
      staleTime: 30_000,
    },
  });
}
