import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

/** False until the list answers; a failed re-read makes the role unknown. */
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
