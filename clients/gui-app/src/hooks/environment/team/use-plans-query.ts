import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { UseQueryResult } from "@tanstack/react-query";
import type {
  HostRpcError,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useConfigurationSource } from "@/components/settings/environment/configuration-source";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
import { cloudVerdictPreflight } from "@/lib/host/cloud-verdict-preflight";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";

export function useConfigurationPlansQuery(): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "environment.plans.list">,
  HostRpcError
> {
  const source = useConfigurationSource();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const client = usePoolTierHostClient(useHostClient());
  return useHostQuery({
    cacheKeyIdentity: [viewerId],
    client,
    method: "environment.plans.list",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
    },
    preflight: cloudVerdictPreflight("environment.plans.list"),
    options: {
      poll: true,
      enabled: source.kind === "pool" && authorized && viewerId.length > 0,
    },
  });
}

/** Opening Unlink fetches current consequences before confirmation can mount. */
export function useConfigurationPlanUnlinkPreview(
  profileId: string | null,
  previewId: string | null,
): UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "environment.plans.unlinkPreview">,
  HostRpcError
> {
  const source = useConfigurationSource();
  const viewerId = useCloudChatViewerId();
  const authorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const client = usePoolTierHostClient(useHostClient());
  return useHostQuery({
    cacheKeyIdentity: [viewerId, previewId],
    client,
    method: "environment.plans.unlinkPreview",
    params: {
      environmentId: source.kind === "pool" ? source.environmentId : "",
      profileId: profileId ?? "",
    },
    preflight: cloudVerdictPreflight("environment.plans.unlinkPreview"),
    options: {
      enabled:
        source.kind === "pool" &&
        authorized &&
        viewerId.length > 0 &&
        profileId !== null,
      staleTime: 0,
    },
  });
}
