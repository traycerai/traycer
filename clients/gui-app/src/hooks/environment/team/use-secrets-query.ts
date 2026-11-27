import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useSecretsEnvironment,
  useSecretsRead,
} from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";

/** Where the page names none (a Local pick), the environment its host runs. */
export function useEnvironmentSecretsQuery(
  client: HostClient<HostRpcRegistry>,
) {
  const { environmentId, resolved } = useSecretsEnvironment(
    usePoolTierHostClient(client),
  );
  return useSecretsRead({
    method: "environment.secrets.list",
    params: { environmentId },
    enabled: resolved,
    poll: true,
  });
}

/**
 * The same list for a pick inside an open server card: read while `enabled`,
 * and never polled, so an open card adds no interval read.
 */
export function useEnvironmentSecretsPickQuery(
  client: HostClient<HostRpcRegistry>,
  enabled: boolean,
) {
  const { environmentId, resolved } = useSecretsEnvironment(
    usePoolTierHostClient(client),
  );
  return useSecretsRead({
    method: "environment.secrets.list",
    params: { environmentId },
    enabled: enabled && resolved,
    poll: false,
  });
}
