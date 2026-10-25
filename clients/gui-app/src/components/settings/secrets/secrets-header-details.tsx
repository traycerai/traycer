import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { useHostClient } from "@/lib/host";

/**
 * `Details` beside the Secrets page's chip: the configuration's secrets,
 * including recent removals. Resolved through the surface's client, as the
 * chip is.
 */
export function SecretsHeaderDetails(): ReactNode {
  const environmentId = useDetailsEnvironmentId(useHostClient());
  if (environmentId === null) return null;
  return (
    <SettingsDetailsButton
      subject={{ environmentId, kind: "secret", key: "" }}
      title="Secrets"
      controls={null}
    />
  );
}
