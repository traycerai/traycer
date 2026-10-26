import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import type { HostRpcRegistry } from "@/lib/host";
import type { DetailsSubject } from "@/lib/settings-details-entry";

/**
 * The named host's configuration as a Details subject, independently of the
 * Environment pick; null while its binding is unread or the read failed.
 */
export function useHostSettingsDetailsSubject(
  props: OverviewCardLineProps,
): DetailsSubject | null {
  const viewerUserId = useCloudChatViewerId();
  const binding = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    client: usePoolTierHostClient(props.client),
    method: "environment.binding.read",
    params: { hostId: props.hostId },
    cacheKeyIdentity: [viewerUserId],
    options: {
      enabled: readsHostBindingsFromPool() && viewerUserId.length > 0,
    },
  });
  if (binding.isError || binding.data === undefined) return null;
  return {
    environmentId: binding.data.environment.environmentId,
    kind: "host_settings",
    key: props.hostId,
  };
}
