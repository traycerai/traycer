import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { useAddressedEnvironment } from "@/hooks/environment/use-addressed-environment";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import { usePreviewFeature } from "@/hooks/auth/use-preview-feature";

export function useEnvironmentSecretsQuery(
  client: HostClient<HostRpcRegistry>,
) {
  const { environmentId, resolved } = useAddressedEnvironment();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // Secrets are an environment's: none are read without environments, and
  // none while unread, which every page that shows them waits out anyway.
  const environments = usePreviewFeature("environments");
  return useHostQuery({
    cacheKeyIdentity: environmentId === null ? undefined : [viewerId],
    client: usePoolTierHostClient(client),
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
      enabled:
        environments === "on" &&
        resolved &&
        (environmentId === null || (viewerId.length > 0 && authorized)),
    },
  });
}
