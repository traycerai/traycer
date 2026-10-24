import type { ReactNode } from "react";
import { openEnvironmentPage } from "@/components/settings/environment/open-environment-page";
import { hostOptionTeamOwner } from "@/components/settings/host-scope/host-option-model";
import type { HostScope } from "@/components/settings/host-scope/use-host-scope";
import { Button } from "@/components/ui/button";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import {
  PERSONAL_CONFIGURATION_ID,
  type ConfigurationId,
} from "@/lib/settings-environment-pages";

/**
 * The Host picker's footer link: the Sandboxes page of the configuration the
 * picked host runs (seam 2). Every sandbox the picker does not list lives
 * there.
 */
export function HostPickerSandboxesLink(props: {
  readonly scope: HostScope;
}): ReactNode {
  const team =
    props.scope.host === null ? null : hostOptionTeamOwner(props.scope.host);
  const environments = useEnvironmentListQuery(
    props.scope.client,
    team !== null,
  );
  let configurationId: ConfigurationId | null = PERSONAL_CONFIGURATION_ID;
  if (team !== null) {
    configurationId =
      environments.data?.environments.find(
        (environment) =>
          environment.ownerKind === "organization" &&
          environment.ownerId === team.teamId,
      )?.environmentId ?? null;
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="justify-start"
      data-testid="settings-host-picker-sandboxes"
      disabled={configurationId === null}
      onClick={() => {
        if (configurationId === null) return;
        openEnvironmentPage({ configurationId, pageId: "sandboxes" });
      }}
    >
      Sandboxes
    </Button>
  );
}
