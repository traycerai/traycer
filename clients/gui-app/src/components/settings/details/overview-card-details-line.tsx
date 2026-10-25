import type { ReactNode } from "react";
import type { OverviewCardLineProps } from "@/components/settings/environment/overview-card-line-props";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { readsHostBindingsFromPool } from "@/hooks/bots/use-host-environment-bindings-query";
import type { HostRpcRegistry } from "@/lib/host";

/**
 * Opens the named host's configuration, independently of the Environment pick.
 */
export function OverviewCardDetailsLine(
  props: OverviewCardLineProps,
): ReactNode {
  const viewerUserId = useCloudChatViewerId();
  const binding = useHostQuery<HostRpcRegistry, "environment.binding.read">({
    client: props.client,
    method: "environment.binding.read",
    params: { hostId: props.hostId },
    cacheKeyIdentity: [viewerUserId],
    options: {
      enabled: readsHostBindingsFromPool() && viewerUserId.length > 0,
    },
  });
  if (binding.isError || binding.data === undefined) return null;
  return (
    <SettingsDetailsButton
      subject={{
        environmentId: binding.data.environment.environmentId,
        kind: "host_settings",
        key: props.hostId,
      }}
      title="Settings"
      controls={null}
    />
  );
}
