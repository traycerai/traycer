import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQueryWithResponseMap } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

export type ConfigurationItem = ResponseOfMethod<
  HostRpcRegistry,
  "environment.configuration.items"
>["items"][number];

/**
 * Page-specific projections share one configuration read and its CAS
 * invalidation. The read uses the pool in a pool build and the surface's
 * host otherwise, on the viewer's session.
 */
export function useConfigurationItemsQuery<Data>(
  page: string,
  mapItems: (items: readonly ConfigurationItem[]) => Data,
): UseQueryResult<Data, HostRpcError> {
  const source = useConfigurationSource();
  const client = usePoolTierHostClient(useHostClient());
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQueryWithResponseMap<
    HostRpcRegistry,
    "environment.configuration.items",
    Data
  >({
    cacheKeyIdentity: [viewerId, page],
    client,
    method: "environment.configuration.items",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.configuration.items"),
    mapResponse: ({ response }) => mapItems(response.items),
    options: {
      enabled: source.kind === "pool" && viewerId.length > 0 && authorized,
    },
  });
}
