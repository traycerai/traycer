import type { ReactNode } from "react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";

/**
 * The configuration's secrets, including recent removals.
 */
export interface SecretsHeaderDetailsProps {
  readonly client: HostClient<HostRpcRegistry>;
  readonly hostId: string | null;
}

export function SecretsHeaderDetails(
  props: SecretsHeaderDetailsProps,
): ReactNode {
  const environmentId = useDetailsEnvironmentId(props.client);
  if (environmentId === null) return null;
  return (
    <SettingsDetailsButton
      subject={{ environmentId, kind: "secret", key: "" }}
      title="Secrets"
    />
  );
}
