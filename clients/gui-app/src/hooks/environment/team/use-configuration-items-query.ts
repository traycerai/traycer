import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useEnvironmentCloudQuery } from "@/hooks/environment/use-environment-cloud";
import type { HostRpcRegistry } from "@/lib/host";

export type ConfigurationItem = ResponseOfMethod<
  HostRpcRegistry,
  "environment.configuration.items"
>["items"][number];

/**
 * Page-specific projections share one configuration read and its CAS
 * invalidation. The app reads it itself from authn on the viewer's sign-in,
 * with no host in the path; the configuration revision moves it.
 */
export function useConfigurationItemsQuery<Data>(
  page: string,
  mapItems: (items: readonly ConfigurationItem[]) => Data,
): UseQueryResult<Data, HostRpcError> {
  const source = useConfigurationSource();
  return useEnvironmentCloudQuery({
    method: "environment.configuration.items",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    cacheKeyIdentity: [page],
    mapResponse: (response) => mapItems(response.items),
    enabled: source.kind === "pool",
    poll: false,
  });
}
