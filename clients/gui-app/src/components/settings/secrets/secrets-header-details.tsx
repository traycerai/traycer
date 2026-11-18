import type { ReactNode } from "react";
import { SettingsDetailsButton } from "@/components/settings/details/settings-details-button";
import { useDetailsEnvironmentId } from "@/components/settings/details/use-details-environment-id";
import { useHostsRunningPersonal } from "@/components/settings/environment/use-hosts-running-configuration";
import { useEnvironmentPick } from "@/stores/settings/settings-environment-pick-store";

/**
 * The Secrets page's `Details`: the configuration's secrets, including
 * recent removals.
 */
export function SecretsHeaderDetails(): ReactNode {
  const pick = useEnvironmentPick();
  // On a Local pick nothing else holds the host list the drawer counts
  // sandboxes from.
  useHostsRunningPersonal(pick.kind === "local");
  const environmentId = useDetailsEnvironmentId();
  if (environmentId === null) return null;
  return (
    <SettingsDetailsButton
      subject={{ environmentId, kind: "secret", key: "" }}
      title="Secrets"
      controls={null}
    />
  );
}
