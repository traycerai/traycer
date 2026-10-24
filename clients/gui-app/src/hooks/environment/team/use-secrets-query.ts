import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useConfigurationEnvironmentId } from "@/components/settings/environment/configuration-source";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";

export function useEnvironmentSecretsQuery(
  client: HostClient<HostRpcRegistry>,
) {
  const environmentId = useConfigurationEnvironmentId();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  return useHostQuery({
    cacheKeyIdentity: environmentId === null ? undefined : [viewerId],
    client,
    method: "environment.secrets.list",
    params: { environmentId },
    preflight:
      environmentId === null
        ? undefined
        : cloudVerdictPreflight("environment.secrets.list"),
    requiredHostMethodVersion: () =>
      environmentId === null
        ? null
        : {
            method: "environment.secrets.list",
            version: { major: 1, minor: 1 },
          },
    options: {
      enabled: environmentId === null || (viewerId.length > 0 && authorized),
    },
  });
}
