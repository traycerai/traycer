import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { SyncLinksListResponse } from "@traycer/protocol/host/sync-links-schemas";
import { syncLinksSupported } from "@/components/settings/sync-links/sync-links-supported";
import { useHostNegotiatedMethodVersion } from "@/hooks/host/use-host-negotiated-method-version";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The folders a 1.5.4 "Sync profiles" linked on the computer `client` names,
 * read only from a host that negotiated `providers.syncLinks.list@1.0`. Every
 * `providers.changed` frame re-reads it (`PROVIDER_INVALIDATIONS`).
 */
export function useProvidersSyncLinksListQuery(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): UseQueryResult<SyncLinksListResponse, HostRpcError> {
  const supported = syncLinksSupported(
    useHostNegotiatedMethodVersion(client, "providers.syncLinks.list"),
  );
  return useHostQuery<HostRpcRegistry, "providers.syncLinks.list">({
    cacheKeyIdentity: undefined,
    client,
    method: "providers.syncLinks.list",
    params: {},
    options: { enabled: enabled && supported },
  });
}
