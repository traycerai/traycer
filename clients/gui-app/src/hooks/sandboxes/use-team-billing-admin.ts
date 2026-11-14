import { useMemo } from "react";
import { configurationRoleOf } from "@/components/settings/environment/configuration-source";
import { useEnvironmentListQuery } from "@/hooks/bots/use-environment-list-query";
import { useTeamEnvironmentIds } from "@/hooks/sandboxes/use-team-environment-query";
import { useHostClient } from "@/lib/host";

const NO_TEAM: readonly string[] = [];

/**
 * Whether the person is `teamId`'s Admin, the one seat that may buy the
 * team's credits. Read from the person's own environment list (the team's
 * environment, found by the team's id, and the role the list gives the
 * person there), never from a sandbox's computer. False for no team, and
 * while either read is out or failed: until it is known, the person is not
 * an Admin.
 */
export function useTeamBillingAdmin(teamId: string | null): boolean {
  const teamIds = useMemo(
    () => (teamId === null ? NO_TEAM : [teamId]),
    [teamId],
  );
  const environmentId = useTeamEnvironmentIds(teamIds).byTeamId.get(
    teamId ?? "",
  );
  const environments = useEnvironmentListQuery(
    useHostClient(),
    environmentId !== undefined,
  );
  if (environmentId === undefined || environments.isError) return false;
  const descriptor = environments.data?.environments.find(
    (environment) => environment.environmentId === environmentId,
  );
  return (
    descriptor !== undefined && configurationRoleOf(descriptor) === "admin"
  );
}
