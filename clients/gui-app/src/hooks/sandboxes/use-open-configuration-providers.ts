import { useCallback } from "react";
import { openEnvironmentPage } from "@/components/settings/environment/open-environment-page";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useHostClient } from "@/lib/host";
import type { StageConfiguration } from "@/lib/sandboxes/sandbox-stage-model";
import { PERSONAL_CONFIGURATION_ID } from "@/lib/settings-environment-pages";

/**
 * Opens a configuration's own Providers page, as the Environment lane's links
 * open a configuration's page (`openEnvironmentPage`): Personal's, or the
 * team's, by the team's environment. `null` for a team whose environment has
 * not been read (`readsTeams` false, or not answered yet).
 */
export function useConfigurationProvidersOpener(
  readsTeams: boolean,
): (configuration: StageConfiguration) => (() => void) | null {
  const environments = useEnvironmentListQuery(useHostClient(), readsTeams);
  const listed = environments.data?.environments;
  return useCallback(
    (configuration: StageConfiguration): (() => void) | null => {
      const teamId =
        configuration.kind === "team" ? configuration.teamId : null;
      const configurationId =
        teamId === null
          ? PERSONAL_CONFIGURATION_ID
          : (listed?.find(
              (environment) =>
                environment.ownerKind === "organization" &&
                environment.ownerId === teamId,
            )?.environmentId ?? null);
      if (configurationId === null) return null;
      return () => {
        openEnvironmentPage({ configurationId, pageId: "providers" });
      };
    },
    [listed],
  );
}
