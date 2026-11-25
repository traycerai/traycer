import { environmentReadData } from "@/hooks/environment/environment-read-data";
import { usePoolTierHostClient } from "@/hooks/host/use-pool-tier";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import type { HostRpcRegistry } from "@/lib/host";
import type { DetailsSubject } from "@/lib/settings-details-entry";

/**
 * The named host's configuration as a Details subject, independently of the
 * Environment pick; a failed refetch retains the answer for this host and viewer.
 */
export function useHostSettingsDetailsSubject(
  props: OverviewCardLineProps,
): DetailsSubject | null {
  const viewerUserId = useCloudChatViewerId();
  const enabled = readsHostBindingsFromPool() && viewerUserId.length > 0;
  const binding = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    client: usePoolTierHostClient(props.client),
    method: "environment.binding.read",
    params: { hostId: props.hostId },
    cacheKeyIdentity: [viewerUserId],
    options: { enabled },
  });
  const data = environmentReadData(binding);
  if (!enabled || data === undefined) return null;
  return {
    environmentId: data.environment.environmentId,
    kind: "host_settings",
    key: props.hostId,
  };
}
