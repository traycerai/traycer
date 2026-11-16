import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/**
 * Whether the person may change the named team's configuration, read from
 * their environment list rather than the settings page's source: false until
 * the list answers, and for a Viewer or a role not known. A failed re-read
 * makes the role not known, whatever an earlier answer said.
 */
export function useMayChangeTeamConfiguration(
  environmentId: string | null,
): boolean {
  const environments = useEnvironmentListQuery(environmentId !== null);
  if (environments.isError) return false;
  const team = environments.data?.environments.find(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === environmentId,
  );
  return (
    team !== undefined && mayChangeConfiguration(configurationRoleOf(team))
  );
}
