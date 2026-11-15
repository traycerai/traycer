import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  useSecretsEnvironment,
  useSecretsRead,
} from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The secrets of the environment a page names, read by the app itself from
 * authn; where it names none (a Local pick), the environment the host it
 * reads through runs.
 */
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
