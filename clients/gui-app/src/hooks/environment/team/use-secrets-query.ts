import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useSecretsRead } from "@/hooks/environment/use-environment-secrets-calls";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * The secrets of the environment a page names, read by the app itself from
 * authn; the host's own secrets (a Local pick, no environment named) are still
 * the host's read.
 */
export function useEnvironmentSecretsQuery(
  client: HostClient<HostRpcRegistry>,
) {
  const { environmentId, resolved } = useAddressedEnvironment();
  return useSecretsRead({
    client: usePoolTierHostClient(client),
    method: "environment.secrets.list",
    params: { environmentId },
    enabled: resolved,
    poll: true,
  });
}
