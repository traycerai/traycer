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
