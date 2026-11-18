import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useEnvironmentCloudQuery } from "@/hooks/environment/use-environment-cloud";
import type { HostRpcRegistry } from "@/lib/host";

export function useConfigurationPlansQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "environment.plans.list">,
  HostRpcError
> {
  const source = useConfigurationSource();
  return useEnvironmentCloudQuery({
    method: "environment.plans.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    cacheKeyIdentity: [],
    mapResponse: (response) => response,
    enabled: source.kind === "pool",
    poll: true,
  });
}
