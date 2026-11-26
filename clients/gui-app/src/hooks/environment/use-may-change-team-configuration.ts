import { environmentReadLostAuthority } from "@/hooks/environment/environment-read-data";
import {
  configurationRoleOf,
  mayChangeConfiguration,
} from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";

export function useTeamConfigurationAccess(
  environmentId: string,
): "allowed" | "denied" | "unanswered" {
  const environments = useEnvironmentListQuery(true);
  if (environmentReadLostAuthority(environments.error ?? null)) return "denied";
  if (environments.isError || environments.data === undefined)
    return "unanswered";
  const team = environments.data.environments.find(
    (environment) =>
      environment.ownerKind === "organization" &&
      environment.environmentId === environmentId,
  );
  // An unread members reply is projected as a Viewer with no team handle.
  if (team?.providerHandle === null) return "unanswered";
  const allowed =
    team !== undefined && mayChangeConfiguration(configurationRoleOf(team));
  return allowed ? "allowed" : "denied";
}
