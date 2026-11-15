import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useHostClient } from "@/lib/host";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * `Details` beside the Secrets page's chip: the configuration's secrets,
 * including recent removals. Resolved through the surface's client, as the
 * chip is.
 */
export function SecretsHeaderDetails(): ReactNode {
  const pick = useEnvironmentPick();
  // On a Local pick no chip holds the host list the drawer counts sandboxes
  // from, so this reads it.
  useHostsRunningPersonal(pick.kind === "local");
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
